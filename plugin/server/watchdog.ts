import { readJson, writeJson } from "./jsonFile";
import type { Vendor } from "./roles";

const STRICT = /(usage|rate) limit (reached|exceeded|hit)|hit (your|the) (usage |rate )?limit|limit (will )?reset|resets? (at|in) \d|out of (credits|extra usage)|quota exceeded|overloaded_error|\b429\b/i;
const LOOSE_FAILURE = /rate.?limit|usage limit|usage quota|quota exceeded for|exceeded your (current )?quota|overloaded|\b429\b|too many requests/i;
const DISK = /disk quota|EDQUOT|ENOSPC|no space left/i;

export function isLimitTurn(outcome: { kind: string; error?: { message: string } }, lastAssistantText: string | null): boolean {
  if (outcome.kind === "failed") { const m = outcome.error?.message ?? ""; return LOOSE_FAILURE.test(m) && !DISK.test(m); }
  if (outcome.kind === "completed" && lastAssistantText !== null && lastAssistantText.length <= 400) return STRICT.test(lastAssistantText) && !DISK.test(lastAssistantText) && !/middleware|implement|added|test/i.test(lastAssistantText);
  return false;
}

export interface UsageWindow { vendor: Vendor; resetsAt: string | null; usedPct: number | null }

interface UsagePayloadLike { providers?: Array<{ providerId?: string; displayName?: string; windows?: Array<{ usedPct?: number | null; resetsAt?: string | null }> }> }

/** Reads `paseo.providers.listUsage()` (ProviderUsageListResponseMessage payload). */
export function usageWindowsFrom(result: unknown): UsageWindow[] {
  const providers = (result as UsagePayloadLike | null)?.providers;
  if (!Array.isArray(providers)) return [];
  const out: UsageWindow[] = [];
  for (const p of providers) {
    const label = `${p.providerId ?? ""} ${p.displayName ?? ""}`.toLowerCase();
    const vendor: Vendor | null = /claude|anthropic/.test(label) ? "claude" : /codex|chatgpt|openai/.test(label) ? "codex" : null;
    if (!vendor) continue;
    for (const w of p.windows ?? []) {
      out.push({ vendor, usedPct: typeof w.usedPct === "number" ? w.usedPct : null, resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null });
    }
  }
  return out;
}

export function resumeAt(windows: UsageWindow[], vendor: Vendor, now: Date, attempt: number): Date {
  const exhausted = windows
    .filter((w) => w.vendor === vendor && w.resetsAt && Date.parse(w.resetsAt) > now.getTime() && (w.usedPct ?? 0) >= 95)
    .map((w) => Date.parse(w.resetsAt!));
  if (exhausted.length > 0) return new Date(Math.max(...exhausted) + 60_000);
  return new Date(now.getTime() + Math.min(2 ** attempt * 60_000, 30 * 60_000));
}

export interface ResumeJob { agentId: string; vendor: Vendor; at: string; attempt: number }

interface ResumeState { jobs: ResumeJob[]; attempts: Record<string, number> }

/** Jobs leave the queue when due; attempt counts stay until clear() (a later turn ended without a limit). */
export class ResumeQueue {
  private state: ResumeState;
  constructor(private readonly file: string) { this.state = readJson<ResumeState>(file, { jobs: [], attempts: {} }); }
  schedule(job: ResumeJob): void {
    this.state.jobs = [...this.state.jobs.filter((j) => j.agentId !== job.agentId), job];
    this.state.attempts[job.agentId] = job.attempt;
    this.save();
  }
  attemptOf(agentId: string): number { return this.state.attempts[agentId] ?? 0; }
  /** Due jobs stay queued until `done`: a crash or a failed send never loses a resume (review Codex 2026-10-22). */
  due(now: Date): ResumeJob[] {
    return this.state.jobs.filter((j) => Date.parse(j.at) <= now.getTime());
  }
  /** The resume was delivered: drop that job (only if it is still the same one, by attempt and time), keep the attempt count. */
  done(agentId: string, job?: Pick<ResumeJob, "attempt" | "at">): void {
    const match = (j: ResumeJob) => j.agentId === agentId && (!job || (j.attempt === job.attempt && j.at === job.at));
    if (!this.state.jobs.some(match)) return;
    this.state.jobs = this.state.jobs.filter((j) => !match(j));
    this.save();
  }
  /** Moves a job later only if it is still the one that was tried. */
  postpone(job: ResumeJob, at: string): void {
    if (!this.state.jobs.some((j) => j.agentId === job.agentId && j.attempt === job.attempt && j.at === job.at)) return;
    this.schedule({ ...job, at });
  }
  clear(agentId: string): void {
    if (!this.state.jobs.some((j) => j.agentId === agentId) && !(agentId in this.state.attempts)) return;
    this.state.jobs = this.state.jobs.filter((j) => j.agentId !== agentId);
    delete this.state.attempts[agentId];
    this.save();
  }
  jobs(): readonly ResumeJob[] { return this.state.jobs; }
  private save(): void { writeJson(this.file, this.state); }
}

export class NudgeTracker {
  private counts: Record<string, number>;
  constructor(private readonly file: string) { this.counts = readJson<Record<string, number>>(file, {}); }
  shouldNudge(agentId: string, max: number): boolean {
    const n = this.counts[agentId] ?? 0;
    if (n >= max) return false;
    this.counts[agentId] = n + 1; writeJson(this.file, this.counts);
    return true;
  }
  reset(agentId: string): void { if (agentId in this.counts) { delete this.counts[agentId]; writeJson(this.file, this.counts); } }
}
