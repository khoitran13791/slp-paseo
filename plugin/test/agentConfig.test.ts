import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindSession, ensureCodexHome, findSuperpowersDir, transformCreate } from "../server/agentConfig";
import { parseSlpConfig } from "../server/config";
import { headOf, trustRepo } from "../server/git";
import { IdentityRegistry } from "../server/identity";
import type { Role, RoleSetup } from "../server/roles";
import { initRepo, sh, tmpDir } from "./helpers";

const STATE = ["/home/u/.slp", "/home/u/.paseo"];
const PLUGIN_DIR = "/home/u/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1";
const CODEX_HOME = "/home/u/.slp/codex-home";
const ISOLATION = { additionalDirectories: [] as string[], extraArgs: { "setting-sources": "", "strict-mcp-config": null, "plugin-dir": PLUGIN_DIR }, disallowedTools: ["Agent", "Task"] };
function deps() {
  const repo = initRepo(); trustRepo(repo);
  const config = parseSlpConfig({ projects: { demo: { repo, verify: ["npm test"] } } });
  const identities = new IdentityRegistry(join(tmpDir(), "ids.json"));
  const setup: RoleSetup = { vendor: { supervisor: "claude", lead: "claude", "peer-impl": "claude", "peer-review": "codex" }, profile: {} };
  const d = { identities, config, setup: () => setup, mcpUrl: () => "http://127.0.0.1:47320/mcp", promptFor: (i: { role: string }) => `PROMPT ${i.role}`, toolNames: (r: Role) => ["slp_state", `slp_${r}`], stateDirs: STATE, claudePluginDir: PLUGIN_DIR as string | null, codexHome: () => CODEX_HOME };
  return { repo, config, identities, d };
}
function worktree(repo: string, branch: string): string {
  const wt = join(tmpDir(), branch.replaceAll("/", "-"));
  sh(repo, "git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", branch, wt, "main"]);
  return wt;
}
const peerMeta = { role: "peer-impl" as const, project: "demo", feature: "f", task: "T1", reviewCommit: null, parentAgentId: "lead-1" };

describe("transformCreate", () => {
  it("leaves non-SLP providers untouched", () => {
    const { d } = deps();
    const req = { config: { provider: "claude/claude-haiku-4-5", cwd: "/x" } };
    expect(transformCreate(req, d)).toBe(req);
  });
  it("mints a Supervisor for a configured project and wires prompt, MCP, tool policy, mode and sandbox", () => {
    const { d, repo, identities } = deps();
    const out = transformCreate({ config: { provider: "slp-supervisor", cwd: repo, mcpServers: { other: { type: "http", url: "u" } } } }, d);
    const token = out.env!.SLP_TOKEN!;
    expect(identities.byToken(token)).toMatchObject({ role: "supervisor", project: "demo", feature: null });
    expect(out.config).toMatchObject({ modeId: "default", systemPrompt: "PROMPT supervisor" });
    expect(out.config.mcpServers).toEqual({ other: { type: "http", url: "u" }, slp: { type: "http", url: "http://127.0.0.1:47320/mcp", headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } });
    expect(out.config.toolPolicy).toEqual({ preapproved: [{ kind: "mcp", server: "slp", tool: "slp_state" }, { kind: "mcp", server: "slp", tool: "slp_supervisor" }] });
    expect(out.config.providerOptions).toEqual({ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [repo], denyRead: STATE }, network: { allowedDomains: [], allowLocalBinding: false } }, ...ISOLATION, additionalDirectories: [repo] });
    expect(out.env).toMatchObject({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
  });
  it("keeps the operator's and the repo's settings, hooks and MCP servers out of Claude roles, whatever the caller passed", () => {
    const { d, repo } = deps();
    const out = transformCreate({ config: { provider: "slp-supervisor", cwd: repo, providerOptions: { extraArgs: { "setting-sources": "user,project,local", verbose: null } } } }, d);
    expect((out.config.providerOptions as { extraArgs: unknown }).extraArgs).toEqual({ verbose: null, "setting-sources": "", "strict-mcp-config": null, "plugin-dir": PLUGIN_DIR });
    const bare = transformCreate({ config: { provider: "slp-supervisor", cwd: repo } }, { ...d, claudePluginDir: null });
    expect((bare.config.providerOptions as { extraArgs: unknown }).extraArgs).toEqual({ "setting-sources": "", "strict-mcp-config": null });
  });
  it("keeps one command chain: no Claude subagents, no Ultra Code, the caller's other disallowed tools kept", () => {
    const { d, repo } = deps();
    const out = transformCreate({ config: { provider: "slp-supervisor", cwd: repo, providerOptions: { disallowedTools: ["WebSearch", "Task"] } } }, d);
    expect((out.config.providerOptions as { disallowedTools: unknown }).disallowedTools).toEqual(["WebSearch", "Task", "Agent"]);
    expect(() => transformCreate({ config: { provider: "slp-supervisor", cwd: repo, thinkingOptionId: "ultracode" } }, d)).toThrow(/ultracode/);
    expect(transformCreate({ config: { provider: "claude", cwd: repo, thinkingOptionId: "ultracode" } }, d).config.thinkingOptionId).toBe("ultracode");
  });
  it("refuses a Supervisor outside any project and starts one Supervisor per idea, each without a feature yet", () => {
    const { d, repo, identities } = deps();
    expect(() => transformCreate({ config: { provider: "slp-supervisor", cwd: tmpDir() } }, d)).toThrow(/not a project/);
    const first = transformCreate({ config: { provider: "slp-supervisor", cwd: repo } }, d);
    identities.bind(first.env!.SLP_TOKEN!, "sup-1");
    const second = transformCreate({ config: { provider: "slp-supervisor", cwd: repo } }, d);
    expect(second.env!.SLP_TOKEN).not.toBe(first.env!.SLP_TOKEN);
    expect(identities.byToken(second.env!.SLP_TOKEN!)).toMatchObject({ role: "supervisor", feature: null });
  });
  it("refuses Lead and Peer agents created outside slp_spawn, and mismatched tokens", () => {
    const { d, identities, repo } = deps();
    expect(() => transformCreate({ config: { provider: "slp-lead", cwd: "/x" } }, d)).toThrow(/only be created through slp_spawn/);
    const peer = identities.mint(peerMeta);
    expect(() => transformCreate({ config: { provider: "slp-lead", cwd: worktree(repo, "slp/f/T1-1") }, env: { SLP_TOKEN: peer.token } }, d)).toThrow(/does not match/);
  });
  it("records the worktree and branch Paseo created, and refuses the main checkout", () => {
    const { d, identities, repo } = deps();
    const wt = worktree(repo, "slp/f/T1-1");
    const peer = identities.mint(peerMeta);
    transformCreate({ config: { provider: "slp-peer-impl/claude-sonnet-5", cwd: wt }, env: { SLP_TOKEN: peer.token } }, d);
    expect(identities.byToken(peer.token)).toMatchObject({ worktree: wt, branch: "slp/f/T1-1" });
    const other = identities.mint({ ...peerMeta, task: "T2" });
    expect(() => transformCreate({ config: { provider: "slp-peer-impl", cwd: repo }, env: { SLP_TOKEN: other.token } }, d)).toThrow(/did not create a worktree/);
  });
  it("sees through a symlinked path: an alias of the main checkout is still refused, an alias of a worktree is recorded by its real path", () => {
    const { d, identities, repo } = deps();
    const alias = join(tmpDir(), "main-alias"); symlinkSync(repo, alias);
    const peer = identities.mint(peerMeta);
    expect(() => transformCreate({ config: { provider: "slp-peer-impl", cwd: alias }, env: { SLP_TOKEN: peer.token } }, d)).toThrow(/did not create a worktree/);
    const lead = identities.mint({ role: "lead", project: "demo", feature: "f", task: null, reviewCommit: null, parentAgentId: "sup" });
    expect(() => transformCreate({ config: { provider: "slp-lead", cwd: alias }, env: { SLP_TOKEN: lead.token } }, d)).toThrow(/did not create a worktree/);

    const wt = worktree(repo, "slp/f/T1-1");
    const wtAlias = join(tmpDir(), "wt-alias"); symlinkSync(wt, wtAlias);
    const impl = identities.mint({ ...peerMeta, task: "T2" });
    const out = transformCreate({ config: { provider: "slp-peer-impl", cwd: wtAlias }, env: { SLP_TOKEN: impl.token } }, d);
    expect(out.config.cwd).toBe(wtAlias); // Paseo owns cwd; only SLP's own decisions use the real path
    expect((out.config.providerOptions as { sandbox: { filesystem: unknown } }).sandbox.filesystem).toEqual({ denyWrite: [join(realpathSync(wt), ".git")], denyRead: STATE });
    expect((out.config.providerOptions as { additionalDirectories: unknown }).additionalDirectories).toEqual([realpathSync(wt)]);
    expect(identities.byToken(impl.token)).toMatchObject({ worktree: realpathSync(wt), branch: "slp/f/T1-1" });
  });
  it("gives a Peer-impl registry-only network, and denies writing the .git link and reading state dirs", () => {
    const { d, identities, repo } = deps();
    const wt = worktree(repo, "slp/f/T1-1");
    const peer = identities.mint(peerMeta);
    const out = transformCreate({ config: { provider: "slp-peer-impl/claude-sonnet-5", cwd: wt }, env: { SLP_TOKEN: peer.token } }, d);
    expect((out.config.providerOptions as { sandbox: unknown }).sandbox).toEqual({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [join(wt, ".git")], denyRead: STATE }, network: { allowedDomains: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"], allowLocalBinding: false } });
  });
  it("configures a Codex reviewer with workspace-write and no network, at exactly the review commit", () => {
    const { d, identities, repo } = deps();
    const wt = worktree(repo, "slp/f/review-T1-1");
    const rev = identities.mint({ ...peerMeta, role: "peer-review", reviewCommit: headOf(wt) });
    const out = transformCreate({ config: { provider: "slp-peer-review", cwd: wt }, env: { SLP_TOKEN: rev.token } }, d);
    expect(out.config.modeId).toBe("auto");
    expect(out.config.providerOptions).toEqual({ sandbox_mode: "workspace-write", approval_policy: "on-request", sandbox_workspace_write: { network_access: false } });
    expect(out.env).toMatchObject({ CODEX_HOME, SLP_TOKEN: rev.token });
    expect(out.env).not.toHaveProperty("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD");
    const stale = identities.mint({ ...peerMeta, role: "peer-review", reviewCommit: "0".repeat(40) });
    expect(() => transformCreate({ config: { provider: "slp-peer-review", cwd: worktree(repo, "slp/f/review-T1-2") }, env: { SLP_TOKEN: stale.token } }, d)).toThrow(/not at the review commit/);
  });
});

describe("ensureCodexHome", () => {
  it("shares only auth.json, rewrites config.toml on every call, and fails without a Codex login", () => {
    const source = tmpDir(); writeFileSync(join(source, "auth.json"), "{}"); writeFileSync(join(source, "config.toml"), "[mcp_servers.cua_repl]\ncommand = \"x\"\n");
    const dir = join(tmpDir(), "codex-home");
    expect(ensureCodexHome(dir, source)).toBe(dir);
    expect(lstatSync(join(dir, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "auth.json"))).toBe(join(source, "auth.json"));
    expect(readFileSync(join(dir, "config.toml"), "utf8")).not.toMatch(/^\[(mcp_servers|projects)/m);
    writeFileSync(join(dir, "config.toml"), `[projects."/x"]\ntrust_level = "trusted"\n`); // Codex may record trust here
    ensureCodexHome(dir, source);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).not.toMatch(/trust_level/);
    expect(() => ensureCodexHome(join(tmpDir(), "h"), tmpDir())).toThrow(/log in to Codex/);
  });
});

describe("findSuperpowersDir", () => {
  it("picks the newest numeric version and returns null when Superpowers is absent", () => {
    const home = tmpDir(); const root = join(home, "plugins", "cache", "claude-plugins-official", "superpowers");
    for (const v of ["6.4.1", "6.10.0", "6.9.9", "notes"]) mkdirSync(join(root, v), { recursive: true });
    expect(findSuperpowersDir(home)).toBe(join(root, "6.10.0"));
    expect(findSuperpowersDir(tmpDir())).toBeNull();
  });
});

describe("bindSession", () => {
  it("binds the token from env to the agent id and ignores agents without a token", () => {
    const { identities } = deps();
    const lead = identities.mint({ role: "lead", project: "demo", feature: "f", task: null, reviewCommit: null, parentAgentId: "sup" });
    bindSession({ agentId: "lead-1", env: { SLP_TOKEN: lead.token } }, identities);
    expect(identities.byAgent("lead-1")?.tokenHash).toBe(lead.tokenHash);
    expect(() => bindSession({ agentId: "x", env: {} }, identities)).not.toThrow();
  });
});
