import { statSync } from "node:fs";
import { join } from "node:path";
import { appendPlugin, refreshDigest, supervisorAddress, type Ctx } from "./context";
import { changedFiles, git, unsafeGitDrivers } from "./git";
import type { Identity } from "./identity";
import { readJson, writeJson } from "./jsonFile";
import { deriveFeature } from "./store/derive";
import type { SlpEvent } from "./store/events";

interface FeatureWatch { tick: number; lastAt: string; lastSeq: number; lastChange: number }
type WatchState = Record<string, FeatureWatch>;

export const watchKey = (project: string, feature: string): string => `watch:${project}:${feature}`;
/** Untrusted text on one line: any line break or control character (U+0085, U+001C..U+001F, U+2028/9 included) could forge a pack section or blow the line budget. Takes any value, because a timeline item may be off-spec. */
const oneLine = (s: unknown) => String(s ?? "").replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
const cut = (s: unknown, n: number) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const minutes = (from: number, now: Date) => Math.max(0, Math.round((now.getTime() - from) / 60_000));

interface ItemLike { type?: string; name?: string; status?: string; text?: string; detail?: { type?: string; command?: string; filePath?: string; query?: string; exitCode?: number | null } }

/** One line for a timeline item, or null for items the pack leaves out. */
export function summarizeItem(raw: unknown): string | null {
  const it = (raw ?? {}) as ItemLike;
  if (it.type === "tool_call") {
    const d = it.detail ?? {};
    const what = d.type === "shell" ? `$ ${cut(d.command ?? "", 80)}`
      : d.type === "read" || d.type === "edit" || d.type === "write" ? `${d.type} ${cut(d.filePath ?? "", 80)}`
      : d.type === "search" ? `search ${cut(d.query ?? "", 80)}`
      : cut(it.name ?? "tool", 80);
    const result = d.type === "shell" && typeof d.exitCode === "number" ? ` → exit ${d.exitCode}` : it.status === "failed" ? " → failed" : it.status === "running" ? " (running)" : "";
    return `${what}${result}`;
  }
  if (it.type === "assistant_message" && it.text) return `says: ${cut(it.text, 120)}`;
  if (it.type === "user_message" && it.text) return `got: ${cut(it.text, 120)}`;
  return null;
}

/** Commands run three or more times and files read four or more times. */
export function repeats(items: readonly unknown[]): string[] {
  const shells = new Map<string, number>(); const reads = new Map<string, number>();
  for (const raw of items) {
    const it = (raw ?? {}) as ItemLike;
    if (it.type !== "tool_call") continue;
    if (it.detail?.type === "shell" && it.detail.command) shells.set(it.detail.command, (shells.get(it.detail.command) ?? 0) + 1);
    if (it.detail?.type === "read" && it.detail.filePath) reads.set(it.detail.filePath, (reads.get(it.detail.filePath) ?? 0) + 1);
  }
  return [
    ...[...shells].filter(([, n]) => n >= 3).map(([c, n]) => `ran ${n}× $ ${cut(c, 60)}`),
    ...[...reads].filter(([, n]) => n >= 4).map(([f, n]) => `read ${n}× ${cut(f, 80)}`),
  ];
}

async function timeline(ctx: Ctx, agentId: string, limit: number): Promise<unknown[]> {
  const page = await ctx.paseo().agents.ref(agentId).timeline.refetch({ direction: "tail", limit }).catch(() => ({ entries: [] }));
  return (page.entries ?? []).map((e) => e.item ?? e);
}

/** Latest watch or intervene verdict per agent, until a later ok verdict closes it. */
export function openItems(events: readonly SlpEvent[]): Map<string, string> {
  const open = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== "watch_result") continue;
    for (const v of (e.data.verdicts as Array<{ agent: string; verdict: string; note?: string }> | undefined) ?? []) {
      if (v.verdict === "ok") open.delete(v.agent);
      else open.set(v.agent, `${v.verdict} at #${e.data.tick}${v.note ? `: ${v.note}` : ""}`);
    }
  }
  return open;
}

/** Tasks a Peer reported on that the Lead has not decided yet (accept or release), with how long they have waited. */
export function waitingForLead(events: readonly SlpEvent[], feature: string, now: Date): string[] {
  const out: string[] = [];
  for (const t of deriveFeature(feature, events).tasks.values()) {
    if (t.status !== "reported") continue;
    const report = [...events].reverse().find((e) => e.kind === "report" && e.data.task === t.id);
    out.push(`- ${t.id} (${t.reportStatus ?? "reported"}): reported ${report ? minutes(Date.parse(report.ts), now) : "?"} min ago, no decision from the Lead yet`);
  }
  return out;
}

/** Newest mtime among the worktree's uncommitted files; 0 when nothing is uncommitted. */
function lastFileChange(worktree: string): number {
  if (unsafeGitDrivers(worktree).length) return 0; // git status would run the repo's drivers outside the sandbox
  let newest = 0;
  for (const f of changedFiles(worktree)) {
    try { newest = Math.max(newest, statSync(join(worktree, f)).mtimeMs); } catch { /* deleted in the worktree */ }
  }
  return newest;
}

/** Events that count as work; the watch's own bookkeeping does not. */
function activitySeq(events: readonly SlpEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "watch_result" || (e.kind === "ops" && String(e.data.type).startsWith("watch_"))) continue;
    return e.seq;
  }
  return 0;
}

const label = (i: Identity) => (i.role === "lead" ? "lead" : i.role === "peer-review" ? `review ${i.task}` : String(i.task));
const watchedAgents = (ctx: Ctx, project: string, feature: string) => ctx.identities.active(project).filter((i) => i.feature === feature && i.role !== "supervisor" && i.agentId);

async function agentPack(ctx: Ctx, ident: Identity, now: Date): Promise<string[]> {
  const agentId = ident.agentId!;
  const ref = ctx.paseo().agents.ref(agentId);
  await ref.refresh().catch(() => undefined);
  const status = ref.status ?? "unknown";
  const perm = ctx.pendingPermissions.get(agentId);
  const resume = ctx.resumes.jobs().find((j) => j.agentId === agentId);
  const state = perm ? `waiting for the human's permission: ${perm.name} (${minutes(perm.since, now)} min)`
    : resume ? `waiting for the ${resume.vendor} limit to reset at ${resume.at.slice(11, 16)}`
    : status;
  const started = ctx.turnStarts.get(agentId);
  const lines = [`## ${label(ident)} (${ident.role}, ${agentId})`, `- status: ${state}${status === "running" && started ? `, turn running ${minutes(started, now)} min` : ""}`];
  if (ident.role === "peer-impl" && ident.feature && ident.task && ident.worktree) {
    const events = ctx.stores.feature(ident.project, ident.feature).all();
    const task = deriveFeature(ident.feature, events).tasks.get(ident.task);
    const assigned = [...events].reverse().find((e) => e.kind === "assign" && e.data.task === ident.task);
    const fails = events.filter((e) => e.kind === "evidence" && e.data.scope === "task" && e.data.task === ident.task && e.data.exitCode !== 0 && (!assigned || e.seq > assigned.seq)).length;
    if (task) lines.push(`- task ${task.id}: ${cut(task.title, 120)}${assigned ? ` (assigned ${minutes(Date.parse(assigned.ts), now)} min ago)` : ""}, failed verifies: ${fails}`);
    if (unsafeGitDrivers(ident.worktree).length) {
      lines.push("- files: not inspected (the repo's git config runs commands on git status; a human must remove them)");
    } else {
      const changed = changedFiles(ident.worktree);
      const last = lastFileChange(ident.worktree);
      const base = assigned ? String(assigned.data.base) : null;
      const stat = base ? git(ident.worktree, ["diff", "--shortstat", "--ignore-submodules=all", base], true).stdout.trim() : "";
      lines.push(`- files: ${changed.length ? `${changed.length} uncommitted (${changed.slice(0, 5).map(oneLine).join(", ")}${changed.length > 5 ? ", …" : ""}), last change ${last ? `${minutes(last, now)} min ago` : "unknown"}` : "no uncommitted changes"}${stat ? `; vs BASE: ${stat}` : ""}`);
    }
  }
  const items = await timeline(ctx, agentId, 60);
  const toolCalls = items.filter((i) => (i as ItemLike).type === "tool_call");
  const calls = toolCalls.slice(-ctx.config.watch.packToolCalls).map(summarizeItem).filter((s): s is string => s !== null);
  // "N of M" tells the Supervisor the pack is cut, so a missing call is an observation gap, not a violation.
  lines.push(calls.length ? `- last ${calls.length} of ${toolCalls.length} tool calls${toolCalls.length > calls.length ? " (more: slp_activity)" : ""}:` : "- last tool calls: none", ...calls.map((c) => `  - ${c}`));
  const reps = repeats(items);
  if (reps.length) lines.push(`- repeated: ${reps.join("; ")}`);
  return lines;
}

export async function buildPack(ctx: Ctx, project: string, feature: string, tick: number): Promise<string> {
  const now = ctx.now();
  const parts = [`[SLP watch #${tick} · ${feature}]`, refreshDigest(ctx, project, feature).trimEnd()];
  for (const a of watchedAgents(ctx, project, feature)) parts.push((await agentPack(ctx, a, now)).join("\n"));
  const events = ctx.stores.feature(project, feature).all();
  const waiting = waitingForLead(events, feature, now);
  if (waiting.length) parts.push(["## Waiting for the Lead's decision", ...waiting].join("\n"));
  const open = openItems(events);
  if (open.size) parts.push(["## Your open items (close one with verdict ok and a note saying what resolved it)", ...[...open].map(([agent, s]) => `- ${agent}: ${s}`)].join("\n"));
  parts.push(`Judge each agent: ok, watch (look again next time) or intervene. Record it with slp_watch_result { tick: ${tick}, verdicts: [{ agent, verdict, note }] }, then end your turn. If every agent is ok, tell the human one line. To intervene, steer the Lead (slp_send { to: "lead", mode: "steer" }) with one observation and one open question; never message a Peer. A cut-off pack is an observation gap, not a violation: read slp_activity first.`);
  return parts.join("\n\n");
}

/** Every watch.intervalMinutes, sends each running feature's Supervisor a pack, unless nothing happened since the last one. */
export async function watchTick(ctx: Ctx): Promise<void> {
  if (!ctx.config.flags.watch) return;
  const now = ctx.now();
  for (const project of Object.keys(ctx.config.projects)) {
    const file = ctx.stores.file(project, "watch.json");
    const state = readJson<WatchState>(file, {});
    for (const feature of ctx.stores.features(project)) {
      let events: readonly SlpEvent[];
      try { events = ctx.stores.feature(project, feature).all(); } catch (error) { ctx.log(`watch skipped ${project}/${feature}: its log is unreadable`, error); continue; }
      const live = ctx.identities.current("lead", project, feature) && ctx.identities.current("supervisor", project, feature);
      if (!live || deriveFeature(feature, events).halted || events.some((e) => e.kind === "shipped")) { delete state[feature]; continue; }
      const agents = watchedAgents(ctx, project, feature);
      const change = Math.max(0, ...agents.filter((a) => a.role === "peer-impl" && a.worktree).map((a) => lastFileChange(a.worktree!)));
      const w = state[feature];
      if (!w) { state[feature] = { tick: 0, lastAt: now.toISOString(), lastSeq: activitySeq(events), lastChange: change }; continue; }
      if (now.getTime() - Date.parse(w.lastAt) < ctx.config.watch.intervalMinutes * 60_000) continue;
      w.lastAt = now.toISOString();
      const statuses = await Promise.all(agents.map(async (a) => { const r = ctx.paseo().agents.ref(a.agentId!); await r.refresh().catch(() => undefined); return r.status; }));
      const seq = activitySeq(events);
      if (!statuses.includes("running") && seq === w.lastSeq && change <= w.lastChange) {
        appendPlugin(ctx, project, feature, { kind: "ops", data: { type: "watch_skipped" } });
        continue;
      }
      const key = watchKey(project, feature);
      if (w.tick > 0 && !events.some((e) => e.kind === "watch_result" && Number(e.data.tick) === w.tick) && !ctx.router.pending().some((p) => p.key === key)) {
        appendPlugin(ctx, project, feature, { kind: "ops", data: { type: "watch_unanswered", tick: w.tick } });
      }
      w.tick += 1; w.lastSeq = seq; w.lastChange = change;
      ctx.router.enqueue(supervisorAddress(project, feature), await buildPack(ctx, project, feature, w.tick), { key });
      appendPlugin(ctx, project, feature, { kind: "ops", data: { type: "watch_sent", tick: w.tick, summary: `#${w.tick}` } });
    }
    writeJson(file, state);
  }
  await ctx.router.flush().catch((e) => ctx.log("router flush failed", e));
}
