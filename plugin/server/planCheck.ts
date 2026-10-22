import { normalizeModel } from "./roles";
import type { PlanTask, PremiseState } from "./store/derive";
import type { SlpEvent } from "./store/events";
import { normTouch } from "./touch";

export interface PlanIssue { severity: "error" | "warning"; code: string; message: string; task?: string }

export function touchOverlaps(a: string, b: string): boolean {
  const x = normTouch(a); const y = normTouch(b);
  if (x === y) return true;
  return (x.endsWith("/") && y.startsWith(x)) || (y.endsWith("/") && x.startsWith(y));
}

export const isContract = (entry: string): boolean => entry.startsWith("contract:");

/** Shared contracts a plan touches: touch-set entries written as "contract:<name>". */
export function contractsOf(tasks: readonly PlanTask[]): string[] {
  return [...new Set(tasks.flatMap((t) => t.touchSet.filter(isContract)))];
}

/** Claim order per contract, from project.jsonl. The first feature of each list holds the contract. */
export function contractQueues(events: readonly SlpEvent[]): Map<string, string[]> {
  const queues = new Map<string, string[]>();
  for (const e of events) {
    if (e.kind !== "contract_claim" && e.kind !== "contract_release") continue;
    const contract = String(e.data.contract); const feature = String(e.data.feature);
    const list = queues.get(contract) ?? [];
    queues.set(contract, e.kind === "contract_claim" ? (list.includes(feature) ? list : [...list, feature]) : list.filter((f) => f !== feature));
  }
  return queues;
}

export const holderOf = (queues: Map<string, string[]>, contract: string): string | null => queues.get(contract)?.[0] ?? null;

export function checkPlan(tasks: PlanTask[], ctx: { premises: Map<string, PremiseState>; others: Array<{ slug: string; touchSet: string[] }>; modelsAllowed: string[]; heldBy?: Map<string, string>; feature?: string; waits?: Map<string, string[]> }): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const err = (code: string, task: string, message: string) => issues.push({ severity: "error", code, task, message });
  const seen = new Set<string>();
  const verifiedBefore = new Set<string>();
  const allIds = new Set(tasks.map((t) => t.id));
  const allowed = ctx.modelsAllowed.map(normalizeModel);

  for (const t of tasks) {
    if (seen.has(t.id)) err("duplicate_task", t.id, `task id ${t.id} appears twice`);
    if (t.verify.trim() === "") err("empty_verify", t.id, `${t.id} has no verify command`);
    for (const d of t.dependsOn) {
      const premise = ctx.premises.get(d);
      if (premise) {
        if (premise.status === "superseded") err("superseded_dependency", t.id, `${t.id} depends on ${d}, superseded by ${premise.supersededBy}`);
        if (premise.kind === "hypothesis" && premise.status === "open" && !verifiedBefore.has(d)) err("unverified_hypothesis", t.id, `${t.id} depends on open hypothesis ${d}; put a task that verifies ${d} before it`);
      } else if (allIds.has(d)) {
        if (!seen.has(d)) err("forward_dependency", t.id, `${t.id} depends on ${d}, which runs later`);
      } else {
        err("unknown_dependency", t.id, `${t.id} depends on unknown id ${d}`);
      }
    }
    for (const v of t.verifies) {
      const premise = ctx.premises.get(v);
      if (premise?.kind !== "hypothesis") err("verifies_unknown", t.id, `${t.id} verifies ${v}, which is not a hypothesis`);
      else verifiedBefore.add(v);
    }
    if (t.model && allowed.length > 0 && !allowed.includes(normalizeModel(t.model))) err("model_not_allowed", t.id, `${t.id} uses model ${t.model}, not in models.allowed (${allowed.join(", ")})`);
    for (const c of t.touchSet.filter(isContract)) {
      const holder = ctx.heldBy?.get(c);
      if (holder && !(t.waitsOn ?? []).includes(holder)) err("contract_held", t.id, `${t.id} touches ${c}, held by feature ${holder}; add waitsOn: ["${holder}"] or leave the contract to ${holder}`);
    }
    for (const other of ctx.others) {
      const hits = t.touchSet.filter((a) => other.touchSet.some((b) => touchOverlaps(a, b)));
      if (hits.length) issues.push({ severity: "warning", code: "touch_set_overlap", task: t.id, message: `${t.id} touches ${hits.join(", ")}, also in feature ${other.slug}` });
    }
    seen.add(t.id);
  }
  // A waits on B while B (directly or through others) waits on A: neither can ship and release its contract (review Codex 2026-10-22).
  if (ctx.feature && ctx.waits) {
    const reaches = (from: string, seen = new Set<string>()): boolean => {
      if (from === ctx.feature) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (ctx.waits!.get(from) ?? []).some((next) => reaches(next, seen));
    };
    for (const t of tasks) for (const w of t.waitsOn ?? []) if (reaches(w)) err("contract_cycle", t.id, `${t.id} waits on ${w}, which already waits on ${ctx.feature}; neither can finish. Ask the human which feature goes first.`);
  }
  return issues;
}
