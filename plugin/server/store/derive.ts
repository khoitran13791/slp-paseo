import type { SlpEvent } from "./events";

/** `outcome`: what the human or the next task can do once the task is done (descriptive; not part of taskDef). */
export interface PlanTask { id: string; title: string; outcome?: string; dependsOn: string[]; verifies: string[]; touchSet: string[]; verify: string; model?: string; waitsOn?: string[] }
export interface WatchResult { tick: number; ts: string; verdicts: Array<{ agent: string; verdict: string; note?: string }> }
export type PremiseStatus = "active" | "open" | "confirmed" | "superseded" | "proposed";
export interface PremiseState { id: string; kind: "decision" | "hypothesis"; title: string; status: PremiseStatus; supersededBy: string | null; supersededAtSeq: number | null; seq: number; byRole: string; source?: "human" | "supervisor" | "lead" }
export type TaskStatus = "pending" | "assigned" | "reported" | "accepted" | "parked" | "stale" | "dropped";
export interface TaskState extends PlanTask {
  status: TaskStatus; closure: string[]; agentId: string | null; worktree: string | null; branch: string | null; base: string | null;
  attempt: number; lastCommit: string | null; evidenceOk: boolean; reviewOk: boolean; reopened: boolean; acceptedAtSeq: number | null;
  /** Status of the latest report; a new assign makes the task "assigned", and the next report overwrites this. */
  reportStatus?: "done" | "done_with_concerns" | "blocked";
}
export interface ChallengeState { id: string; target: string; level: "plan" | "spec"; byRole: string; byAgent: string | null; open: boolean; seq: number; ts: string; outcome: "accepted" | "rejected" | null }
export interface DocState { version: number; sha256: string; path: string; seq: number; ts: string; approved: boolean }
export interface FeatureState {
  slug: string; brief: DocState | null; spec: DocState | null; plan: DocState | null;
  premises: Map<string, PremiseState>; tasks: Map<string, TaskState>; challenges: Map<string, ChallengeState>;
  halted: boolean; waitingOnHuman: string[]; lastWatch: WatchResult | null;
}

const TASK_KINDS = new Set(["assign", "report", "commit", "evidence", "review", "release", "ops"]);

/** What a task promises; accepted work goes stale when a later plan changes it, and evidence counts only for the definition it ran under. */
export const taskDef = (t: PlanTask) => ({ verify: t.verify, touchSet: [...t.touchSet].sort(), dependsOn: [...t.dependsOn].sort(), verifies: [...t.verifies].sort() });

/**
 * Green evidence: exit 0, no timeout, the run left the commit's tracked files and HEAD as they were, and (with `def`) it ran under that
 * task definition, so a plan that changes the verify command makes old evidence red (review Codex 2026-10-22, rounds 1 and 2).
 */
export const evidencePassed = (d: Record<string, unknown>, def?: ReturnType<typeof taskDef>): boolean =>
  d.exitCode === 0 && d.timedOut !== true && !(Array.isArray(d.dirty) && d.dirty.length > 0) && (def === undefined || d.def === undefined || JSON.stringify(d.def) === JSON.stringify(def));
const str = (v: unknown): string | null => (v == null ? null : String(v));

export function deriveFeature(slug: string, events: readonly SlpEvent[]): FeatureState {
  const st: FeatureState = { slug, brief: null, spec: null, plan: null, premises: new Map(), tasks: new Map(), challenges: new Map(), halted: false, waitingOnHuman: [], lastWatch: null };
  let planTasks: PlanTask[] = [];
  const specPremises = new Map<string, string[]>(); // spec sha256 → Lead premises that version relies on
  const dropped = new Set<string>();

  for (const e of events) {
    switch (e.kind) {
      case "brief": case "spec": case "plan":
        st[e.kind] = { version: Number(e.data.version), sha256: String(e.data.sha256), path: String(e.data.path), seq: e.seq, ts: e.ts, approved: false };
        if (e.kind === "plan") planTasks = (e.data.tasks as PlanTask[] | undefined) ?? [];
        if (e.kind === "spec") specPremises.set(String(e.data.sha256), (e.data.premises as string[] | undefined) ?? []);
        break;
      case "premise": {
        const kind = e.data.kind === "hypothesis" ? "hypothesis" : "decision";
        // Every premise waits for an approved spec that lists it (spec §5.2). With no brief gate this is the human's only look at a premise (review Codex 2026-10-23).
        const source = e.data.source === "human" || e.data.source === "supervisor" || e.data.source === "lead" ? e.data.source : undefined;
        st.premises.set(e.id!, { id: e.id!, kind, title: String(e.data.title ?? ""), status: "proposed", supersededBy: null, supersededAtSeq: null, seq: e.seq, byRole: e.by_role, source });
        break;
      }
      case "human_decision":
        if (e.data.decides === "approve_spec" && st.spec && st.spec.sha256 === e.data.target) {
          st.spec.approved = true;
          // Only the premises this spec version lists; a premise proposed with an abandoned version stays proposed (review Codex 2026-10-22).
          const listed = specPremises.get(String(e.data.target)) ?? [];
          for (const p of st.premises.values()) if (p.status === "proposed" && listed.includes(p.id)) p.status = p.kind === "hypothesis" ? "open" : "active";
        }
        if (e.data.decides === "change_goal") st.halted = true;
        break;
      case "plan_approved":
        if (st.plan && st.plan.sha256 === e.data.sha256) st.plan.approved = true;
        break;
      case "supersede": {
        const old = e.supersedes ? st.premises.get(e.supersedes) : undefined;
        if (old) Object.assign(old, { status: "superseded", supersededBy: e.refs[0] ?? null, supersededAtSeq: e.seq });
        // The human chose the replacement, with a quote (supersede comes only from slp_human_decision): it is in force at once.
        const repl = st.premises.get(e.refs[0] ?? "");
        if (repl?.status === "proposed") repl.status = repl.kind === "hypothesis" ? "open" : "active";
        break;
      }
      case "confirms": {
        const h = st.premises.get(e.refs[0] ?? "");
        if (h?.kind === "hypothesis" && h.status === "open") h.status = "confirmed";
        break;
      }
      case "challenge":
        st.challenges.set(e.id!, { id: e.id!, target: String(e.data.target), level: e.data.level === "spec" ? "spec" : "plan", byRole: e.by_role, byAgent: e.by_agent, open: true, seq: e.seq, ts: e.ts, outcome: null });
        break;
      case "challenge_resolved": {
        const c = st.challenges.get(e.refs[0] ?? "");
        if (c) { c.open = false; c.outcome = e.data.outcome === "accepted" ? "accepted" : "rejected"; }
        break;
      }
      case "ruling":
        for (const t of (e.data.drop as string[] | undefined) ?? []) dropped.add(t);
        break;
      case "watch_result":
        st.lastWatch = { tick: Number(e.data.tick), ts: e.ts, verdicts: (e.data.verdicts as WatchResult["verdicts"] | undefined) ?? [] };
        break;
    }
  }

  const byId = new Map(planTasks.map((t) => [t.id, t]));
  const closureOf = (id: string, seen = new Set<string>()): string[] => {
    const t = byId.get(id);
    if (!t || seen.has(id)) return [];
    seen.add(id);
    const out = new Set<string>();
    for (const d of t.dependsOn) { out.add(d); for (const x of closureOf(d, seen)) out.add(x); }
    return [...out];
  };
  const openSpecTargets = new Set([...st.challenges.values()].filter((c) => c.open && c.level === "spec").map((c) => c.target));

  for (const pt of planTasks) {
    const ts: TaskState = { ...pt, status: "pending", closure: closureOf(pt.id), agentId: null, worktree: null, branch: null, base: null, attempt: 0, lastCommit: null, evidenceOk: false, reviewOk: false, reopened: false, acceptedAtSeq: null };
    let wasAccepted = false;
    let acceptedDef: string | null = null;
    const reviews = new Map<string, { commit: string; ok: boolean }>(); // by reviewer; counted only after the turn-end check
    for (const e of events) {
      if (!TASK_KINDS.has(e.kind) || e.data.task !== pt.id) continue;
      if (e.kind === "assign") {
        if (e.data.takeover === true) { ts.agentId = str(e.data.agentId); continue; } // a new Peer owns it; the delivery (commit, evidence, review) stays
        if (wasAccepted) ts.reopened = true;
        Object.assign(ts, { status: "assigned", agentId: str(e.data.agentId), worktree: str(e.data.worktree), branch: str(e.data.branch), base: str(e.data.base), attempt: Number(e.data.attempt ?? ts.attempt + 1), lastCommit: null, evidenceOk: false, reviewOk: false, acceptedAtSeq: null });
      } else if (e.kind === "report") {
        if (ts.status === "assigned" || ts.status === "reported") { ts.status = "reported"; ts.reportStatus = e.data.status as TaskState["reportStatus"]; }
      } else if (e.kind === "commit") {
        if (e.data.scope !== "challenge") { ts.lastCommit = str(e.data.hash); ts.evidenceOk = false; ts.reviewOk = false; reviews.clear(); }
      } else if (e.kind === "evidence") {
        // Latest evidence for this commit under this definition, the same rule as evidenceOkFor: evidence from another definition is skipped, not counted as red.
        if (e.data.scope === "task" && e.data.commit === ts.lastCommit && (e.data.def === undefined || JSON.stringify(e.data.def) === JSON.stringify(taskDef(pt)))) ts.evidenceOk = evidencePassed(e.data);
      } else if (e.kind === "review") {
        if (e.data.commit === ts.lastCommit) { reviews.set(String(e.by_agent), { commit: String(e.data.commit), ok: e.data.verdict === "pass" && Number(e.data.blocking ?? 1) === 0 }); ts.reviewOk = false; }
      } else if (e.kind === "ops") {
        if (e.data.type === "review_checked" && e.data.commit === ts.lastCommit) { const r = reviews.get(String(e.data.agentId)); ts.reviewOk = r?.commit === ts.lastCommit && r.ok; }
        if (e.data.type === "review_invalidated" && e.data.commit === ts.lastCommit) ts.reviewOk = false;
      } else if (e.kind === "release") {
        if (e.data.outcome === "accepted") { ts.status = "accepted"; ts.acceptedAtSeq = e.seq; wasAccepted = true; acceptedDef = e.data.def ? JSON.stringify(e.data.def) : null; }
        else { ts.status = "pending"; ts.agentId = null; }
      }
    }
    const supersededAfterAccept = ts.closure.some((d) => {
      const p = st.premises.get(d);
      return p?.status === "superseded" && (p.supersededAtSeq ?? 0) > (ts.acceptedAtSeq ?? 0);
    });
    const changedSinceAccept = acceptedDef !== null && acceptedDef !== JSON.stringify(taskDef(pt));
    if (dropped.has(pt.id)) ts.status = "dropped";
    else if (ts.status === "accepted" && (supersededAfterAccept || changedSinceAccept)) ts.status = "stale";
    else if (ts.status !== "accepted" && (openSpecTargets.has(pt.id) || ts.closure.some((d) => openSpecTargets.has(d)) || ts.touchSet.some((e) => openSpecTargets.has(e)))) ts.status = "parked";
    st.tasks.set(pt.id, ts);
  }
  // Accepted work built on a task that went stale, or was accepted again later, is stale too (spec §6.5). Plan order puts dependencies first.
  for (const ts of st.tasks.values()) {
    if (ts.status !== "accepted") continue;
    const moved = ts.dependsOn.some((d) => { const dep = st.tasks.get(d); return dep !== undefined && (dep.status === "stale" || (dep.status === "accepted" && (dep.acceptedAtSeq ?? 0) > (ts.acceptedAtSeq ?? 0))); });
    if (moved) ts.status = "stale";
  }

  if (st.spec && !st.spec.approved) st.waitingOnHuman.push(`approve spec v${st.spec.version}`);
  for (const c of st.challenges.values()) if (c.open && c.byRole === "supervisor") st.waitingOnHuman.push(`decide ${c.id} on ${c.target}`);
  const lastPkg = [...events].reverse().find((e) => e.kind === "ship_package");
  if (lastPkg && !events.some((e) => e.kind === "shipped" && e.seq > lastPkg.seq)) st.waitingOnHuman.push(`approve ship ${String(lastPkg.data.commit).slice(0, 7)}`);
  return st;
}

export function acceptanceBlockers(st: FeatureState, events: readonly SlpEvent[], head: string): string[] {
  const out: string[] = [];
  if (st.halted) out.push("the feature is halted (the human changed the goal)");
  // The tasks come from the latest plan; an unapproved one must not drop tasks from this gate (review Codex 2026-10-22, round 6).
  for (const [name, doc] of [["spec", st.spec], ["plan", st.plan]] as const) if (!doc || !doc.approved) out.push(doc ? `${name} v${doc.version} is not approved` : `no ${name}`);
  for (const t of st.tasks.values()) if (t.status !== "accepted" && t.status !== "dropped") out.push(`${t.id} is ${t.status}`);
  for (const c of st.challenges.values()) if (c.open) out.push(`${c.id} is open`);
  const ev = [...events].reverse().find((e) => e.kind === "evidence" && e.data.scope === "feature" && e.data.commit === head);
  if (!ev || !evidencePassed(ev.data)) out.push(`no green full-suite evidence on ${head.slice(0, 7)}`);
  return out;
}
