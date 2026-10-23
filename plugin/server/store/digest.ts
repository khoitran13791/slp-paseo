import type { FeatureState } from "./derive";
import type { SlpEvent } from "./events";

export function phaseOf(st: FeatureState): string {
  if (st.halted) return "halted";
  if (!st.brief) return "intake";
  if (!st.spec) return "brainstorm";
  if (!st.spec.approved) return "spec-review";
  if (!st.plan) return "planning";
  if (!st.plan.approved) return "plan-review";
  const live = [...st.tasks.values()].filter((t) => t.status !== "dropped");
  return live.length > 0 && live.every((t) => t.status === "accepted") ? "acceptance" : "executing";
}

const minutes = (ts: string, now: Date) => Math.max(0, Math.round((now.getTime() - Date.parse(ts)) / 60000));
const list = (xs: string[]) => (xs.length ? xs.join("; ") : "—");
const one = (s: unknown, n = 160): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function renderDigest(st: FeatureState, ops: readonly SlpEvent[], now: Date): string {
  const tasks = [...st.tasks.values()];
  const accepted = tasks.filter((t) => t.status === "accepted").length;
  const lines: string[] = [];
  lines.push(`# ${one(st.slug)} — phase: ${phaseOf(st)}${st.plan ? ` (plan v${st.plan.version}, ${accepted}/${tasks.length} accepted)` : ""}`);
  lines.push(`Owners: ${list(tasks.filter((t) => t.status === "assigned" || t.status === "reported").map((t) => `${one(t.id)} → ${t.agentId} (${t.status})`))}`);
  lines.push(`Waiting on human: ${list(st.waitingOnHuman.map((w) => one(w)))}`);
  lines.push(`Open challenges: ${list([...st.challenges.values()].filter((c) => c.open).map((c) => `${c.id} (${c.level}, ${one(c.target)}, ${minutes(c.ts, now)} min)`))}`);
  lines.push(`Stale: ${list(tasks.filter((t) => t.status === "stale").map((t) => one(t.id)))} | Parked: ${list(tasks.filter((t) => t.status === "parked").map((t) => one(t.id)))}`);
  lines.push(`Open hypotheses: ${list([...st.premises.values()].filter((p) => p.status === "open").map((p) => `${p.id} ${one(p.title)}`))}`);
  lines.push(`Awaiting spec approval: ${list([...st.premises.values()].filter((p) => p.status === "proposed").map((p) => `${p.id} ${one(p.title, 60)} [${p.source ?? p.byRole}]`))}`);
  const contracts = [...new Set(tasks.flatMap((t) => t.touchSet.filter((e) => e.startsWith("contract:")).map((e) => one(e))))];
  const waits = tasks.filter((t) => t.waitsOn?.length && t.status !== "accepted" && t.status !== "dropped").map((t) => `${one(t.id)} waits on ${t.waitsOn!.map((w) => one(w)).join(", ")}`);
  if (contracts.length || waits.length) lines.push(`Contracts: ${list([...contracts, ...waits])}`);
  if (st.lastWatch) lines.push(`Watch: #${st.lastWatch.tick} ${st.lastWatch.ts.slice(11, 16)} — ${st.lastWatch.verdicts.map((v) => `${one(v.agent)} ${one(v.verdict)}`).join("; ") || "no agents"}`);
  const recent = ops.filter((o) => !String(o.data.type).startsWith("watch_")).slice(-5).map((o) => `- ${o.ts.slice(11, 16)} ${String(o.data.type)} ${one(o.data.summary)}`.trimEnd());
  if (recent.length) lines.push("Recent ops:", ...recent);
  lines.push("Tasks:");
  const rows = tasks.map((t) => `- ${one(t.id)} ${t.status}${t.status === "reported" && t.reportStatus && t.reportStatus !== "done" ? ` (${one(t.reportStatus)})` : ""}${t.lastCommit ? ` @${t.lastCommit.slice(0, 7)}` : ""}${t.evidenceOk ? " ✓verify" : ""}${t.reviewOk ? " ✓review" : ""} — ${one(t.title)}`);
  const room = 30 - lines.length;
  lines.push(...(rows.length > room ? [...rows.slice(0, room - 1), `- … +${rows.length - room + 1} more`] : rows));
  return lines.join("\n") + "\n";
}
