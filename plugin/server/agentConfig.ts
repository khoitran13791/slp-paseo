import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome, projectForCwd, type SlpConfig } from "./config";
import { currentBranch, gitCommonDir, headOf } from "./git";
import type { Identity, IdentityRegistry } from "./identity";
import { ROLE_PROVIDER, roleOfProvider, type Role, type RoleSetup, type Vendor } from "./roles";

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
    filesystem: { denyWrite: [impl ? join(cwd, ".git") : cwd], denyRead: [...new Set([...stateDirs, ...config.sandbox.denyRead.map(expandHome)])] },
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

/** A role's process env. Paseo saves agent config but not env overrides, so this runs at create and at every session open (spec §7.1 rev 5.10). */
export function roleEnv(vendor: Vendor, codexHome: () => string): Record<string, string> {
  return vendor === "claude" ? { ...CLAUDE_ISOLATION_ENV } : { CODEX_HOME: codexHome() };
}

const CODEX_CONFIG = "# Written by the SLP plugin before each Codex role starts. No MCP servers and no trusted projects:\n# the agent gets only what Paseo passes for its session.\n";

/** A CODEX_HOME that shares only auth.json with the operator's Codex home (their MCP servers include computer use). */
/** A Codex permission profile on top of :workspace that denies reading each path (checked with codex sandbox -P, 2026-10-23). */
export function codexDenyProfile(name: string, denyRead: string[]): string {
  return [`[permissions.${name}]`, `extends = ":workspace"`, "", `[permissions.${name}.filesystem]`, ...denyRead.map((p) => `${JSON.stringify(p)} = "deny"`), ""].join("\n");
}

export function ensureCodexHome(dir: string, sourceHome: string, denyRead: string[]): string {
  const auth = join(sourceHome, "auth.json");
  if (!existsSync(auth)) throw new Error(`SLP: ${auth} not found; log in to Codex before starting a Codex role.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Rewritten on every start: this also drops the trust entry Codex or Paseo adds while the reviewer runs (T21).
  writeFileSync(join(dir, "config.toml"), `${CODEX_CONFIG}default_permissions = "slp-review"\n\n${codexDenyProfile("slp-review", denyRead)}`);
  const link = join(dir, "auth.json");
  let target: string | null = null;
  try { target = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : ""; } catch { target = null; }
  if (target !== auth) { rmSync(link, { force: true }); symlinkSync(auth, link); }
  return dir;
}

export function ensureRunnerHome(dir: string, denyRead: string[]): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "config.toml"), `# Written by the SLP plugin for its verify runner (codex sandbox -P slp-verify).\ndefault_permissions = "slp-verify"\n\n${codexDenyProfile("slp-verify", denyRead)}`);
  return dir;
}

/** Keys that would pick a legacy sandbox or another permission profile than the CODEX_HOME default (review Codex 2026-10-23). */
const CODEX_SANDBOX_KEYS = ["sandbox_mode", "sandbox", "default_permissions", "permissions", "profile"];
export const stripCodexSandbox = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !CODEX_SANDBOX_KEYS.includes(k)));

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

/** Lead and Peers must run in a worktree Paseo created for them, never in the main checkout. `cwd` must already be a realpath. */
function recordPlacement(ident: Identity, cwd: string, identities: IdentityRegistry): void {
  if (ident.role === "supervisor") return;
  if (gitCommonDir(cwd) === join(cwd, ".git")) throw new Error(`SLP: Paseo did not create a worktree for ${ident.role} (cwd is the main checkout ${cwd}).`);
  if (ident.role === "peer-review" && headOf(cwd) !== ident.reviewCommit) throw new Error(`SLP: reviewer worktree ${cwd} is not at the review commit ${ident.reviewCommit}.`);
  const branch = currentBranch(cwd);
  identities.place(ident.tokenHash, { worktree: cwd, workspaceId: ident.workspaceId, branch });
  Object.assign(ident, { worktree: cwd, branch });
}

export function transformCreate(req: CreateRequest, deps: AgentConfigDeps): CreateRequest {
  const role = roleOfProvider(req.config.provider);
  if (!role) return req;
  let token = req.env?.SLP_TOKEN;
  let ident = token ? deps.identities.byToken(token) : null;
  if (!ident && role !== "supervisor") throw new Error(`SLP: ${ROLE_PROVIDER[role]} agents can only be created through slp_spawn.`);
  // Canonicalize once: cwd may be a symlink alias (or /tmp for /private/tmp), and every decision and sandbox path below uses the real path.
  const cwd = realpathSync(req.config.cwd);
  if (!ident) {
    const found = projectForCwd(deps.config, cwd);
    if (!found) throw new Error(`SLP: ${cwd} is not a project in ~/.slp/config.json.`);
    // One Supervisor per idea: it has no feature until its first slp_brief (spec §7.4).
    const minted = deps.identities.mint({ role, project: found.name, feature: null, task: null, reviewCommit: null, parentAgentId: null });
    ident = minted; token = minted.token;
  }
  if (ident.role !== role) throw new Error(`SLP: token role ${ident.role} does not match provider ${req.config.provider}`);
  if (req.config.thinkingOptionId === "ultracode") throw new Error("SLP: thinking \"ultracode\" starts Claude Code's own multi-agent workflow, outside slp_spawn and the writer cap; pick xhigh in the role's agent profile.");
  recordPlacement(ident, cwd, deps.identities);
  const vendor = deps.setup().vendor[role];
  const base = asRecord(req.config.providerOptions);
  const providerOptions = vendor === "claude"
    ? {
        ...base, sandbox: claudeSandbox(ident, deps.config, cwd, deps.stateDirs), ...claudeIsolation(cwd, deps.claudePluginDir, base.extraArgs),
        disallowedTools: [...new Set([...(Array.isArray(base.disallowedTools) ? (base.disallowedTools as string[]) : []), ...CLAUDE_DISALLOWED_TOOLS])],
      }
    : { ...stripCodexSandbox(base), approval_policy: "on-request", sandbox_workspace_write: { network_access: false } };
  const runtimeEnv = roleEnv(vendor, deps.codexHome);
  const preapproved: McpToolRef[] = deps.toolNames(role).map((tool) => ({ kind: "mcp", server: "slp", tool }));
  return {
    ...req,
    env: { ...req.env, ...runtimeEnv, SLP_TOKEN: token! },
    config: {
      ...req.config,
      // Codex: no modeId and no sandbox_mode, so Paseo sends no legacy sandbox at thread or turn start and the CODEX_HOME
      // default_permissions profile (deny ~/.slp, ~/.paseo) decides (paseo 0.12 codex-app-server-agent.ts; spike 2026-10-23).
      ...(vendor === "claude" ? { modeId: "default" } : { modeId: undefined }),
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

/** `before agent.session_open` request (plugin SDK 0.12 PluginSessionOpenRequest); the hook may change only env. */
export interface SessionOpenRequest { agentId: string; workspaceId: string | null; provider: string; cwd: string; reason: "create" | "resume" | "refresh" | "import"; purpose: "interactive" | "history"; env: Record<string, string> }

/** Binds the session's token, then gives an SLP role its env back: a reload opens the session without it (smoke rerun F6: the Codex reviewer resumed from ~/.codex and was lost). */
export function sessionOpen(req: SessionOpenRequest, deps: { identities: IdentityRegistry; setup: () => RoleSetup; codexHome: () => string }): SessionOpenRequest | undefined {
  bindSession(req, deps.identities);
  const role = roleOfProvider(req.provider);
  if (!role) return undefined;
  return { ...req, env: { ...req.env, ...roleEnv(deps.setup().vendor[role], deps.codexHome) } };
}
