import { describe, expect, it } from "vitest";
import { checkPlan, contractQueues, contractsOf, holderOf, touchOverlaps } from "../server/planCheck";
import type { PlanTask, PremiseState } from "../server/store/derive";
import type { SlpEvent } from "../server/store/events";

const t = (id: string, o: Partial<PlanTask> = {}): PlanTask => ({ id, title: id, dependsOn: [], verifies: [], touchSet: ["src/a/"], verify: "npm test", ...o });
const p = (id: string, kind: "decision" | "hypothesis", status: PremiseState["status"]): [string, PremiseState] =>
  [id, { id, kind, title: id, status, supersededBy: null, supersededAtSeq: null, seq: 1, byRole: "supervisor" }];
const premises = new Map([p("D1", "decision", "active"), p("D0", "decision", "superseded"), p("H1", "hypothesis", "open"), p("H2", "hypothesis", "confirmed")]);
const codes = (tasks: PlanTask[], others: Array<{ slug: string; touchSet: string[] }> = [], allowed: string[] = []) =>
  checkPlan(tasks, { premises, others, modelsAllowed: allowed }).map((i) => `${i.severity}:${i.code}:${i.task ?? ""}`);

describe("checkPlan", () => {
  it("accepts a clean plan", () => {
    expect(codes([t("T1", { verifies: ["H1"] }), t("T2", { dependsOn: ["D1", "H1", "T1", "H2"] })])).toEqual([]);
  });
  it("flags structural errors", () => {
    expect(codes([t("T1"), t("T1")])).toContain("error:duplicate_task:T1");
    expect(codes([t("T1", { verify: " " })])).toContain("error:empty_verify:T1");
    expect(codes([t("T1", { dependsOn: ["D9"] })])).toContain("error:unknown_dependency:T1");
    expect(codes([t("T1", { dependsOn: ["T2"] }), t("T2")])).toContain("error:forward_dependency:T1");
    expect(codes([t("T1", { dependsOn: ["D0"] })])).toContain("error:superseded_dependency:T1");
    expect(codes([t("T1", { verifies: ["D1"] })])).toContain("error:verifies_unknown:T1");
  });
  it("requires an earlier verify task before depending on an open hypothesis", () => {
    expect(codes([t("T1", { dependsOn: ["H1"] }), t("T2", { verifies: ["H1"] })])).toContain("error:unverified_hypothesis:T1");
  });
  it("rejects a task that relies on a premise no approved spec version activated", () => {
    const withProposed = new Map([...premises, p("D3", "decision", "proposed"), p("H3", "hypothesis", "proposed")]);
    const run = (tasks: PlanTask[]) => checkPlan(tasks, { premises: withProposed, others: [], modelsAllowed: [] }).map((i) => `${i.severity}:${i.code}:${i.task ?? ""}`);
    expect(run([t("T1", { dependsOn: ["D3"] })])).toEqual(["error:unapproved_premise:T1"]);
    expect(run([t("T1", { dependsOn: ["H3"] })])).toEqual(["error:unapproved_premise:T1"]);
    expect(run([t("T1", { verifies: ["H3"] })])).toEqual(["error:unapproved_premise:T1"]);
    expect(checkPlan([t("T1", { dependsOn: ["D3"] })], { premises: withProposed, others: [], modelsAllowed: [] })[0]!.message).toBe("T1 relies on D3, which no approved spec version activated");
    expect(run([t("T1", { verifies: ["H1"] }), t("T2", { dependsOn: ["D1", "H1", "H2"] })])).toEqual([]); // active, open and confirmed still pass
  });
  it("enforces the model allowlist only when a task names a model", () => {
    expect(codes([t("T1", { model: "claude-opus-5-5" })], [], ["claude-sonnet-5"])).toContain("error:model_not_allowed:T1");
    expect(codes([t("T1", { model: "claude/claude-sonnet-5" })], [], ["claude-sonnet-5"])).toEqual([]);
  });
  it("warns about touch-set overlap with other features", () => {
    expect(codes([t("T1", { touchSet: ["src/a/x.ts"] })], [{ slug: "other", touchSet: ["src/a/"] }])).toEqual(["warning:touch_set_overlap:T1"]);
  });
  it("requires waitsOn for a contract another feature holds", () => {
    const run = (tasks: PlanTask[]) => checkPlan(tasks, { premises, others: [], modelsAllowed: [], heldBy: new Map([["contract:auth-api", "login"]]) }).map((i) => `${i.code}:${i.task}`);
    expect(run([t("T1", { touchSet: ["contract:auth-api"] })])).toEqual(["contract_held:T1"]);
    expect(run([t("T1", { touchSet: ["contract:auth-api"], waitsOn: ["login"] })])).toEqual([]);
    expect(run([t("T1", { touchSet: ["contract:billing"] })])).toEqual([]);
  });
  it("rejects waits that close a loop between features", () => {
    const run = (waits: Map<string, string[]>) => checkPlan([t("T1", { touchSet: ["contract:x"], waitsOn: ["login"] })], { premises, others: [], modelsAllowed: [], heldBy: new Map([["contract:x", "login"]]), feature: "cache", waits }).map((i) => i.code);
    expect(run(new Map([["login", ["cache"]]]))).toEqual(["contract_cycle"]);
    expect(run(new Map([["login", ["billing"]], ["billing", ["cache"]]]))).toEqual(["contract_cycle"]);
    expect(run(new Map([["login", []]]))).toEqual([]);
  });
});

describe("contract queues", () => {
  const ev = (seq: number, kind: SlpEvent["kind"], contract: string, feature: string): SlpEvent =>
    ({ seq, ts: "", feature: null, kind, id: null, by_role: "plugin", by_agent: null, refs: [], supersedes: null, data: { contract, feature } });
  it("hands a contract to the next feature in claim order when the holder releases it", () => {
    const events = [ev(1, "contract_claim", "contract:a", "login"), ev(2, "contract_claim", "contract:a", "cache"), ev(3, "contract_claim", "contract:a", "login")];
    expect(holderOf(contractQueues(events), "contract:a")).toBe("login");
    expect(holderOf(contractQueues([...events, ev(4, "contract_release", "contract:a", "login")]), "contract:a")).toBe("cache");
    expect(holderOf(contractQueues([]), "contract:a")).toBeNull();
  });
  it("lists the contracts a plan touches once each", () => {
    expect(contractsOf([t("T1", { touchSet: ["contract:a", "src/"] }), t("T2", { touchSet: ["contract:a", "contract:b"] })])).toEqual(["contract:a", "contract:b"]);
  });
});

describe("touchOverlaps", () => {
  it("handles files, directory prefixes and /** suffixes", () => {
    expect(touchOverlaps("src/a/", "src/a/b.ts")).toBe(true);
    expect(touchOverlaps("src/a/**", "src/a/b.ts")).toBe(true);
    expect(touchOverlaps("src/a.ts", "src/a.ts")).toBe(true);
    expect(touchOverlaps("src/a/", "src/ab/c.ts")).toBe(false);
  });
});
