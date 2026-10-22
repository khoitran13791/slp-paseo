import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Identity } from "../server/identity";
import { decidePermission } from "../server/permissions";
import { tmpDir } from "./helpers";

const ident = (role: Identity["role"], worktree: string | null): Identity =>
  ({ tokenHash: "t", role, project: "p", feature: "f", task: "T1", worktree, workspaceId: null, branch: null, reviewCommit: null, agentId: "a", parentAgentId: null, createdAt: "", retiredAt: null });
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ id: "r", name: "Bash", kind: "tool", input: { command, ...extra } });

describe("decidePermission", () => {
  it("ignores agents that are not SLP roles", () => {
    expect(decidePermission(bash("rm -rf /"), null)).toEqual({ action: "ignore" });
  });
  it("leaves other MCP servers to the human (slp_* tools are preapproved by toolPolicy)", () => {
    expect(decidePermission({ id: "r", name: "CodexMcpElicitation", title: 'Allow the github MCP server to run tool "x"?' }, ident("peer-review", "/w")).action).toBe("defer");
  });
  it("denies any tool that touches the SLP or Paseo state dirs, and WebFetch to loopback", () => {
    const opts = { deniedRoots: ["/home/u/.slp", "/home/u/.paseo"], realpath: (p: string) => p };
    expect(decidePermission({ id: "r", name: "Read", input: { file_path: "/home/u/.paseo/agents/a.json" } }, ident("peer-impl", "/w"), opts).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Grep", input: { path: "/home/u/.slp" } }, ident("lead", "/w"), opts).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "WebFetch", input: { url: "http://127.0.0.1:47320/mcp" } }, ident("lead", "/w"), opts).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "WebFetch", input: { url: "http://localhost:6767/" } }, ident("lead", "/w"), opts).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "WebFetch", input: { url: "https://docs.example.com/" } }, ident("lead", "/w"), opts).action).toBe("defer");
  });
  it.each(["/Applications/Paseo.app/Contents/Resources/bin/paseo ls", "paseo send x hi", "cd x && paseo ls", "git push origin main", "git commit -m x", "git -c core.hooksPath=/dev/null commit -m x", "git merge main", "git worktree add ../x"])(
    "denies plugin-reserved command: %s", (command) => {
      expect(decidePermission(bash(command), ident("peer-impl", "/w")).action).toBe("deny");
    });
  it("denies requests to leave the sandbox and defers other shell commands", () => {
    expect(decidePermission(bash("npm install", { dangerouslyDisableSandbox: true }), ident("peer-impl", "/w")).action).toBe("deny");
    expect(decidePermission(bash("git status && npm test"), ident("peer-impl", "/w"))).toEqual({ action: "defer", reason: "shell: git status && npm test" });
    expect(decidePermission({ id: "r", name: "CodexBash", input: { command: "paseo ls", cwd: "/w" } }, ident("peer-review", "/w")).action).toBe("deny");
  });
  it("lets only a Peer-impl edit, and only inside its worktree after resolving symlinks", () => {
    const root = tmpDir(); const wt = join(root, "wt"); const outside = join(root, "outside");
    mkdirSync(join(wt, "src"), { recursive: true }); mkdirSync(outside); symlinkSync(outside, join(wt, "escape"));
    const peer = ident("peer-impl", wt);
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "src", "new.ts") } }, peer)).toEqual({ action: "allow" });
    expect(decidePermission({ id: "r", name: "Edit", input: { file_path: join(wt, "deep", "missing", "x.ts") } }, peer)).toEqual({ action: "allow" });
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "escape", "x.ts") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "..", "x.ts") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "src", "a.ts") } }, ident("lead", wt))).toEqual({ action: "deny", message: "SLP: role lead does not edit files." });
  });
  it("denies edits to the worktree's .git link", () => {
    const wt = tmpDir(); const peer = ident("peer-impl", wt);
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, ".git") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Edit", input: { file_path: join(wt, ".git", "config") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "paseo.json") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, ".husky", "post-checkout") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, ".claude", "settings.json") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Edit", input: { file_path: join(wt, ".codex", "config.toml") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, ".mcp.json") } }, peer).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, ".github", "ci.yml") } }, peer).action).toBe("allow");
  });
  it("denies case, Unicode and bare-name variants of protected paths (macOS folds case and ſ to s)", () => {
    const wt = tmpDir(); const peer = ident("peer-impl", wt);
    for (const p of [join(wt, ".CLAUDE", "settings.json"), join(wt, "Paseo.json"), join(wt, ".huſky", "pre-commit"), join(wt, ".claude"), join(wt, ".GIT", "config")]) {
      expect(decidePermission({ id: "r", name: "Write", input: { file_path: p } }, peer).action, p).toBe("deny");
    }
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "src", ".claude-notes.md") } }, peer)).toEqual({ action: "allow" });
  });
  it("accepts /tmp paths that resolve inside a /private/tmp worktree", () => {
    const viaTmp = mkdtempSync("/tmp/slp-wt-");          // on macOS /tmp is a symlink to /private/tmp
    const wt = realpathSync(viaTmp);
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(viaTmp, "a.ts") } }, ident("peer-impl", wt))).toEqual({ action: "allow" });
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "a.ts") } }, ident("peer-impl", viaTmp))).toEqual({ action: "allow" });
  });
  it("defers everything else", () => {
    expect(decidePermission({ id: "r", name: "AskUserQuestion", kind: "question" }, ident("peer-impl", "/w"))).toEqual({ action: "defer", reason: "question: AskUserQuestion" });
  });
});
