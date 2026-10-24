import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseContracts, type Ctx } from "../server/context";
import type { Identity } from "../server/identity";
import { contractQueues, holderOf } from "../server/planCheck";
import { deriveFeature } from "../server/store/derive";
import { decisionTools } from "../server/tools/decisions";
import { bound, humanSays, makeCtx, specArgs } from "./helpers";

function world() {
  const w = makeCtx();
  // The Supervisor of feature "cache" (its first brief bound it; see "one Supervisor per feature").
  const sup = bound(w.ctx, { role: "supervisor", project: "demo", feature: "cache", task: null, worktree: null, reviewCommit: null, parentAgentId: null }, "sup-1");
  const lead = bound(w.ctx, { role: "lead", project: "demo", feature: "cache", task: null, worktree: "/l", reviewCommit: null, parentAgentId: "sup-1" }, "lead-1");
  const peer = bound(w.ctx, { role: "peer-impl", project: "demo", feature: "cache", task: "T1", worktree: "/p", reviewCommit: null, parentAgentId: "lead-1" }, "peer-1");
  // Keep every agent "running" so routed messages stay in the queue and tests can inspect them deterministically.
  for (const a of ["sup-1", "lead-1", "peer-1"]) w.paseo.statuses.set(a, "running");
  const tools = decisionTools(w.ctx);
  const call = async (who: Identity, name: string, args: unknown) => {
    const t = tools.find((x) => x.name === name)!;
    if (!t.roles.includes(who.role)) return { text: `not available to ${who.role}`, isError: true };
    try { return await t.handler(who, args); } catch (e) { return { text: (e as Error).message, isError: true }; }
  };
  const human = (who: Identity, text: string) => humanSays(w.paseo, who.agentId!)(text);
  const events = () => w.ctx.stores.feature("demo", "cache").all();
  return { ...w, sup, lead, peer, call, human, events };
}

describe("brief and human decisions", () => {
  it("tells the Supervisor when the human approves the spec in the Lead's tab", async () => {
    const w = await world();
    await w.call(w.lead, "slp_spec", specArgs("# Spec\n## Decisions added by the Lead\nNone."));
    await w.human(w.lead, "duyệt");
    expect((await w.call(w.lead, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "duyệt" })).isError).toBeFalsy();
    expect(w.ctx.router.pending().some((p) => p.to.role === "supervisor" && p.text.includes("The human decided in the Lead's tab: approve_spec"))).toBe(true);
  });
  it("asks the Supervisor to walk the human through the spec in their language (rev 5.10 F2)", async () => {
    const w = world();
    await w.call(w.lead, "slp_spec", specArgs("# Spec\n## Decisions added by the Lead\nNone."));
    expect(w.ctx.router.pending().some((p) => p.to.role === "supervisor" && p.text.includes("walk the human through it in their language"))).toBe(true);
  });
  it("stores a brief as the brainstorm record, with no approval step", async () => {
    const w = await world();
    const r = await w.call(w.sup, "slp_brief", { feature: "cache", title: "Cache", markdown: "# Brief", premises: [{ kind: "decision", title: "Redis", source: "human" }, { kind: "decision", title: "TTL 60s" }] });
    expect(r.text).toMatch(/brainstorm record: there is no approval step/);
    expect((await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "approve_brief", quote: "duyệt" })).isError).toBe(true);
    const premises = w.events().filter((e) => e.kind === "premise").map((e) => e.data.source);
    expect(premises).toEqual(["human", "supervisor"]);
    expect(deriveFeature("cache", w.events()).premises.get("D1")).toMatchObject({ status: "proposed", source: "human" });
  });
  it("stores a Lead's spec premise as the Lead's, even when it claims the human chose it (smoke G1 H2)", async () => {
    const w = await world();
    await w.call(w.lead, "slp_spec", specArgs("# Spec\n## Decisions added by the Lead\n- D1 lowercase", { premises: [{ kind: "decision", title: "Output is lowercase (confirmed by human)", source: "human" }] }));
    expect(w.events().filter((e) => e.kind === "premise").map((e) => e.data.source)).toEqual(["lead"]);
    expect(deriveFeature("cache", w.events()).premises.get("D1")).toMatchObject({ status: "proposed", source: "lead" });
  });
  it("lets no premise govern a plan until an approved spec lists it, Supervisor premises included (spec §5.2)", async () => {
    const w = await world();
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "Cache", markdown: "# Brief", premises: [{ kind: "decision", title: "Redis", source: "human" }] });
    await w.call(w.lead, "slp_spec", specArgs("# Spec\n## Premises\n- D1 Redis\n## Decisions added by the Lead\nNone."));
    await w.human(w.sup, "duyệt");
    await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "duyệt" });
    expect(deriveFeature("cache", w.events()).premises.get("D1")?.status).toBe("active");
    // A later brief adds D2 after the human approved the spec: it stays proposed, and a plan that relies on it is refused.
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "Cache", markdown: "# Brief v2", premises: [{ kind: "decision", title: "TTL 60s" }] });
    expect(deriveFeature("cache", w.events()).premises.get("D2")?.status).toBe("proposed");
    const plan = await w.call(w.lead, "slp_plan", { markdown: "# Plan", tasks: [{ id: "T1", title: "t", dependsOn: ["D2"], verifies: [], touchSet: ["a.ts"], verify: "true" }] });
    expect(plan.text).toMatch(/D2, which no approved spec version activated/);
  });
  it("refuses a spec without the Lead's added-decisions section", async () => {
    const w = await world();
    expect(await w.call(w.lead, "slp_spec", specArgs("# Spec only"))).toMatchObject({ isError: true, text: expect.stringMatching(/Decisions added by the Lead/) });
    expect((await w.call(w.lead, "slp_spec", specArgs("# Spec\n## Decisions added by the Lead\n- empty input returns \"\""))).isError).toBeFalsy();
  });
  it("rejects a hypothesis without verify_by and a brief from a non-supervisor", async () => {
    const w = world();
    expect((await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "x", premises: [{ kind: "hypothesis", title: "h" }] })).isError).toBe(true);
    expect((await w.call(w.lead, "slp_brief", { feature: "cache", title: "C", markdown: "x" })).isError).toBe(true);
  });
  it("supersedes a premise from a quoted human decision and resolves its open challenges", async () => {
    const w = world();
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "x", premises: [{ kind: "decision", title: "memory cache" }] });
    await w.call(w.lead, "slp_spec", specArgs("# Spec\nD1\n## Decisions added by the Lead\nNone."));
    await w.human(w.sup, "duyệt spec");
    await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "duyệt spec" });
    await w.call(w.lead, "slp_challenge", { target: "D1", level: "spec", claim: "memory cache breaks retries", evidence: "test retry.spec fails: expected same body", impact: "T4,T6", smallest_correction: "Redis TTL" });
    await w.call(w.sup, "slp_challenge", { feature: "cache", target: "D1", level: "spec", claim: "ask human", evidence: "see C1 evidence from lead", impact: "T4", smallest_correction: "Redis" });
    await w.human(w.sup, "supersede D1, dùng Redis");
    const r = await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "supersede", target: "D1", quote: "dùng Redis", replacement: { kind: "decision", title: "Redis with TTL" } });
    expect(r.isError).toBeFalsy();
    const st = deriveFeature("cache", w.events());
    expect(st.premises.get("D1")).toMatchObject({ status: "superseded", supersededBy: "D2" });
    expect([...st.challenges.values()].every((c) => !c.open)).toBe(true);
    expect(w.ctx.router.pending().some((d) => d.to.role === "lead" && d.text.includes("D1 superseded by D2"))).toBe(true);
  });
  it("requires the full-suite verify command in the spec, inside its ## Verify section (rev 5.11)", async () => {
    const w = world();
    const md = "# Spec\n## Decisions added by the Lead\nNone.";
    expect((await w.call(w.lead, "slp_spec", { markdown: md })).text).toMatch(/Invalid arguments[\s\S]*verify/);
    expect((await w.call(w.lead, "slp_spec", { markdown: md, verify: ["npm test"] })).text).toMatch(/needs a "## Verify" section/);
    expect((await w.call(w.lead, "slp_spec", { markdown: `${md}\n## Verify\nbaseline: 3 pass\n## Notes\nnpm test`, verify: ["npm test"] })).text).toMatch(/not in the "## Verify" section: npm test/);
    const ok = await w.call(w.lead, "slp_spec", { markdown: `${md}\n## Verify\n\`\`\`sh\nnpm test -- --run\n\`\`\`\nbaseline at abc1234: 3 pass, 0 fail\n### Notes\nnone`, verify: ["npm test -- --run"] });
    expect(ok.isError).toBeFalsy();
    expect(w.events().filter((e) => e.kind === "spec").at(-1)!.data.verify).toEqual(["npm test -- --run"]);
  });
});

describe("brief premises are a snapshot (rev 5.10 F1)", () => {
  const brief = (w: ReturnType<typeof world>, markdown: string, premises: unknown[]) => w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown, premises });
  const premiseIds = (w: ReturnType<typeof world>) => w.events().filter((e) => e.kind === "premise").map((e) => e.id);
  it("keeps a resent premise, by id or by title, instead of recording it again", async () => {
    const w = world();
    expect((await brief(w, "v1", [{ kind: "decision", title: "Redis", source: "human" }])).text).toContain("Premises in this version: D1 Redis");
    await brief(w, "v2", [{ id: "D1", kind: "decision", title: "Redis", source: "human" }, { kind: "decision", title: "TTL 60s", source: "human" }]);
    await brief(w, "v3", [{ kind: "decision", title: "  redis ", source: "human" }, { id: "D2", kind: "decision", title: "TTL 60s", source: "human" }]);
    expect(premiseIds(w)).toEqual(["D1", "D2"]);
    expect(w.events().filter((e) => e.kind === "brief").map((e) => e.data.premises)).toEqual([["D1"], ["D1", "D2"], ["D1", "D2"]]);
  });
  it("keeps both premises when the Supervisor's own labels drift from the plugin's ids (Review Focus)", async () => {
    const w = world();
    await brief(w, "v1", [{ kind: "decision", title: "purpose: config" }, { kind: "decision", title: "invalid input throws" }]);
    await brief(w, "v2", [{ id: "D2", kind: "decision", title: "purpose: config" }, { id: "D1", kind: "decision", title: "invalid input throws" }]);
    expect(premiseIds(w)).toEqual(["D1", "D2"]);
    expect(deriveFeature("cache", w.events()).premises.get("D1")?.status).toBe("proposed");
  });
  it("records one premise for a repeated title in one call, and a new one for an unknown id (Review Focus)", async () => {
    const w = world();
    await brief(w, "v1", [{ id: "D99", kind: "decision", title: "Use Redis" }, { kind: "decision", title: "use  REDIS" }]);
    const ps = w.events().filter((e) => e.kind === "premise");
    expect(ps.map((e) => e.id)).toEqual(["D1"]);
    expect(ps[0]!.data).not.toHaveProperty("id");
    expect(ps[0]!.data.origin).toBe("brief");
  });
  it("drops a premise the latest brief leaves out, so the spec cannot carry it", async () => {
    const w = world();
    await brief(w, "v1", [{ kind: "decision", title: "memory cache" }, { kind: "decision", title: "TTL 60s" }]);
    const r = await brief(w, "v2", [{ id: "D2", kind: "decision", title: "TTL 60s" }]);
    expect(r.text).toContain("Dropped: D1.");
    expect(deriveFeature("cache", w.events()).premises.get("D1")?.status).toBe("superseded");
    await w.call(w.lead, "slp_spec", specArgs("# Spec\nD1 and D2\n## Decisions added by the Lead\nNone."));
    expect(w.events().filter((e) => e.kind === "spec").at(-1)!.data.premises).toEqual(["D2"]);
  });
  it("keeps a hypothesis resent by id without verify_by; a new hypothesis still needs one (final review #1)", async () => {
    const w = world();
    await brief(w, "v1", [{ kind: "hypothesis", title: "p95 under 50ms", verify_by: "bench" }]);
    const r = await brief(w, "v2", [{ id: "H1", kind: "hypothesis", title: "p95 under 50ms" }]);
    expect(r.isError).toBeFalsy();
    expect(premiseIds(w)).toEqual(["H1"]);
    expect((await brief(w, "v3", [{ id: "H1", kind: "hypothesis", title: "p95 under 50ms" }, { kind: "hypothesis", title: "cold start under 1s" }])).text).toMatch(/needs verify_by/);
    expect(premiseIds(w)).toEqual(["H1"]);
  });
  it("records a renamed premise as new and drops the old one", async () => {
    const w = world();
    await brief(w, "v1", [{ kind: "decision", title: "TTL 60s" }]);
    await brief(w, "v2", [{ id: "D1", kind: "decision", title: "TTL 90s" }]);
    const st = deriveFeature("cache", w.events());
    expect(st.premises.get("D1")?.status).toBe("superseded");
    expect(st.premises.get("D2")).toMatchObject({ title: "TTL 90s", status: "proposed" });
  });
});

describe("spec and plan", () => {
  async function approvedSpec(w: ReturnType<typeof world>) {
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "x", premises: [{ kind: "hypothesis", title: "h", verify_by: "bench" }] });
    await w.call(w.lead, "slp_spec", specArgs("# Spec\nH1\n## Decisions added by the Lead\nNone."));
    await w.human(w.sup, "spec ok");
    await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "spec ok" });
  }
  it("refuses a plan before the spec is approved and a plan with structural errors", async () => {
    const w = world();
    const plan = { markdown: "# Plan", tasks: [{ id: "T1", title: "t", dependsOn: ["H1"], verifies: [], touchSet: ["src/"], verify: "npm test" }] };
    expect((await w.call(w.lead, "slp_plan", plan)).text).toMatch(/spec is not approved/);
    await approvedSpec(w);
    const r = await w.call(w.lead, "slp_plan", plan);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unverified_hypothesis/);
  });
  it("stores a valid plan, routes it to the Supervisor, and approves by sha", async () => {
    const w = world();
    await approvedSpec(w);
    const r = await w.call(w.lead, "slp_plan", { markdown: "# Plan", tasks: [{ id: "T1", title: "verify h", dependsOn: [], verifies: ["H1"], touchSet: ["bench/"], verify: "npm run bench" }] });
    expect(r.isError).toBeFalsy();
    const sha = deriveFeature("cache", w.events()).plan!.sha256;
    expect(w.ctx.router.pending().some((d) => d.to.role === "supervisor" && d.text.includes("Plan v1"))).toBe(true);
    expect((await w.call(w.sup, "slp_approve_plan", { feature: "cache", sha256: "wrong" })).isError).toBe(true);
    expect((await w.call(w.sup, "slp_approve_plan", { feature: "cache", sha256: sha })).isError).toBeFalsy();
    expect(deriveFeature("cache", w.events()).plan!.approved).toBe(true);
  });
  it("hashes the tasks with the prose, so the same markdown with another verify command is a different plan", async () => {
    const w = world();
    await approvedSpec(w);
    const task = { id: "T1", title: "verify h", dependsOn: [], verifies: ["H1"], touchSet: ["bench/"], verify: "npm run bench" };
    await w.call(w.lead, "slp_plan", { markdown: "# Plan", tasks: [task] });
    const v1 = deriveFeature("cache", w.events()).plan!;
    await w.call(w.lead, "slp_plan", { markdown: "# Plan", tasks: [{ ...task, verify: "true" }] });
    const v2 = deriveFeature("cache", w.events()).plan!;
    expect(v2.sha256).not.toBe(v1.sha256);
    expect(readFileSync(v2.path, "utf8")).toContain('"verify": "true"');
    expect((await w.call(w.sup, "slp_approve_plan", { feature: "cache", sha256: v1.sha256 })).isError).toBe(true);
  });
  it("activates on spec approval only the Lead premises that spec version lists or names", async () => {
    const w = world();
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "x" });
    await w.call(w.lead, "slp_spec", specArgs("# Spec v1\n## Decisions added by the Lead\nNone.", { premises: [{ kind: "decision", title: "memory cache" }, { kind: "decision", title: "TTL 60s" }] }));
    await w.call(w.lead, "slp_spec", specArgs("# Spec v2 keeps D2 only\n## Decisions added by the Lead\nNone."));
    await w.human(w.sup, "spec ok");
    await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "spec ok" });
    const st = deriveFeature("cache", w.events());
    expect(st.premises.get("D1")?.status).toBe("proposed");
    expect(st.premises.get("D2")?.status).toBe("active");
  });
  it("lets one human message back only one decision", async () => {
    const w = world();
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "x", premises: [{ kind: "decision", title: "memory cache" }] });
    await w.call(w.lead, "slp_spec", specArgs("# Spec\n## Decisions added by the Lead\nNone."));
    await w.call(w.sup, "slp_challenge", { feature: "cache", target: "D1", level: "spec", claim: "c", evidence: "evidence text here", impact: "i", smallest_correction: "s" });
    await w.human(w.sup, "ok");
    expect((await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "ok" })).isError).toBeFalsy();
    expect((await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "keep", target: "D1", quote: "ok", reason: "r" })).text).toMatch(/already backs another decision/);
  });
  it("auto-approves when supervisorPlanApproval is off", async () => {
    const w = world();
    w.ctx.config.flags.supervisorPlanApproval = false;
    await approvedSpec(w);
    await w.call(w.lead, "slp_plan", { markdown: "# P", tasks: [{ id: "T1", title: "v", dependsOn: [], verifies: ["H1"], touchSet: [], verify: "x" }] });
    expect(deriveFeature("cache", w.events()).plan!.approved).toBe(true);
  });
  it("keeps a halted feature out of the spec, plan and contract queue", async () => {
    const w = world();
    await approvedSpec(w);
    const task = { id: "T1", title: "verify h", dependsOn: [], verifies: ["H1"], touchSet: ["contract:auth-api"], verify: "npm run bench" };
    await w.call(w.lead, "slp_plan", { markdown: "# Plan", tasks: [task] });
    const sha = deriveFeature("cache", w.events()).plan!.sha256;
    expect((await w.call(w.sup, "slp_approve_plan", { feature: "cache", sha256: sha })).isError).toBeFalsy();
    expect(contractQueues(w.ctx.stores.project("demo").all()).get("contract:auth-api")).toEqual(["cache"]);
    await w.call(w.sup, "slp_challenge", { feature: "cache", target: "T1", level: "spec", claim: "goal is wrong", evidence: "evidence text here", impact: "all", smallest_correction: "rethink" });
    await w.human(w.sup, "đổi goal, dừng feature này lại");
    expect((await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "change_goal", quote: "đổi goal" })).isError).toBeFalsy();
    expect(contractQueues(w.ctx.stores.project("demo").all()).get("contract:auth-api") ?? []).toEqual([]);

    const plan = await w.call(w.lead, "slp_plan", { markdown: "# Plan v2", tasks: [task] });
    expect(plan.isError).toBe(true);
    expect(plan.text).toMatch(/feature cache is halted/);
    const spec = await w.call(w.lead, "slp_spec", specArgs("# Spec v2\n## Decisions added by the Lead\nNone."));
    expect(spec.isError).toBe(true);
    expect(spec.text).toMatch(/feature cache is halted/);
    const approve = await w.call(w.sup, "slp_approve_plan", { feature: "cache", sha256: sha });
    expect(approve.isError).toBe(true);
    expect(approve.text).toMatch(/feature cache is halted/);
    expect(contractQueues(w.ctx.stores.project("demo").all()).get("contract:auth-api") ?? []).toEqual([]);
    expect(w.events().filter((e) => e.kind === "plan")).toHaveLength(1);
  });
});

describe("challenges, questions, messages", () => {
  it("routes a peer challenge to its lead and lets the lead resolve plan-level ones only", async () => {
    const w = world();
    await w.call(w.peer, "slp_challenge", { target: "T1", claim: "plan step wrong", evidence: "npm test -- retry exits 1: expected 200", impact: "T1", smallest_correction: "use redis", repro_command: "npm test -- retry" });
    expect(w.ctx.router.pending().at(-1)!.to).toEqual({ role: "lead", project: "demo", feature: "cache" });
    expect(w.ctx.toolCalls.has("peer-1")).toBe(true);
    expect((await w.call(w.lead, "slp_resolve", { challenge: "C1", outcome: "accepted", reason: "reproduced" })).isError).toBeFalsy();
    await w.call(w.lead, "slp_challenge", { target: "D9", level: "spec", claim: "c", evidence: "evidence text here", impact: "i", smallest_correction: "s" });
    expect((await w.call(w.lead, "slp_resolve", { challenge: "C2", outcome: "rejected", reason: "r" })).text).toMatch(/spec-level/);
  });
  it("makes a Peer challenge on a premise or contract spec-level, whatever level it asked for, and parks tasks touching the contract", async () => {
    const w = world();
    await w.call(w.peer, "slp_challenge", { target: "D1", level: "plan", claim: "D1 is false", evidence: "npm test -- retry exits 1: expected 200", impact: "T1", smallest_correction: "Redis" });
    expect((await w.call(w.lead, "slp_resolve", { challenge: "C1", outcome: "rejected", reason: "nah" })).text).toMatch(/spec-level/);
    expect(w.ctx.router.pending().at(-1)!.text).toMatch(/Only the human decides this/);
    await w.call(w.peer, "slp_challenge", { target: "contract: auth-api", claim: "contract breaks login", evidence: "npm test -- login exits 1: 401", impact: "T1", smallest_correction: "add a field" });
    const c2 = deriveFeature("cache", w.events()).challenges.get("C2")!;
    expect(c2).toMatchObject({ level: "spec", target: "contract:auth-api" });
  });
  it("halts the feature on a change of goal: Peers are told to stop and spawning is refused", async () => {
    const w = world();
    await w.call(w.sup, "slp_challenge", { feature: "cache", target: "T1", level: "spec", claim: "goal is wrong", evidence: "evidence text here", impact: "all", smallest_correction: "rethink" });
    await w.human(w.sup, "đổi goal, dừng feature này lại");
    expect((await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "change_goal", quote: "đổi goal" })).isError).toBeFalsy();
    expect(deriveFeature("cache", w.events()).halted).toBe(true);
    await w.ctx.router.flush();
    expect(w.paseo.sent.some((s) => s.agentId === w.peer.agentId && s.text.includes("feature is halted"))).toBe(true);
  });
  it("rejects a challenge without evidence", async () => {
    const w = world();
    expect((await w.call(w.peer, "slp_challenge", { target: "T1", claim: "feels wrong", evidence: "hmm", impact: "?", smallest_correction: "?" })).isError).toBe(true);
  });
  it("asks and answers through the router", async () => {
    const w = world();
    const q = await w.call(w.peer, "slp_ask", { question: "Does retry include other sessions?" });
    expect(q.text).toMatch(/Q1/);
    await w.call(w.lead, "slp_answer", { question: "Q1", answer: "No, same session only." });
    expect(w.ctx.router.pending().at(-1)).toMatchObject({ to: { role: "peer-impl", feature: "cache", task: "T1" } });
  });
  it("lets only the parent role resolve a challenge: nobody resolves their own, and a skipped level changes nothing", async () => {
    const w = world();
    const resolved = () => w.events().filter((e) => e.kind === "challenge_resolved");
    await w.call(w.peer, "slp_challenge", { target: "T1", claim: "plan step wrong", evidence: "npm test -- retry exits 1: expected 200", impact: "T1", smallest_correction: "use redis" });
    const bySup = await w.call(w.sup, "slp_resolve", { feature: "cache", challenge: "C1", outcome: "rejected", reason: "skipping the Lead" });
    expect(bySup.isError).toBe(true);
    expect(resolved()).toHaveLength(0);
    expect(deriveFeature("cache", w.events()).challenges.get("C1")!.open).toBe(true);
    expect(bySup.text).toMatch(/raised by peer-impl; only its parent role/);
    await w.call(w.lead, "slp_challenge", { target: "T2", level: "plan", claim: "my own step is wrong", evidence: "npm test -- other exits 1: expected 1", impact: "T2", smallest_correction: "redo" });
    const own = await w.call(w.lead, "slp_resolve", { challenge: "C2", outcome: "accepted", reason: "I agree with myself" });
    expect(own.isError).toBe(true);
    expect(resolved()).toHaveLength(0);
    expect(deriveFeature("cache", w.events()).challenges.get("C2")!.open).toBe(true);
    expect(own.text).toMatch(/raised by lead; only its parent role/);
  });
  it("does not let a Lead resolve a challenge the Supervisor raised: resolving goes down the tree, never up", async () => {
    const w = world();
    await w.call(w.sup, "slp_challenge", { feature: "cache", target: "T2", level: "plan", claim: "the plan skips a step", evidence: "plan v1 lists no migration before T2", impact: "T2", smallest_correction: "add the step" });
    const r = await w.call(w.lead, "slp_resolve", { challenge: "C1", outcome: "rejected", reason: "the Lead closes the Supervisor's challenge" });
    expect(r.isError).toBe(true);
    expect(w.events().filter((e) => e.kind === "challenge_resolved")).toHaveLength(0);
    expect(deriveFeature("cache", w.events()).challenges.get("C1")!.open).toBe(true);
    expect(r.text).toMatch(/C1 was raised by supervisor; only its parent role resolves it/);
  });
  it("lets only the parent role answer a question: a Supervisor cannot answer a Peer's", async () => {
    const w = world();
    await w.call(w.peer, "slp_ask", { question: "Does retry include other sessions?" });
    const r = await w.call(w.sup, "slp_answer", { feature: "cache", question: "Q1", answer: "skipping the Lead" });
    expect(r.isError).toBe(true);
    expect(w.events().filter((e) => e.kind === "answer")).toHaveLength(0);
    expect(r.text).toMatch(/Q1 was raised by peer-impl; only its parent role/);
  });
  it("still routes an answer or a resolution to the role that raised it, one level down", async () => {
    const w = world();
    await w.call(w.lead, "slp_ask", { question: "Which cache TTL?" });
    expect((await w.call(w.sup, "slp_answer", { feature: "cache", question: "Q1", answer: "60s" })).isError).toBeFalsy();
    expect(w.ctx.router.pending().at(-1)).toMatchObject({ to: { role: "lead", feature: "cache" } });
    await w.call(w.lead, "slp_challenge", { target: "T2", level: "plan", claim: "step is wrong", evidence: "npm test -- other exits 1: expected 1", impact: "T2", smallest_correction: "redo" });
    expect((await w.call(w.sup, "slp_resolve", { feature: "cache", challenge: "C1", outcome: "accepted", reason: "agreed" })).isError).toBeFalsy();
    expect(w.ctx.router.pending().at(-1)).toMatchObject({ to: { role: "lead", feature: "cache" } });
    expect(w.events().filter((e) => e.kind === "challenge_resolved")).toHaveLength(1);
  });
  it("hides slp_ask when the ask flag is off", () => {
    const w = makeCtx({ flags: { ask: false } });
    expect(decisionTools(w.ctx).find((t) => t.name === "slp_ask")!.roles).toEqual([]);
  });
  it("enforces router edges for slp_send, and steer only from a Supervisor to its Lead or a Lead to its Peers", async () => {
    const w = world();
    expect((await w.call(w.sup, "slp_send", { to: "lead", feature: "cache", text: "status?" })).isError).toBeFalsy();
    expect((await w.call(w.lead, "slp_send", { to: "T1", text: "go" })).isError).toBeFalsy();
    expect((await w.call(w.sup, "slp_send", { to: "T1", feature: "cache", text: "do it" })).isError).toBe(true);
    expect((await w.call(w.lead, "slp_send", { to: "supervisor", text: "x", mode: "steer" })).text).toMatch(/cannot steer/);
    expect((await w.call(w.sup, "slp_send", { to: "lead", text: "you are looping on the same test", mode: "steer" })).isError).toBeFalsy();
    await w.ctx.router.flush();
    expect(w.paseo.sent.at(-1)).toMatchObject({ agentId: "lead-1", behavior: "steer", text: expect.stringContaining("you are looping") });
    expect((await w.call(w.lead, "slp_send", { to: "T1", text: "stop and report", mode: "interrupt" })).isError).toBeFalsy();
    await w.ctx.router.flush();
    expect(w.paseo.sent.at(-1)).toMatchObject({ agentId: "peer-1", behavior: "interrupt" });
  });
  it("records rulings and confirms only open hypotheses with evidence", async () => {
    const w = world();
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "x", premises: [{ kind: "hypothesis", title: "h", verify_by: "bench" }] });
    await w.call(w.lead, "slp_spec", specArgs("# Spec\nH1\n## Decisions added by the Lead\nNone."));
    await w.human(w.sup, "spec ok");
    await w.call(w.sup, "slp_human_decision", { feature: "cache", decides: "approve_spec", quote: "spec ok" });
    expect((await w.call(w.lead, "slp_rule", { decision: "use LRU", reason: "simpler", cost_if_wrong: "rewrite cache module", drop: ["T9"] })).text).toMatch(/R1/);
    expect((await w.call(w.lead, "slp_confirm", { hypothesis: "H1", evidence: "bench p95 41ms on commit abc" })).isError).toBeFalsy();
    expect((await w.call(w.lead, "slp_confirm", { hypothesis: "H1", evidence: "again evidence" })).isError).toBe(true);
  });
  it("returns the digest and documents through slp_state", async () => {
    const w = world();
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "# My brief", premises: [] });
    expect((await w.call(w.sup, "slp_state", {})).text).toContain("# cache — phase: brainstorm");
    expect((await w.call(w.lead, "slp_state", { doc: "brief" })).text).toContain("# My brief");
    expect((await w.call(w.peer, "slp_state", { feature: "other" })).isError).toBe(true);
  });
  it("does not count slp_state as a report", async () => {
    const w = world();
    await w.call(w.peer, "slp_state", {});
    expect(w.ctx.toolCalls.has("peer-1")).toBe(false);
  });
  it("logs and drops an incomplete last line when a feature log opens", () => {
    const w = makeCtx();
    const dir = w.ctx.stores.featureDir("demo", "cache"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "");
    appendFileSync(join(dir, "events.jsonl"), '{"seq":1,"ts":"2026');
    expect(w.ctx.stores.feature("demo", "cache").all().map((e) => e.data.type)).toEqual(["log_truncated"]);
  });
});

describe("one Supervisor per feature", () => {
  it("binds a new Supervisor to the feature its first brief creates, and keeps it there", async () => {
    const w = world();
    const fresh = bound(w.ctx, { role: "supervisor", project: "demo", feature: null, task: null, reviewCommit: null, parentAgentId: null }, "sup-2");
    expect((await w.call(fresh, "slp_approve_plan", { sha256: "x" })).text).toMatch(/write the brief first/);
    expect((await w.call(fresh, "slp_brief", { title: "L", markdown: "x" })).text).toMatch(/name the feature/);
    await w.call(w.sup, "slp_brief", { feature: "cache", title: "C", markdown: "x" });
    expect((await w.call(fresh, "slp_brief", { feature: "cache", title: "L", markdown: "x" })).text).toMatch(/already exists/);
    expect((await w.call(fresh, "slp_brief", { feature: "login", title: "L", markdown: "x" })).isError).toBeFalsy();
    expect(w.ctx.identities.current("supervisor", "demo", "login")?.agentId).toBe("sup-2");
    expect((await w.call(fresh, "slp_brief", { feature: "other", title: "O", markdown: "x" })).text).toMatch(/own Supervisor/);
    expect((await w.call(fresh, "slp_state", { all: true })).text).toContain("# cache");
    expect((await w.call(fresh, "slp_state", { feature: "cache" })).text).toContain("# cache");
    expect((await w.call(fresh, "slp_send", { to: "lead", feature: "cache", text: "hi" })).isError).toBe(true);
  });
});

describe("shared contracts", () => {
  it("lets the first approved plan hold a contract, makes the next feature wait, and hands it over on release", async () => {
    const w = world();
    const supL = bound(w.ctx, { role: "supervisor", project: "demo", feature: "login", task: null, reviewCommit: null, parentAgentId: null }, "sup-2");
    const leadL = bound(w.ctx, { role: "lead", project: "demo", feature: "login", task: null, worktree: "/l2", reviewCommit: null, parentAgentId: "sup-2" }, "lead-2");
    for (const a of ["sup-2", "lead-2"]) w.paseo.statuses.set(a, "running");
    const plan = async (sup: Identity, lead: Identity, feature: string, task: Record<string, unknown>) => {
      await w.call(sup, "slp_brief", { feature, title: feature, markdown: "x" });
      await w.call(lead, "slp_spec", specArgs("# Spec\n## Decisions added by the Lead\nNone."));
      await w.human(sup, `spec ok ${feature}`);
      await w.call(sup, "slp_human_decision", { decides: "approve_spec", quote: `spec ok ${feature}` });
      return w.call(lead, "slp_plan", { markdown: "# P", tasks: [{ id: "T1", title: "t", dependsOn: [], verifies: [], verify: "true", ...task }] });
    };
    const approve = (sup: Identity, feature: string) => w.call(sup, "slp_approve_plan", { sha256: deriveFeature(feature, w.ctx.stores.feature("demo", feature).all()).plan!.sha256 });
    expect((await plan(w.sup, w.lead, "cache", { touchSet: ["contract:auth-api"] })).isError).toBeFalsy();
    expect((await approve(w.sup, "cache")).isError).toBeFalsy();
    expect((await plan(supL, leadL, "login", { touchSet: ["contract:auth-api"] })).text).toMatch(/contract_held/);
    expect((await w.call(leadL, "slp_plan", { markdown: "# P", tasks: [{ id: "T1", title: "t", dependsOn: [], verifies: [], verify: "true", touchSet: ["contract:auth-api"], waitsOn: ["cache"] }] })).isError).toBeFalsy();
    expect((await approve(supL, "login")).isError).toBeFalsy();
    expect(contractQueues(w.ctx.stores.project("demo").all()).get("contract:auth-api")).toEqual(["cache", "login"]);
    releaseContracts(w.ctx, "demo", "cache");
    expect(holderOf(contractQueues(w.ctx.stores.project("demo").all()), "contract:auth-api")).toBe("login");
    expect(w.ctx.router.pending().some((p) => p.to.role === "lead" && p.to.feature === "login" && p.text.includes("now held by your feature"))).toBe(true);
  });
});
