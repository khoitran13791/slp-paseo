import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// zod 4: .prefault({}) parses the default through the inner schema so nested defaults apply.
export const SlpConfigSchema = z.object({
  flags: z.object({
    ask: z.boolean().default(true),
    evidenceCheck: z.boolean().default(true),
    touchSetGuard: z.boolean().default(true),
    crossVendorReview: z.boolean().default(true),
    supervisorPlanApproval: z.boolean().default(true),
    autoResume: z.boolean().default(true),
    watch: z.boolean().default(true),
  }).prefault({}),
  limits: z.object({
    resumeMaxAttempts: z.number().int().nonnegative().default(6),
    challengeAnswerMinutes: z.number().positive().default(30),
    noReportNudges: z.number().int().nonnegative().default(1),
    verifyTimeoutSeconds: z.number().int().positive().default(900),
    maxCommitFiles: z.number().int().positive().default(500),
    humanReminderMinutes: z.number().positive().default(30),
    maxWriters: z.number().int().positive().default(2),
  }).prefault({}),
  models: z.object({ allowed: z.array(z.string()).default([]) }).prefault({}),
  sandbox: z.object({
    runner: z.array(z.string()).min(1).default(["codex", "sandbox", "-P", "slp-verify", "-C", "{worktree}", "--"]),
    claudeAllowedDomains: z.array(z.string()).default(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]),
    /** No SLP sandbox (Claude roles, Codex reviewer, verify runner) may read these (spec §8). */
    denyRead: z.array(z.string().min(1)).default(["~/.slp", "~/.paseo"]),
  }).prefault({}),
  rotation: z.object({
    contextRatio: z.number().gt(0).lte(1).default(0.6),
    maxTurns: z.number().int().positive().default(200),
  }).prefault({}),
  watch: z.object({
    intervalMinutes: z.number().positive().default(15),
    packToolCalls: z.number().int().positive().max(50).default(10),
  }).prefault({}),
  mcp: z.object({ port: z.number().int().min(0).max(65535).default(47320) }).prefault({}),
  ship: z.object({ remote: z.string().default("origin"), openPr: z.boolean().default(true) }).prefault({}),
  // null: the newest Superpowers in Claude Code's plugin cache (T16 findSuperpowersDir).
  runtime: z.object({ claudePluginDir: z.string().min(1).nullable().default(null) }).prefault({}),
});
export type SlpConfig = z.infer<typeof SlpConfigSchema>;

export const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

export function slpHome(): string {
  return process.env.SLP_HOME ?? join(homedir(), ".slp");
}

export function parseSlpConfig(raw: unknown): SlpConfig {
  const parsed = SlpConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`SLP config invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** `~/.slp/config.json` is optional since rev 5.11: no file means every default. A leftover `projects` section is ignored. */
export function loadSlpConfig(file = join(slpHome(), "config.json"), log: (message: string) => void = (m) => console.error(`[slp] ${m}`)): SlpConfig {
  if (!existsSync(file)) return parseSlpConfig({});
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (raw && typeof raw === "object" && "projects" in raw) log(`projects in ${file} is no longer used (rev 5.11): SLP registers a repo when a Supervisor starts in it; base branch and verify belong to each feature.`);
  return parseSlpConfig(raw);
}
