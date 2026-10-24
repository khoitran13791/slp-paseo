import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindSession, claudeSandbox, ensureCodexHome, ensureRunnerHome, findSuperpowersDir, sessionOpen, stripCodexSandbox, transformCreate } from "../server/agentConfig";
import { parseSlpConfig } from "../server/config";
import { headOf, trustRepo } from "../server/git";
import { IdentityRegistry, type Identity } from "../server/identity";
import { ProjectRegistry } from "../server/projects";
import type { Role, RoleSetup } from "../server/roles";
import { initRepo, sh, tmpDir } from "./helpers";

const STATE = ["/home/u/.slp", "/home/u/.paseo"];
const DENY = [...STATE, join(homedir(), ".slp"), join(homedir(), ".paseo")];
const PLUGIN_DIR = "/home/u/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1";
const CODEX_HOME = "/home/u/.slp/codex-home";
const ISOLATION = { additionalDirectories: [] as string[], extraArgs: { "setting-sources": "", "strict-mcp-config": null, "plugin-dir": PLUGIN_DIR }, disallowedTools: ["Agent", "Task", "AskUserQuestion"] };
function deps() {
  const repo = initRepo("demo"); trustRepo(repo); sh(repo, "git", ["remote", "add", "origin", join(tmpDir(), "o.git")]);
  const config = parseSlpConfig({});
  const projects = new ProjectRegistry(join(tmpDir(), "projects.json"));
  const identities = new IdentityRegistry(join(tmpDir(), "ids.json"));
  const setup: RoleSetup = { vendor: { supervisor: "claude", lead: "claude", "peer-impl": "claude", "peer-review": "codex" }, profile: {} };
  const d = { identities, config, projects, setup: () => setup, mcpUrl: () => "http://127.0.0.1:47320/mcp", promptFor: (i: { role: string }) => `PROMPT ${i.role}`, toolNames: (r: Role) => ["slp_state", `slp_${r}`], stateDirs: STATE, claudePluginDir: PLUGIN_DIR as string | null, codexHome: () => CODEX_HOME };
  return { repo, config, identities, d };
}
const ident = (role: Role): Identity => ({ tokenHash: "t", role, project: "demo", feature: "f", task: null, worktree: "/w", workspaceId: null, branch: null, reviewCommit: null, agentId: "a", parentAgentId: null, createdAt: "", retiredAt: null });
function worktree(repo: string, branch: string): string {
  const wt = join(tmpDir(), branch.replaceAll("/", "-"));
  sh(repo, "git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", branch, wt, "main"]);
  return wt;
}
const peerMeta = { role: "peer-impl" as const, project: "demo", feature: "f", task: "T1", reviewCommit: null, parentAgentId: "lead-1" };

describe("transformCreate", () => {
  it("takes AskUserQuestion away from every Claude role, so the human answers in chat where SLP records it (rev 5.10 G1)", () => {
    const { d, repo } = deps();
    const out = transformCreate({ config: { provider: "slp-supervisor", cwd: repo } }, d);
    expect((out.config.providerOptions as { disallowedTools: string[] }).disallowedTools).toContain("AskUserQuestion");
  });
  it("leaves non-SLP providers untouched", () => {
    const { d } = deps();
    const req = { config: { provider: "claude/claude-haiku-4-5", cwd: "/x" } };
    expect(transformCreate(req, d)).toBe(req);
  });
  it("registers the repo and mints a Supervisor for it, and wires prompt, MCP, tool policy, mode and sandbox", () => {
    const { d, repo, identities } = deps();
    const out = transformCreate({ config: { provider: "slp-supervisor", cwd: repo, mcpServers: { other: { type: "http", url: "u" } } } }, d);
    const token = out.env!.SLP_TOKEN!;
    expect(identities.byToken(token)).toMatchObject({ role: "supervisor", project: "demo", feature: null });
    expect(out.config).toMatchObject({ modeId: "default", systemPrompt: "PROMPT supervisor" });
    expect(out.config.mcpServers).toEqual({ other: { type: "http", url: "u" }, slp: { type: "http", url: "http://127.0.0.1:47320/mcp", headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } });
    expect(out.config.toolPolicy).toEqual({ preapproved: [{ kind: "mcp", server: "slp", tool: "slp_state" }, { kind: "mcp", server: "slp", tool: "slp_supervisor" }] });
    expect(out.config.providerOptions).toEqual({ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [repo], denyRead: DENY }, network: { allowedDomains: [], allowLocalBinding: false } }, ...ISOLATION, additionalDirectories: [repo] });
    expect(out.env).toMatchObject({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
  });
  it("registers the repo of a new Supervisor's folder, and refuses a folder outside any git repo (rev 5.11)", () => {
    const { d, identities } = deps();
    const other = initRepo("my-app"); sh(other, "git", ["remote", "add", "origin", join(tmpDir(), "o.git")]); mkdirSync(join(other, "src"));
    const out = transformCreate({ config: { provider: "slp-supervisor", cwd: join(other, "src") } }, d);
    expect(identities.byToken(out.env!.SLP_TOKEN!)).toMatchObject({ role: "supervisor", project: "my-app" });
    expect(() => transformCreate({ config: { provider: "slp-supervisor", cwd: tmpDir() } }, d)).toThrow(/not inside a git repo/);
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
    expect((out.config.providerOptions as { disallowedTools: unknown }).disallowedTools).toEqual(["WebSearch", "Task", "Agent", "AskUserQuestion"]);
    expect(() => transformCreate({ config: { provider: "slp-supervisor", cwd: repo, thinkingOptionId: "ultracode" } }, d)).toThrow(/ultracode/);
    expect(transformCreate({ config: { provider: "claude", cwd: repo, thinkingOptionId: "ultracode" } }, d).config.thinkingOptionId).toBe("ultracode");
  });
  it("refuses a Supervisor outside any project and starts one Supervisor per idea, each without a feature yet", () => {
    const { d, repo, identities } = deps();
    expect(() => transformCreate({ config: { provider: "slp-supervisor", cwd: tmpDir() } }, d)).toThrow(/not inside a git repo/);
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
    expect((out.config.providerOptions as { sandbox: { filesystem: unknown } }).sandbox.filesystem).toEqual({ denyWrite: [join(realpathSync(wt), ".git")], denyRead: DENY });
    expect((out.config.providerOptions as { additionalDirectories: unknown }).additionalDirectories).toEqual([realpathSync(wt)]);
    expect(identities.byToken(impl.token)).toMatchObject({ worktree: realpathSync(wt), branch: "slp/f/T1-1" });
  });
  it("gives a Peer-impl registry-only network, and denies writing the .git link and reading state dirs", () => {
    const { d, identities, repo } = deps();
    const wt = worktree(repo, "slp/f/T1-1");
    const peer = identities.mint(peerMeta);
    const out = transformCreate({ config: { provider: "slp-peer-impl/claude-sonnet-5", cwd: wt }, env: { SLP_TOKEN: peer.token } }, d);
    expect((out.config.providerOptions as { sandbox: unknown }).sandbox).toEqual({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [join(wt, ".git")], denyRead: DENY }, network: { allowedDomains: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"], allowLocalBinding: false } });
  });
  it("drops sandbox and profile keys that a Codex request brings in", () => {
    expect(stripCodexSandbox({ sandbox_mode: "danger-full-access", default_permissions: ":danger", permissions: {}, model_reasoning_effort: "high" })).toEqual({ model_reasoning_effort: "high" });
  });
  it("configures a Codex reviewer with no legacy sandbox, so its CODEX_HOME profile decides, at exactly the review commit", () => {
    const { d, identities, repo } = deps();
    const wt = worktree(repo, "slp/f/review-T1-1");
    const rev = identities.mint({ ...peerMeta, role: "peer-review", reviewCommit: headOf(wt) });
    const out = transformCreate({ config: { provider: "slp-peer-review", cwd: wt, modeId: "auto", providerOptions: { sandbox_mode: "workspace-write" } }, env: { SLP_TOKEN: rev.token } }, d);
    expect(out.config.modeId).toBeUndefined();
    expect(out.config.providerOptions).toEqual({ approval_policy: "on-request", sandbox_workspace_write: { network_access: false } });
    expect(out.env).toMatchObject({ CODEX_HOME, SLP_TOKEN: rev.token });
    expect(out.env).not.toHaveProperty("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD");
    const stale = identities.mint({ ...peerMeta, role: "peer-review", reviewCommit: "0".repeat(40) });
    expect(() => transformCreate({ config: { provider: "slp-peer-review", cwd: worktree(repo, "slp/f/review-T1-2") }, env: { SLP_TOKEN: stale.token } }, d)).toThrow(/not at the review commit/);
  });
});

describe("ensureCodexHome", () => {
  it("writes a Codex home whose default profile denies reading the state dirs", () => {
    const src = tmpDir(); writeFileSync(join(src, "auth.json"), "{}");
    const dir = ensureCodexHome(join(tmpDir(), "codex-home"), src, ["/h/.slp", "/h/.paseo"]);
    const toml = readFileSync(join(dir, "config.toml"), "utf8");
    expect(toml).toContain('default_permissions = "slp-review"');
    expect(toml).toContain('[permissions.slp-review.filesystem]');
    expect(toml).toContain('"/h/.paseo" = "deny"');
    expect(toml).not.toContain("trust_level");
  });
  it("writes a runner home with the slp-verify profile", () => {
    const dir = ensureRunnerHome(join(tmpDir(), "runner"), ["/h/.slp"]);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain('[permissions.slp-verify]\nextends = ":workspace"');
  });
  it("adds sandbox.denyRead to the Claude sandbox's denyRead", () => {
    const cfg = parseSlpConfig({ sandbox: { denyRead: ["~/.slp", "~/.ssh"] } });
    const sb = claudeSandbox(ident("lead"), cfg, "/w", ["/state/.slp"]) as { filesystem: { denyRead: string[] } };
    expect(sb.filesystem.denyRead).toEqual(["/state/.slp", join(homedir(), ".slp"), join(homedir(), ".ssh")]);
  });
  it("shares only auth.json, rewrites config.toml on every call, and fails without a Codex login", () => {
    const source = tmpDir(); writeFileSync(join(source, "auth.json"), "{}"); writeFileSync(join(source, "config.toml"), "[mcp_servers.cua_repl]\ncommand = \"x\"\n");
    const dir = join(tmpDir(), "codex-home");
    expect(ensureCodexHome(dir, source, [])).toBe(dir);
    expect(lstatSync(join(dir, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "auth.json"))).toBe(join(source, "auth.json"));
    expect(readFileSync(join(dir, "config.toml"), "utf8")).not.toMatch(/^\[(mcp_servers|projects)/m);
    writeFileSync(join(dir, "config.toml"), `[projects."/x"]\ntrust_level = "trusted"\n`); // Codex may record trust here
    ensureCodexHome(dir, source, []);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).not.toMatch(/trust_level/);
    expect(() => ensureCodexHome(join(tmpDir(), "h"), tmpDir(), [])).toThrow(/log in to Codex/);
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

describe("sessionOpen (rev 5.10 F6)", () => {
  const base = { workspaceId: null, cwd: "/w", purpose: "interactive" as const };
  it("gives an SLP role its env back at every session open, refresh included, and binds the token at create", () => {
    const { identities, d } = deps();
    const rev = identities.mint({ role: "peer-review", project: "demo", feature: "f", task: "T1", reviewCommit: "abc", parentAgentId: "lead-1" });
    expect(sessionOpen({ ...base, agentId: "rev-1", provider: "slp-peer-review", reason: "create", env: { SLP_TOKEN: rev.token } }, d)?.env).toEqual({ SLP_TOKEN: rev.token, CODEX_HOME });
    expect(identities.byAgent("rev-1")?.tokenHash).toBe(rev.tokenHash);
    expect(sessionOpen({ ...base, agentId: "rev-1", provider: "slp-peer-review", reason: "refresh", env: {} }, d)?.env).toEqual({ CODEX_HOME });
    expect(sessionOpen({ ...base, agentId: "lead-1", provider: "slp-lead/claude-opus-5-5", reason: "resume", env: { KEEP: "1" } }, d)?.env).toEqual({ KEEP: "1", CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
  });
  it("leaves a non-SLP session alone, and still restores env for a retired SLP agent (Review Focus)", () => {
    const { identities, d } = deps();
    expect(sessionOpen({ ...base, agentId: "x", provider: "codex/gpt-5.5", reason: "refresh", env: { A: "1" } }, d)).toBeUndefined();
    const rev = identities.mint({ role: "peer-review", project: "demo", feature: "f", task: "T1", reviewCommit: "abc", parentAgentId: "lead-1" });
    identities.bind(rev.token, "rev-2");
    identities.retire(rev.tokenHash);
    expect(sessionOpen({ ...base, agentId: "rev-2", provider: "slp-peer-review", reason: "refresh", env: {} }, d)?.env).toEqual({ CODEX_HOME });
  });
});
