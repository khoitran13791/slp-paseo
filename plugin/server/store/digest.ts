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
  const phase = phaseOf(st);
  const lines: string[] = [];
  // Rev 5.10: the human reads this too (the watch pack shows in the Supervisor tab), so empty fields are left out and what waits on them comes first.
  const field = (label: string, items: string[]) => { if (items.length) lines.push(`${label}: ${items.join("; ")}`); };
  const bullets = (label: string, items: string[], max: number) => {
    if (!items.length) return;
    lines.push(`${label}:`, ...items.slice(0, max).map((i) => `- ${i}`), ...(items.length > max ? [`- … +${items.length - max} more`] : []));
  };
  lines.push(`# ${one(st.slug)} — phase: ${phase}${st.plan ? ` (plan v${st.plan.version}, ${accepted}/${tasks.length} accepted)` : ""}`);
  field("Waiting on human", st.waitingOnHuman.map((w) => one(w)));
  field("Owners", tasks.filter((t) => t.status === "assigned" || t.status === "reported").map((t) => `${one(t.id)} → ${t.agentId} (${t.status})`));
  bullets("Open challenges", [...st.challenges.values()].filter((c) => c.open).map((c) => `${c.id} (${c.level}, ${one(c.target)}, ${minutes(c.ts, now)} min)`), 5);
  const stale = tasks.filter((t) => t.status === "stale").map((t) => one(t.id));
  const parked = tasks.filter((t) => t.status === "parked").map((t) => one(t.id));
  if (stale.length || parked.length) lines.push(`Stale: ${list(stale)} | Parked: ${list(parked)}`);
  bullets("Open hypotheses", [...st.premises.values()].filter((p) => p.status === "open").map((p) => `${p.id} ${one(p.title)}`), 5);
  if (phase === "brainstorm" || phase === "spec-review") bullets("Awaiting spec approval", [...st.premises.values()].filter((p) => p.status === "proposed").map((p) => `${p.id} ${one(p.title, 120)} [${p.source ?? p.byRole}]`), 8);
  const contracts = [...new Set(tasks.flatMap((t) => t.touchSet.filter((e) => e.startsWith("contract:")).map((e) => one(e))))];
  const waits = tasks.filter((t) => t.waitsOn?.length && t.status !== "accepted" && t.status !== "dropped").map((t) => `${one(t.id)} waits on ${t.waitsOn!.map((w) => one(w)).join(", ")}`);
  field("Contracts", [...contracts, ...waits]);
  if (st.lastWatch) lines.push(`Watch: #${st.lastWatch.tick} ${st.lastWatch.ts.slice(11, 16)} — ${st.lastWatch.verdicts.map((v) => `${one(v.agent)} ${one(v.verdict)}`).join("; ") || "no agents"}`);
  const recent = ops.filter((o) => !String(o.data.type).startsWith("watch_")).slice(-5).map((o) => `- ${o.ts.slice(11, 16)} ${String(o.data.type)} ${one(o.data.summary)}`.trimEnd());
  if (recent.length) lines.push("Recent ops:", ...recent);
  const rows = tasks.map((t) => `- ${one(t.id)} ${t.status}${t.status === "reported" && t.reportStatus && t.reportStatus !== "done" ? ` (${one(t.reportStatus)})` : ""}${t.lastCommit ? ` @${t.lastCommit.slice(0, 7)}` : ""}${t.evidenceOk ? " ✓verify" : ""}${t.reviewOk ? " ✓review" : ""} — ${one(t.title)}`);
  if (rows.length) {
    lines.push("Tasks:");
    const room = Math.max(3, 30 - lines.length); // never squeeze the task list out
    lines.push(...(rows.length > room ? [...rows.slice(0, room - 1), `- … +${rows.length - room + 1} more`] : rows));
  }
  return lines.join("\n") + "\n";
}
