import { describe, expect, it } from "vitest";
import type { SlpEvent } from "../server/store/events";
import { acceptanceBlockers, deriveFeature, type PlanTask } from "../server/store/derive";

let seq = 0;
function ev(kind: SlpEvent["kind"], data: Record<string, unknown> = {}, extra: Partial<SlpEvent> = {}): SlpEvent {
  seq += 1;
  return { seq, ts: new Date(Date.UTC(2026, 9, 22, 0, seq)).toISOString(), feature: "f", kind, id: null, by_role: "lead", by_agent: "lead-1", refs: [], supersedes: null, data, ...extra };
}
const task = (id: string, dependsOn: string[] = [], verifies: string[] = []): PlanTask => ({ id, title: id, dependsOn, verifies, touchSet: ["src/"], verify: "npm test" });
const premise = (id: string, kind: "decision" | "hypothesis", by: SlpEvent["by_role"] = "supervisor") => ev("premise", { kind, title: id }, { id, by_role: by });
const accepted = (t: string, commit: string) => [
  ev("assign", { task: t, agentId: `p-${t}`, worktree: `/w/${t}`, branch: `b/${t}`, base: "base", attempt: 1 }),
  ev("report", { task: t, status: "done", message: "m" }, { by_role: "peer-impl" }),
  ev("commit", { task: t, hash: commit }, { by_role: "plugin" }),
  ev("evidence", { scope: "task", task: t, commit, exitCode: 0, timedOut: false }, { by_role: "plugin" }),
  ev("review", { task: t, commit, blocking: 0, verdict: "pass" }, { by_role: "peer-review", by_agent: `r-${t}` }),
  ev("ops", { type: "review_checked", task: t, commit, agentId: `r-${t}` }, { by_role: "plugin" }),
  ev("release", { task: t, outcome: "accepted" }),
];

describe("deriveFeature", () => {
  it("activates the replacement the human chose in a supersede at once", () => {
    const st = deriveFeature("f", [premise("D1", "decision"), ev("spec", { version: 1, sha256: "s1", path: "p", premises: ["D1"] }), ev("human_decision", { decides: "approve_spec", target: "s1" }, { by_role: "supervisor" }),
      premise("D2", "decision"), ev("supersede", {}, { supersedes: "D1", refs: ["D2"], by_role: "supervisor" })]);
    expect(st.premises.get("D2")?.status).toBe("active");
  });
  it("tracks premise statuses, including lead proposals activated by spec approval", () => {
    const events = [premise("D1", "decision"), premise("H1", "hypothesis"), premise("D2", "decision", "lead"), ev("spec", { version: 1, sha256: "s1", path: "p", premises: ["D1", "H1", "D2"] }),
      ev("human_decision", { decides: "approve_spec", target: "s1" }, { by_role: "supervisor" })];
    const st = deriveFeature("f", events);
    expect(st.premises.get("D1")?.status).toBe("active");
    expect(st.premises.get("H1")?.status).toBe("open");
    expect(st.premises.get("D2")?.status).toBe("active");
    expect(deriveFeature("f", events.slice(0, 4)).premises.get("D1")?.status).toBe("proposed");
    expect(deriveFeature("f", events.slice(0, 4)).premises.get("D2")?.status).toBe("proposed");
  });
  it("does not activate a premise proposed with a spec version that was dropped", () => {
    const events = [premise("D2", "decision", "lead"), ev("spec", { version: 1, sha256: "s1", path: "p", premises: ["D2"] }),
      premise("D3", "decision", "lead"), ev("spec", { version: 2, sha256: "s2", path: "p", premises: ["D3"] }),
      ev("human_decision", { decides: "approve_spec", target: "s2" }, { by_role: "supervisor" })];
    const st = deriveFeature("f", events);
    expect(st.premises.get("D2")?.status).toBe("proposed");
    expect(st.premises.get("D3")?.status).toBe("active");
  });

  it("marks accepted work stale when a premise it depends on is superseded later, directly or via a task", () => {
    const events = [premise("D1", "decision"), ev("spec", { version: 1, sha256: "s1", path: "p", premises: ["D1"] }), ev("human_decision", { decides: "approve_spec", target: "s1" }, { by_role: "supervisor" }),
      ev("plan", { version: 1, sha256: "p1", path: "p", tasks: [task("T1", ["D1"]), task("T2", ["T1"]), task("T3")] }),
      ...accepted("T1", "c1"), ...accepted("T2", "c2"), ...accepted("T3", "c3"),
      premise("D2", "decision"), ev("supersede", {}, { supersedes: "D1", refs: ["D2"], by_role: "supervisor" })];
    const st = deriveFeature("f", events);
    expect(st.premises.get("D1")).toMatchObject({ status: "superseded", supersededBy: "D2" });
    expect(st.tasks.get("T1")?.status).toBe("stale");
    expect(st.tasks.get("T2")?.status).toBe("stale");
    expect(st.tasks.get("T3")?.status).toBe("accepted");
  });

  it("does not mark work stale when it was accepted after the supersede", () => {
    const events = [premise("D1", "decision"), premise("D2", "decision"), ev("supersede", {}, { supersedes: "D1", refs: ["D2"] }),
      ev("plan", { version: 1, sha256: "p1", path: "p", tasks: [task("T1", ["D1"])] }), ...accepted("T1", "c1")];
    expect(deriveFeature("f", events).tasks.get("T1")?.status).toBe("accepted");
  });

  it("confirms a hypothesis and keeps dependent work accepted", () => {
    const events = [premise("H1", "hypothesis"), ev("spec", { version: 1, sha256: "s1", path: "p", premises: ["H1"] }), ev("human_decision", { decides: "approve_spec", target: "s1" }, { by_role: "supervisor" }),
      ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1", [], ["H1"]), task("T2", ["H1"])] }),
      ...accepted("T2", "c2"), ev("confirms", { evidence: "x" }, { refs: ["H1"] })];
    const st = deriveFeature("f", events);
    expect(st.premises.get("H1")?.status).toBe("confirmed");
    expect(st.tasks.get("T2")?.status).toBe("accepted");
  });

  it("parks unaccepted work behind an open spec-level challenge and unparks on resolution", () => {
    const open = [premise("D1", "decision"), ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1", ["D1"]), task("T2")] }),
      ev("challenge", { target: "D1", level: "spec", claim: "c" }, { id: "C1", by_role: "lead" })];
    let st = deriveFeature("f", open);
    expect(st.tasks.get("T1")?.status).toBe("parked");
    expect(st.tasks.get("T2")?.status).toBe("pending");
    st = deriveFeature("f", [...open, ev("challenge_resolved", { outcome: "rejected" }, { refs: ["C1"] })]);
    expect(st.tasks.get("T1")?.status).toBe("pending");
    const contract = [ev("plan", { version: 1, sha256: "p", path: "p", tasks: [{ ...task("T1"), touchSet: ["contract:auth-api"] }, task("T2")] }),
      ev("challenge", { target: "contract:auth-api", level: "spec", claim: "c" }, { id: "C1", by_role: "peer-impl" })];
    expect(deriveFeature("f", contract).tasks.get("T1")?.status).toBe("parked");
    expect(deriveFeature("f", contract).tasks.get("T2")?.status).toBe("pending");
  });

  it("drops tasks named by a ruling", () => {
    const events = [ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1")] }), ev("ruling", { decision: "d", drop: ["T1"] }, { id: "R1" })];
    expect(deriveFeature("f", events).tasks.get("T1")?.status).toBe("dropped");
  });

  it("ties evidence and review to the latest commit and honors review invalidation", () => {
    const events = [ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1")] }),
      ev("assign", { task: "T1", agentId: "p1", worktree: "/w", branch: "b", base: "base", attempt: 1 }),
      ev("commit", { task: "T1", hash: "old" }, { by_role: "plugin" }),
      ev("evidence", { scope: "task", task: "T1", commit: "old", exitCode: 0, timedOut: false }, { by_role: "plugin" }),
      ev("commit", { task: "T1", hash: "new" }, { by_role: "plugin" })];
    let t = deriveFeature("f", events).tasks.get("T1")!;
    expect(t).toMatchObject({ lastCommit: "new", evidenceOk: false });
    const more = [...events, ev("evidence", { scope: "task", task: "T1", commit: "new", exitCode: 0, timedOut: false }, { by_role: "plugin" }),
      ev("review", { task: "T1", commit: "new", blocking: 0, verdict: "pass" }, { by_role: "peer-review", by_agent: "r1" })];
    t = deriveFeature("f", more).tasks.get("T1")!;
    expect(t).toMatchObject({ evidenceOk: true, reviewOk: false });
    const checked = [...more, ev("ops", { type: "review_checked", task: "T1", commit: "new", agentId: "r1" }, { by_role: "plugin" })];
    expect(deriveFeature("f", checked).tasks.get("T1")!.reviewOk).toBe(true);
    t = deriveFeature("f", [...checked, ev("ops", { type: "review_invalidated", task: "T1", commit: "new" }, { by_role: "plugin" })]).tasks.get("T1")!;
    expect(t.reviewOk).toBe(false);
  });
  it("never counts a failing verdict, a dirty verify, or an unchecked review", () => {
    const base = [ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1")] }),
      ev("assign", { task: "T1", agentId: "p1", worktree: "/w", branch: "b", base: "base", attempt: 1 }), ev("commit", { task: "T1", hash: "c" }, { by_role: "plugin" })];
    const failNoFindings = [...base, ev("review", { task: "T1", commit: "c", blocking: 0, verdict: "fail" }, { by_role: "peer-review", by_agent: "r1" }), ev("ops", { type: "review_checked", task: "T1", commit: "c", agentId: "r1" }, { by_role: "plugin" })];
    expect(deriveFeature("f", failNoFindings).tasks.get("T1")!.reviewOk).toBe(false);
    const dirty = [...base, ev("evidence", { scope: "task", task: "T1", commit: "c", exitCode: 0, timedOut: false, dirty: ["src.ts"] }, { by_role: "plugin" })];
    expect(deriveFeature("f", dirty).tasks.get("T1")!.evidenceOk).toBe(false);
  });
  it("ties evidence to the task definition, keeps a delivery across a takeover, and spreads staleness to dependents", () => {
    const def = { verify: "npm test", touchSet: ["src/"], dependsOn: [], verifies: [] };
    const base = [ev("plan", { version: 1, sha256: "p1", path: "p", tasks: [task("T1")] }),
      ev("assign", { task: "T1", agentId: "p1", worktree: "/w", branch: "b", base: "base", attempt: 1 }), ev("commit", { task: "T1", hash: "c1" }, { by_role: "plugin" }),
      ev("evidence", { scope: "task", task: "T1", commit: "c1", exitCode: 0, timedOut: false, dirty: [], def }, { by_role: "plugin" })];
    expect(deriveFeature("f", base).tasks.get("T1")!.evidenceOk).toBe(true);
    const changed = [...base, ev("plan", { version: 2, sha256: "p2", path: "p", tasks: [{ ...task("T1"), verify: "npm run strict" }] })];
    expect(deriveFeature("f", changed).tasks.get("T1")!.evidenceOk).toBe(false);
    const defB = { ...def, verify: "npm run strict" };
    const back = [...changed, ev("evidence", { scope: "task", task: "T1", commit: "c1", exitCode: 1, timedOut: false, dirty: [], def: defB }, { by_role: "plugin" }),
      ev("plan", { version: 3, sha256: "p3", path: "p", tasks: [task("T1")] })];
    expect(deriveFeature("f", back).tasks.get("T1")!.evidenceOk).toBe(true); // A → B → A: A's green evidence counts again
    const taken = [...base, ev("assign", { task: "T1", agentId: "p2", takeover: true }), ev("report", { task: "T1", status: "done", message: "m" }, { by_role: "peer-impl" })];
    expect(deriveFeature("f", taken).tasks.get("T1")).toMatchObject({ agentId: "p2", lastCommit: "c1", evidenceOk: true, status: "reported" });
    const two = [ev("plan", { version: 1, sha256: "p1", path: "p", tasks: [task("T1"), task("T2", ["T1"])] }),
      ...accepted("T1", "c1").slice(0, -1), ev("release", { task: "T1", outcome: "accepted", def }), ...accepted("T2", "c2")];
    const v2 = [...two, ev("plan", { version: 2, sha256: "p2", path: "p", tasks: [{ ...task("T1"), verify: "npm run strict" }, task("T2", ["T1"])] })];
    expect(deriveFeature("f", v2).tasks.get("T2")!.status).toBe("stale");
    expect(deriveFeature("f", two).tasks.get("T2")!.status).toBe("accepted");
  });
  it("marks accepted work stale when a later plan changes what the task promises", () => {
    const def = { verify: "npm test", touchSet: ["src/"], dependsOn: [], verifies: [] };
    const acc = [...accepted("T1", "c1").slice(0, -1), ev("release", { task: "T1", outcome: "accepted", def })];
    const v1 = [ev("plan", { version: 1, sha256: "p1", path: "p", tasks: [task("T1")] }), ...acc];
    expect(deriveFeature("f", v1).tasks.get("T1")!.status).toBe("accepted");
    const v2 = [...v1, ev("plan", { version: 2, sha256: "p2", path: "p", tasks: [{ ...task("T1"), verify: "npm test -- --strict" }] })];
    expect(deriveFeature("f", v2).tasks.get("T1")!.status).toBe("stale");
    const v3 = [...v1, ev("plan", { version: 3, sha256: "p3", path: "p", tasks: [{ ...task("T1"), title: "renamed" }] })];
    expect(deriveFeature("f", v3).tasks.get("T1")!.status).toBe("accepted");
  });

  it("flags reopened work and lists what waits on the human", () => {
    const events = [ev("brief", { version: 1, sha256: "b1", path: "p" }, { by_role: "supervisor" }), ev("spec", { version: 1, sha256: "s1", path: "p" }),
      ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1")] }), ...accepted("T1", "c1"),
      ev("assign", { task: "T1", agentId: "p2", worktree: "/w2", branch: "b2", base: "c1", attempt: 2 }),
      ev("challenge", { target: "D9", level: "spec" }, { id: "C1", by_role: "supervisor" }),
      ev("ship_package", { commit: "abcdef123" }, { by_role: "supervisor" })];
    const st = deriveFeature("f", events);
    expect(st.tasks.get("T1")).toMatchObject({ status: "assigned", reopened: true, attempt: 2 });
    expect(st.waitingOnHuman).toEqual(["approve spec v1", "decide C1 on D9", "approve ship abcdef1"]);
  });
});

describe("acceptanceBlockers", () => {
  it("requires every task accepted, no open challenge, and green full-suite evidence on head", () => {
    const approvedDocs = [ev("brief", { version: 1, sha256: "b", path: "p" }, { by_role: "supervisor" }),
      ev("spec", { version: 1, sha256: "s", path: "p" }), ev("human_decision", { decides: "approve_spec", target: "s" }, { by_role: "supervisor" })];
    const events = [...approvedDocs, ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1"), task("T2")] }), ev("plan_approved", { sha256: "p" }, { by_role: "supervisor" }), ...accepted("T1", "c1"),
      ev("challenge", { target: "T1", level: "plan" }, { id: "C1", by_role: "peer-impl" })];
    const st = deriveFeature("f", events);
    expect(acceptanceBlockers(st, events, "head1")).toEqual(["T2 is pending", "C1 is open", "no green full-suite evidence on head1"]);
    const dropped = [...events, ev("plan", { version: 2, sha256: "p2", path: "p", tasks: [task("T1")] })];
    expect(acceptanceBlockers(deriveFeature("f", dropped), dropped, "head1")).toContain("plan v2 is not approved");
    const done = [...events, ...accepted("T2", "c2"), ev("challenge_resolved", { outcome: "rejected" }, { refs: ["C1"] }),
      ev("evidence", { scope: "feature", commit: "head1", exitCode: 0, timedOut: false }, { by_role: "plugin" })];
    expect(acceptanceBlockers(deriveFeature("f", done), done, "head1")).toEqual([]);
  });
});

describe("watch results", () => {
  it("keeps the latest watch result", () => {
    const events = [ev("watch_result", { tick: 1, verdicts: [] }, { by_role: "supervisor" }), ev("watch_result", { tick: 2, verdicts: [{ agent: "T1", verdict: "watch", note: "slow" }] }, { by_role: "supervisor" })];
    expect(deriveFeature("f", events).lastWatch).toMatchObject({ tick: 2, verdicts: [{ agent: "T1", verdict: "watch" }] });
    expect(deriveFeature("f", []).lastWatch).toBeNull();
  });
});
