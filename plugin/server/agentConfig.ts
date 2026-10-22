import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectForCwd, type SlpConfig } from "./config";
import { currentBranch, gitCommonDir, headOf } from "./git";
import type { Identity, IdentityRegistry } from "./identity";
import { ROLE_PROVIDER, roleOfProvider, type Role, type RoleSetup } from "./roles";

interface McpToolRef { kind: "mcp"; server: string; tool: string }
export interface CreateRequest {
  config: { provider: string; cwd: string; modeId?: string; systemPrompt?: string; providerOptions?: unknown; toolPolicy?: { preapproved: McpToolRef[] }; mcpServers?: Record<string, unknown>; [k: string]: unknown };
  env?: Record<string, string>;
}
export interface AgentConfigDeps {
  identities: IdentityRegistry; config: SlpConfig; setup(): RoleSetup; mcpUrl(): string;
  promptFor(ident: Identity): string; toolNames(role: Role): string[]; stateDirs: string[];
  /** Superpowers, loaded back with --plugin-dir; null runs Claude roles without it. */
  claudePluginDir: string | null;
  /** CODEX_HOME for Codex roles; may create it (ensureCodexHome). */
  codexHome(): string;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function claudeSandbox(ident: Identity, config: SlpConfig, cwd: string, stateDirs: string[]): Record<string, unknown> {
  const impl = ident.role === "peer-impl";
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyWrite: [impl ? join(cwd, ".git") : cwd], denyRead: stateDirs },
    network: { allowedDomains: impl ? config.sandbox.claudeAllowedDomains : [], allowLocalBinding: false },
  };
}

/**
 * Claude roles start without the operator's or the repo's settings. Paseo loads user, project and local settings, so hooks
 * in a checkout's .claude/settings.json would run outside the sandbox, and .mcp.json servers, the operator's MCP servers,
 * plugins and claude.ai connectors would load. The SDK appends extraArgs after its own flags, so "--setting-sources="
 * (empty) overrides Paseo's list. CLAUDE.md comes back through --add-dir plus CLAUDE_ISOLATION_ENV; Superpowers through --plugin-dir.
 */
export function claudeIsolation(cwd: string, pluginDir: string | null, extraArgs: unknown): { additionalDirectories: string[]; extraArgs: Record<string, string | null> } {
  return {
    additionalDirectories: [cwd],
    extraArgs: { ...(asRecord(extraArgs) as Record<string, string | null>), "setting-sources": "", "strict-mcp-config": null, ...(pluginDir ? { "plugin-dir": pluginDir } : {}) },
  };
}
export const CLAUDE_ISOLATION_ENV = { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } as const;
/** One command chain: SLP roles get help only through slp_spawn, never through Claude Code's own subagents. */
export const CLAUDE_DISALLOWED_TOOLS = ["Agent", "Task"];

const CODEX_CONFIG = "# Written by the SLP plugin before each Codex role starts. No MCP servers and no trusted projects:\n# the agent gets only what Paseo passes for its session.\n";

/** A CODEX_HOME that shares only auth.json with the operator's Codex home (their MCP servers include computer use). */
export function ensureCodexHome(dir: string, sourceHome: string): string {
  const auth = join(sourceHome, "auth.json");
  if (!existsSync(auth)) throw new Error(`SLP: ${auth} not found; log in to Codex before starting a Codex role.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.toml"), CODEX_CONFIG);
  const link = join(dir, "auth.json");
  let target: string | null = null;
  try { target = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : ""; } catch { target = null; }
  if (target !== auth) { rmSync(link, { force: true }); symlinkSync(auth, link); }
  return dir;
}

/** Newest Superpowers in Claude Code's plugin cache, or null. */
export function findSuperpowersDir(claudeHome: string): string | null {
  const root = join(claudeHome, "plugins", "cache", "claude-plugins-official", "superpowers");
  let versions: string[];
  try { versions = readdirSync(root).filter((v) => /^\d+(\.\d+)*$/.test(v)); } catch { return null; }
  const parts = (v: string) => v.split(".").map(Number);
  versions.sort((a, b) => {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const diff = (x[i] ?? 0) - (y[i] ?? 0); if (diff) return diff; }
    return 0;
  });
  const newest = versions.at(-1);
  return newest ? join(root, newest) : null;
}

/** Lead and Peers must run in a worktree Paseo created for them, never in the main checkout. */
function recordPlacement(ident: Identity, cwd: string, identities: IdentityRegistry): void {
  if (ident.role === "supervisor") return;
  if (gitCommonDir(cwd) === join(cwd, ".git")) throw new Error(`SLP: Paseo did not create a worktree for ${ident.role} (cwd is the main checkout ${cwd}).`);
  if (ident.role === "peer-review" && headOf(cwd) !== ident.reviewCommit) throw new Error(`SLP: reviewer worktree ${cwd} is not at the review commit ${ident.reviewCommit}.`);
  identities.place(ident.tokenHash, { worktree: cwd, workspaceId: ident.workspaceId, branch: currentBranch(cwd) });
  Object.assign(ident, { worktree: cwd, branch: currentBranch(cwd) });
}

export function transformCreate(req: CreateRequest, deps: AgentConfigDeps): CreateRequest {
  const role = roleOfProvider(req.config.provider);
  if (!role) return req;
  let token = req.env?.SLP_TOKEN;
  let ident = token ? deps.identities.byToken(token) : null;
  if (!ident) {
    if (role !== "supervisor") throw new Error(`SLP: ${ROLE_PROVIDER[role]} agents can only be created through slp_spawn.`);
    const found = projectForCwd(deps.config, req.config.cwd);
    if (!found) throw new Error(`SLP: ${req.config.cwd} is not a project in ~/.slp/config.json.`);
    // One Supervisor per idea: it has no feature until its first slp_brief (spec §7.4).
    const minted = deps.identities.mint({ role, project: found.name, feature: null, task: null, reviewCommit: null, parentAgentId: null });
    ident = minted; token = minted.token;
  }
  if (ident.role !== role) throw new Error(`SLP: token role ${ident.role} does not match provider ${req.config.provider}`);
  if (req.config.thinkingOptionId === "ultracode") throw new Error("SLP: thinking \"ultracode\" starts Claude Code's own multi-agent workflow, outside slp_spawn and the writer cap; pick xhigh in the role's agent profile.");
  recordPlacement(ident, req.config.cwd, deps.identities);
  const vendor = deps.setup().vendor[role];
  const base = asRecord(req.config.providerOptions);
  const providerOptions = vendor === "claude"
    ? {
        ...base, sandbox: claudeSandbox(ident, deps.config, req.config.cwd, deps.stateDirs), ...claudeIsolation(req.config.cwd, deps.claudePluginDir, base.extraArgs),
        disallowedTools: [...new Set([...(Array.isArray(base.disallowedTools) ? (base.disallowedTools as string[]) : []), ...CLAUDE_DISALLOWED_TOOLS])],
      }
    : { ...base, sandbox_mode: "workspace-write", approval_policy: "on-request", sandbox_workspace_write: { network_access: false } };
  const runtimeEnv: Record<string, string> = vendor === "claude" ? { ...CLAUDE_ISOLATION_ENV } : { CODEX_HOME: deps.codexHome() };
  const preapproved: McpToolRef[] = deps.toolNames(role).map((tool) => ({ kind: "mcp", server: "slp", tool }));
  return {
    ...req,
    env: { ...req.env, ...runtimeEnv, SLP_TOKEN: token! },
    config: {
      ...req.config,
      modeId: vendor === "claude" ? "default" : "auto",
      systemPrompt: deps.promptFor(ident),
      providerOptions,
      toolPolicy: { preapproved: [...(req.config.toolPolicy?.preapproved ?? []), ...preapproved] },
      mcpServers: { ...req.config.mcpServers, slp: { type: "http", url: deps.mcpUrl(), headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } },
    },
  };
}

export function bindSession(req: { agentId: string; env: Record<string, string> }, identities: IdentityRegistry): void {
  const token = req.env?.SLP_TOKEN;
  if (token && identities.byToken(token)) identities.bind(token, req.agentId);
}
