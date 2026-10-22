import { describe, expect, it } from "vitest";
import { deriveFeature, type PlanTask } from "../server/store/derive";
import { phaseOf, renderDigest } from "../server/store/digest";
import type { SlpEvent } from "../server/store/events";

let seq = 0;
const ev = (kind: SlpEvent["kind"], data: Record<string, unknown> = {}, extra: Partial<SlpEvent> = {}): SlpEvent =>
  ({ seq: ++seq, ts: "2026-10-22T10:00:00.000Z", feature: "f", kind, id: null, by_role: "lead", by_agent: null, refs: [], supersedes: null, data, ...extra });
const task = (id: string): PlanTask => ({ id, title: `title ${id}`, dependsOn: [], verifies: [], touchSet: [], verify: "x" });

describe("renderDigest", () => {
  it("names the phase as the feature moves forward", () => {
    expect(phaseOf(deriveFeature("f", []))).toBe("intake");
    const b = [ev("brief", { version: 1, sha256: "b", path: "p" })];
    expect(phaseOf(deriveFeature("f", b))).toBe("brief-review");
    const s = [...b, ev("human_decision", { decides: "approve_brief", target: "b" }), ev("spec", { version: 1, sha256: "s", path: "p" })];
    expect(phaseOf(deriveFeature("f", s))).toBe("spec-review");
    const p = [...s, ev("human_decision", { decides: "approve_spec", target: "s" }), ev("plan", { version: 1, sha256: "p1", path: "p", tasks: [task("T1")] })];
    expect(phaseOf(deriveFeature("f", p))).toBe("plan-review");
    expect(phaseOf(deriveFeature("f", [...p, ev("plan_approved", { sha256: "p1" })]))).toBe("executing");
  });
  it("stays within 30 lines with many tasks and shows open challenges with their age", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => task(`T${i + 1}`));
    const events = [ev("plan", { version: 2, sha256: "p", path: "p", tasks }), ev("challenge", { target: "T1", level: "plan" }, { id: "C1", ts: "2026-10-22T09:48:00.000Z" })];
    const text = renderDigest(deriveFeature("f", events), [ev("ops", { type: "limit_hit", summary: "claude until 11:00" }, { by_role: "plugin" })], new Date("2026-10-22T10:00:00.000Z"));
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(text).toContain("Open challenges: C1 (plan, T1, 12 min)");
    expect(text).toContain("limit_hit claude until 11:00");
    expect(lines.at(-1)).toMatch(/^- … \+\d+ more$/);
  });
  it("shows contracts, waits and the last watch result, and keeps watch ops out of recent ops", () => {
    const events = [ev("plan", { version: 1, sha256: "p", path: "p", tasks: [{ ...task("T1"), touchSet: ["contract:auth-api"], waitsOn: ["login"] }] }),
      ev("watch_result", { tick: 3, verdicts: [{ agent: "lead", verdict: "ok" }, { agent: "T1", verdict: "watch", note: "slow" }] }, { by_role: "supervisor" })];
    const text = renderDigest(deriveFeature("f", events), [ev("ops", { type: "watch_sent", summary: "#3" }, { by_role: "plugin" })], new Date("2026-10-22T10:00:00.000Z"));
    expect(text).toContain("Contracts: contract:auth-api; T1 waits on login");
    expect(text).toContain("Watch: #3 10:00 — lead ok; T1 watch");
    expect(text).not.toContain("watch_sent");
  });
  it("shows a reported task's status when it is not plain done, so a restarted Lead sees blockers", () => {
    const events = [ev("plan", { version: 1, sha256: "p", path: "p", tasks: [task("T1"), task("T2")] }),
      ev("assign", { task: "T1", agentId: "a1" }), ev("report", { task: "T1", status: "blocked", message: "x" }, { by_role: "peer-impl" }),
      ev("assign", { task: "T2", agentId: "a2" }), ev("report", { task: "T2", status: "done", message: "y" }, { by_role: "peer-impl" })];
    const text = renderDigest(deriveFeature("f", events), [], new Date("2026-10-22T10:00:00.000Z"));
    expect(text).toContain("- T1 reported (blocked) — title T1");
    expect(text).toContain("- T2 reported — title T2");
  });
});
