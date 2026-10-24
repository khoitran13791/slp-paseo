import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSlpConfig } from "../server/config";
import { processChallengeEvidence, processReport, verifyFeature } from "../server/evidence";
import { commitAll, headOf, trustRepo } from "../server/git";
import { runSandboxed } from "../server/sandbox";
import type { TaskState } from "../server/store/derive";
import { EventStore } from "../server/store/events";
import { FAKE_RUNNER, initRepo, sh, tmpDir } from "./helpers";

function setup(over: Record<string, unknown> = {}) {
  const repo = initRepo(); trustRepo(repo);
  const config = parseSlpConfig({ projects: { p: { repo, verify: ["test -f src.ts"] } }, sandbox: { runner: FAKE_RUNNER }, ...over });
  const store = new EventStore(join(tmpDir(), "events.jsonl"));
  const run = vi.fn(runSandboxed);
  const deps = { store, config, project: config.projects.p!, run, now: () => new Date("2026-10-22T00:00:00Z") };
  const task: TaskState = { id: "T1", title: "t", dependsOn: [], verifies: [], touchSet: ["src.ts"], verify: "test -f src.ts", status: "reported", closure: [], agentId: "peer-1", worktree: repo, branch: "main", base: headOf(repo), attempt: 1, lastCommit: null, evidenceOk: false, reviewOk: false, reopened: false, acceptedAtSeq: null };
  const report = store.append({ feature: "f", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "add src" } });
  return { repo, store, run, deps, task, report };
}
const verifyCalls = (run: ReturnType<typeof vi.fn>) => run.mock.calls.filter((c) => c[2] !== "true");
/** A clean filter that touches `marker` and a .gitattributes selecting it for every file: if git runs it, the marker appears. */
function armFilter(repo: string, marker: string): void {
  sh(repo, "git", ["config", "filter.fmt.clean", `touch '${marker}' && cat`]);
  writeFileSync(join(repo, ".gitattributes"), "* filter=fmt\n");
}

describe("processReport", () => {
  it("commits the worktree, then runs verify in the sandbox and records evidence", async () => {
    const { repo, store, run, deps, task, report } = setup();
    writeFileSync(join(repo, "src.ts"), "x"); writeFileSync(join(repo, "extra.md"), "y");
    const out = await processReport(deps, task, report);
    expect(out).toMatchObject({ outcome: "committed", evidenceOk: true, flags: { outsideTouchSet: ["extra.md"], excludedSensitive: [], excludedProtected: [] } });
    expect(store.all().map((e) => e.kind)).toEqual(["report", "commit", "evidence"]);
    expect(store.all()[1]!.data).toMatchObject({ task: "T1", reportSeq: report.seq, files: ["extra.md", "src.ts"] });
    expect(run).toHaveBeenCalledWith(FAKE_RUNNER, repo, "test -f src.ts", 900);
    expect(sh(repo, "git", ["log", "-1", "--format=%s"])).toBe("T1: add src");
  });
  it("records failing verification as not ok", async () => {
    const { repo, deps, task, report } = setup();
    writeFileSync(join(repo, "other.ts"), "x");
    expect(await processReport(deps, task, report)).toMatchObject({ outcome: "committed", evidenceOk: false });
  });
  it("is idempotent for the same report (duplicate turn_ended)", async () => {
    const { repo, store, deps, task, report } = setup();
    writeFileSync(join(repo, "src.ts"), "x");
    const a = await processReport(deps, task, report);
    writeFileSync(join(repo, "late.ts"), "z");
    const b = await processReport(deps, task, report);
    expect(b).toEqual(a);
    expect(store.all().filter((e) => e.kind === "commit")).toHaveLength(1);
  });
  it("refuses to run git on a report when the repo config has a filter that runs repo files", async () => {
    const { repo, store, deps, task, report } = setup();
    sh(repo, "git", ["config", "filter.fmt.clean", "node scripts/filter.js"]);
    writeFileSync(join(repo, "src.ts"), "x");
    expect(await processReport(deps, task, report)).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/filter\.fmt\.clean/) });
    expect(store.all().some((e) => e.kind === "commit")).toBe(false);
  });
  it("does not run git to verify a recorded commit once the repo config has a driver that runs repo files", async () => {
    const { repo, store, deps, task, report } = setup({ sandbox: { runner: ["/nonexistent/runner"] } });
    const marker = join(tmpDir(), "filter.log");
    writeFileSync(join(repo, "src.ts"), "x"); writeFileSync(join(repo, ".gitattributes"), "* filter=fmt\n");
    const first = await processReport(deps, task, report); // commit recorded, but the broken runner leaves it without evidence
    expect(first).toMatchObject({ outcome: "committed", evidenceOk: null });
    armFilter(repo, marker); sh(repo, "touch", ["src.ts"]); // stat-dirty tracked file: `git status` would run the clean filter on it
    const fixed = { ...deps, config: parseSlpConfig({ projects: { p: { repo, verify: ["test -f src.ts"] } }, sandbox: { runner: FAKE_RUNNER } }) };
    expect(await processReport(fixed, task, report)).toMatchObject({ outcome: "committed", commit: (first as { commit: string }).commit, evidenceOk: null, runnerError: expect.stringMatching(/git config runs commands/) });
    expect(existsSync(marker)).toBe(false);
    expect(store.all().some((e) => e.kind === "evidence")).toBe(false);
    expect(store.all().at(-1)!.data.type).toBe("unsafe_git_config");
  });
  it("rejects empty, sensitive-only and oversized changes", async () => {
    let s = setup();
    expect(await processReport(s.deps, s.task, s.report)).toEqual({ outcome: "rejected", reason: "no changes in worktree" });
    s = setup(); writeFileSync(join(s.repo, ".env"), "S=1");
    expect(await processReport(s.deps, s.task, s.report)).toEqual({ outcome: "rejected", reason: "only sensitive or protected files changed: .env" });
    s = setup({ limits: { maxCommitFiles: 2 } }); for (const f of ["a", "b", "c"]) writeFileSync(join(s.repo, f), f);
    expect(await processReport(s.deps, s.task, s.report)).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/3 files changed \(limit 2\)/) });
  });
  it("does not count a verify that changes tracked files as evidence for the commit", async () => {
    const { repo, store, deps, task, report } = setup();
    writeFileSync(join(repo, "src.ts"), "x");
    expect(await processReport(deps, { ...task, verify: "printf y > src.ts" }, report)).toMatchObject({ outcome: "committed", evidenceOk: false });
    expect(store.all().find((e) => e.kind === "evidence")!.data).toMatchObject({ exitCode: 0, dirty: ["src.ts"] });
  });
  it("keeps the recorded commit on a report with no new changes, and verifies it again only under a new task definition", async () => {
    const { repo, store, run, deps, task, report } = setup();
    writeFileSync(join(repo, "src.ts"), "x");
    const first = await processReport(deps, task, report);
    const c1 = (first as { commit: string }).commit;
    const again = store.append({ feature: "f", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "same" } });
    const before = verifyCalls(run).length;
    expect(await processReport(deps, { ...task, lastCommit: c1 }, again)).toMatchObject({ outcome: "committed", commit: c1, evidenceOk: true });
    expect(verifyCalls(run).length).toBe(before);
    const third = store.append({ feature: "f", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "same" } });
    expect(await processReport(deps, { ...task, lastCommit: c1, verify: "test -f src.ts && true" }, third)).toMatchObject({ outcome: "committed", commit: c1, evidenceOk: true });
    expect(verifyCalls(run).length).toBe(before + 1);
  });
  it("records a blocked report with no changes for the Lead instead of rejecting it, once", async () => {
    const { store, deps, task } = setup();
    const blocked = store.append({ feature: "f", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "blocked", message: "which TTL?" } });
    expect(await processReport(deps, task, blocked)).toEqual({ outcome: "blocked" });
    expect(await processReport(deps, task, blocked)).toEqual({ outcome: "blocked" });
    expect(store.all().filter((e) => e.kind === "ops").map((e) => e.data.type)).toEqual(["report_blocked"]);
  });
  it("never commits hook files, agent settings or paseo.json, and flags them", async () => {
    const { repo, store, deps, task, report } = setup();
    mkdirSync(join(repo, ".husky")); writeFileSync(join(repo, ".husky", "post-checkout"), "#!/bin/sh\necho pwned\n");
    mkdirSync(join(repo, ".claude")); writeFileSync(join(repo, ".claude", "settings.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo pwned"}]}]}}');
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{"x":{"command":"echo"}}}');
    writeFileSync(join(repo, "paseo.json"), '{"worktree":{"setup":["echo pwned"]}}'); writeFileSync(join(repo, "src.ts"), "x");
    expect(await processReport(deps, task, report)).toMatchObject({ outcome: "committed", flags: { excludedProtected: [".claude/settings.json", ".husky/post-checkout", ".mcp.json", "paseo.json"] } });
    expect(store.all().find((e) => e.kind === "commit")!.data.files).toEqual(["src.ts"]);
    expect(sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"])).toBe("src.ts");
  });
  it("never commits a nested repo, and flags it with the protected files", async () => {
    const { repo, store, deps, task, report } = setup();
    const vendor = join(repo, "vendor"); mkdirSync(vendor);
    sh(vendor, "git", ["init", "-q", "-b", "main"]); writeFileSync(join(vendor, "file.txt"), "one\n");
    writeFileSync(join(repo, "src.ts"), "x");
    const out = await processReport(deps, task, report);
    expect(out).toMatchObject({ outcome: "committed", flags: { excludedProtected: ["vendor/"] } });
    expect(store.all().find((e) => e.kind === "commit")!.data.files).toEqual(["src.ts"]);
    expect(sh(repo, "git", ["show", "--name-only", "--format=", "HEAD"])).toBe("src.ts");
    expect(sh(repo, "git", ["ls-files", "-s"]).split("\n").filter((l) => /vendor/.test(l))).toEqual([]);
  });
  it("runs the repo pre-commit hook through the runner, never during the commit", async () => {
    const { repo, run, deps, task, report } = setup();
    const marker = join(tmpDir(), "hook.log");
    mkdirSync(join(repo, ".husky")); writeFileSync(join(repo, ".husky", "pre-commit"), `#!/bin/sh\necho ran >> "${marker}"\n`); chmodSync(join(repo, ".husky", "pre-commit"), 0o755);
    sh(repo, "git", ["add", ".husky"]); sh(repo, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "hooks"]);
    sh(repo, "git", ["config", "core.hooksPath", ".husky"]);
    const t = { ...task, base: headOf(repo) };
    writeFileSync(join(repo, "src.ts"), "x");
    run.mockImplementation(async (r, w, c, s) => { if (c !== "true") expect(existsSync(marker)).toBe(false); return runSandboxed(r, w, c, s); });
    await processReport(deps, t, report);
    expect(verifyCalls(run)[0]![2]).toBe(`'${join(repo, ".husky", "pre-commit")}' && test -f src.ts`);
    expect(existsSync(marker)).toBe(true);
  });
  it("skips verification when evidenceCheck is off", async () => {
    const { repo, run, deps, task, report } = setup({ flags: { evidenceCheck: false } });
    writeFileSync(join(repo, "src.ts"), "x");
    expect(await processReport(deps, task, report)).toMatchObject({ outcome: "committed", evidenceOk: null });
    expect(run).not.toHaveBeenCalled();
  });
  it("fails closed on a broken runner without blaming the Peer, then verifies once the runner works", async () => {
    const { repo, store, deps, task, report } = setup({ sandbox: { runner: ["/nonexistent/runner"] } });
    writeFileSync(join(repo, "src.ts"), "x");
    const a = await processReport(deps, task, report);
    expect(a).toMatchObject({ outcome: "committed", evidenceOk: null, runnerError: expect.stringMatching(/sandbox runner failed/) });
    expect(store.all().map((e) => e.kind)).toEqual(["report", "commit", "ops"]);
    expect(store.all()[2]!.data.type).toBe("runner_failed");
    const fixed = { ...deps, config: parseSlpConfig({ projects: { p: { repo, verify: ["test -f src.ts"] } }, sandbox: { runner: FAKE_RUNNER } }) };
    expect(await processReport(fixed, task, report)).toMatchObject({ outcome: "committed", commit: (a as { commit: string }).commit, evidenceOk: true });
    expect(store.all().filter((e) => e.kind === "commit")).toHaveLength(1);
  });
  it("recovers a commit the plugin made just before a crash", async () => {
    const { repo, store, deps, task, report } = setup();
    writeFileSync(join(repo, "src.ts"), "x");
    const hash = commitAll(repo, { message: "T1: add src", trailers: { "SLP-Task": "T1", "SLP-Agent": "peer-1" }, exclude: [] });
    expect(await processReport(deps, task, report)).toMatchObject({ outcome: "committed", commit: hash, evidenceOk: true, recovered: true });
    expect(store.all().find((e) => e.kind === "commit")!.data).toMatchObject({ hash, recovered: true, files: ["src.ts"], reportSeq: report.seq });
  });
});

describe("challenge evidence and feature verification", () => {
  it("does not run git for a challenge when the repo config has a driver that runs repo files", async () => {
    const { repo, store, run, deps, task } = setup();
    const marker = join(tmpDir(), "filter.log");
    armFilter(repo, marker); writeFileSync(join(repo, "repro.test.ts"), "x");
    const ch = store.append({ feature: "f", kind: "challenge", by_role: "peer-impl", by_agent: "peer-1", idPrefix: "C", data: { target: "D1", repro_command: "exit 1" } });
    expect(await processChallengeEvidence(deps, task, ch)).toEqual({ commit: null, exitCode: null });
    expect(existsSync(marker)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(store.all().some((e) => e.kind === "commit" || e.kind === "evidence")).toBe(false);
    expect(await processChallengeEvidence(deps, task, ch)).toBeNull();
  });
  it("commits repro work as challenge-scoped and runs the repro command once", async () => {
    const { repo, store, deps, task } = setup();
    writeFileSync(join(repo, "repro.test.ts"), "x");
    const ch = store.append({ feature: "f", kind: "challenge", by_role: "peer-impl", by_agent: "peer-1", idPrefix: "C", data: { target: "D1", repro_command: "exit 1" } });
    expect(await processChallengeEvidence(deps, task, ch)).toMatchObject({ exitCode: 1 });
    expect(await processChallengeEvidence(deps, task, ch)).toBeNull();
    expect(store.all().find((e) => e.kind === "commit")!.data.scope).toBe("challenge");
    expect(store.all().find((e) => e.kind === "evidence")!.data).toMatchObject({ scope: "challenge", challenge: "C1", exitCode: 1 });
  });
  it("does not give green evidence to a commit that is not the one under test", async () => {
    const { repo, store, deps } = setup();
    writeFileSync(join(repo, "src.ts"), "x"); sh(repo, "git", ["add", "."]); sh(repo, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "c1"]);
    const run = vi.fn(async (r: readonly string[], w: string, c: string, s: number) => {
      if (c === "true") { writeFileSync(join(repo, "late.txt"), "y"); sh(repo, "git", ["add", "."]); sh(repo, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "c2"]); }
      return runSandboxed(r, w, c, s);
    });
    expect(await verifyFeature({ ...deps, run }, "f", repo, ["test -f src.ts"])).toMatchObject({ ok: false });
    expect(store.all().at(-1)!.data.dirty).toEqual([expect.stringMatching(/^HEAD is [0-9a-f]{7}, not [0-9a-f]{7}$/)]);
  });
  it("runs the given full-suite commands, joined with &&, on the lead worktree head", async () => {
    const { repo, store, deps } = setup();
    writeFileSync(join(repo, "src.ts"), "x"); sh(repo, "git", ["add", "."]); sh(repo, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "x"]);
    expect(await verifyFeature(deps, "f", repo, ["test -f src.ts", "true"])).toMatchObject({ commit: headOf(repo), ok: true });
    expect(store.all().at(-1)!.data).toMatchObject({ scope: "feature", commit: headOf(repo), command: "test -f src.ts && true", exitCode: 0 });
  });
});
