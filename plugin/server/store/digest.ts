import type { FeatureState } from "./derive";
import type { SlpEvent } from "./events";

export function phaseOf(st: FeatureState): string {
  if (st.halted) return "halted";
  if (!st.brief) return "intake";
  if (!st.brief.approved) return "brief-review";
  if (!st.spec) return "spec-writing";
  if (!st.spec.approved) return "spec-review";
  if (!st.plan) return "planning";
  if (!st.plan.approved) return "plan-review";
  const live = [...st.tasks.values()].filter((t) => t.status !== "dropped");
  return live.length > 0 && live.every((t) => t.status === "accepted") ? "acceptance" : "executing";
}

const minutes = (ts: string, now: Date) => Math.max(0, Math.round((now.getTime() - Date.parse(ts)) / 60000));
const list = (xs: string[]) => (xs.length ? xs.join("; ") : "—");

export function renderDigest(st: FeatureState, ops: readonly SlpEvent[], now: Date): string {
  const tasks = [...st.tasks.values()];
  const accepted = tasks.filter((t) => t.status === "accepted").length;
  const lines: string[] = [];
  lines.push(`# ${st.slug} — phase: ${phaseOf(st)}${st.plan ? ` (plan v${st.plan.version}, ${accepted}/${tasks.length} accepted)` : ""}`);
  lines.push(`Owners: ${list(tasks.filter((t) => t.status === "assigned" || t.status === "reported").map((t) => `${t.id} → ${t.agentId} (${t.status})`))}`);
  lines.push(`Waiting on human: ${list(st.waitingOnHuman)}`);
  lines.push(`Open challenges: ${list([...st.challenges.values()].filter((c) => c.open).map((c) => `${c.id} (${c.level}, ${c.target}, ${minutes(c.ts, now)} min)`))}`);
  lines.push(`Stale: ${list(tasks.filter((t) => t.status === "stale").map((t) => t.id))} | Parked: ${list(tasks.filter((t) => t.status === "parked").map((t) => t.id))}`);
  lines.push(`Open hypotheses: ${list([...st.premises.values()].filter((p) => p.status === "open").map((p) => `${p.id} ${p.title}`))}`);
  const contracts = [...new Set(tasks.flatMap((t) => t.touchSet.filter((e) => e.startsWith("contract:"))))];
  const waits = tasks.filter((t) => t.waitsOn?.length && t.status !== "accepted" && t.status !== "dropped").map((t) => `${t.id} waits on ${t.waitsOn!.join(", ")}`);
  if (contracts.length || waits.length) lines.push(`Contracts: ${list([...contracts, ...waits])}`);
  if (st.lastWatch) lines.push(`Watch: #${st.lastWatch.tick} ${st.lastWatch.ts.slice(11, 16)} — ${st.lastWatch.verdicts.map((v) => `${v.agent} ${v.verdict}`).join("; ") || "no agents"}`);
  const recent = ops.filter((o) => !String(o.data.type).startsWith("watch_")).slice(-5).map((o) => `- ${o.ts.slice(11, 16)} ${String(o.data.type)} ${String(o.data.summary ?? "")}`.trimEnd());
  if (recent.length) lines.push("Recent ops:", ...recent);
  lines.push("Tasks:");
  const rows = tasks.map((t) => `- ${t.id} ${t.status}${t.status === "reported" && t.reportStatus && t.reportStatus !== "done" ? ` (${t.reportStatus})` : ""}${t.lastCommit ? ` @${t.lastCommit.slice(0, 7)}` : ""}${t.evidenceOk ? " ✓verify" : ""}${t.reviewOk ? " ✓review" : ""} — ${t.title}`);
  const room = 30 - lines.length;
  lines.push(...(rows.length > room ? [...rows.slice(0, room - 1), `- … +${rows.length - room + 1} more`] : rows));
  return lines.join("\n") + "\n";
}
