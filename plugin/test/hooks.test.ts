import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { onAgentArchived, onAgentClosed, onPermissionRequested, onPermissionResolved, onTurnEnded, onTurnStarted, reconcile, tick } from "../server/hooks";
import { deriveFeature } from "../server/store/derive";
import { bound, makeCtx, sh } from "./helpers";

function world(over: Record<string, unknown> = {}) {
  const w = makeCtx(over);
  const sup = bound(w.ctx, { role: "supervisor", project: "demo", feature: "cache", task: null, worktree: null, reviewCommit: null, parentAgentId: null }, "sup-1");
  const lead = bound(w.ctx, { role: "lead", project: "demo", feature: "cache", task: null, worktree: w.repo, reviewCommit: null, parentAgentId: "sup-1" }, "lead-1");
  const wt = join(w.home, "wt-T1"); sh(w.repo, "git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "slp/cache/T1-1", wt, "main"]);
  const peer = bound(w.ctx, { role: "peer-impl", project: "demo", feature: "cache", task: "T1", worktree: wt, reviewCommit: null, parentAgentId: "lead-1" }, "peer-1");
  const store = w.ctx.stores.feature("demo", "cache");
  store.append({ feature: "cache", kind: "plan", by_role: "lead", by_agent: "lead-1", data: { version: 1, sha256: "p", path: "p", tasks: [{ id: "T1", title: "t", dependsOn: [], verifies: [], touchSet: ["a.ts"], verify: "test -f a.ts" }] } });
  store.append({ feature: "cache", kind: "assign", by_role: "lead", by_agent: "lead-1", data: { task: "T1", agentId: "peer-1", worktree: wt, branch: "slp/cache/T1-1", base: "base", attempt: 1 } });
  return { ...w, sup, lead, peer, wt, store };
}
const done = { kind: "completed" as const };

describe("turn_ended", () => {
  it("records a human message to a Peer and tells its Lead", async () => {
    const w = world();
    w.paseo.timelines.set("peer-1", [{ type: "user_message", text: "đổi sang Redis đi", messageId: "h-1" }]);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.store.all().find((e) => e.kind === "human_message")!.data).toMatchObject({ agentId: "peer-1", text: "đổi sang Redis đi" });
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1" && s.text.includes("The human messaged Peer T1 directly"))).toBe(true);
  });
  it("records human messages to the Supervisor in the project store", async () => {
    const w = world();
    w.paseo.timelines.set("sup-1", [{ type: "user_message", text: "ok duyệt", messageId: "h-2" }]);
    await onTurnEnded(w.ctx, { agent: { id: "sup-1" }, outcome: done });
    expect(w.ctx.stores.project("demo").all().map((e) => e.kind)).toEqual(["human_message"]);
  });
  it("schedules a resume on a limit stop and skips the rest of the pipeline", async () => {
    const w = world();
    w.paseo.usage = { requestId: "r", fetchedAt: "", providers: [{ providerId: "claude", displayName: "Claude", status: "available", planLabel: null, windows: [{ id: "5h", label: "5h", usedPct: 100, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] }] };
    w.paseo.timelines.set("peer-1", [{ type: "assistant_message", text: "You've hit your usage limit · resets at 3pm" }]);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.ctx.resumes.jobs()).toHaveLength(1);
    expect(Date.parse(w.ctx.resumes.jobs()[0]!.at)).toBeGreaterThan(Date.now() + 3500_000);
    expect(w.store.all().some((e) => e.kind === "ops" && e.data.type === "limit_hit")).toBe(true);
    expect(w.paseo.sent.filter((s) => s.agentId === "peer-1")).toEqual([]);
  });
  it("counts resume attempts across resumes and tells the Supervisor once the cap is reached", async () => {
    const w = world({ limits: { resumeMaxAttempts: 1 } });
    const limited = { kind: "failed" as const, error: { message: "429 Too Many Requests" } };
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: limited });
    expect(w.ctx.resumes.due(new Date(Date.now() + 3 * 3600_000)).map((j) => j.attempt)).toEqual([1]);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: limited });
    await w.ctx.router.flush();
    expect(w.ctx.resumes.jobs()).toEqual([]);
    expect(w.paseo.sent.some((s) => s.agentId === "sup-1" && s.text.includes("still blocked"))).toBe(true);
  });
  it("commits and verifies after a reported turn and tells the Lead, with the Peer's status and report", async () => {
    const w = world();
    onTurnStarted(w.ctx, "peer-1");
    writeFileSync(join(w.wt, "a.ts"), "x");
    const reportPath = join(w.home, "T1-1.md"); writeFileSync(reportPath, "Added a.ts. Concern: the TTL may be too short under load.");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done_with_concerns", message: "add a", reportPath } });
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(deriveFeature("cache", w.store.all()).tasks.get("T1")).toMatchObject({ evidenceOk: true });
    const toLead = w.paseo.sent.find((s) => s.agentId === "lead-1" && /T1 committed [0-9a-f]{7}, verify exit 0/.test(s.text))!;
    expect(toLead.text).toContain("Peer status: done_with_concerns — add a");
    expect(toLead.text).toContain("the TTL may be too short under load");
  });
  it("sends a blocked report with no changes to the Lead, not back to the Peer", async () => {
    const w = world();
    onTurnStarted(w.ctx, "peer-1");
    const reportPath = join(w.home, "T1-1.md"); writeFileSync(reportPath, "Spec says TTL 60s, the contract says 300s. Which one?");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "blocked", message: "TTL conflict", reportPath } });
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    const toLead = w.paseo.sent.find((s) => s.agentId === "lead-1")!;
    expect(toLead.text).toContain("T1 is blocked; the Peer changed no files.");
    expect(toLead.text).toContain("the contract says 300s");
    expect(w.paseo.sent.filter((s) => s.agentId === "peer-1")).toEqual([]);
    expect(w.store.all().some((e) => e.kind === "ops" && e.data.type === "report_rejected")).toBe(false);
  });
  it("handles one agent's turn ends one at a time, so overlapping runs commit and verify once", async () => {
    const w = world();
    await onTurnStarted(w.ctx, "peer-1");
    writeFileSync(join(w.wt, "a.ts"), "x");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "add a" } });
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
    await Promise.all([onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done }), onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done })]);
    expect(w.store.all().filter((e) => e.kind === "commit")).toHaveLength(1);
    expect(w.store.all().filter((e) => e.kind === "evidence")).toHaveLength(1);
    expect(w.store.all().some((e) => e.kind === "ops" && e.data.type === "report_rejected")).toBe(false);
  });
  it("tells the Supervisor, not the Peer, when the sandbox runner is broken", async () => {
    const w = world({ sandbox: { runner: ["/nonexistent/runner"] } });
    await onTurnStarted(w.ctx, "peer-1");
    writeFileSync(join(w.wt, "a.ts"), "x");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "add a" } });
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.paseo.sent.some((s) => s.agentId === "sup-1" && s.text.includes("sandbox runner"))).toBe(true);
    expect(w.paseo.sent.filter((s) => s.agentId === "peer-1")).toEqual([]);
  });
  it("records a human message at turn start, before any tool runs", async () => {
    const w = world();
    w.paseo.timelines.set("sup-1", [{ type: "user_message", text: "ship đi", messageId: "h-9" }]);
    await onTurnStarted(w.ctx, "sup-1");
    expect(w.ctx.stores.project("demo").all().map((e) => e.data.text)).toEqual(["ship đi"]);
  });
  it("sends a failing verify back to the Peer", async () => {
    const w = world();
    onTurnStarted(w.ctx, "peer-1");
    writeFileSync(join(w.wt, "b.ts"), "x");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "add b" } });
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("Verify failed"))).toBe(true);
  });
  it("does not nudge a Peer whose turn the human canceled", async () => {
    const w = world();
    onTurnStarted(w.ctx, "peer-1");
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: { kind: "canceled" } });
    expect(w.paseo.sent).toEqual([]);
  });
  it("tells another feature's Supervisor when a commit touches files in that feature's touch set", async () => {
    const w = world();
    const supL = bound(w.ctx, { role: "supervisor", project: "demo", feature: "login", task: null, worktree: null, reviewCommit: null, parentAgentId: null }, "sup-2");
    w.paseo.statuses.set(supL.agentId!, "running");
    w.ctx.stores.feature("demo", "login").append({ feature: "login", kind: "plan", by_role: "lead", by_agent: "lead-2", data: { version: 1, sha256: "q", path: "q", tasks: [{ id: "T1", title: "t", dependsOn: [], verifies: [], touchSet: ["a.ts"], verify: "true" }] } });
    onTurnStarted(w.ctx, "peer-1");
    writeFileSync(join(w.wt, "a.ts"), "x");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "add a" } });
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.ctx.router.pending().some((p) => p.to.role === "supervisor" && p.to.feature === "login" && p.text.includes("cache T1 committed files in your touch set: a.ts"))).toBe(true);
  });
  it("nudges a Peer that ended without a report, then tells the Lead", async () => {
    const w = world();
    onTurnStarted(w.ctx, "peer-1");
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.paseo.sent.at(-1)).toMatchObject({ agentId: "peer-1", text: expect.stringContaining("without slp_report") });
    onTurnStarted(w.ctx, "peer-1");
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.paseo.sent.at(-1)).toMatchObject({ agentId: "lead-1", text: expect.stringContaining("stopped without reporting") });
  });
  it("invalidates a review that changed tracked files and retires the reviewer", async () => {
    const w = world();
    const rwt = join(w.home, "rev"); sh(w.repo, "git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "--detach", rwt, "main"]);
    bound(w.ctx, { role: "peer-review", project: "demo", feature: "cache", task: "T1", worktree: rwt, reviewCommit: "abc", parentAgentId: "lead-1" }, "rev-1");
    writeFileSync(join(rwt, "README.md"), "tampered");
    w.ctx.toolCalls.set("rev-1", Date.now() + 1);
    await onTurnEnded(w.ctx, { agent: { id: "rev-1" }, outcome: done });
    expect(w.store.all().some((e) => e.kind === "ops" && e.data.type === "review_invalidated" && e.data.commit === "abc")).toBe(true);
    expect(w.ctx.identities.byAgent("rev-1")).toBeNull();
    expect(w.paseo.archived).toContain("rev-1");
  });
  it("passes a review to the Lead only after the reviewer's turn ends with a clean worktree", async () => {
    const w = world();
    const rwt = join(w.home, "rev2"); sh(w.repo, "git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "--detach", rwt, "main"]);
    bound(w.ctx, { role: "peer-review", project: "demo", feature: "cache", task: "T1", worktree: rwt, reviewCommit: "abc", parentAgentId: "lead-1" }, "rev-2");
    w.store.append({ feature: "cache", kind: "review", by_role: "peer-review", by_agent: "rev-2", data: { task: "T1", commit: "abc", verdict: "pass", blocking: 0, findings: [] } });
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1")).toBe(false);
    w.ctx.toolCalls.set("rev-2", Date.now() + 1);
    await onTurnEnded(w.ctx, { agent: { id: "rev-2" }, outcome: done });
    expect(w.store.all().some((e) => e.kind === "ops" && e.data.type === "review_checked" && e.data.agentId === "rev-2")).toBe(true);
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1" && s.text.includes("Review of T1 @abc: pass"))).toBe(true);
  });
  it("asks a Lead to checkpoint once when its context passes the ratio", async () => {
    const w = world();
    w.paseo.usageOf.set("lead-1", { contextWindowUsedTokens: 130_000, contextWindowMaxTokens: 200_000 });
    await onTurnEnded(w.ctx, { agent: { id: "lead-1" }, outcome: done });
    await onTurnEnded(w.ctx, { agent: { id: "lead-1" }, outcome: done });
    expect(w.paseo.sent.filter((s) => s.agentId === "lead-1" && s.text.includes("slp_checkpoint"))).toHaveLength(1);
  });
  it("ignores agents that are not SLP roles", async () => {
    const w = world();
    await onTurnEnded(w.ctx, { agent: { id: "stranger" }, outcome: done });
    expect(w.paseo.sent).toEqual([]);
  });
});

describe("permissions, archive, tick", () => {
  it("denies reserved commands and state-dir access, allows a Claude Peer's sandboxed shell, and leaves outside reads to the human", async () => {
    const w = world();
    await onPermissionRequested(w.ctx, "peer-1", { id: "r1", name: "Bash", input: { command: "git push" } });
    await onPermissionRequested(w.ctx, "peer-1", { id: "r2", name: "Read", input: { file_path: join(w.home, "identities.json") } });
    await onPermissionRequested(w.ctx, "peer-1", { id: "r3", name: "Bash", input: { command: "make bench" } });
    await onPermissionRequested(w.ctx, "peer-1", { id: "r4", name: "Read", input: { file_path: "/etc/hosts" } });
    await w.ctx.router.flush();
    expect(w.paseo.responses.map((r) => `${r.requestId}:${r.behavior}`)).toEqual(["r1:deny", "r2:deny", "r3:allow"]);
    expect(w.ctx.pendingPermissions.get("peer-1")?.name).toBe("Read");
    expect(w.paseo.sent).toEqual([]);
  });
  it("retires the identity of an archived agent", () => {
    const w = world();
    onAgentArchived(w.ctx, "sup-1");
    expect(w.ctx.identities.byAgent("sup-1")).toBeNull();
  });
  it("records a permission left to the human until it is resolved", async () => {
    const w = world();
    await onPermissionRequested(w.ctx, "peer-1", { id: "r3", name: "Read", input: { file_path: "/etc/hosts" } });
    expect(w.ctx.pendingPermissions.get("peer-1")?.name).toBe("Read");
    onPermissionResolved(w.ctx, "peer-1");
    expect(w.ctx.pendingPermissions.has("peer-1")).toBe(false);
  });
  it("retires agents the daemon lost, freeing their writer slot, and tells the parent role", async () => {
    const w = world();
    w.paseo.gone.add("peer-1");
    await reconcile(w.ctx);
    expect(w.ctx.identities.byAgent("peer-1")).toBeNull();
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1" && s.text.includes("peer-impl T1 is gone"))).toBe(true);
    w.paseo.statuses.set("lead-1", "closed");
    onAgentClosed(w.ctx, "lead-1");
    expect(w.ctx.identities.byAgent("lead-1")).toBeNull();
    await w.ctx.router.flush();
    expect(w.paseo.sent.some((s) => s.agentId === "sup-1" && s.text.includes("lead of cache is gone"))).toBe(true);
  });
  it("leaves a Peer that waits for a resume alone on reconcile, so its old limit reply does not burn an attempt", async () => {
    const w = world({ limits: { resumeMaxAttempts: 1 } });
    w.ctx.resumes.schedule({ agentId: "peer-1", vendor: "claude", at: new Date(Date.now() + 3600_000).toISOString(), attempt: 1 });
    w.paseo.timelines.set("peer-1", [{ type: "assistant_message", text: "You've hit your usage limit · resets at 3pm" }]);
    w.paseo.statuses.set("peer-1", "idle");
    await reconcile(w.ctx);
    await reconcile(w.ctx);
    expect(w.ctx.resumes.jobs().map((j) => [j.agentId, j.attempt])).toEqual([["peer-1", 1]]);
    expect(w.paseo.sent.some((s) => s.text.includes("still blocked"))).toBe(false);
  });
  it("delivers due resumes and nudges the Lead about unanswered challenges", async () => {
    const w = world();
    w.ctx.resumes.schedule({ agentId: "peer-1", vendor: "claude", at: new Date(Date.now() - 1000).toISOString(), attempt: 1 });
    w.store.append({ feature: "cache", kind: "challenge", by_role: "peer-impl", by_agent: "peer-1", idPrefix: "C", data: { target: "T1", level: "plan" } }, new Date(Date.now() - 31 * 60_000));
    await tick(w.ctx);
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("usage limit has reset"))).toBe(true);
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1" && s.text.includes("C1 has waited"))).toBe(true);
  });
  it("never sends a resume into a running turn, and drops it when the agent starts working again", async () => {
    const w = world();
    w.ctx.resumes.schedule({ agentId: "peer-1", vendor: "claude", at: new Date(Date.now() - 1000).toISOString(), attempt: 1 });
    w.paseo.statuses.set("peer-1", "running");
    await tick(w.ctx);
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("usage limit has reset"))).toBe(false);
    expect(w.ctx.resumes.jobs()).toEqual([]);
    w.ctx.resumes.schedule({ agentId: "lead-1", vendor: "claude", at: new Date(Date.now() + 3600_000).toISOString(), attempt: 2 });
    await onTurnStarted(w.ctx, "lead-1");
    expect(w.ctx.resumes.jobs()).toEqual([]);
    expect(w.ctx.resumes.attemptOf("lead-1")).toBe(2);
  });
  it("runs one tick at a time, so a resume is sent once even when ticks overlap", async () => {
    const w = world();
    w.ctx.resumes.schedule({ agentId: "peer-1", vendor: "claude", at: new Date(Date.now() - 1000).toISOString(), attempt: 1 });
    await Promise.all([tick(w.ctx), tick(w.ctx)]);
    expect(w.paseo.sent.filter((s) => s.agentId === "peer-1" && s.text.includes("usage limit has reset"))).toHaveLength(1);
  });
  it("does not let one failing resume hold back the others", async () => {
    const w = world();
    const past = new Date(Date.now() - 1000).toISOString();
    w.ctx.resumes.schedule({ agentId: "peer-1", vendor: "claude", at: new Date(Date.now() - 2000).toISOString(), attempt: 1 });
    w.ctx.resumes.schedule({ agentId: "lead-1", vendor: "claude", at: past, attempt: 1 });
    w.paseo.failSend.add("peer-1");
    await tick(w.ctx);
    await tick(w.ctx);
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1" && s.text.includes("usage limit has reset"))).toBe(true);
    expect(w.ctx.resumes.jobs().map((j) => j.agentId)).toEqual(["peer-1"]);
  });
  it("keeps a resume whose send failed and delivers it on a later tick", async () => {
    const w = world();
    w.ctx.resumes.schedule({ agentId: "peer-1", vendor: "claude", at: new Date(Date.now() - 1000).toISOString(), attempt: 1 });
    w.paseo.failSend.add("peer-1");
    await tick(w.ctx);
    expect(w.ctx.resumes.jobs().map((j) => j.agentId)).toEqual(["peer-1"]);
    w.paseo.failSend.delete("peer-1");
    w.ctx.resumes.schedule({ ...w.ctx.resumes.jobs()[0]!, at: new Date(Date.now() - 1000).toISOString() }); // the minute of back-off has passed
    await tick(w.ctx);
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("usage limit has reset"))).toBe(true);
    expect(w.ctx.resumes.jobs()).toEqual([]);
    expect(w.ctx.resumes.attemptOf("peer-1")).toBe(1);
  });
  it("nudges about an overdue C1 in each feature, not only the first", async () => {
    const w = world();
    bound(w.ctx, { role: "lead", project: "demo", feature: "login", task: null, worktree: w.repo, reviewCommit: null, parentAgentId: null }, "lead-2");
    const old = new Date(Date.now() - 31 * 60_000);
    for (const f of ["cache", "login"]) w.ctx.stores.feature("demo", f).append({ feature: f, kind: "challenge", by_role: "peer-impl", by_agent: "p", idPrefix: "C", data: { target: "T1", level: "plan" } }, old);
    await tick(w.ctx);
    expect(w.paseo.sent.filter((s) => s.text.includes("C1 has waited")).map((s) => s.agentId).sort()).toEqual(["lead-1", "lead-2"]);
  });
});

describe("tick with a corrupt feature log", () => {
  it("still nudges the other features and flushes the router", async () => {
    const w = world();
    const logs: string[] = []; w.ctx.log = (m) => { logs.push(m); };
    const bad = w.ctx.stores.featureDir("demo", "aaa"); mkdirSync(bad, { recursive: true }); // sorts before "cache"
    writeFileSync(join(bad, "events.jsonl"), "not json\n");
    w.store.append({ feature: "cache", kind: "challenge", by_role: "peer-impl", by_agent: "peer-1", idPrefix: "C", data: { target: "T1", level: "plan" } }, new Date(Date.now() - 31 * 60_000));
    await tick(w.ctx);
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1" && s.text.includes("C1 has waited"))).toBe(true);
    expect(logs.some((m) => m.includes("demo/aaa"))).toBe(true);
  });
});

describe("reconcile after a restart", () => {
  it("opens every feature store, so a torn last line is logged even when no agent is left", async () => {
    const w = makeCtx();
    const dir = w.ctx.stores.featureDir("demo", "cache"); mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    appendFileSync(file, '{"seq":1,"ts":"2026'); // the plugin died mid-append
    await reconcile(w.ctx);
    // Read the file, not the store: asking the registry would open the store and log the cut itself.
    expect(readFileSync(file, "utf8")).toContain('"type":"log_truncated"');
    expect(w.ctx.stores.feature("demo", "cache").all().some((e) => e.kind === "ops" && e.data.type === "log_truncated")).toBe(true);
  });
  it("opens the other feature stores even when one feature's log is corrupt", async () => {
    const w = makeCtx();
    const logs: string[] = []; w.ctx.log = (m) => { logs.push(m); };
    const bad = w.ctx.stores.featureDir("demo", "aaa"); mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "events.jsonl"), "not json\n");
    const torn = w.ctx.stores.featureDir("demo", "bbb"); mkdirSync(torn, { recursive: true });
    appendFileSync(join(torn, "events.jsonl"), '{"seq":1,"ts":"2026');
    await expect(reconcile(w.ctx)).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes("demo/aaa"))).toBe(true);
    expect(readFileSync(join(torn, "events.jsonl"), "utf8")).toContain('"type":"log_truncated"');
    expect(w.ctx.stores.project("demo").all().some((e) => e.kind === "ops" && e.data.type === "reconcile")).toBe(true);
  });
  it("keeps reconciling the other agents when one agent's reconcile throws", async () => {
    const w = world();
    const logs: string[] = []; w.ctx.log = (m) => { logs.push(m); };
    writeFileSync(join(w.wt, "a.ts"), "x");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "add a" } });
    rmSync(w.wt, { recursive: true, force: true }); // the first Peer's worktree is gone
    bound(w.ctx, { role: "supervisor", project: "demo", feature: "login", task: null, worktree: null, reviewCommit: null, parentAgentId: null }, "sup-2");
    bound(w.ctx, { role: "lead", project: "demo", feature: "login", task: null, worktree: w.repo, reviewCommit: null, parentAgentId: "sup-2" }, "lead-2");
    const wt2 = join(w.home, "wt-login-T1"); sh(w.repo, "git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "slp/login/T1-1", wt2, "main"]);
    bound(w.ctx, { role: "peer-impl", project: "demo", feature: "login", task: "T1", worktree: wt2, reviewCommit: null, parentAgentId: "lead-2" }, "peer-2");
    const login = w.ctx.stores.feature("demo", "login");
    login.append({ feature: "login", kind: "plan", by_role: "lead", by_agent: "lead-2", data: { version: 1, sha256: "q", path: "q", tasks: [{ id: "T1", title: "t", dependsOn: [], verifies: [], touchSet: ["b.ts"], verify: "test -f b.ts" }] } });
    login.append({ feature: "login", kind: "assign", by_role: "lead", by_agent: "lead-2", data: { task: "T1", agentId: "peer-2", worktree: wt2, branch: "slp/login/T1-1", base: "base", attempt: 1 } });
    writeFileSync(join(wt2, "b.ts"), "y");
    login.append({ feature: "login", kind: "report", by_role: "peer-impl", by_agent: "peer-2", data: { task: "T1", status: "done", message: "add b" } });
    await expect(reconcile(w.ctx)).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes("reconcile of peer-impl peer-1 failed"))).toBe(true);
    expect(login.all().some((e) => e.kind === "commit")).toBe(true);
    expect(w.ctx.stores.project("demo").all().some((e) => e.kind === "ops" && e.data.type === "reconcile")).toBe(true);
  });
  it("does not nudge an idle Peer for a missing report after a restart, and keeps its nudge budget", async () => {
    const w = world(); // fresh ctx maps: toolCalls and turnStarts are empty, as after a restart
    await reconcile(w.ctx);
    expect(w.paseo.sent.filter((s) => s.agentId === "peer-1")).toEqual([]);
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1")).toBe(false);
    await onTurnStarted(w.ctx, "peer-1");
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(w.paseo.sent.at(-1)).toMatchObject({ agentId: "peer-1", text: expect.stringContaining("without slp_report") });
  });
});

describe("messages to SLP agents go through the router", () => {
  function reportFailingVerify(w: ReturnType<typeof world>) {
    onTurnStarted(w.ctx, "peer-1");
    writeFileSync(join(w.wt, "b.ts"), "x"); // verify wants a.ts
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "add b" } });
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
  }
  const heldFor = (w: ReturnType<typeof world>, agentId: string, role: string, needle: string) => ({
    sentNow: w.paseo.sent.filter((s) => s.agentId === agentId),
    pending: w.ctx.router.pending().some((p) => p.to.role === role && p.text.startsWith("[SLP plugin] ") && p.text.includes(needle)),
  });
  it("holds a failing-verify message for a Peer that is running again, then delivers it when idle", async () => {
    const w = world();
    reportFailingVerify(w);
    w.paseo.statuses.set("peer-1", "running");
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(heldFor(w, "peer-1", "peer-impl", "Verify failed")).toEqual({ sentNow: [], pending: true });
    w.paseo.statuses.set("peer-1", "idle");
    await w.ctx.router.flush();
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("Verify failed"))).toBe(true);
    expect(w.ctx.router.pending()).toEqual([]);
  });
  it("holds a rejected-report message for a Peer that is running again", async () => {
    const w = world();
    onTurnStarted(w.ctx, "peer-1");
    w.store.append({ feature: "cache", kind: "report", by_role: "peer-impl", by_agent: "peer-1", data: { task: "T1", status: "done", message: "nothing" } }); // no changes: rejected
    w.ctx.toolCalls.set("peer-1", Date.now() + 1);
    w.paseo.statuses.set("peer-1", "running");
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(heldFor(w, "peer-1", "peer-impl", "was not committed")).toEqual({ sentNow: [], pending: true });
    w.paseo.statuses.set("peer-1", "idle");
    await w.ctx.router.flush();
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("was not committed"))).toBe(true);
  });
  it("holds the no-report nudge for a Peer that is running again", async () => {
    const w = world();
    onTurnStarted(w.ctx, "peer-1");
    w.paseo.statuses.set("peer-1", "running");
    await onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done });
    expect(heldFor(w, "peer-1", "peer-impl", "without slp_report")).toEqual({ sentNow: [], pending: true });
    w.paseo.statuses.set("peer-1", "idle");
    await w.ctx.router.flush();
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("without slp_report"))).toBe(true);
  });
  it("holds the checkpoint request for a Lead that is running again", async () => {
    const w = world();
    w.paseo.usageOf.set("lead-1", { contextWindowUsedTokens: 130_000, contextWindowMaxTokens: 200_000 });
    w.paseo.statuses.set("lead-1", "running");
    await onTurnEnded(w.ctx, { agent: { id: "lead-1" }, outcome: done });
    expect(heldFor(w, "lead-1", "lead", "slp_checkpoint")).toEqual({ sentNow: [], pending: true });
    w.paseo.statuses.set("lead-1", "idle");
    await w.ctx.router.flush();
    expect(w.paseo.sent.filter((s) => s.agentId === "lead-1" && s.text.includes("slp_checkpoint"))).toHaveLength(1);
  });
  it("still tells the Lead and the Peer when the touch-set alert cannot read a sibling feature's log", async () => {
    const w = world();
    const dir = w.ctx.stores.featureDir("demo", "login"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "not json\n"); // a corrupt sibling log makes featuresTouching throw
    reportFailingVerify(w);
    await expect(onTurnEnded(w.ctx, { agent: { id: "peer-1" }, outcome: done })).resolves.toBeUndefined();
    expect(w.paseo.sent.some((s) => s.agentId === "lead-1" && /T1 committed [0-9a-f]{7}, verify exit non-zero/.test(s.text))).toBe(true);
    expect(w.paseo.sent.some((s) => s.agentId === "peer-1" && s.text.includes("Verify failed"))).toBe(true);
  });
});
