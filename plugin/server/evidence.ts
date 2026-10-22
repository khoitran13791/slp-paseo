import type { ProjectConfig, SlpConfig } from "./config";
import { changedFiles, commitAll, commitTrailer, filesOutside, git, headOf, hookFile, hooksDir, isProtectedPath, isSensitivePath, nestedRepos, NoChangesError, trackedChanges, unsafeGitDrivers } from "./git";
import type { RunFn, SandboxResult } from "./sandbox";
import { evidencePassed, taskDef, type TaskState } from "./store/derive";
import type { EventStore, SlpEvent } from "./store/events";

export interface PipelineDeps { store: EventStore; config: SlpConfig; project: ProjectConfig; run: RunFn; now(): Date }
export interface CommitFlags { outsideTouchSet: string[]; excludedSensitive: string[]; excludedProtected: string[] }
export type ReportOutcome =
  | { outcome: "committed"; commit: string; evidenceOk: boolean | null; flags: CommitFlags; runnerError?: string; recovered?: true }
  | { outcome: "rejected"; reason: string }
  | { outcome: "blocked" };

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Latest task evidence for `commit` under this task definition; null when there is none for it yet. */
function evidenceOkFor(store: EventStore, commit: string, task: TaskState): boolean | null {
  const def = JSON.stringify(taskDef(task));
  const ev = [...store.all()].reverse().find((e) => e.kind === "evidence" && e.data.scope === "task" && e.data.commit === commit && (e.data.def === undefined || JSON.stringify(e.data.def) === def));
  return ev ? evidencePassed(ev.data) : null;
}

/**
 * Probes the runner first, so a broken runner is reported as infrastructure, never as a failing test.
 * Afterwards `dirty` lists tracked files the run changed (and "HEAD moved"): such a run proves nothing about the commit (review Codex 2026-10-22).
 * In the Lead worktree, which no agent may write, tracked files are put back so later merges and verifies start clean.
 */
async function runEvidence(deps: PipelineDeps, feature: string | null, worktree: string, command: string, data: Record<string, unknown>): Promise<(SandboxResult & { dirty: string[] }) | { runnerError: string }> {
  // Every git call below (and the callers' before it) would run clean/smudge filters, merge drivers or textconv that a Peer may have configured.
  const drivers = unsafeGitDrivers(worktree);
  if (drivers.length) {
    const runnerError = `the repo's git config runs commands on add/status (${drivers.join("; ")}); the plugin will not run git here until a human removes them`;
    deps.store.append({ feature, kind: "ops", by_role: "plugin", by_agent: null, data: { ...data, type: "unsafe_git_config", error: runnerError, summary: runnerError.slice(0, 200) } }, deps.now());
    return { runnerError };
  }
  const probe = await deps.run(deps.config.sandbox.runner, worktree, "true", 60);
  if (probe.exitCode !== 0) {
    const runnerError = `sandbox runner failed (exit ${probe.exitCode}): ${probe.stderrTail.trim().slice(-300)}`;
    deps.store.append({ feature, kind: "ops", by_role: "plugin", by_agent: null, data: { ...data, type: "runner_failed", error: runnerError, summary: `sandbox runner broken: ${runnerError.slice(0, 160)}` } }, deps.now());
    return { runnerError };
  }
  // The commit the evidence names must be the one under test, before and after: a merge during the runner probe would otherwise be tested under the old name (review Codex 2026-10-22, round 2).
  const expected = typeof data.commit === "string" ? data.commit : headOf(worktree);
  const before = headOf(worktree);
  const r = await deps.run(deps.config.sandbox.runner, worktree, command, deps.config.limits.verifyTimeoutSeconds);
  const after = headOf(worktree);
  const dirty = [...trackedChanges(worktree), ...(before !== expected || after !== expected ? [`HEAD is ${(before !== expected ? before : after).slice(0, 7)}, not ${expected.slice(0, 7)}`] : [])];
  if (dirty.length && data.scope === "feature") git(worktree, ["checkout", "--", "."], true);
  deps.store.append({ feature, kind: "evidence", by_role: "plugin", by_agent: null, data: { ...data, command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: r.stdoutTail, stderrTail: r.stderrTail, dirty } }, deps.now());
  return { ...r, dirty };
}

async function verifyTask(deps: PipelineDeps, feature: string | null, worktree: string, task: TaskState, hash: string, flags: CommitFlags, recovered: boolean): Promise<ReportOutcome> {
  const base = { outcome: "committed" as const, commit: hash, flags, ...(recovered ? { recovered: true as const } : {}) };
  if (!deps.config.flags.evidenceCheck) return { ...base, evidenceOk: null };
  const hook = hookFile(worktree, "pre-commit");
  const command = hook ? `${shQuote(hook)} && ${task.verify}` : task.verify;
  const r = await runEvidence(deps, feature, worktree, command, { scope: "task", task: task.id, commit: hash, def: taskDef(task) });
  if ("runnerError" in r) return { ...base, evidenceOk: null, runnerError: r.runnerError };
  return { ...base, evidenceOk: r.exitCode === 0 && !r.timedOut && r.dirty.length === 0 };
}

/** A commit the plugin made but never recorded (crash between commit and append). */
function orphanCommit(deps: PipelineDeps, task: TaskState, worktree: string): string | null {
  const head = headOf(worktree);
  if (head === task.base) return null;
  if (deps.store.all().some((e) => e.kind === "commit" && e.data.hash === head)) return null;
  return commitTrailer(worktree, head, "SLP-Task") === task.id ? head : null;
}

export async function processReport(deps: PipelineDeps, task: TaskState, report: SlpEvent): Promise<ReportOutcome> {
  const worktree = task.worktree;
  const prior = deps.store.all().find((e) => e.data.reportSeq === report.seq && (e.kind === "commit" || (e.kind === "ops" && ["report_rejected", "report_blocked", "report_unchanged"].includes(String(e.data.type)))));
  if (prior?.kind === "commit" || prior?.data.type === "report_unchanged") {
    const hash = String(prior.data.hash);
    const flags = prior.data.flags as CommitFlags;
    const ok = evidenceOkFor(deps.store, hash, task);
    if (ok === null && deps.config.flags.evidenceCheck && worktree) return verifyTask(deps, report.feature, worktree, task, hash, flags, prior.data.recovered === true);
    return { outcome: "committed", commit: hash, evidenceOk: ok, flags, ...(prior.data.recovered === true ? { recovered: true as const } : {}) };
  }
  if (prior?.data.type === "report_blocked") return { outcome: "blocked" };
  if (prior) return { outcome: "rejected", reason: String(prior.data.reason) };

  const reject = (reason: string): ReportOutcome => {
    deps.store.append({ feature: report.feature, kind: "ops", by_role: "plugin", by_agent: null, data: { type: "report_rejected", task: task.id, reportSeq: report.seq, reason, summary: `${task.id}: ${reason}` } }, deps.now());
    return { outcome: "rejected", reason };
  };
  if (!worktree) return reject("task has no worktree");
  const drivers = unsafeGitDrivers(worktree); // `git status` would already run them
  if (drivers.length) return reject(`the repo's git config runs commands on add/status (${drivers.join("; ")}); the plugin will not commit until a human removes them`);
  const files = changedFiles(worktree);
  const hookDir = hooksDir(worktree);
  const nested = new Set(nestedRepos(worktree)); const isNested = (f: string) => nested.has(f.replace(/\/$/, ""));
  const excludedSensitive = files.filter(isSensitivePath);
  const excludedProtected = files.filter((f) => !isSensitivePath(f) && (isProtectedPath(f, hookDir) || isNested(f)));
  const kept = files.filter((f) => !isSensitivePath(f) && !isProtectedPath(f, hookDir) && !isNested(f));

  let hash: string;
  let committed: string[];
  let recovered = false;
  if (kept.length === 0) {
    const orphan = orphanCommit(deps, task, worktree);
    if (!orphan) {
      if (report.data.status === "blocked") {
        deps.store.append({ feature: report.feature, kind: "ops", by_role: "plugin", by_agent: null, data: { type: "report_blocked", task: task.id, reportSeq: report.seq, summary: `${task.id}: blocked, no changes` } }, deps.now());
        return { outcome: "blocked" };
      }
      if (task.lastCommit && headOf(worktree) === task.lastCommit) {
        // Nothing new on top of the recorded commit (a Peer that took over, or one answering without edits): keep that commit,
        // and verify it again only if its evidence ran under another task definition (review Codex 2026-10-22, round 2).
        const flags: CommitFlags = { outsideTouchSet: [], excludedSensitive, excludedProtected };
        deps.store.append({ feature: report.feature, kind: "ops", by_role: "plugin", by_agent: null, data: { type: "report_unchanged", task: task.id, reportSeq: report.seq, hash: task.lastCommit, flags, summary: `${task.id}: no new changes on ${task.lastCommit.slice(0, 7)}` } }, deps.now());
        const ok = evidenceOkFor(deps.store, task.lastCommit, task);
        if (ok === null && deps.config.flags.evidenceCheck) return verifyTask(deps, report.feature, worktree, task, task.lastCommit, flags, false);
        return { outcome: "committed", commit: task.lastCommit, evidenceOk: ok, flags };
      }
      const excluded = [...excludedSensitive, ...excludedProtected];
      return reject(excluded.length ? `only sensitive or protected files changed: ${excluded.join(", ")}` : "no changes in worktree");
    }
    hash = orphan; recovered = true;
    committed = git(worktree, ["diff", "--name-only", `${task.base}..${hash}`]).stdout.split("\n").filter(Boolean);
  } else {
    if (kept.length > deps.config.limits.maxCommitFiles) return reject(`${kept.length} files changed (limit ${deps.config.limits.maxCommitFiles}); check .gitignore`);
    try {
      hash = commitAll(worktree, { message: `${task.id}: ${String(report.data.message ?? "update")}`, trailers: { "SLP-Task": task.id, "SLP-Agent": String(report.by_agent) }, exclude: [...excludedSensitive, ...excludedProtected] });
    } catch (error) {
      if (error instanceof NoChangesError) return reject("no changes in worktree");
      throw error;
    }
    committed = kept;
  }
  const flags: CommitFlags = { outsideTouchSet: deps.config.flags.touchSetGuard ? filesOutside(committed, task.touchSet) : [], excludedSensitive, excludedProtected };
  deps.store.append({ feature: report.feature, kind: "commit", by_role: "plugin", by_agent: null, data: { task: task.id, hash, base: task.base, files: [...committed].sort(), flags, reportSeq: report.seq, ...(recovered ? { recovered: true } : {}) } }, deps.now());
  return verifyTask(deps, report.feature, worktree, task, hash, flags, recovered);
}

export async function processChallengeEvidence(deps: PipelineDeps, task: TaskState, challenge: SlpEvent): Promise<{ commit: string | null; exitCode: number | null; runnerError?: string } | null> {
  if (deps.store.all().some((e) => e.data.challengeSeq === challenge.seq)) return null;
  const worktree = task.worktree;
  if (!worktree) return null;
  const drivers = unsafeGitDrivers(worktree);
  if (drivers.length) {
    deps.store.append({ feature: challenge.feature, kind: "ops", by_role: "plugin", by_agent: null, data: { type: "challenge_evidence", challenge: challenge.id, challengeSeq: challenge.seq, summary: `${challenge.id}: the repo's git config runs commands on add/status (${drivers.join("; ")}); no evidence until a human removes them` } }, deps.now());
    return { commit: null, exitCode: null };
  }
  let commit: string | null = null;
  const hookDir = hooksDir(worktree);
  const nested = new Set(nestedRepos(worktree)); const isNested = (f: string) => nested.has(f.replace(/\/$/, ""));
  const files = changedFiles(worktree);
  const excluded = files.filter((f) => isSensitivePath(f) || isProtectedPath(f, hookDir) || isNested(f));
  const kept = files.filter((f) => !excluded.includes(f));
  if (kept.length > 0 && kept.length <= deps.config.limits.maxCommitFiles) {
    commit = commitAll(worktree, { message: `${task.id}: evidence for ${challenge.id}`, trailers: { "SLP-Task": task.id, "SLP-Agent": String(challenge.by_agent) }, exclude: excluded });
    deps.store.append({ feature: challenge.feature, kind: "commit", by_role: "plugin", by_agent: null, data: { task: task.id, hash: commit, scope: "challenge", challenge: challenge.id, challengeSeq: challenge.seq, files: kept.sort() } }, deps.now());
  }
  const repro = typeof challenge.data.repro_command === "string" ? challenge.data.repro_command : null;
  if (!repro) {
    deps.store.append({ feature: challenge.feature, kind: "ops", by_role: "plugin", by_agent: null, data: { type: "challenge_evidence", challenge: challenge.id, challengeSeq: challenge.seq, summary: `${challenge.id}: no repro command` } }, deps.now());
    return { commit, exitCode: null };
  }
  const r = await runEvidence(deps, challenge.feature, worktree, repro, { scope: "challenge", task: task.id, challenge: challenge.id, challengeSeq: challenge.seq, commit: commit ?? headOf(worktree) });
  if ("runnerError" in r) return { commit, exitCode: null, runnerError: r.runnerError };
  return { commit, exitCode: r.exitCode };
}

export async function verifyFeature(deps: PipelineDeps, feature: string, leadWorktree: string): Promise<{ commit: string; ok: boolean; stderrTail: string; runnerError?: string }> {
  const commit = headOf(leadWorktree);
  const r = await runEvidence(deps, feature, leadWorktree, deps.project.verify.join(" && "), { scope: "feature", commit });
  if ("runnerError" in r) return { commit, ok: false, stderrTail: "", runnerError: r.runnerError };
  return { commit, ok: r.exitCode === 0 && !r.timedOut && r.dirty.length === 0, stderrTail: r.dirty.length ? `verify changed tracked files: ${r.dirty.join(", ")}\n${r.stderrTail}` : r.stderrTail };
}
