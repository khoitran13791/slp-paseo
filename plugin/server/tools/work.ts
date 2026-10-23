import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { appendAs, appendPlugin, claimContracts, humanMessagesFor, leadAddress, notify, refreshDigest, releaseContracts, requireFeature, routeFrom, supervisorAddress, syncHumanMessages, type CreateOptions, type Ctx } from "../context";
import { processReport, verifyFeature, type PipelineDeps, type ReportOutcome } from "../evidence";
import { addWorktree, changedFiles, deleteBranch, diffStat, git, headOf, hooksDir, isProtectedPath, isSensitivePath, mergeNoHooks, pushNoHooks, removeWorktree, startMerge, unsafeGitDrivers } from "../git";
import type { Identity } from "../identity";
import type { ToolDef } from "../mcp/server";
import { contractQueues, contractsOf, holderOf, isContract } from "../planCheck";
import { leadKickoff, reviewBrief, taskBrief } from "../prompts";
import { verifyShipApproval } from "../quote";
import { normalizeModel, providerString, type Role } from "../roles";
import { acceptanceBlockers, deriveFeature, taskDef, type FeatureState } from "../store/derive";
import { defineTool, ToolError } from "./define";

const SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export function pipelineDeps(ctx: Ctx, project: string, feature: string): PipelineDeps {
  return { store: ctx.stores.feature(project, feature), config: ctx.config, project: ctx.config.projects[project]!, run: ctx.run, now: () => ctx.now() };
}
const stateOf = (ctx: Ctx, project: string, feature: string): FeatureState => deriveFeature(feature, ctx.stores.feature(project, feature).all());

type Placement =
  | { kind: "worktree"; branch: string; base: string } // SLP creates the worktree off `base` (hooks off) and a directory workspace for it
  | { kind: "workspace"; workspaceId: string; worktree?: string | null } // reuse a workspace (rotation, takeover)
  | { kind: "dir"; cwd: string };                        // the Supervisor's project directory

/** Where an SLP worktree for `branch` lives: outside ~/.paseo/worktrees, so Paseo never runs setup or teardown for it (T9). */
const worktreePath = (ctx: Ctx, project: string, branch: string): string => join(ctx.worktreeRoot, project, branch.replaceAll("/", "-"));

async function createAgent(ctx: Ctx, role: Role, o: { project: string; feature: string | null; task: string | null; placement: Placement; reviewCommit?: string | null; parent: string | null; title: string; prompt: string; model?: string; deferPrompt?: boolean }): Promise<{ agentId: string; ident: Identity }> {
  const minted = ctx.identities.mint({ role, project: o.project, feature: o.feature, task: o.task, reviewCommit: o.reviewCommit ?? null, parentAgentId: o.parent });
  const profile = ctx.setup().profile[role] ?? {};
  const opts: CreateOptions = {
    config: { provider: providerString(role, o.model ?? profile.model), ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}), ...(profile.featureValues ? { featureValues: profile.featureValues } : {}) },
    ...(o.parent ? { parent: o.parent } : {}), title: o.title, env: { SLP_TOKEN: minted.token },
    ...(o.deferPrompt ? {} : { prompt: o.prompt, clientMessageId: ctx.router.issue() }),
  };
  const p = o.placement;
  const repo = ctx.config.projects[o.project]!.repo;
  if (p.kind !== "dir") {
    const drivers = unsafeGitDrivers(p.kind === "workspace" && p.worktree ? p.worktree : repo);
    if (drivers.length) { ctx.identities.retire(minted.tokenHash); throw new ToolError(`SLP will not run agents in ${o.project}: its git config runs commands on add/status/merge/diff that a Peer could change (${drivers.join("; ")}). Remove them, or keep this repo out of SLP.`); }
  }
  let made: { path: string; branch: string } | null = null;
  let agent: { id: string; workspaceId?: string | null };
  try {
    if (p.kind === "worktree") {
      // An explicit workspace wins over `parent` for placement (create-agent/intent.ts resolvePlacement), and `parent` still nests the agent.
      const path = worktreePath(ctx, o.project, p.branch);
      addWorktree(repo, path, p.branch, p.base);
      made = { path, branch: p.branch }; // only now is there something this call owns and must roll back
      const ws = await ctx.paseo().workspaces.create({ source: { kind: "directory", path }, title: o.title });
      const a = await ws.agents.create(opts);
      agent = { id: a.id, workspaceId: a.workspaceId ?? ws.id };
    } else {
      agent = p.kind === "workspace" ? await ctx.paseo().workspaces.ref(p.workspaceId).agents.create(opts) : await ctx.paseo().agents.create({ ...opts, cwd: p.cwd });
    }
  } catch (error) {
    ctx.identities.retire(minted.tokenHash);
    // Undo exactly what this call made: its worktree, then its branch, so a retry can create the same branch again (review Codex 2026-10-22, round 4).
    if (made) { if (removeWorktree(repo, made.path)) deleteBranch(repo, made.branch); else ctx.log(`could not remove ${made.path} after a failed create`); }
    throw error;
  }
  const placed = ctx.identities.byToken(minted.token)!; // the before-create hook (T16) recorded worktree and branch
  if (role !== "supervisor" && !placed.worktree) throw new ToolError("SLP: the plugin hook did not record a worktree for the new agent");
  ctx.identities.place(placed.tokenHash, { worktree: placed.worktree, branch: placed.branch, workspaceId: agent.workspaceId ?? (p.kind === "workspace" ? p.workspaceId : null) });
  return { agentId: agent.id, ident: ctx.identities.byToken(minted.token)! };
}

function activeWriters(ctx: Ctx, project: string): Identity[] {
  return ctx.identities.active(project).filter((i) => i.role === "peer-impl" && i.agentId);
}

/** Retires the identity and archives the agent's workspace (Paseo removes the worktree, keeps the branch). */
/** Retires the identity, archives the agent and its directory workspace, and removes a Peer's or reviewer's SLP worktree (the branch stays). */
export async function retireAgent(ctx: Ctx, i: Identity, repo: string): Promise<void> {
  ctx.identities.retire(i.tokenHash);
  if (i.agentId) ctx.resumes.clear(i.agentId);
  // Messages are addressed by role: a "Verify failed" left for this Peer would reach the next Peer of the same task.
  if (i.role === "peer-impl" || i.role === "peer-review") ctx.router.drop((to) => to.role === i.role && to.project === i.project && to.feature === i.feature && (to.task ?? null) === (i.task ?? null));
  const stopped = i.agentId ? await ctx.paseo().agents.ref(i.agentId).archive().then(() => true, () => false) : true;
  if (i.workspaceId) await ctx.paseo().workspaces.ref(i.workspaceId).archive().catch(() => undefined); // a directory workspace: Paseo only drops the record
  if (i.worktree && (i.role === "peer-impl" || i.role === "peer-review")) {
    if (stopped) { if (!removeWorktree(repo, i.worktree)) ctx.log(`git did not remove ${i.worktree}; left in place`); }
    else ctx.log(`kept ${i.worktree}: could not stop agent ${i.agentId}`);
  }
  if (i.role === "peer-review" && i.branch) deleteBranch(repo, i.branch);
}

async function retireTaskAgents(ctx: Ctx, project: string, feature: string, task: string): Promise<void> {
  const repo = ctx.config.projects[project]!.repo;
  for (const i of ctx.identities.active(project).filter((x) => x.feature === feature && x.task === task && (x.role === "peer-impl" || x.role === "peer-review"))) {
    await retireAgent(ctx, i, repo);
  }
}

/** After a reviewer's turn ends with a clean worktree (T20): count its latest review and pass it to the Lead. Never earlier (review Codex 2026-10-22). */
export function finalizeReview(ctx: Ctx, rev: Identity): boolean {
  const events = ctx.stores.feature(rev.project, rev.feature!).all();
  const review = [...events].reverse().find((e) => e.kind === "review" && e.by_agent === rev.agentId && e.data.commit === rev.reviewCommit);
  if (!review || events.some((e) => e.kind === "ops" && e.data.type === "review_checked" && e.data.reviewSeq === review.seq)) return false;
  appendPlugin(ctx, rev.project, rev.feature, { kind: "ops", data: { type: "review_checked", task: rev.task, commit: review.data.commit, agentId: rev.agentId, reviewSeq: review.seq } });
  const findings = (review.data.findings as Array<{ severity: string; file: string; line?: number; issue: string; command?: string }> | undefined) ?? [];
  const blocking = Number(review.data.blocking ?? 0);
  notify(ctx, leadAddress(rev.project, rev.feature!), `Review of ${rev.task} @${String(review.data.commit).slice(0, 7)}: ${String(review.data.verdict)}, ${blocking} blocking, ${findings.length - blocking} non-blocking.\n${findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.issue}${f.command ? ` (ran: ${f.command})` : ""}`).join("\n")}`);
  refreshDigest(ctx, rev.project, rev.feature!);
  return true;
}

export async function processReportFor(ctx: Ctx, peer: Identity): Promise<ReportOutcome | null> {
  const events = ctx.stores.feature(peer.project, peer.feature!).all();
  const report = [...events].reverse().find((e) => e.kind === "report" && e.by_agent === peer.agentId);
  if (!report) return null;
  const task = stateOf(ctx, peer.project, peer.feature!).tasks.get(peer.task!);
  if (!task || task.agentId !== peer.agentId) return null;
  const out = await processReport(pipelineDeps(ctx, peer.project, peer.feature!), task, report);
  refreshDigest(ctx, peer.project, peer.feature!);
  return out;
}

const spawnQueue = new Map<string, Promise<unknown>>();
/**
 * One slp_spawn per project at a time. The checks (one Peer-impl per feature, writer cap, Lead exists) and the assign event
 * then happen with no gap for a parallel call to slip into (review Codex 2026-10-22: two parallel calls both passed the cap).
 */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (spawnQueue.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  spawnQueue.set(key, next.catch(() => undefined));
  return next;
}

export function workTools(ctx: Ctx): ToolDef[] {
  return [
    defineTool({
      name: "slp_spawn", description: 'Create a Lead (Supervisor only) or a Peer for a task (Lead only). role: "lead" | "peer-impl" | "peer-review". merge_base: start a Peer-impl with the base branch merged in, to resolve conflicts.',
      roles: ["supervisor", "lead"],
      input: z.object({ role: z.enum(["lead", "peer-impl", "peer-review"]), feature: SLUG.optional(), task: z.string().optional(), model: z.string().optional(), prompt: z.string().min(1), merge_base: z.boolean().optional() }),
      run: (who, a) => serial(who.project, async () => {
        const feature = requireFeature(who, a.feature);
        const project = ctx.config.projects[who.project]!;
        const st = stateOf(ctx, who.project, feature);
        if (st.halted) throw new ToolError(`${feature} is halted: the human changed the goal`);
        if (a.role === "lead") {
          if (who.role !== "supervisor") throw new ToolError("only the Supervisor spawns Leads");
          if (!st.brief?.approved) throw new ToolError("the brief is not approved by the human yet");
          if (ctx.identities.current("lead", who.project, feature)) throw new ToolError(`feature ${feature} already has a Lead`);
          const previous = ctx.identities.last("lead", who.project, feature);
          const checkpoint = join(ctx.stores.featureDir(who.project, feature), "checkpoint-lead.md");
          const placement: Placement = previous?.workspaceId ? { kind: "workspace", workspaceId: previous.workspaceId, worktree: previous.worktree } : { kind: "worktree", branch: `feat/${feature}`, base: project.baseBranch };
          const prompt = previous
            ? `[SLP] You take over as Lead for feature ${feature}; the previous Lead stopped. Call slp_state first.\n\n${existsSync(checkpoint) ? `${readFileSync(checkpoint, "utf8")}\n\n` : ""}## Current state\n${refreshDigest(ctx, who.project, feature)}\n\n## Note from the Supervisor\n${a.prompt}`
            : leadKickoff(feature, ctx.stores.readDoc(st.brief.path), a.prompt);
          const { agentId, ident } = await createAgent(ctx, "lead", { project: who.project, feature, task: null, placement, parent: who.agentId, title: `[Lead] ${feature}`, prompt });
          appendAs(ctx, who, feature, { kind: "assign", data: { role: "lead", agentId, worktree: ident.worktree, branch: ident.branch } });
          return `Lead ${agentId} started in ${ident.worktree} on ${ident.branch}.`;
        }
        if (who.role !== "lead") throw new ToolError("only the Lead spawns Peers");
        if (!st.plan?.approved) throw new ToolError("the plan is not approved yet");
        if (!st.spec?.approved) throw new ToolError("the spec is not approved by the human yet");
        const task = st.tasks.get(a.task ?? "");
        if (!task) throw new ToolError(`unknown task ${a.task}`);
        if (a.role === "peer-impl") {
          // A Peer that died leaves its task assigned; a new Peer takes it over in the same workspace (review Codex 2026-10-22).
          const lost = (task.status === "assigned" || task.status === "reported") && !(task.agentId && ctx.identities.byAgent(task.agentId));
          if (!["pending", "stale"].includes(task.status) && !lost) throw new ToolError(`${task.id} is ${task.status}; only pending or stale tasks can be started`);
          if ([...st.tasks.values()].some((t) => t.id !== task.id && (t.status === "assigned" || t.status === "reported"))) throw new ToolError("one Peer-impl at a time per feature: accept or release the running task first");
          const unmet = task.dependsOn.filter((d) => (st.tasks.has(d) ? st.tasks.get(d)!.status !== "accepted" : st.premises.get(d)?.kind === "hypothesis" && st.premises.get(d)!.status !== "confirmed"));
          if (unmet.length) throw new ToolError(`${task.id} depends on ${unmet.join(", ")}, which ${unmet.length > 1 ? "are" : "is"} not accepted or confirmed yet`);
          claimContracts(ctx, who.project, feature, contractsOf([...st.tasks.values()])); // idempotent; repairs a claim lost to a crash right after approval
          const queues = contractQueues(ctx.stores.project(who.project).all());
          const held = task.touchSet.filter((e) => isContract(e) && holderOf(queues, e) !== feature);
          if (held.length) throw new ToolError(`${task.id} touches ${held.map((c) => `${c} (held by ${holderOf(queues, c)})`).join(", ")}; it can start when that feature ships or stops`);
          if (activeWriters(ctx, who.project).length >= project.maxWriters) throw new ToolError(`project writer cap reached (${project.maxWriters}); retry after a task is accepted`);
          const model = task.model ?? a.model ?? ctx.setup().profile["peer-impl"]?.model;
          if (model && ctx.config.models.allowed.length && !ctx.config.models.allowed.map(normalizeModel).includes(normalizeModel(model))) throw new ToolError(`model ${model} is not in models.allowed`);
          if (lost) {
            const previous = ctx.identities.last("peer-impl", who.project, feature, task.id);
            if (!previous?.workspaceId) throw new ToolError(`the Peer of ${task.id} is gone and its workspace is unknown; slp_release ${task.id} to start it over`);
            const takeoverPrompt = `${taskBrief(feature, task, st.premises, a.prompt)}\n\n## You take over\nThe previous Peer on ${task.id} stopped. Its work in this worktree is kept, committed and uncommitted: read git status and git log first, then continue.`;
            const { agentId, ident } = await createAgent(ctx, "peer-impl", { project: who.project, feature, task: task.id, placement: { kind: "workspace", workspaceId: previous.workspaceId, worktree: previous.worktree }, parent: who.agentId, title: `[Peer ${task.id}] ${feature}`, prompt: takeoverPrompt, model });
            appendAs(ctx, who, feature, { kind: "assign", data: { task: task.id, agentId, worktree: ident.worktree, branch: ident.branch, base: task.base, attempt: task.attempt, model: model ?? null, takeover: true } });
            return `Peer-impl ${agentId} took over ${task.id} in ${ident.worktree}.`;
          }
          const attempt = task.attempt + 1;
          const prompt = taskBrief(feature, task, st.premises, a.prompt);
          const { agentId, ident } = await createAgent(ctx, "peer-impl", { project: who.project, feature, task: task.id, placement: { kind: "worktree", branch: `slp/${feature}/${task.id}-${attempt}`, base: who.branch ?? `feat/${feature}` }, parent: who.agentId, title: `[Peer ${task.id}] ${feature}`, prompt, model, deferPrompt: a.merge_base === true });
          const base = headOf(ident.worktree!);
          appendAs(ctx, who, feature, { kind: "assign", data: { task: task.id, agentId, worktree: ident.worktree, branch: ident.branch, base, attempt, model: model ?? null, mergeBase: a.merge_base === true } });
          if (a.merge_base) {
            try {
              git(project.repo, ["fetch", "--quiet", "origin"], true); // network git runs in the human's checkout (T9 pushNoHooks)
              const conflicts = startMerge(ident.worktree!, project.baseBranch);
              const note = conflicts.length ? `Resolve the conflict markers in: ${conflicts.join(", ")}.` : "It merged without conflicts; check that the result builds and passes.";
              await ctx.paseo().agents.ref(agentId).send(`${prompt}\n\n## Merge in progress\nThe plugin started merging ${project.baseBranch} into your branch. ${note} Do not run git; slp_report when done and the plugin records the merge commit.`, { messageId: ctx.router.issue() });
            } catch (error) {
              // The Peer never got its brief: stop it and return the task, so it is not left assigned to an agent that waits for nothing.
              const message = error instanceof Error ? error.message : String(error);
              await retireAgent(ctx, ident, project.repo);
              appendAs(ctx, who, feature, { kind: "release", data: { task: task.id, outcome: "returned", reason: `merge_base setup failed: ${message}` } });
              throw new ToolError(`merging ${project.baseBranch} into the new worktree failed: ${message}`);
            }
          }
          return `Peer-impl ${agentId} started on ${task.id} in ${ident.worktree}.`;
        }
        if (!task.lastCommit || !task.branch) throw new ToolError(`${task.id} has no commit to review`);
        if (ctx.config.flags.evidenceCheck && !task.evidenceOk) throw new ToolError(`${task.id} has no green evidence on ${task.lastCommit.slice(0, 7)}`);
        const branch = `slp/${feature}/review-${task.id}-${task.lastCommit.slice(0, 7)}-${randomUUID().slice(0, 8)}`;
        const { agentId } = await createAgent(ctx, "peer-review", { project: who.project, feature, task: task.id, placement: { kind: "worktree", branch, base: task.lastCommit }, reviewCommit: task.lastCommit, parent: who.agentId, title: `[Review ${task.id}] ${feature}`, prompt: reviewBrief(feature, task, task.lastCommit, a.prompt) });
        return `Reviewer ${agentId} started on ${task.lastCommit.slice(0, 7)}.`;
      }),
    }),
    defineTool({
      name: "slp_report", description: "Report your task. The plugin commits your worktree after your turn ends and runs the verify command in a sandbox.",
      roles: ["peer-impl"],
      input: z.object({ status: z.enum(["done", "done_with_concerns", "blocked"]), message: z.string().min(1).max(120), report: z.string().min(1) }),
      run(who, a) {
        const task = stateOf(ctx, who.project, who.feature!).tasks.get(who.task!);
        if (!task || task.agentId !== who.agentId) throw new ToolError("this task is not assigned to you");
        const reportPath = ctx.stores.writeReport(who.project, who.feature!, who.task!, a.report);
        appendAs(ctx, who, who.feature!, { kind: "report", data: { task: who.task, status: a.status, message: a.message, reportPath } });
        if (who.agentId) ctx.toolCalls.set(who.agentId, Date.now());
        return "Report recorded. End your turn now; the plugin will commit and verify.";
      },
    }),
    defineTool({
      name: "slp_review", description: "Submit your review of the commit you were assigned.",
      roles: ["peer-review"],
      input: z.object({ commit: z.string(), verdict: z.enum(["pass", "fail"]), findings: z.array(z.object({ severity: z.enum(["blocking", "non_blocking"]), file: z.string(), line: z.number().int().optional(), issue: z.string(), command: z.string().optional() })).default([]) }),
      run(who, a) {
        if (a.commit !== who.reviewCommit) throw new ToolError(`you were assigned commit ${who.reviewCommit}, not ${a.commit}`);
        const blocking = a.findings.filter((f) => f.severity === "blocking").length;
        appendAs(ctx, who, who.feature!, { kind: "review", data: { task: who.task, commit: a.commit, verdict: a.verdict, blocking, findings: a.findings } });
        if (who.agentId) ctx.toolCalls.set(who.agentId, Date.now());
        return "Review recorded. End your turn: the plugin checks your worktree, then passes the review to the Lead.";
      },
    }),
    defineTool({
      name: "slp_accept", description: "Accept a task: requires green evidence and a clean review on its latest commit. The plugin merges it into the feature branch.",
      roles: ["lead"],
      input: z.object({ task: z.string() }),
      async run(who, a) {
        const st = stateOf(ctx, who.project, who.feature!);
        const t = st.tasks.get(a.task);
        if (!t || !t.lastCommit || !t.branch) throw new ToolError(`${a.task} has no commit`);
        if (st.halted) throw new ToolError(`${who.feature} is halted: the human changed the goal`);
        if (!st.plan?.approved) throw new ToolError(`plan v${st.plan?.version ?? "?"} is waiting for approval; accept after it is approved`);
        if (!st.spec?.approved) throw new ToolError("the spec is not approved by the human yet");
        if (t.status !== "reported") throw new ToolError(`${a.task} is ${t.status}; only a reported task can be accepted`);
        if (ctx.config.flags.evidenceCheck && !t.evidenceOk) throw new ToolError(`${a.task} has no green evidence on ${t.lastCommit.slice(0, 7)}`);
        if (!t.reviewOk) throw new ToolError(`${a.task} has no clean review on ${t.lastCommit.slice(0, 7)}; spawn a peer-review first (a review counts once the reviewer's turn has ended)`);
        if ([...st.challenges.values()].some((c) => c.open && c.target === a.task)) throw new ToolError(`${a.task} has an open challenge`);
        if (t.worktree && existsSync(t.worktree)) {
          const hookDir = hooksDir(t.worktree);
          const pending = changedFiles(t.worktree).filter((f) => !isSensitivePath(f) && !isProtectedPath(f, hookDir));
          if (pending.length) throw new ToolError(`${a.task} has uncommitted changes (${pending.slice(0, 5).join(", ")}); accepting would archive them. Wait until the plugin commits the Peer's latest report, or ask the Peer to slp_report.`);
        }
        // Merge the commit that was verified and reviewed, not the branch tip: a challenge commit may sit on top (review Codex 2026-10-22).
        const merged = mergeNoHooks(who.worktree!, t.lastCommit, `Merge ${t.id}: ${t.title}`);
        if (!merged.ok) throw new ToolError(`merge conflict in: ${merged.conflicts.join(", ")}. Plan a resolve task (slp_spawn with merge_base for conflicts with the base branch).`);
        appendPlugin(ctx, who.project, who.feature!, { kind: "merge", data: { task: t.id, source: t.branch, commit: t.lastCommit, target: who.branch, hash: merged.hash } });
        appendAs(ctx, who, who.feature!, { kind: "release", data: { task: t.id, outcome: "accepted", commit: t.lastCommit, def: taskDef(t) } });
        await retireTaskAgents(ctx, who.project, who.feature!, t.id);
        return `${t.id} accepted and merged (${merged.hash.slice(0, 7)}).`;
      },
    }),
    defineTool({
      name: "slp_release", description: "Return a task without accepting it (stops its Peers).",
      roles: ["lead"],
      input: z.object({ task: z.string(), reason: z.string().min(1) }),
      async run(who, a) {
        appendAs(ctx, who, who.feature!, { kind: "release", data: { task: a.task, outcome: "returned", reason: a.reason } });
        await retireTaskAgents(ctx, who.project, who.feature!, a.task);
        return `${a.task} returned to pending.`;
      },
    }),
    defineTool({
      name: "slp_merge_main", description: "Merge the base branch into the feature branch (hooks off). Conflicts are reported, not resolved.",
      roles: ["lead"],
      input: z.object({}),
      run(who) {
        const project = ctx.config.projects[who.project]!;
        if (stateOf(ctx, who.project, who.feature!).halted) throw new ToolError(`${who.feature} is halted: the human changed the goal`);
        git(project.repo, ["fetch", "--quiet", "origin"], true); // network git runs in the human's checkout (T9 pushNoHooks)
        const merged = mergeNoHooks(who.worktree!, project.baseBranch, `Merge ${project.baseBranch} into ${who.branch}`);
        if (!merged.ok) return `Conflicts in: ${merged.conflicts.join(", ")}. Add a resolve task to the plan, then slp_spawn it as a peer-impl with merge_base: true.`;
        appendPlugin(ctx, who.project, who.feature!, { kind: "merge", data: { source: project.baseBranch, target: who.branch, hash: merged.hash } });
        return `Merged ${project.baseBranch} (${merged.hash.slice(0, 7)}). Re-run acceptance before shipping.`;
      },
    }),
    defineTool({
      name: "slp_ship_package", description: "Verify the feature head in a sandbox and build the ship package for the human.",
      roles: ["supervisor"],
      input: z.object({ feature: SLUG.optional(), summary: z.string().min(1) }),
      async run(who, a) {
        await syncHumanMessages(ctx, who); // an earlier "ship" must not approve this package
        const feature = requireFeature(who, a.feature);
        const lead = ctx.identities.current("lead", who.project, feature);
        if (!lead?.worktree) throw new ToolError("feature has no Lead worktree");
        const v = await verifyFeature(pipelineDeps(ctx, who.project, feature), feature, lead.worktree);
        if (v.runnerError) throw new ToolError(`cannot verify: ${v.runnerError}. Fix sandbox.runner in ~/.slp/config.json and retry.`);
        const events = ctx.stores.feature(who.project, feature).all();
        const st = deriveFeature(feature, events);
        const blockers = acceptanceBlockers(st, events, v.commit);
        if (blockers.length) throw new ToolError(`not ready to ship:\n${blockers.map((b) => `- ${b}`).join("\n")}${v.ok ? "" : `\nFull suite stderr:\n${v.stderrTail.slice(-800)}`}`);
        const base = ctx.config.projects[who.project]!.baseBranch;
        const rulings = events.filter((e) => e.kind === "ruling").map((e) => `- ${e.id}: ${String(e.data.decision)} (cost if wrong: ${String(e.data.cost_if_wrong)})`);
        const openH = [...st.premises.values()].filter((p) => p.status === "open").map((p) => `- ${p.id}: ${p.title}`);
        const text = `# Ship package: ${feature} @ ${v.commit.slice(0, 7)}\n\n${a.summary}\n\n## Diff\n${diffStat(lead.worktree, base, v.commit)}\n\n## Evidence\n- full suite green on ${v.commit} (sandboxed)\n\n## Rulings\n${rulings.join("\n") || "- none"}\n\n## Open hypotheses\n${openH.join("\n") || "- none"}\n`;
        await syncHumanMessages(ctx, who); // a message typed while the suite ran is older than the package; nothing else may be awaited before the append
        appendAs(ctx, who, feature, { kind: "ship_package", data: { commit: v.commit, text } });
        return `${text}\nShow this to the human. After they approve, call slp_ship with their exact words.`;
      },
    }),
    defineTool({
      name: "slp_ship", description: "Push the feature branch and open a PR, only after the human approved the latest ship package.",
      roles: ["supervisor"],
      input: z.object({ feature: SLUG.optional(), quote: z.string() }),
      async run(who, a) {
        await syncHumanMessages(ctx, who); // the approval usually arrives in this very turn
        const feature = requireFeature(who, a.feature);
        const lead = ctx.identities.current("lead", who.project, feature);
        if (!lead?.worktree) throw new ToolError("feature has no Lead worktree");
        const head = headOf(lead.worktree);
        const events = ctx.stores.feature(who.project, feature).all();
        if (deriveFeature(feature, events).halted) throw new ToolError(`${feature} is halted: the human changed the goal`);
        const ok = verifyShipApproval(events, humanMessagesFor(ctx, who), { agentId: who.agentId!, quote: a.quote, commit: head, extraWords: [feature] });
        if (!ok.ok) throw new ToolError(`ship refused: ${ok.reason}`);
        // Anything that arrived after the package (a challenge, red evidence, a new plan) still blocks (review Codex 2026-10-22, round 6).
        const blockers = acceptanceBlockers(deriveFeature(feature, events), events, head);
        if (blockers.length) throw new ToolError(`ship refused, not ready any more:\n${blockers.map((b) => `- ${b}`).join("\n")}`);
        appendAs(ctx, who, feature, { kind: "human_decision", data: { decides: "approve_ship", target: head, quote: a.quote, messageSeq: ok.seq, messageId: ok.messageId } });
        const branch = lead.branch ?? `feat/${feature}`;
        pushNoHooks(ctx.config.projects[who.project]!.repo, ctx.config.ship.remote, branch);
        let pr: string | null = null;
        if (ctx.config.ship.openPr) {
          const pkg = [...events].reverse().find((e) => e.kind === "ship_package")!;
          const title = String(events.find((e) => e.kind === "brief")?.data.title ?? feature);
          // A retry after a crash between "gh pr create" and the shipped event finds the PR instead of failing on it (review Codex 2026-10-22).
          const existing = spawnSync("gh", ["pr", "view", branch, "--json", "url,state", "--jq", 'select(.state == "OPEN") | .url'], { cwd: ctx.config.projects[who.project]!.repo, encoding: "utf8", timeout: 120_000 });
          if (existing.status === 0 && existing.stdout.trim()) pr = existing.stdout.trim();
          else {
            const r = spawnSync("gh", ["pr", "create", "--head", branch, "--base", ctx.config.projects[who.project]!.baseBranch.replace(/^origin\//, ""), "--title", title, "--body", String(pkg.data.text)], { cwd: ctx.config.projects[who.project]!.repo, encoding: "utf8", timeout: 120_000 });
            // A missing or hung gh has no exit status and no stderr: say why instead of throwing a TypeError.
            if (r.status !== 0) throw new ToolError(`pushed ${branch}, but gh pr create failed: ${(r.stderr ?? "").trim() || r.error?.message || `exit ${r.status}`}`);
            pr = r.stdout.trim();
          }
        }
        appendPlugin(ctx, who.project, feature, { kind: "shipped", data: { commit: head, pr } });
        releaseContracts(ctx, who.project, feature);
        for (const other of ctx.stores.features(who.project).filter((f) => f !== feature)) {
          if (!ctx.identities.current("lead", who.project, other)) continue;
          notify(ctx, leadAddress(who.project, other), `Feature ${feature} shipped${pr ? ` (${pr})` : ""}. After the human merges it, call slp_merge_main and re-run acceptance.`);
          if (ctx.identities.current("supervisor", who.project, other)) notify(ctx, supervisorAddress(who.project, other), `Feature ${feature} shipped${pr ? ` (${pr})` : ""}; your Lead will merge main after the human merges it.`);
        }
        return pr ? `Shipped: ${pr}. The human merges.` : `Pushed ${branch} @ ${head.slice(0, 7)}.`;
      },
    }),
    defineTool({
      name: "slp_checkpoint", description: "Hand your role to a fresh agent: write what is in progress, what waits on the human, and promises made.",
      roles: ["supervisor", "lead"],
      input: z.object({ summary: z.string().min(1), pending_human: z.array(z.string()).default([]), promises: z.array(z.string()).default([]) }),
      async run(who, a) {
        const feature = requireFeature(who, undefined);
        const body = `# Checkpoint (${who.role} · ${feature})\n\n## In progress\n${a.summary}\n\n## Waiting on the human\n${a.pending_human.map((x) => `- ${x}`).join("\n") || "- none"}\n\n## Promises made to the human\n${a.promises.map((x) => `- ${x}`).join("\n") || "- none"}\n`;
        const file = join(ctx.stores.featureDir(who.project, feature), `checkpoint-${who.role}.md`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body, { mode: 0o600 });
        appendAs(ctx, who, feature, { kind: "checkpoint", data: { path: file } });
        const digest = refreshDigest(ctx, who.project, feature);
        if (who.role === "lead" && !who.workspaceId) throw new ToolError("no workspace recorded for this Lead; cannot rotate in place");
        const placement: Placement = who.role === "lead" ? { kind: "workspace", workspaceId: who.workspaceId! } : { kind: "dir", cwd: ctx.config.projects[who.project]!.repo };
        const { agentId } = await createAgent(ctx, who.role, { project: who.project, feature, task: null, placement, parent: who.parentAgentId, title: who.role === "lead" ? `[Lead] ${feature}` : `[Supervisor] ${feature}`, prompt: `[SLP] You take over the ${who.role} role for feature ${feature} from a previous agent.\n\n${body}\n\n## Current state\n${digest}` });
        ctx.identities.retire(who.tokenHash);
        if (who.agentId) await ctx.paseo().agents.ref(who.agentId).archive().catch(() => undefined);
        return `Started replacement agent ${agentId}. End your turn now.`;
      },
    }),
  ];
}
