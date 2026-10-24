import { describe, expect, it } from "vitest";
import type { Identity } from "../server/identity";
import { leadKickoff, promptFor, reviewBrief, taskBrief } from "../server/prompts";
import type { PremiseState, TaskState } from "../server/store/derive";

const ident = (role: Identity["role"], extra: Partial<Identity> = {}): Identity =>
  ({ tokenHash: "t", role, project: "demo", feature: "cache", task: "T4", worktree: "/w/T4", workspaceId: null, branch: null, reviewCommit: "abc1234", agentId: "a", parentAgentId: null, createdAt: "", retiredAt: null, ...extra });
const task: TaskState = { id: "T4", title: "Cache results", dependsOn: ["D2", "H1"], verifies: [], touchSet: ["src/cache/"], verify: "npm test -- cache", status: "assigned", closure: ["D2", "H1"], agentId: "a", worktree: "/w/T4", branch: "b", base: "c", attempt: 1, lastCommit: "abc1234", evidenceOk: true, reviewOk: false, reopened: false, acceptedAtSeq: null };
const premises = new Map<string, PremiseState>([
  ["D2", { id: "D2", kind: "decision", title: "Redis is available", status: "active", supersededBy: null, supersededAtSeq: null, seq: 1, byRole: "supervisor" }],
  ["H1", { id: "H1", kind: "hypothesis", title: "p95 under 50ms", status: "open", supersededBy: null, supersededAtSeq: null, seq: 2, byRole: "supervisor" }],
]);

describe("role prompts", () => {
  it("starts the Lead as a consultant to the Supervisor's brainstorm", () => {
    expect(leadKickoff("cache", "# B", "q?")).toContain("called in by the Supervisor while it brainstorms");
  });
  it("tells Peers that a reply after their report needs no new report (T21 B-7)", () => {
    expect(promptFor(ident("peer-impl"), { task })).toContain("After your report, a turn that changes no file needs no tool");
    expect(promptFor(ident("peer-review"), { task })).toContain("Once your review is in, answer questions without a new slp_review");
  });
  it("every role shares the common rules", () => {
    for (const role of ["supervisor", "lead", "peer-impl", "peer-review"] as const) {
      const p = promptFor(ident(role, role === "supervisor" ? { feature: null } : {}), { task });
      expect(p).toContain("slp_* tools");
      expect(p).toContain("Challenging is a right, not a duty");
      expect(p).toContain("in the language of their latest message");
    }
  });
  it("supervisor prompt keeps to one feature, answers the watch pack, and never approves for the human", () => {
    const p = promptFor(ident("supervisor", { feature: null }), {});
    expect(p).not.toContain("Speak Vietnamese");
    expect(p).toContain("walk the human through the spec in their language");
    expect(p).toContain("a table of example inputs and results");
    expect(p).toContain("a premise you leave out is dropped");
    expect(p).toContain('"On approval" line');
    expect(p).toContain("exactly one feature");
    expect(p).toContain("[SLP watch #n]");
    expect(p).toContain("slp_watch_result");
    expect(p).toContain("You never message Peers");
    expect(p).toContain("never approve anything on the human's behalf");
    expect(p).toContain("slp_checkpoint");
    expect(promptFor(ident("supervisor"), {})).toContain("feature cache");
    expect(p).toContain("one open question");
    expect(p).toContain("observation gap, not a violation");
    expect(p).toContain("An acknowledgment does not close an item");
    expect(p).toContain("smallest working path");
    expect(p).toContain("an inference is a question, not an instruction");
    expect(p).toContain("verify command exercises that outcome");
    expect(p).toContain("Brainstorm with the human");
    expect(p).toContain("purpose first");
    expect(p).toContain("2–3 approaches");
    expect(p).toContain("edge cases and failure modes");
    expect(p).toContain("Never settle a point yourself to keep the interview short");
    expect(p).toContain('source "human"');
    expect(p).toContain("call the Lead in");
    expect(p).toContain("at most two rounds");
    expect(p).toContain("the two gates (spec, ship)");
    expect(p).not.toContain("heartbeat");
    expect(p).not.toContain("brief is approved");
  });
  it("lead prompt locks contracts, not implementation, and acts on the Supervisor's watch notes", () => {
    const p = promptFor(ident("lead"), {});
    expect(p).toContain("Lock contracts only");
    expect(p).toContain("One Peer-impl at a time");
    expect(p).toContain("Never add protective layers");
    expect(p).toContain('"contract:<name>"');
    expect(p).toContain('mode: "interrupt"');
    expect(p).toContain("Silence, DONE or green tests are not a decision");
    expect(p).toContain("not a stopping point");
    expect(p).toContain("Do not ask again for permission already given");
    expect(p).toContain("outcome (what the human or the next task can do");
    expect(p).toContain("## Consulting in the brainstorm");
    expect(p).toContain("evidence from the repo");
    expect(p).toContain("Do not concede without evidence");
    expect(p).toContain("## Decisions added by the Lead");
    expect(p).toContain("A premise binds work only once the human approves a spec that names it");
  });
  it("peer-impl prompt names its worktree and verify command and forbids commits", () => {
    const p = promptFor(ident("peer-impl"), { task });
    expect(p).toContain("/w/T4");
    expect(p).toContain("npm test -- cache");
    expect(p).toContain("Do not commit, push or merge");
    expect(p).toContain("Doubt without evidence is not a challenge");
    expect(p).toContain("verified, not verified, failed, unknown");
    expect(p).toContain("a missing prerequisite that nobody owns");
    expect(p).toContain("evidence, the consequence and the decision");
  });
  it("peer-review prompt names the commit and treats reports as testimony", () => {
    const p = promptFor(ident("peer-review"), { task });
    expect(p).toContain("abc1234");
    expect(p).toContain("unverified testimony");
  });
  it("task brief lists premises and marks open hypotheses", () => {
    const b = taskBrief("cache", task, premises, "Keep retries consistent.");
    expect(b).toContain("[SLP] Task T4: Cache results");
    expect(b).toContain("- D2 — Redis is available");
    expect(b).toContain("- H1 — p95 under 50ms (hypothesis, not yet verified)");
    expect(b).toContain("src/cache/");
    expect(b).not.toContain("## Outcome");
    expect(taskBrief("cache", { ...task, outcome: "A repeated lookup returns the cached value" }, premises, "x")).toContain("## Outcome\nA repeated lookup returns the cached value");
    expect(reviewBrief("cache", task, "abc1234", "Keep retries consistent.")).toContain("Review commit abc1234");
    expect(reviewBrief("cache", task, "abc1234", "Keep retries consistent.")).not.toContain("## Outcome");
    expect(reviewBrief("cache", { ...task, outcome: "A repeated lookup returns the cached value" }, "abc1234", "Keep retries consistent.")).toContain("## Brief from the Lead\nKeep retries consistent.\n\n## Outcome\nA repeated lookup returns the cached value\n\n## Touch set");
    expect(leadKickoff("cache", "# Brief", "start")).toContain("# Brief");
  });
});
