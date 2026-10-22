import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";

export const ProjectSchema = z.object({
  repo: z.string().min(1),
  baseBranch: z.string().default("origin/main"),
  verify: z.array(z.string().min(1)).min(1),
  maxWriters: z.number().int().positive().default(2),
});
export type ProjectConfig = z.infer<typeof ProjectSchema>;

// zod 4: .prefault({}) parses the default through the inner schema so nested defaults apply.
export const SlpConfigSchema = z.object({
  projects: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ProjectSchema),
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
  }).prefault({}),
  models: z.object({ allowed: z.array(z.string()).default([]) }).prefault({}),
  sandbox: z.object({
    runner: z.array(z.string()).min(1).default(["codex", "sandbox", "-P", ":workspace", "-C", "{worktree}", "--"]),
    claudeAllowedDomains: z.array(z.string()).default(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]),
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

export function slpHome(): string {
  return process.env.SLP_HOME ?? join(homedir(), ".slp");
}

export function parseSlpConfig(raw: unknown): SlpConfig {
  const parsed = SlpConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`SLP config invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadSlpConfig(file = join(slpHome(), "config.json")): SlpConfig {
  return parseSlpConfig(JSON.parse(readFileSync(file, "utf8")));
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function projectForCwd(config: SlpConfig, cwd: string): { name: string; project: ProjectConfig } | null {
  const real = safeRealpath(cwd);
  for (const [name, project] of Object.entries(config.projects)) {
    const root = safeRealpath(project.repo);
    if (real === root || real.startsWith(root + sep)) return { name, project };
  }
  return null;
}
