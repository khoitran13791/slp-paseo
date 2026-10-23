import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseContracts } from "../server/context";
import type { Identity } from "../server/identity";
import { headOf } from "../server/git";
import { deriveFeature } from "../server/store/derive";
import { buildTools } from "../server/tools";
import { finalizeReview, processReportFor, retireAgent } from "../server/tools/work";
import { bound, humanSays, makeCtx, sh } from "./helpers";

async function ready() {
  const w = makeCtx();
  const sup = bound(w.ctx, { role: "supervisor", project: "demo", feature: null, task: null, reviewCommit: null, parentAgentId: null }, "sup-1");
  const tools = buildTools(w.ctx);
  const call = async (who: Identity, name: string, args: unknown) => {
    const t = tools.find((x) => x.name === name)!;
    if (!t.roles.includes(who.role)) return { text: `not available to ${who.role}`, isError: true };
    try { return await t.handler(who, args); } catch (e) { return { text: (e as Error).message, isError: true }; }
  };
  const human = humanSays(w.paseo, "sup-1");
  await call(sup, "slp_brief", { feature: "cache", title: "Cache", markdown: "# Brief", premises: [] });
  await human("duyệt");
  await call(sup, "slp_human_decision", { feature: "cache", decides: "approve_brief", quote: "duyệt" });
  return { ...w, sup, call, human, events: () => w.ctx.stores.feature("demo", "cache").all() };
}

const TASKS = [{ id: "T1", title: "add src", dependsOn: [], verifies: [], touchSet: ["src.ts"], verify: "test -f src.ts" }, { id: "T2", title: "more", dependsOn: ["T1"], verifies: [], touchSet: [], verify: "true" }];

async function withLeadAndPlan(tasks: Array<Record<string, unknown>> = TASKS, before?: (r: Awaited<ReturnType<typeof ready>>) => void) {
  const r = await ready();
  before?.(r);
  const spawned = await r.call(r.sup, "slp_spawn", { role: "lead", feature: "cache", prompt: "go" });
  expect(spawned.isError).toBeFalsy();
  const lead = r.ctx.identities.byAgent(r.paseo.created[0]!.id)!; // bound by the fake session_open hook
  await r.call(lead, "slp_spec", { markdown: "# Spec" });
  await r.human("spec ok");
  await r.call(r.sup, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "spec ok" });
  await r.call(lead, "slp_plan", { markdown: "# Plan", tasks });
  await r.call(r.sup, "slp_approve_plan", { feature: "cache", sha256: deriveFeature("cache", r.events()).plan!.sha256 });
  return { ...r, lead };
}

describe("slp_spawn", () => {
  it("refuses a Lead before the brief is approved and starts one in an SLP worktree on feat/<feature> after", async () => {
    const w = makeCtx();
    const sup = bound(w.ctx, { role: "supervisor", project: "demo", feature: null, task: null, reviewCommit: null, parentAgentId: null }, "sup-1");
    const t = buildTools(w.ctx).find((x) => x.name === "slp_spawn")!;
    await expect(t.handler(sup, { role: "lead", prompt: "go" })).rejects.toThrow(/write the brief first/);
    w.ctx.identities.setFeature(sup.tokenHash, "cache");
    await expect(t.handler(sup, { role: "lead", prompt: "go" })).rejects.toThrow(/brief is not approved/);
    const r = await withLeadAndPlan();
    const created = r.paseo.created[0]!;
    expect(created).toMatchObject({ parent: "sup-1", title: "[Lead] cache" });
    expect(r.paseo.createdWorkspaces[0]).toMatchObject({ source: { kind: "directory", path: created.cwd }, title: "[Lead] cache" });
    expect(created.cwd.startsWith(r.ctx.worktreeRoot)).toBe(true);
    expect((created.config as { provider: string }).provider).toBe("slp-lead");
    expect(r.lead).toMatchObject({ worktree: created.cwd, branch: "feat/cache", workspaceId: created.workspaceId });
    expect(r.lead.worktree).not.toBe(r.repo);
    expect(sh(r.lead.worktree!, "git", ["branch", "--show-current"])).toBe("feat/cache");
  });
  it("restarts a Lead that died in its old workspace, with the digest", async () => {
    const r = await withLeadAndPlan();
    r.ctx.identities.retire(r.lead.tokenHash);
    expect((await r.call(r.sup, "slp_spawn", { role: "lead", prompt: "continue with T1" })).isError).toBeFalsy();
    const again = r.paseo.created.at(-1)!;
    expect(again).toMatchObject({ cwd: r.lead.worktree, workspaceId: r.lead.workspaceId });
    expect(String(again.prompt)).toContain("the previous Lead stopped");
    expect(String(again.prompt)).toContain("# cache — phase: executing");
  });
  it("spawns one Peer-impl at a time in its own worktree off the feature branch, with the profile model and a brief", async () => {
    const r = await withLeadAndPlan();
    const res = await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "Keep it tiny." });
    expect(res.isError).toBeFalsy();
    const peerCreate = r.paseo.created[1]!;
    expect(peerCreate).toMatchObject({ parent: r.lead.agentId });
    expect(r.paseo.createdWorkspaces.at(-1)).toMatchObject({ source: { kind: "directory", path: peerCreate.cwd } });
    expect((peerCreate.config as { provider: string }).provider).toBe("slp-peer-impl/claude-sonnet-5");
    expect(String(peerCreate.prompt)).toContain("[SLP] Task T1: add src");
    expect(String(peerCreate.prompt)).toContain("Keep it tiny.");
    expect(r.ctx.router.isPluginMessageId(String(peerCreate.clientMessageId))).toBe(true);
    expect(peerCreate.cwd).not.toBe(r.lead.worktree);
    expect(sh(peerCreate.cwd, "git", ["branch", "--show-current"])).toBe("slp/cache/T1-1");
    expect(r.events().filter((e) => e.kind === "assign").at(-1)!.data).toMatchObject({ task: "T1", worktree: peerCreate.cwd, branch: "slp/cache/T1-1", base: headOf(r.lead.worktree!) });
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T2", prompt: "x" })).text).toMatch(/one Peer-impl at a time/);
  });
  it("checks dependencies at spawn, and lets only one of two parallel spawns through", async () => {
    const r = await withLeadAndPlan([{ id: "T1", title: "a", dependsOn: [], verifies: [], touchSet: ["a.ts"], verify: "true" }, { id: "T2", title: "b", dependsOn: ["T1"], verifies: [], touchSet: ["b.ts"], verify: "true" }, { id: "T3", title: "c", dependsOn: [], verifies: [], touchSet: ["c.ts"], verify: "true" }]);
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T2", prompt: "x" })).text).toMatch(/depends on T1, which is not accepted/);
    const [a, b] = await Promise.all([r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" }), r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T3", prompt: "x" })]);
    expect([a.isError === true, b.isError === true].sort()).toEqual([false, true]);
    expect(r.events().filter((e) => e.kind === "assign" && e.data.task)).toHaveLength(1);
  });
  it("lets a new Peer take over the task of a Peer that died, in the same workspace with its uncommitted work", async () => {
    const r = await withLeadAndPlan();
    await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" });
    const peer = r.ctx.identities.byAgent(r.paseo.created[1]!.id)!;
    writeFileSync(join(peer.worktree!, "half.ts"), "wip");
    r.ctx.identities.retire(peer.tokenHash);
    const res = await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "continue" });
    expect(res.text).toMatch(/took over T1/);
    expect(r.paseo.created.at(-1)).toMatchObject({ cwd: peer.worktree, workspaceId: peer.workspaceId });
    expect(String(r.paseo.created.at(-1)!.prompt)).toContain("You take over");
    expect(existsSync(join(peer.worktree!, "half.ts"))).toBe(true);
    const assigns = r.events().filter((e) => e.kind === "assign" && e.data.task === "T1");
    expect(assigns.at(-1)!.data).toMatchObject({ takeover: true, worktree: peer.worktree, base: assigns[0]!.data.base, attempt: 1 });
  });
  it("refuses spawn and merge_main once the feature is halted", async () => {
    const r = await withLeadAndPlan();
    r.ctx.stores.feature("demo", "cache").append({ feature: "cache", kind: "human_decision", by_role: "supervisor", by_agent: r.sup.agentId, data: { decides: "change_goal", target: "", quote: "x" } });
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).text).toMatch(/halted/);
    expect((await r.call(r.lead, "slp_merge_main", {})).text).toMatch(/halted/);
  });
  it("enforces models.allowed and the project writer cap", async () => {
    const r = await withLeadAndPlan();
    r.ctx.config.models.allowed = ["claude-opus-5-5"];
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).text).toMatch(/not in models.allowed/);
    r.ctx.config.models.allowed = [];
    r.ctx.config.projects.demo!.maxWriters = 0;
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).text).toMatch(/writer cap/);
  });
  it("starts a task that touches a shared contract only once its feature holds the contract", async () => {
    const r = await withLeadAndPlan([{ id: "T1", title: "use auth", dependsOn: [], verifies: [], touchSet: ["contract:auth-api"], waitsOn: ["login"], verify: "true" }], (w) => {
      w.ctx.stores.project("demo").append({ feature: null, kind: "contract_claim", by_role: "plugin", by_agent: null, data: { contract: "contract:auth-api", feature: "login" } });
    });
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).text).toMatch(/contract:auth-api \(held by login\)/);
    releaseContracts(r.ctx, "demo", "login");
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).isError).toBeFalsy();
  });
  it("starts a resolve task with the base branch merged in and the conflict markers left for the Peer", async () => {
    const r = await withLeadAndPlan();
    writeFileSync(join(r.repo, "README.md"), "main side\n"); sh(r.repo, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "main moves"]);
    writeFileSync(join(r.lead.worktree!, "README.md"), "feature side\n"); sh(r.lead.worktree!, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "feature moves"]);
    expect((await r.call(r.lead, "slp_merge_main", {})).text).toMatch(/Conflicts in: README.md/);
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "resolve", merge_base: true })).isError).toBeFalsy();
    const peerCreate = r.paseo.created[1]!;
    expect(peerCreate.prompt).toBeUndefined();
    expect(sh(peerCreate.cwd, "git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toBe(headOf(r.repo));
    expect(r.paseo.sent.find((s) => s.agentId === peerCreate.id)!.text).toContain("README.md");
  });
  it("rolls back a failed create so a retry works, and never touches a directory it did not make", async () => {
    const r = await withLeadAndPlan();
    r.paseo.failWorkspaceCreate = 1;
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).isError).toBe(true);
    expect(sh(r.repo, "git", ["branch", "--list", "slp/cache/T1-1"])).toBe("");
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).isError).toBeFalsy();
    const peer = r.ctx.identities.byAgent(r.paseo.created.at(-1)!.id)!;
    r.ctx.identities.retire(peer.tokenHash);
    r.paseo.failWorkspaceAgentCreate = 1;
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "go on" })).isError).toBe(true);
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "go on" })).text).toMatch(/took over T1/);
  });
  it("leaves a directory it did not make alone when a create fails on it", async () => {
    const r = await withLeadAndPlan();
    const theirs = join(r.ctx.worktreeRoot, "demo", "slp-cache-T1-1"); mkdirSync(theirs, { recursive: true }); writeFileSync(join(theirs, "keep.txt"), "mine");
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).text).toMatch(/already exists/);
    expect(readFileSync(join(theirs, "keep.txt"), "utf8")).toBe("mine");
    expect(sh(r.repo, "git", ["branch", "--list", "slp/cache/T1-1"])).toBe("");
  });
  it("refuses to start agents when the repo's git config has a filter that runs repo files, also in a reused workspace", async () => {
    const r = await withLeadAndPlan();
    await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" });
    const peer = r.ctx.identities.byAgent(r.paseo.created[1]!.id)!;
    r.ctx.identities.retire(peer.tokenHash);
    sh(r.repo, "git", ["config", "filter.fmt.clean", "node scripts/filter.js"]);
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "go on" })).text).toMatch(/filter\.fmt\.clean/);
  });
  it("never lets Paseo run the repo's setup or hooks for an SLP worktree", async () => {
    const r = await withLeadAndPlan();
    const marker = join(r.home, "hook-ran");
    writeFileSync(join(r.lead.worktree!, "paseo.json"), JSON.stringify({ worktree: { setup: `touch ${marker}`, teardown: `touch ${marker}` } }));
    mkdirSync(join(r.lead.worktree!, ".husky"), { recursive: true }); writeFileSync(join(r.lead.worktree!, ".husky", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`); chmodSync(join(r.lead.worktree!, ".husky", "post-checkout"), 0o755);
    sh(r.lead.worktree!, "git", ["add", "."]); sh(r.lead.worktree!, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "setup"]);
    sh(r.repo, "git", ["config", "core.hooksPath", ".husky"]);
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).isError).toBeFalsy();
    const peer = r.ctx.identities.byAgent(r.paseo.created[1]!.id)!;
    expect(existsSync(marker)).toBe(false);
    await retireAgent(r.ctx, peer, r.repo);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(peer.worktree!)).toBe(false);
    expect(sh(r.repo, "git", ["branch", "--list", peer.branch!])).toContain(peer.branch!);
  });
  it("drops the messages queued for a Peer when it retires, so the next Peer of the task never sees them", async () => {
    const r = await withLeadAndPlan();
    await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" });
    const peer = r.ctx.identities.byAgent(r.paseo.created[1]!.id)!;
    r.paseo.statuses.set(peer.agentId!, "running"); // the Peer is mid-turn, so the plugin's notices wait in the queue
    const to = { project: "demo", feature: "cache" };
    r.ctx.router.enqueue({ role: "peer-impl", ...to, task: "T1" }, "Verify failed: old");
    r.ctx.router.enqueue({ role: "peer-impl", ...to, task: "T2" }, "for another task");
    r.ctx.router.enqueue({ role: "lead", ...to }, "for the lead");
    await retireAgent(r.ctx, peer, r.repo);
    expect(r.ctx.router.pending().map((d) => d.text)).toEqual(["for another task", "for the lead"]);
    bound(r.ctx, { role: "peer-impl", ...to, task: "T1", worktree: null, reviewCommit: null, parentAgentId: r.lead.agentId }, "peer-next");
    await r.ctx.router.flush();
    expect(r.paseo.sent.filter((s) => s.agentId === "peer-next")).toEqual([]);
  });
  it("refuses Peers once a newer spec waits for the human's approval", async () => {
    const r = await withLeadAndPlan();
    expect((await r.call(r.lead, "slp_spec", { markdown: "# Spec v2" })).isError).toBeFalsy();
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" })).text).toMatch(/the spec is not approved by the human yet/);
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-review", task: "T1", prompt: "x" })).text).toMatch(/the spec is not approved by the human yet/);
    expect(r.paseo.created).toHaveLength(1); // the Lead only
  });
  it("returns the task and retires the Peer when the base branch cannot be merged in for merge_base", async () => {
    const r = await withLeadAndPlan();
    r.ctx.config.projects.demo!.baseBranch = "no-such-branch";
    const res = await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "resolve", merge_base: true });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/merging no-such-branch into the new worktree failed: .*did not start/);
    const peerCreate = r.paseo.created[1]!;
    expect(deriveFeature("cache", r.events()).tasks.get("T1")!.status).toBe("pending");
    expect(r.ctx.identities.byAgent(peerCreate.id)).toBeNull();
    expect(r.ctx.identities.active("demo").filter((i) => i.role === "peer-impl")).toHaveLength(0);
    expect(r.paseo.archived).toContain(peerCreate.id);
    expect(existsSync(peerCreate.cwd)).toBe(false);
    expect(r.paseo.sent.some((s) => s.agentId === peerCreate.id)).toBe(false);
    expect(r.events().filter((e) => e.kind === "release").at(-1)!).toMatchObject({ by_role: "lead", data: { task: "T1", outcome: "returned" } });
    r.ctx.config.projects.demo!.baseBranch = "main";
    const again = await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" });
    expect(again.isError).toBeFalsy();
    expect(sh(r.paseo.created[2]!.cwd, "git", ["branch", "--show-current"])).toBe("slp/cache/T1-2");
  });
});

describe("report → review → accept", () => {
  async function reported() {
    const r = await withLeadAndPlan();
    await r.call(r.lead, "slp_spawn", { role: "peer-impl", task: "T1", prompt: "x" });
    const peer = r.ctx.identities.byAgent(r.paseo.created[1]!.id)!;
    writeFileSync(join(peer.worktree!, "src.ts"), "export const x = 1;\n");
    const rep = await r.call(peer, "slp_report", { status: "done", message: "add src", report: "Added src.ts; test -f passes." });
    expect(rep.text).toMatch(/End your turn/);
    return { ...r, peer };
  }
  it("records the report; the pipeline (run by the hook) commits and verifies", async () => {
    const r = await reported();
    const out = await processReportFor(r.ctx, r.peer);
    expect(out).toMatchObject({ outcome: "committed", evidenceOk: true });
    expect(deriveFeature("cache", r.events()).tasks.get("T1")!).toMatchObject({ status: "reported", evidenceOk: true });
    expect(existsSync(join(r.ctx.stores.featureDir("demo", "cache"), "reports", "T1-1.md"))).toBe(true);
  });
  it("spawns a reviewer on the exact commit, accepts after a clean review, merges into feat, and archives the task workspaces", async () => {
    const r = await reported();
    await processReportFor(r.ctx, r.peer);
    const commit = deriveFeature("cache", r.events()).tasks.get("T1")!.lastCommit!;
    sh(r.peer.worktree!, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "on top of the verified commit"]);
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).text).toMatch(/review/);
    await r.call(r.lead, "slp_spawn", { role: "peer-review", task: "T1", prompt: "review" });
    const revCreate = r.paseo.created[2]!;
    expect((revCreate.config as { provider: string }).provider).toBe("slp-peer-review");
    expect(headOf(revCreate.cwd)).toBe(commit);
    const rev = r.ctx.identities.byAgent(revCreate.id)!;
    expect((await r.call(rev, "slp_review", { commit: "deadbeef", verdict: "pass", findings: [] })).isError).toBe(true);
    await r.call(rev, "slp_review", { commit, verdict: "pass", findings: [{ severity: "non_blocking", file: "src.ts", line: 1, issue: "name", command: "cat src.ts" }] });
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).text).toMatch(/turn has ended/);
    expect(finalizeReview(r.ctx, rev)).toBe(true);
    expect(finalizeReview(r.ctx, rev)).toBe(false);
    await r.ctx.router.flush();
    expect(r.paseo.sent.some((s) => s.agentId === r.lead.agentId && s.text.includes("Review of T1"))).toBe(true);
    const acc = await r.call(r.lead, "slp_accept", { task: "T1" });
    expect(acc.isError).toBeFalsy();
    expect(sh(r.lead.worktree!, "git", ["log", "-1", "--format=%s"])).toBe("Merge T1: add src");
    expect(deriveFeature("cache", r.events()).tasks.get("T1")!.status).toBe("accepted");
    expect(r.paseo.archivedWorkspaces).toEqual(expect.arrayContaining([r.peer.workspaceId, rev.workspaceId]));
    expect(r.ctx.identities.byAgent(r.peer.agentId!)).toBeNull();
  });
  it("does not accept while a new plan waits for approval", async () => {
    const r = await reported();
    await processReportFor(r.ctx, r.peer);
    await r.call(r.lead, "slp_plan", { markdown: "# Plan v2", tasks: TASKS });
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).text).toMatch(/plan v2 is waiting for approval/);
  });
  it("does not accept while a newer spec waits for the human's approval", async () => {
    const r = await reported();
    await processReportFor(r.ctx, r.peer);
    await r.call(r.lead, "slp_spec", { markdown: "# Spec v2" });
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).text).toMatch(/the spec is not approved by the human yet/);
  });
  it("runs network git in the project checkout, so a relative sshCommand cannot run a Peer's script", async () => {
    const r = await withLeadAndPlan();
    const marker = join(r.home, "ssh-ran");
    mkdirSync(join(r.lead.worktree!, "scripts"), { recursive: true }); writeFileSync(join(r.lead.worktree!, "scripts", "ssh.sh"), `touch ${marker}\n`);
    sh(r.lead.worktree!, "git", ["add", "."]); sh(r.lead.worktree!, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "accepted peer work"]);
    sh(r.repo, "git", ["remote", "add", "origin", "ssh://example.invalid/repo.git"]); sh(r.repo, "git", ["config", "core.sshCommand", "sh scripts/ssh.sh"]);
    await r.call(r.lead, "slp_merge_main", {});
    expect(existsSync(marker)).toBe(false);
  });
  it("refuses to accept a task that is not reported, such as one parked behind a spec-level challenge", async () => {
    const r = await reported();
    await processReportFor(r.ctx, r.peer);
    await r.call(r.lead, "slp_challenge", { target: "T1", level: "spec", claim: "contract is wrong", evidence: "test retry exits 1: expected 200", impact: "T1", smallest_correction: "fix the contract" });
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).text).toMatch(/T1 is parked; only a reported task can be accepted/);
  });
  it("does not accept a failing verdict, uncommitted work, or anything past the reviewed commit", async () => {
    const r = await reported();
    await processReportFor(r.ctx, r.peer);
    const commit = deriveFeature("cache", r.events()).tasks.get("T1")!.lastCommit!;
    await r.call(r.lead, "slp_spawn", { role: "peer-review", task: "T1", prompt: "review" });
    const rev = r.ctx.identities.byAgent(r.paseo.created[2]!.id)!;
    await r.call(rev, "slp_review", { commit, verdict: "fail", findings: [] });
    finalizeReview(r.ctx, rev);
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).text).toMatch(/no clean review/);
    await r.call(rev, "slp_review", { commit, verdict: "pass", findings: [] });
    finalizeReview(r.ctx, rev);
    writeFileSync(join(r.peer.worktree!, "late.ts"), "x");
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).text).toMatch(/uncommitted changes \(late\.ts\)/);
    sh(r.peer.worktree!, "git", ["add", "late.ts"]); sh(r.peer.worktree!, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "after review"]);
    expect((await r.call(r.lead, "slp_accept", { task: "T1" })).isError).toBeFalsy();
    expect(existsSync(join(r.lead.worktree!, "src.ts"))).toBe(true);
    expect(existsSync(join(r.lead.worktree!, "late.ts"))).toBe(false);
  });
  it("can start a second reviewer on the same commit", async () => {
    const r = await reported();
    await processReportFor(r.ctx, r.peer);
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-review", task: "T1", prompt: "a" })).isError).toBeFalsy();
    expect((await r.call(r.lead, "slp_spawn", { role: "peer-review", task: "T1", prompt: "b" })).isError).toBeFalsy();
    expect(r.paseo.created[2]!.cwd).not.toBe(r.paseo.created[3]!.cwd);
  });
});

describe("ship", () => {
  it("builds a package only when acceptance passes and ships only with a quoted approval of that commit", async () => {
    const r = await withLeadAndPlan();
    expect((await r.call(r.sup, "slp_ship_package", { feature: "cache", summary: "s" })).text).toMatch(/T1 is pending/);
    r.ctx.stores.feature("demo", "cache").append({ feature: "cache", kind: "ruling", by_role: "lead", by_agent: r.lead.agentId, idPrefix: "R", data: { decision: "skip", reason: "r", cost_if_wrong: "c", drop: ["T1", "T2"] } });
    const pkg = await r.call(r.sup, "slp_ship_package", { feature: "cache", summary: "Cache for retries." });
    expect(pkg.isError).toBeFalsy();
    expect(pkg.text).toContain("Rulings");
    const bare = join(r.home, "origin.git"); sh(r.home, "git", ["init", "-q", "--bare", bare]); sh(r.lead.worktree!, "git", ["remote", "add", "origin", bare]);
    r.ctx.config.ship.openPr = false;
    expect((await r.call(r.sup, "slp_ship", { feature: "cache", quote: "ship" })).isError).toBe(true);
    await r.human("ship đi");
    const late = r.ctx.stores.feature("demo", "cache").append({ feature: "cache", kind: "challenge", by_role: "lead", by_agent: r.lead.agentId, idPrefix: "C", data: { target: "T9", level: "plan", claim: "late" } });
    expect((await r.call(r.sup, "slp_ship", { feature: "cache", quote: "ship đi" })).text).toMatch(/not ready any more[\s\S]*C1 is open/);
    r.ctx.stores.feature("demo", "cache").append({ feature: "cache", kind: "challenge_resolved", by_role: "lead", by_agent: r.lead.agentId, refs: [late.id!], data: { outcome: "rejected" } });
    const shipped = await r.call(r.sup, "slp_ship", { feature: "cache", quote: "ship đi" });
    expect(shipped.isError).toBeFalsy();
    expect(sh(bare, "git", ["rev-parse", "feat/cache"])).toBe(headOf(r.lead.worktree!));
    expect(r.events().at(-1)!.kind).toBe("shipped");
  });
  it("pushes and then reports a missing gh as a failed PR step, not a TypeError", async () => {
    const r = await withLeadAndPlan();
    r.ctx.stores.feature("demo", "cache").append({ feature: "cache", kind: "ruling", by_role: "lead", by_agent: r.lead.agentId, idPrefix: "R", data: { decision: "skip", reason: "r", cost_if_wrong: "c", drop: ["T1", "T2"] } });
    expect((await r.call(r.sup, "slp_ship_package", { feature: "cache", summary: "s" })).isError).toBeFalsy();
    const bare = join(r.home, "origin.git"); sh(r.home, "git", ["init", "-q", "--bare", bare]); sh(r.lead.worktree!, "git", ["remote", "add", "origin", bare]);
    r.ctx.config.ship.openPr = true;
    await r.human("ship đi");
    // A PATH with git and sh but no gh: the test never reaches GitHub, whatever is installed on this machine.
    const bin = join(r.home, "bin"); mkdirSync(bin);
    for (const tool of ["git", "sh"]) symlinkSync(sh(r.home, "sh", ["-c", `command -v ${tool}`]), join(bin, tool));
    const savedPath = process.env.PATH;
    let res;
    try { process.env.PATH = bin; res = await r.call(r.sup, "slp_ship", { feature: "cache", quote: "ship đi" }); } finally { process.env.PATH = savedPath; }
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/pushed feat\/cache, but gh pr create failed: .*ENOENT/);
    expect(res.text).not.toMatch(/TypeError|Cannot read/);
    expect(sh(bare, "git", ["rev-parse", "feat/cache"])).toBe(headOf(r.lead.worktree!));
  });
  it("counts a message typed while the package was verifying as older than the package, so it cannot approve it", async () => {
    const r = await withLeadAndPlan();
    r.ctx.stores.feature("demo", "cache").append({ feature: "cache", kind: "ruling", by_role: "lead", by_agent: r.lead.agentId, idPrefix: "R", data: { decision: "skip", reason: "r", cost_if_wrong: "c", drop: ["T1", "T2"] } });
    const bare = join(r.home, "origin.git"); sh(r.home, "git", ["init", "-q", "--bare", bare]); sh(r.lead.worktree!, "git", ["remote", "add", "origin", bare]);
    r.ctx.config.ship.openPr = false;
    const real = r.ctx.run;
    r.ctx.run = async (runner, worktree, command, timeoutSec) => { await r.human("ok"); return real(runner, worktree, command, timeoutSec); };
    expect((await r.call(r.sup, "slp_ship_package", { feature: "cache", summary: "s" })).isError).toBeFalsy();
    r.ctx.run = real;
    const refused = await r.call(r.sup, "slp_ship", { feature: "cache", quote: "ok" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/no message from the human after the item under approval/);
    await r.human("ok"); // typed after the package: this one approves
    expect((await r.call(r.sup, "slp_ship", { feature: "cache", quote: "ok" })).isError).toBeFalsy();
    expect(sh(bare, "git", ["rev-parse", "feat/cache"])).toBe(headOf(r.lead.worktree!));
  });
});

describe("slp_checkpoint", () => {
  it("rotates a Lead to a fresh agent in the same workspace and retires the old identity", async () => {
    const r = await withLeadAndPlan();
    const res = await r.call(r.lead, "slp_checkpoint", { summary: "T1 next", pending_human: [], promises: ["ship by Friday"] });
    expect(res.text).toMatch(/replacement/);
    const fresh = r.paseo.created.at(-1)!;
    expect(String(fresh.prompt)).toContain("ship by Friday");
    expect(fresh).toMatchObject({ parent: "sup-1", cwd: r.lead.worktree, workspaceId: r.lead.workspaceId });
    expect(r.ctx.identities.byAgent(fresh.id)).toMatchObject({ role: "lead", worktree: r.lead.worktree, branch: "feat/cache" });
    expect(r.ctx.identities.byAgent(r.lead.agentId!)).toBeNull();
    expect(r.paseo.archived).toContain(r.lead.agentId);
  });
  it("rotates a Supervisor within its feature, in the project directory", async () => {
    const r = await withLeadAndPlan();
    expect((await r.call(r.sup, "slp_checkpoint", { summary: "waiting on T1", pending_human: ["ship later"], promises: [] })).text).toMatch(/replacement/);
    const fresh = r.paseo.created.at(-1)!;
    expect(fresh).toMatchObject({ cwd: r.repo, title: "[Supervisor] cache" });
    expect(r.ctx.identities.current("supervisor", "demo", "cache")?.agentId).toBe(fresh.id);
    expect(existsSync(join(r.ctx.stores.featureDir("demo", "cache"), "checkpoint-supervisor.md"))).toBe(true);
  });
});
