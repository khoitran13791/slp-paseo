import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  it("denies protected paths at any depth, not only at the repo root", () => {
    const wt = tmpDir(); const peer = ident("peer-impl", wt);
    for (const p of [join(wt, "pkg", ".claude", "settings.json"), join(wt, "pkg", ".mcp.json"), join(wt, "a", "b", ".codex", "config.toml"), join(wt, "docs", "paseo.json"), join(wt, "frontend", ".husky", "pre-commit")]) {
      expect(decidePermission({ id: "r", name: "Write", input: { file_path: p } }, peer).action, p).toBe("deny");
    }
    expect(decidePermission({ id: "r", name: "Write", input: { file_path: join(wt, "src", "claude", "x.ts") } }, peer)).toEqual({ action: "allow" });
  });
  it("checks every path key of a write, not only the first one present", () => {
    const root = tmpDir(); const wt = join(root, "wt"); const outside = join(root, "outside");
    mkdirSync(join(wt, "src"), { recursive: true }); mkdirSync(outside);
    const peer = ident("peer-impl", wt);
    const edit = (input: Record<string, unknown>) => decidePermission({ id: "r", name: "NotebookEdit", input }, peer);
    expect(edit({ file_path: join(wt, "src", "a.ipynb"), notebook_path: join(outside, "n.ipynb") }).action).toBe("deny");
    expect(edit({ notebook_path: join(wt, "src", "a.ipynb"), path: join(outside, "n.ipynb") }).action).toBe("deny");
    expect(edit({ file_path: join(wt, "src", "a.ipynb"), notebook_path: join(wt, ".claude", "n.ipynb") }).action).toBe("deny");
    expect(edit({ file_path: join(wt, "src", "a.ipynb"), notebook_path: join(wt, "src", "b.ipynb") })).toEqual({ action: "allow" });
    expect(edit({ notebook_path: join(wt, "src", "b.ipynb") })).toEqual({ action: "allow" });
    expect(edit({}).action).toBe("deny");
    expect(edit({ file_path: "" }).action).toBe("deny");
  });
  it("denies writes through dangling symlinks, symlink loops and raw .. segments", () => {
    const root = tmpDir(); const wt = join(root, "wt"); const outside = join(root, "outside");
    mkdirSync(join(wt, "src"), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(wt, "src", "real.ts"), "");
    symlinkSync(join(outside, "nonexistent.txt"), join(wt, "dangling.txt"));
    symlinkSync(join(outside, "nonexistent-dir"), join(wt, "dangdir"));
    symlinkSync(join(wt, "loop"), join(wt, "loop"));
    symlinkSync(outside, join(wt, "escape"));
    symlinkSync(join(wt, "src", "real.ts"), join(wt, "alias.ts"));
    const peer = ident("peer-impl", wt);
    const write = (file_path: string) => decidePermission({ id: "r", name: "Write", input: { file_path } }, peer).action;
    expect(write(join(wt, "dangling.txt"))).toBe("deny");
    expect(write(join(wt, "dangdir", "x.ts"))).toBe("deny");
    expect(write(join(wt, "loop"))).toBe("deny");
    expect(write(join(wt, "loop", "x.ts"))).toBe("deny");
    expect(write(`${wt}/escape/../x.ts`)).toBe("deny");
    expect(write(join(wt, "alias.ts"))).toBe("allow");
  });
  it("denies state dirs however the path is spelled: ~, case, Unicode, relative", () => {
    const home = homedir();
    const opts = { deniedRoots: [join(home, ".paseo")], realpath: (p: string) => p };
    const read = (file_path: string) => decidePermission({ id: "r", name: "Read", input: { file_path } }, ident("peer-impl", "/w"), opts).action;
    expect(read("~/.paseo/agents/a.json")).toBe("deny");
    expect(read(`${home}/.PASEO/x`)).toBe("deny");
    expect(read(`${home}/.paſeo/x`)).toBe("deny");
    const wt = tmpDir();
    expect(decidePermission({ id: "r", name: "Read", input: { file_path: ".slp/x" } }, ident("lead", wt), { deniedRoots: [join(wt, ".slp")], realpath: (p: string) => p }).action).toBe("deny");
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

describe("decidePermission rev 5.9", () => {
  const claude = { deniedRoots: ["/home/u/.slp", "/home/u/.paseo"], vendor: "claude" as const, readRoots: ["/repo", "/wts/p"], realpath: (p: string) => p };
  const codex = { ...claude, vendor: "codex" as const };
  it("allows a Claude role's sandboxed shell, compound commands included (T21 B-8)", () => {
    for (const command of ["cd /wts/p/feat && npm test >/dev/null 2>&1; echo $?", "out=$(npm test 2>&1); rc=$?", "printf x > src/a.js && npm test | grep ok", "cat > f <<'EOF'\nx\nEOF"]) {
      expect(decidePermission(bash(command), ident("lead", "/wts/p/feat"), claude)).toEqual({ action: "allow" });
    }
  });
  it.each(["bash -c 'paseo ls'", "echo $(git push origin main)", "true && git -c a=b commit -m x", "sh -c \"git merge main\"", "\"paseo\" ls", "pa\"\"seo ls", "p\\aseo ls", "git -C /repo commit -m x", "git --git-dir=/repo/.git push", "git --no-pager -c x=y merge main", "git -C '/repo with spaces' commit -m x"])(
    "still denies a reserved command hidden in a compound command: %s", (command) => {
      expect(decidePermission(bash(command), ident("peer-impl", "/wts/p/T1"), claude).action).toBe("deny");
    });
  it("denies a Claude request to leave the sandbox even when shell is auto-allowed", () => {
    expect(decidePermission(bash("npm install", { dangerouslyDisableSandbox: true }), ident("peer-impl", "/wts/p/T1"), claude).action).toBe("deny");
  });
  it("denies every Codex shell approval: for Codex it asks to run outside the sandbox", () => {
    expect(decidePermission({ id: "r", name: "exec_command", input: { command: "npm test" } }, ident("peer-review", "/wts/p/rev"), codex).action).toBe("deny");
    expect(decidePermission({ id: "r", name: "CodexBash", input: { command: "cat x" } }, ident("peer-review", "/wts/p/rev"), codex).action).toBe("deny");
  });
  it("denies Paseo's own MCP tools (T21 B-3)", () => {
    expect(decidePermission({ id: "r", name: "mcp__paseo__create_terminal", input: {} }, ident("lead", "/wts/p/feat"), claude).action).toBe("deny");
  });
  it("allows reads inside the repo and the project's SLP worktrees, leaves other reads to the human", () => {
    expect(decidePermission({ id: "r", name: "Read", input: { file_path: "/wts/p/T1/test/a.test.js" } }, ident("lead", "/wts/p/feat"), claude)).toEqual({ action: "allow" });
    expect(decidePermission({ id: "r", name: "Grep", input: { path: "/repo/src", pattern: "x" } }, ident("supervisor", null), claude)).toEqual({ action: "allow" });
    expect(decidePermission({ id: "r", name: "Glob", input: { pattern: "**/*.ts" } }, ident("lead", "/wts/p/feat"), claude)).toEqual({ action: "allow" });
    expect(decidePermission({ id: "r", name: "Read", input: { file_path: "/etc/hosts" } }, ident("lead", "/wts/p/feat"), claude).action).toBe("defer");
    expect(decidePermission({ id: "r", name: "Read", input: { file_path: "/wts/other/x.ts" } }, ident("lead", "/wts/p/feat"), claude).action).toBe("defer");
  });
  it("leaves a Glob whose pattern reaches outside to the human", () => {
    for (const input of [{ pattern: "/home/u/.paseo/**" }, { path: "/repo", pattern: "/etc/**" }, { pattern: "~/.ssh/*" }, { path: "/repo", pattern: "../**/*.env" }]) {
      expect(decidePermission({ id: "r", name: "Glob", input }, ident("lead", "/wts/p/feat"), claude).action).toBe("defer");
    }
  });
  it("still allows ordinary read-only git and commands that only mention a reserved word", () => {
    for (const command of ["git log --oneline -5", "git diff HEAD~1 -- src/commit.ts", "git status --short"]) {
      expect(decidePermission(bash(command), ident("peer-impl", "/wts/p/T1"), claude)).toEqual({ action: "allow" });
    }
  });
  it("does not allow a read that escapes the worktree through a symlink", () => {
    const root = tmpDir(); const wt = join(root, "wt"); const outside = join(root, "secret");
    mkdirSync(wt); mkdirSync(outside); writeFileSync(join(outside, "id_rsa"), "x"); symlinkSync(outside, join(wt, "escape"));
    const opts = { deniedRoots: [], vendor: "claude" as const, readRoots: [wt] };
    expect(decidePermission({ id: "r", name: "Read", input: { file_path: join(wt, "escape", "id_rsa") } }, ident("lead", wt), opts).action).toBe("defer");
  });
});
