import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendPlugin, featuresTouching, leadAddress, notify, repoOf, supervisorAddress, syncHumanMessages, type Ctx } from "./context";
import { processChallengeEvidence } from "./evidence";
import { changedFiles, trackedChanges } from "./git";
import type { TimelineItemLike } from "./human";
import type { Identity } from "./identity";
import { decidePermission, type PermissionLike } from "./permissions";
import type { Address } from "./router";
import { deriveFeature } from "./store/derive";
import { finalizeReview, pipelineDeps, processReportFor, retireAgent } from "./tools/work";
import { humanWaits, watchTick } from "./watch";
import { isLimitTurn, resumeAt, usageWindowsFrom } from "./watchdog";

/** The human's prompt is already in the timeline when the turn starts; record it before any tool checks a quote. */
export async function onTurnStarted(ctx: Ctx, agentId: string): Promise<void> {
  ctx.turnStarts.set(agentId, Date.now());
  ctx.resumes.done(agentId); // the agent is working again: a pending resume would only interrupt it (attempts are kept)
  const ident = ctx.identities.byAgent(agentId);
  if (ident) await syncHumanMessages(ctx, ident);
}

async function scheduleResume(ctx: Ctx, ident: Identity): Promise<void> {
  if (!ctx.config.flags.autoResume || !ident.agentId) return;
  const vendor = ctx.setup().vendor[ident.role];
  const attempt = ctx.resumes.attemptOf(ident.agentId) + 1;
  if (attempt > ctx.config.limits.resumeMaxAttempts) {
    ctx.resumes.done(ident.agentId);
    if (ident.feature && ident.role !== "supervisor") notify(ctx, supervisorAddress(ident.project, ident.feature), `${ident.role}${ident.task ? ` ${ident.task}` : ""} (${ident.feature ?? ident.project}) is still blocked by the ${vendor} usage limit after ${attempt - 1} resumes.`);
    return;
  }
  const windows = usageWindowsFrom(await ctx.paseo().providers.listUsage().catch(() => []));
  const at = resumeAt(windows, vendor, ctx.now(), attempt);
  ctx.resumes.schedule({ agentId: ident.agentId, vendor, at: at.toISOString(), attempt });
  appendPlugin(ctx, ident.project, ident.feature, { kind: "ops", data: { type: "limit_hit", agentId: ident.agentId, vendor, resumeAt: at.toISOString(), attempt, summary: `${vendor} limit; resume ${at.toISOString().slice(11, 16)} (${attempt}/${ctx.config.limits.resumeMaxAttempts})` } });
}

/** Where the router finds this agent. Plugin messages to an SLP agent go through the router, which waits for `idle`; a direct send would interrupt a running turn. */
const addressOf = (i: Identity): Address => ({ role: i.role, project: i.project, feature: i.feature, task: i.task });

/** Best effort and last: a sibling feature's unreadable log must not stop the Lead's notice or the Peer's "Verify failed". */
function alertTouchingSupervisors(ctx: Ctx, ident: Identity, commit: string): void {
  try {
    const feature = ident.feature!;
    const commitEv = [...ctx.stores.feature(ident.project, feature).all()].reverse().find((e) => e.kind === "commit" && e.data.hash === commit);
    for (const other of featuresTouching(ctx, ident.project, feature, (commitEv?.data.files as string[] | undefined) ?? [])) {
      if (ctx.identities.current("supervisor", ident.project, other.slug)) notify(ctx, supervisorAddress(ident.project, other.slug), `${feature} ${ident.task} committed files in your touch set: ${other.files.join(", ")}. Check with your Lead whether the plans collide.`);
    }
  } catch (error) { ctx.log("touch-set alert failed", error); }
}

const REPORT_EXCERPT = 3000;

/** What the Peer said in its latest report, so the Lead sees concerns and blockers, not only a commit hash. */
function peerSaid(ctx: Ctx, ident: Identity): string {
  const report = [...ctx.stores.feature(ident.project, ident.feature!).all()].reverse().find((e) => e.kind === "report" && e.by_agent === ident.agentId);
  if (!report) return "";
  const path = typeof report.data.reportPath === "string" ? report.data.reportPath : null;
  const text = path && existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  const body = text.length > REPORT_EXCERPT ? `${text.slice(0, REPORT_EXCERPT)}\n… (truncated)` : text;
  return `\nPeer status: ${String(report.data.status)} — ${String(report.data.message ?? "")}${body ? `\nReport:\n${body}` : ""}`;
}

async function afterPeerImplTurn(ctx: Ctx, ident: Identity, calledTool: boolean): Promise<void> {
  if (deriveFeature(ident.feature!, ctx.stores.feature(ident.project, ident.feature!).all()).halted) return; // nothing lands after the human changed the goal
  const out = await processReportFor(ctx, ident);
  const feature = ident.feature!;
  const said = out ? peerSaid(ctx, ident) : "";
  const events = ctx.stores.feature(ident.project, feature).all();
  const challenge = [...events].reverse().find((e) => e.kind === "challenge" && e.by_agent === ident.agentId && !events.some((x) => x.data.challengeSeq === e.seq));
  if (challenge) {
    const task = deriveFeature(feature, events).tasks.get(ident.task!);
    if (task) {
      const ev = await processChallengeEvidence(pipelineDeps(ctx, ident.project, feature), task, challenge);
      if (ev) notify(ctx, leadAddress(ident.project, feature), `Evidence for ${challenge.id}: ${ev.commit ? `commit ${ev.commit.slice(0, 7)}, ` : ""}repro exit ${ev.exitCode ?? "n/a"} (sandboxed).`);
    }
  }
  // One notice per report and result: a report seen again on a later turn (the human talked to the Peer, a reconcile replay) is not news (T21 B-5).
  const report = out ? [...events].reverse().find((e) => e.kind === "report" && e.by_agent === ident.agentId) : undefined;
  const result = !out ? null : out.outcome === "committed" ? (out.runnerError ? "runner" : out.evidenceOk === null ? "skipped" : out.evidenceOk ? "ok" : "fail") : out.outcome;
  if (out && events.some((e) => e.kind === "ops" && e.data.type === "report_notified" && e.data.reportSeq === (report?.seq ?? null) && e.data.result === result)) {
    // Checked before nudges.reset, so repeated dirty turns still reach noReportNudges and escalate.
    // Files the plugin left out on purpose (sensitive, protected) are not new work.
    const leftOut = new Set(out.outcome === "committed" ? [...out.flags.excludedSensitive, ...out.flags.excludedProtected] : []);
    if (!calledTool && ident.worktree && changedFiles(ident.worktree).some((f) => !leftOut.has(f))) await nudgeOrEscalate(ctx, ident);
    return;
  }
  const told = () => {
    if (!ctx.router.durable) { ctx.log(`router queue not on disk; ${ident.task}'s notice will be sent again`); return; }
    appendPlugin(ctx, ident.project, feature, { kind: "ops", data: { type: "report_notified", task: ident.task, reportSeq: report?.seq ?? null, result, commit: out?.outcome === "committed" ? out.commit : null, summary: `${ident.task}: report ${report?.seq ?? "?"} notified (${result})` } });
  };
  if (out?.outcome === "committed") {
    ctx.nudges.reset(ident.agentId!);
    const flags = out.flags.outsideTouchSet.length ? ` Outside touch set: ${out.flags.outsideTouchSet.join(", ")}.` : "";
    const excluded = out.flags.excludedSensitive.length ? ` Excluded sensitive files: ${out.flags.excludedSensitive.join(", ")}.` : "";
    const protectedFiles = out.flags.excludedProtected.length ? ` Not committed (git hooks, paseo.json or agent settings; a human must change these): ${out.flags.excludedProtected.join(", ")}.` : "";
    if (out.runnerError) {
      notify(ctx, supervisorAddress(ident.project, feature), `The sandbox runner is broken, so ${feature} ${ident.task} @${out.commit.slice(0, 7)} cannot be verified: ${out.runnerError}. Fix sandbox.runner in ~/.slp/config.json; the plugin re-verifies on the Peer's next turn or on restart.`);
      notify(ctx, leadAddress(ident.project, feature), `${ident.task} committed ${out.commit.slice(0, 7)}; verification waits on the sandbox runner (the Supervisor has been told).${flags}${excluded}${protectedFiles}${said}`);
      told();
      alertTouchingSupervisors(ctx, ident, out.commit);
      return;
    }
    notify(ctx, leadAddress(ident.project, feature), `${ident.task} committed ${out.commit.slice(0, 7)}, verify exit ${out.evidenceOk === null ? "skipped" : out.evidenceOk ? "0 ✓" : "non-zero ✗"}.${flags}${excluded}${protectedFiles}${said}`);
    if (out.evidenceOk === false) {
      const ev = [...ctx.stores.feature(ident.project, feature).all()].reverse().find((e) => e.kind === "evidence" && e.data.commit === out.commit);
      notify(ctx, addressOf(ident), `Verify failed on ${out.commit.slice(0, 7)} (exit ${String(ev?.data.exitCode)}):\n${String(ev?.data.stderrTail ?? "").slice(-1500)}\nFix it and slp_report again.`);
    }
    told();
    alertTouchingSupervisors(ctx, ident, out.commit);
    return;
  }
  if (out?.outcome === "blocked") {
    ctx.nudges.reset(ident.agentId!);
    notify(ctx, leadAddress(ident.project, feature), `${ident.task} is blocked; the Peer changed no files.${said}\nAnswer with slp_send {to: "${ident.task}"}, or slp_release the task.`);
    told();
    return;
  }
  if (out?.outcome === "rejected") {
    notify(ctx, addressOf(ident), `Your report was not committed: ${out.reason}. Fix it and slp_report again.`);
    told();
    return;
  }
  if (!calledTool) await nudgeOrEscalate(ctx, ident);
}

async function nudgeOrEscalate(ctx: Ctx, ident: Identity): Promise<void> {
  if (ctx.nudges.shouldNudge(ident.agentId!, ctx.config.limits.noReportNudges)) {
    // Each role's own report tool (rev 5.10 F4): a reviewer has slp_review, not slp_report.
    const finish = ident.role === "peer-review" ? "slp_review" : "slp_report";
    notify(ctx, addressOf(ident), `You ended your turn without ${finish}, slp_challenge or slp_ask. Finish with one of them.`);
  } else {
    notify(ctx, leadAddress(ident.project, ident.feature!), `${ident.role} ${ident.task} stopped without reporting.`);
  }
}

async function afterReviewTurn(ctx: Ctx, ident: Identity, calledTool: boolean): Promise<void> {
  if (ident.worktree && trackedChanges(ident.worktree).length > 0) {
    appendPlugin(ctx, ident.project, ident.feature, { kind: "ops", data: { type: "review_invalidated", task: ident.task, commit: ident.reviewCommit, summary: `review of ${ident.task} changed tracked files` } });
    await retireAgent(ctx, ident, repoOf(ctx, ident.project));
    notify(ctx, leadAddress(ident.project, ident.feature!), `The reviewer of ${ident.task} changed tracked files; its review is invalid and it was stopped. Spawn a new reviewer.`);
    return;
  }
  finalizeReview(ctx, ident); // the review counts, and reaches the Lead, only now
  // A reviewer reviews one commit; once its review counted, a later turn (a question from the human or the Lead) needs no tool (T21 B-7).
  const counted = ctx.stores.feature(ident.project, ident.feature!).all().some((e) => e.kind === "ops" && e.data.type === "review_checked" && e.data.agentId === ident.agentId);
  if (!calledTool && !counted) await nudgeOrEscalate(ctx, ident);
}

async function maybeAskForCheckpoint(ctx: Ctx, ident: Identity): Promise<void> {
  const ref = ctx.paseo().agents.ref(ident.agentId!);
  await ref.refresh().catch(() => undefined);
  const u = ref.lastUsage;
  if (!u?.contextWindowMaxTokens || !u.contextWindowUsedTokens) return;
  const ratio = u.contextWindowUsedTokens / u.contextWindowMaxTokens;
  if (ratio < ctx.config.rotation.contextRatio || ctx.flags.checkpointAsked.has(ident.tokenHash)) return;
  ctx.flags.checkpointAsked.add(ident.tokenHash);
  notify(ctx, addressOf(ident), `Your context is at ${Math.round(ratio * 100)}%. Call slp_checkpoint now, then end your turn.`);
}

/** `replay`: reconcile, after a restart, replays a turn end for an idle agent; the in-memory tool-call marks are gone, so it must not read as "ended without reporting". */
type TurnEnded = { agent: { id: string }; outcome: { kind: string; error?: { message: string } }; replay?: boolean };
const chains = new WeakMap<Ctx, Map<string, Promise<void>>>();

/** Runs one agent's turn-end handling at a time, so a real turn_ended and reconcile never process the same report together. */
export function onTurnEnded(ctx: Ctx, ev: TurnEnded): Promise<void> {
  const byAgent = chains.get(ctx) ?? new Map<string, Promise<void>>();
  chains.set(ctx, byAgent);
  const next = (byAgent.get(ev.agent.id) ?? Promise.resolve()).then(() => turnEnded(ctx, ev));
  byAgent.set(ev.agent.id, next.catch(() => undefined));
  return next;
}

async function turnEnded(ctx: Ctx, ev: TurnEnded): Promise<void> {
  const ident = ctx.identities.byAgent(ev.agent.id);
  if (!ident) return;
  await syncHumanMessages(ctx, ident).catch(() => undefined);
  const page = await ctx.paseo().agents.ref(ev.agent.id).timeline.refetch({ direction: "tail", limit: 30 }).catch(() => ({ entries: [] }));
  const items = (page.entries ?? []).map((e) => (e.item ?? e) as TimelineItemLike);
  const lastText = [...items].reverse().find((i) => i.type === "assistant_message")?.text ?? null;
  if (isLimitTurn(ev.outcome, lastText)) { await scheduleResume(ctx, ident); return; }
  ctx.resumes.clear(ev.agent.id);
  ctx.pendingPermissions.delete(ev.agent.id);
  const lastCall = ctx.toolCalls.get(ev.agent.id);
  // Only report tools mark a call (m1); a turn the human canceled, or one replayed by reconcile, is not "stopped without reporting".
  const calledTool = (lastCall !== undefined && lastCall >= (ctx.turnStarts.get(ev.agent.id) ?? 0)) || ev.outcome.kind === "canceled" || ev.replay === true;
  if (ident.role === "peer-impl") await afterPeerImplTurn(ctx, ident, calledTool);
  if (ident.role === "peer-review") await afterReviewTurn(ctx, ident, calledTool);
  if (ident.role === "supervisor" || ident.role === "lead") await maybeAskForCheckpoint(ctx, ident);
  await ctx.router.flush();
}

/** `defer` means the plugin does not decide: the request stays pending in the app for the human. */
export async function onPermissionRequested(ctx: Ctx, agentId: string, request: PermissionLike): Promise<void> {
  const ident = ctx.identities.byAgent(agentId);
  let vendor: "claude" | "codex" | undefined;
  try { vendor = ident ? ctx.setup().vendor[ident.role] : undefined; } catch { vendor = undefined; } // setup not loaded: decide nothing new
  const repo = ident ? ctx.projects.get(ident.project)?.repo : undefined;
  const readRoots = ident && repo ? [repo, join(ctx.worktreeRoot, ident.project)] : [];
  const decision = decidePermission(request, ident, { deniedRoots: ctx.stateDirs, vendor, readRoots });
  if (decision.action === "defer" && ident) ctx.pendingPermissions.set(agentId, { name: request.name ?? request.kind ?? "permission", since: ctx.now().getTime() });
  if (decision.action === "ignore" || decision.action === "defer" || !ident) return;
  const ref = ctx.paseo().agents.ref(agentId);
  if (decision.action === "allow") { await ref.respondToPermission({ requestId: request.id, response: { behavior: "allow" } }); return; }
  await ref.respondToPermission({ requestId: request.id, response: { behavior: "deny", message: decision.message } });
}

export function onPermissionResolved(ctx: Ctx, agentId: string): void {
  ctx.pendingPermissions.delete(agentId);
}

export function onAgentArchived(ctx: Ctx, agentId: string): void {
  const ident = ctx.identities.byAgent(agentId);
  if (ident) ctx.identities.retire(ident.tokenHash);
}

/** An agent that closed or that the daemon no longer knows: retire it (it stops counting as a writer) and tell its parent role. */
function retireLost(ctx: Ctx, ident: Identity): void {
  ctx.identities.retire(ident.tokenHash);
  ctx.pendingPermissions.delete(ident.agentId ?? "");
  if (ident.agentId) ctx.resumes.clear(ident.agentId);
  if (!ident.feature) return;
  if (ident.role === "peer-impl" || ident.role === "peer-review") notify(ctx, leadAddress(ident.project, ident.feature), `${ident.role} ${ident.task} is gone (closed or lost by the daemon). Its worktree and branch are kept; spawn a new Peer to continue.`);
  if (ident.role === "lead") notify(ctx, supervisorAddress(ident.project, ident.feature), `The lead of ${ident.feature} is gone (closed or lost by the daemon). Start a new one with slp_spawn {role: "lead"}; it resumes in the same worktree.`);
}

export function onAgentClosed(ctx: Ctx, agentId: string): void {
  const ident = ctx.identities.byAgent(agentId);
  if (ident) retireLost(ctx, ident);
}

const ticking = new WeakSet<Ctx>();

/** Single-flight: an SDK call can outlast the 30 s timer, and two ticks at once would send the same resume twice (review Codex 2026-10-22, round 3). */
export async function tick(ctx: Ctx): Promise<void> {
  if (ticking.has(ctx)) return;
  ticking.add(ctx);
  try { await tickOnce(ctx); } finally { ticking.delete(ctx); }
}

async function tickOnce(ctx: Ctx): Promise<void> {
  const resume = (agentId: string) => ctx.paseo().agents.ref(agentId).send("[SLP plugin] The usage limit has reset. Continue the work you were doing.", { messageId: ctx.router.issue() });
  // One resume per 30 s tick, oldest first: that is the stagger, and nothing lives only in a timer. A failed send moves to the back
  // of the line for a minute instead of blocking the others (review Codex 2026-10-22, round 2).
  const [job] = [...ctx.resumes.due(ctx.now())].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (job) {
    const ref = ctx.paseo().agents.ref(job.agentId);
    await ref.refresh().catch(() => undefined);
    // Running means someone already resumed it; sending now would interrupt that turn (the SDK default) (review Codex 2026-10-22, round 6).
    if (ref.status === "running") ctx.resumes.done(job.agentId, job);
    else try { await resume(job.agentId); ctx.resumes.done(job.agentId, job); } // a newer job scheduled meanwhile survives
    catch (error) {
      ctx.resumes.postpone(job, new Date(ctx.now().getTime() + 60_000).toISOString());
      ctx.log(`resume of ${job.agentId} failed; retrying in a minute`, error);
    }
  }
  for (const project of ctx.projects.names()) {
    for (const feature of ctx.stores.features(project)) {
      // One feature's unreadable log must not stop the other features' nudges, the watch tick or the router flush.
      try {
        const st = deriveFeature(feature, ctx.stores.feature(project, feature).all());
        for (const c of st.challenges.values()) {
          if (!c.open || c.byRole === "supervisor") continue;
          const age = (ctx.now().getTime() - Date.parse(c.ts)) / 60_000;
          const limit = ctx.config.limits.challengeAnswerMinutes;
          const key = `${project}/${feature}/${c.id}`; // C1 exists in every feature (review Codex 2026-10-22)
          if (age > 2 * limit && !ctx.flags.challengeNudged.has(`${key}:sup`)) { ctx.flags.challengeNudged.add(`${key}:sup`); notify(ctx, supervisorAddress(project, feature), `${feature}: challenge ${c.id} on ${c.target} has waited ${Math.round(age)} min without an answer from the Lead.`); }
          else if (age > limit && !ctx.flags.challengeNudged.has(`${key}:lead`)) { ctx.flags.challengeNudged.add(`${key}:lead`); notify(ctx, leadAddress(project, feature), `${c.id} has waited ${Math.round(age)} min. Resolve it (slp_resolve / slp_rule) or escalate it.`); }
        }
        if (ctx.identities.current("supervisor", project, feature)) {
          for (const w of humanWaits(ctx, project, feature, ctx.now())) {
            if (ctx.flags.humanReminded.has(w.key)) continue;
            ctx.flags.humanReminded.add(w.key);
            // The notice may sit in the queue while the Supervisor works; it checks the state before it asks (review Codex 2026-10-23).
            notify(ctx, supervisorAddress(project, feature), `${feature}: "${w.what}" has waited on the human for ${w.minutes} min. Check slp_state first; if it still waits, remind them in one line in your tab, otherwise ignore this.`);
          }
        }
      } catch (error) { ctx.log(`challenge scan of ${project}/${feature} failed`, error); }
    }
  }
  await watchTick(ctx).catch((error) => ctx.log("watch tick failed", error));
  await ctx.router.flush();
}

export async function reconcile(ctx: Ctx): Promise<void> {
  for (const project of ctx.projects.names()) {
    // Opening a store is what logs a cut-off last line (store/registry.ts); after a restart nothing else opens a feature without agents.
    for (const feature of ctx.stores.features(project)) {
      try { ctx.stores.feature(project, feature); } catch (error) { ctx.log(`could not open the log of ${project}/${feature}`, error); }
    }
    for (const ident of ctx.identities.active(project)) {
      if (!ident.agentId) continue;
      // One agent's failure (a missing worktree, an untrusted git dir) must not stop the others or the other projects.
      try {
        const ref = ctx.paseo().agents.ref(ident.agentId);
        const snapshot = await ref.refresh().catch(() => undefined); // undefined: could not ask; keep the agent
        if (snapshot === null || ref.status === "closed") { retireLost(ctx, ident); continue; }
        // pendingPermissions lives in memory: after a plugin reload, a popup already open would never be reminded (T21 row 24).
        // Its age restarts at the reload; the snapshot carries no request time.
        const open = ref.pendingPermissions?.[0];
        if (open && !ctx.pendingPermissions.has(ident.agentId)) ctx.pendingPermissions.set(ident.agentId, { name: String(open.name ?? open.kind ?? "permission"), since: ctx.now().getTime() });
        // An agent waiting for a usage-limit resume has nothing new to process; replaying its old limit reply would burn a resume attempt (review Codex 2026-10-22, round 2).
        const waiting = ctx.resumes.jobs().some((j) => j.agentId === ident.agentId);
        if (ref.status === "idle" && ident.role === "peer-impl" && !waiting) await onTurnEnded(ctx, { agent: { id: ident.agentId }, outcome: { kind: "completed" }, replay: true });
      } catch (error) { ctx.log(`reconcile of ${ident.role} ${ident.agentId} failed`, error); }
    }
    appendPlugin(ctx, project, null, { kind: "ops", data: { type: "reconcile", queued: ctx.router.pending().length, resumes: ctx.resumes.jobs().length } });
  }
  await ctx.router.flush();
}
