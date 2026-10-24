import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addWorktree, changedFiles, commitAll, commitTrailer, currentBranch, filesOutside, git, headOf, hookFile, hooksDir, isProtectedPath, isSensitivePath, mergeNoHooks, nestedRepos, NoChangesError, removeWorktree, resolveBaseBranch, startMerge, trackedChanges, trustRepo, unsafeGitDrivers, UntrustedGitDirError } from "../server/git";
import { initRepo, sh, tmpDir } from "./helpers";

function withHusky(repo: string, marker: string): void {
  mkdirSync(join(repo, ".husky"), { recursive: true });
  for (const h of ["pre-commit", "commit-msg", "post-commit", "pre-merge-commit", "post-merge", "post-checkout"]) {
    writeFileSync(join(repo, ".husky", h), `#!/bin/sh\necho ${h} >> "${marker}"\n`); chmodSync(join(repo, ".husky", h), 0o755);
  }
  sh(repo, "git", ["add", ".husky"]); sh(repo, "git", ["commit", "-qm", "husky"]);
  sh(repo, "git", ["config", "core.hooksPath", ".husky"]);
}
function repo(): string { const r = initRepo(); trustRepo(r); return r; }
function worktree(r: string, branch: string): string {
  const wt = join(tmpDir(), branch.replaceAll("/", "-"));
  sh(r, "git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", branch, wt, "main"]);
  return wt;
}

/** A nested repo committed as a tracked gitlink `vendor` on the current branch of r, hooks off. Returns its path. */
function gitlinkVendor(r: string): string {
  const vendor = join(r, "vendor"); mkdirSync(vendor);
  sh(vendor, "git", ["init", "-q", "-b", "main"]); writeFileSync(join(vendor, "file.txt"), "one\n");
  sh(vendor, "git", ["add", "."]); sh(vendor, "git", ["-c", "user.name=SLP Test", "-c", "user.email=slp@test.local", "commit", "-qm", "vendor"]);
  sh(r, "git", ["update-index", "--add", "--cacheinfo", `160000,${sh(vendor, "git", ["rev-parse", "HEAD"])},vendor`]);
  sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "gitlink"]);
  return vendor;
}
/** The Peer's move: a clean filter in the nested config, a .gitattributes that selects it, and a stat-dirty file (same bytes). */
function armNested(vendor: string, marker: string): void {
  sh(vendor, "git", ["config", "filter.x.clean", `touch ${marker} && cat`]);
  writeFileSync(join(vendor, ".gitattributes"), "* filter=x\n");
  sh(vendor, "touch", ["file.txt"]);
}
/** A clean main checkout with a tracked gitlink `vendor`, and branch `other` that conflicts with main on README.md. */
function conflictingGitlinkRepo(): { r: string; marker: string } {
  const r = repo(); const marker = join(tmpDir(), "nested-clean.log");
  const vendor = gitlinkVendor(r);
  sh(r, "git", ["checkout", "-qb", "other"]); writeFileSync(join(r, "README.md"), "other\n"); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "other"]);
  sh(r, "git", ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "main"]); writeFileSync(join(r, "README.md"), "main\n"); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "main"]);
  armNested(vendor, marker);
  return { r, marker };
}

describe("git helpers", () => {
  it("lists changed files including untracked names with spaces", () => {
    const r = repo();
    writeFileSync(join(r, "README.md"), "changed\n"); writeFileSync(join(r, "a file.txt"), "x");
    expect(changedFiles(r).sort()).toEqual(["README.md", "a file.txt"]);
    expect(trackedChanges(r)).toEqual(["README.md"]);
  });
  it("refuses directories that are not a registered repo or one of its worktrees", () => {
    expect(() => headOf(tmpDir())).toThrow(UntrustedGitDirError);
    expect(() => headOf(initRepo())).toThrow(UntrustedGitDirError);
  });
  it("ignores a forged .git file in a worktree and never runs fsmonitor", () => {
    const r = repo(); const wt = worktree(r, "slp/f/T1-1"); const marker = join(tmpDir(), "fsmonitor.log");
    const rogue = join(wt, "rogue"); mkdirSync(rogue);
    sh(rogue, "git", ["init", "-q", "--bare", "."]);
    writeFileSync(join(wt, "evil.sh"), `#!/bin/sh\necho ran >> "${marker}"\n`); chmodSync(join(wt, "evil.sh"), 0o755);
    sh(rogue, "git", ["config", "--file", join(rogue, "config"), "core.fsmonitor", join(wt, "evil.sh")]);
    writeFileSync(join(wt, ".git"), `gitdir: ${rogue}\n`);
    writeFileSync(join(wt, "src.ts"), "x");
    expect(changedFiles(wt)).toContain("src.ts");
    expect(currentBranch(wt)).toBe("slp/f/T1-1");
    expect(existsSync(marker)).toBe(false);
  });
  it("commits with trailers, never runs repo hooks, and excludes given paths", () => {
    const r = repo(); const marker = join(tmpDir(), "hooks.log"); withHusky(r, marker);
    writeFileSync(join(r, "src.ts"), "x"); writeFileSync(join(r, ".env"), "SECRET=1");
    const hash = commitAll(r, { message: "T1: add src", trailers: { "SLP-Task": "T1", "SLP-Agent": "a1" }, exclude: [".env"] });
    expect(headOf(r)).toBe(hash);
    expect(sh(r, "git", ["log", "-1", "--format=%B"])).toBe("T1: add src\n\nSLP-Task: T1\nSLP-Agent: a1");
    expect(commitTrailer(r, hash, "SLP-Task")).toBe("T1");
    expect(commitTrailer(r, "HEAD~1", "SLP-Task")).toBeNull();
    expect(sh(r, "git", ["show", "--name-only", "--format=", "HEAD"])).toBe("src.ts");
    expect(existsSync(marker)).toBe(false);
    expect(() => commitAll(r, { message: "m", trailers: {}, exclude: [".env"] })).toThrow(NoChangesError);
  });
  it("merges without hooks and reports conflicts, leaving the tree clean", () => {
    const r = repo(); const marker = join(tmpDir(), "hooks.log"); withHusky(r, marker);
    sh(r, "git", ["-c", "core.hooksPath=/dev/null", "checkout", "-qb", "side"]); writeFileSync(join(r, "README.md"), "side\n"); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "side"]);
    sh(r, "git", ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "main"]); writeFileSync(join(r, "other.txt"), "o"); sh(r, "git", ["add", "."]); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "main"]);
    const ok = mergeNoHooks(r, "side", "Merge side");
    expect(ok.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    sh(r, "git", ["-c", "core.hooksPath=/dev/null", "checkout", "-qb", "c1", "HEAD~1"]); writeFileSync(join(r, "README.md"), "c1\n"); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "c1"]);
    sh(r, "git", ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "main"]); writeFileSync(join(r, "README.md"), "main\n"); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "m2"]);
    expect(mergeNoHooks(r, "c1", "Merge c1")).toEqual({ ok: false, conflicts: ["README.md"] });
    expect(changedFiles(r)).toEqual([]);
  });
  it("starts a merge that leaves conflict markers for a Peer, and commitAll then records a merge commit", () => {
    const r = repo();
    sh(r, "git", ["checkout", "-qb", "other"]); writeFileSync(join(r, "README.md"), "other\n"); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "other"]);
    sh(r, "git", ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "main"]);
    const wt = worktree(r, "slp/f/T2-1"); writeFileSync(join(wt, "README.md"), "mine\n"); sh(wt, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qam", "mine"]);
    expect(startMerge(wt, "other")).toEqual(["README.md"]);
    writeFileSync(join(wt, "README.md"), "resolved\n");
    const hash = commitAll(wt, { message: "T2: resolve", trailers: {}, exclude: [] });
    expect(sh(wt, "git", ["rev-list", "--parents", "-n", "1", hash]).split(" ")).toHaveLength(3);
  });
  it("classifies sensitive and protected paths and touch-set outsiders, and finds hooks", () => {
    expect(["a/.env", ".env.local", "k.pem", "x.key", "id_rsa", "id_ed25519.pub", "c.p12", "credentials.json"].every(isSensitivePath)).toBe(true);
    expect(isSensitivePath("src/env.ts")).toBe(false);
    expect(["paseo.json", ".husky/pre-commit", ".githooks/x", "hooks/pre-push", ".claude/settings.json", ".codex/config.toml", ".mcp.json"].map((p) => isProtectedPath(p, "hooks"))).toEqual([true, true, true, true, true, true, true]);
    expect(["src/paseo.json", "src/hooks/a.ts", "src/.mcp.json", "docs/.claude/x.md"].map((p) => isProtectedPath(p, "hooks"))).toEqual([true, false, true, true]);
    expect(filesOutside(["src/a.ts", "test/a.test.ts", "package.json"], ["src/", "test/**"])).toEqual(["package.json"]);
    const r = repo(); const marker = join(tmpDir(), "h.log"); withHusky(r, marker);
    expect(hooksDir(r)).toBe(".husky");
    expect(hookFile(r, "pre-commit")).toBe(join(r, ".husky", "pre-commit"));
    expect(hookFile(repo(), "pre-commit")).toBeNull();
    expect(git(r, ["config", "--get", "core.fsmonitor"], true).code).toBe(0);
  });
  it("creates and removes SLP worktrees with hooks off, keeping the branch", () => {
    const r = repo(); const marker = join(tmpDir(), "pc.log"); withHusky(r, marker);
    writeFileSync(join(r, "paseo.json"), JSON.stringify({ worktree: { setup: "touch SETUP_RAN" } })); sh(r, "git", ["add", "."]); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "cfg"]);
    const path = join(tmpDir(), "wts", "demo", "slp-f-T1-1");
    addWorktree(r, path, "slp/f/T1-1", "main");
    expect(currentBranch(path)).toBe("slp/f/T1-1");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(path, "SETUP_RAN"))).toBe(false);
    expect(removeWorktree(r, path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(sh(r, "git", ["branch", "--list", "slp/f/T1-1"])).toContain("slp/f/T1-1");
    const theirs = join(tmpDir(), "theirs"); mkdirSync(theirs); writeFileSync(join(theirs, "keep.txt"), "x");
    expect(() => addWorktree(r, theirs, "slp/f/T2-1", "main")).toThrow(/already exists/);
    expect(removeWorktree(r, theirs)).toBe(false);
    expect(existsSync(join(theirs, "keep.txt"))).toBe(true);
  });
  it("lists git filters and drivers that would run repo files, but not git-lfs", () => {
    const r = repo();
    expect(unsafeGitDrivers(r)).toEqual([]);
    sh(r, "git", ["config", "filter.lfs.clean", "git-lfs clean -- %f"]);
    expect(unsafeGitDrivers(r)).toEqual([]);
    sh(r, "git", ["config", "filter.fmt.clean", "node scripts/filter.js"]); sh(r, "git", ["config", "merge.ours.driver", "./scripts/merge.sh %O %A %B"]);
    expect(unsafeGitDrivers(r)).toEqual(["filter.fmt.clean node scripts/filter.js", "merge.ours.driver ./scripts/merge.sh %O %A %B"]);
    const lfs = repo();
    sh(lfs, "git", ["config", "filter.lfs.clean", "git-lfs clean -- %f; node scripts/filter.js"]);
    expect(unsafeGitDrivers(lfs)).toEqual(["filter.lfs.clean git-lfs clean -- %f; node scripts/filter.js"]);
  });
  it("checks the new worktree's own config, including branch-conditional includes, before checking anything out", () => {
    const r = repo(); const marker = join(tmpDir(), "smudge-ran");
    writeFileSync(join(r, ".gitattributes"), "*.txt filter=fmt\n"); writeFileSync(join(r, "a.txt"), "a\n");
    sh(r, "git", ["add", "."]); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "attrs"]);
    writeFileSync(join(r, ".git", "slp.inc"), `[filter "fmt"]\n\tsmudge = "touch ${marker} && cat"\n`); // no ";": it starts a comment in git config
    sh(r, "git", ["config", "includeIf.onbranch:slp/**.path", "slp.inc"]);
    expect(unsafeGitDrivers(r)).toEqual([]);
    const path = join(tmpDir(), "wts", "demo", "slp-f-T9-1");
    expect(() => addWorktree(r, path, "slp/f/T9-1", "main")).toThrow(/filter\.fmt\.smudge/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(sh(r, "git", ["branch", "--list", "slp/f/T9-1"])).toBe("");
  });
  it("treats case variants, bare names and similar names of protected paths correctly", () => {
    expect([".claude", ".husky", ".CLAUDE/x", ".Codex/config.toml", "Paseo.json", ".MCP.json"].map((p) => isProtectedPath(p, "hooks"))).toEqual([true, true, true, true, true, true]);
    expect(isProtectedPath("hooks", "hooks")).toBe(true);
    expect(["src/.mcp.json", "docs/.claude/x.md", ".claudeignore"].map((p) => isProtectedPath(p, "hooks"))).toEqual([true, true, false]);
  });
  it("never stages a nested repo, and reports it", () => {
    const r = repo(); const wt = worktree(r, "slp/f/T9-3"); const vendor = join(wt, "vendor");
    mkdirSync(vendor); sh(vendor, "git", ["init", "-q", "-b", "main"]); writeFileSync(join(vendor, "x.txt"), "x");
    sh(vendor, "git", ["add", "."]); sh(vendor, "git", ["-c", "user.name=SLP Test", "-c", "user.email=slp@test.local", "commit", "-qm", "vendor"]);
    writeFileSync(join(wt, "src.ts"), "x");
    const hash = commitAll(wt, { message: "T9: src", trailers: {}, exclude: [] });
    expect(sh(wt, "git", ["ls-tree", "-r", "--name-only", hash]).split("\n")).toEqual(["README.md", "src.ts"]);
    expect(nestedRepos(wt)).toEqual(["vendor"]);
  });
  it("never runs a nested repo's own filter, even when the nested repo is a tracked gitlink", () => {
    const r = repo(); const wt = worktree(r, "slp/f/T9-2"); const marker = join(tmpDir(), "nested-filter.log");
    const vendor = join(wt, "vendor"); mkdirSync(vendor);
    sh(vendor, "git", ["init", "-q", "-b", "main"]); sh(vendor, "git", ["config", "user.name", "SLP Test"]); sh(vendor, "git", ["config", "user.email", "slp@test.local"]);
    writeFileSync(join(vendor, "file.txt"), "one\n"); sh(vendor, "git", ["add", "."]); sh(vendor, "git", ["commit", "-qm", "vendor"]);
    sh(wt, "git", ["update-index", "--add", "--cacheinfo", `160000,${sh(vendor, "git", ["rev-parse", "HEAD"])},vendor`]); sh(wt, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "gitlink"]);
    // The Peer's move: a filter in the nested config, a .gitattributes that selects it, and a stat-dirty tracked file.
    sh(vendor, "git", ["config", "filter.x.clean", `touch ${marker} && cat`]);
    writeFileSync(join(vendor, ".gitattributes"), "* filter=x\n");
    sh(vendor, "touch", ["file.txt"]); // same bytes, new mtime: stat-dirty, so git must hash it through the filter
    writeFileSync(join(wt, "src.ts"), "x");
    expect(changedFiles(wt)).toContain("src.ts");
    trackedChanges(wt);
    commitAll(wt, { message: "T9: nested", trailers: {}, exclude: [] });
    expect(existsSync(marker)).toBe(false);
  });
  it("startMerge throws when the merge does not start, instead of reporting no conflicts", () => {
    const r = repo(); const wt = worktree(r, "slp/f/T10-1");
    expect(() => startMerge(wt, "no-such-ref")).toThrow(/did not start/);
  });
  it("folds Unicode case aliases (long s) and hook-dir case for protected paths", () => {
    expect(["paſeo.json", ".huſky/x", ".MCP.json"].map((p) => isProtectedPath(p, "hooks"))).toEqual([true, true, true]);
    expect(isProtectedPath("hooks/pre-commit", "Hooks")).toBe(true);
    expect(isProtectedPath("hooks/x", "hookſ")).toBe(true);
  });
  it("refuses to merge over uncommitted tracked changes, before git merge can run a nested filter", () => {
    const { r, marker } = conflictingGitlinkRepo();
    writeFileSync(join(r, "README.md"), "dirty\n");
    expect(() => mergeNoHooks(r, "other", "Merge other")).toThrow(/uncommitted tracked changes/);
    expect(() => startMerge(r, "other")).toThrow(/uncommitted tracked changes/);
    expect(existsSync(marker)).toBe(false);
  });
  it("startMerge reports conflicts on a clean tree without running a nested filter", () => {
    const { r, marker } = conflictingGitlinkRepo();
    expect(startMerge(r, "other")).toEqual(["README.md"]);
    expect(existsSync(marker)).toBe(false);
  });
  it("mergeNoHooks reports conflicts on a clean tree without running a nested filter", () => {
    const { r, marker } = conflictingGitlinkRepo();
    expect(mergeNoHooks(r, "other", "Merge other")).toEqual({ ok: false, conflicts: ["README.md"] });
    expect(existsSync(marker)).toBe(false);
  });
  it("handles a repo whose ls-files output exceeds Node's default 1 MiB buffer", () => {
    const r = repo(); const dir = join(r, "src");
    try {
      mkdirSync(dir);
      for (let i = 0; i < 15000; i++) writeFileSync(join(dir, `module-with-a-long-name-${String(i).padStart(6, "0")}.ts`), "x\n");
      sh(r, "git", ["add", "-A"]); sh(r, "git", ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "many files"]);
      expect(git(r, ["ls-files", "-s", "-z"]).stdout.length).toBeGreaterThan(1 << 20);
      expect(nestedRepos(r)).toEqual([]);
      writeFileSync(join(r, "one-more.ts"), "y\n");
      expect(commitAll(r, { message: "T1: one more", trailers: {}, exclude: [] })).toBe(headOf(r));
    } finally { rmSync(r, { recursive: true, force: true }); }
  }, 60_000);
  it("reports a git that cannot start as a failed call instead of a TypeError, honouring allowFail", () => {
    const r = repo(); const saved = process.env.PATH;
    try {
      process.env.PATH = join(tmpDir(), "no-git-here");
      const res = git(r, ["status"], true);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/ENOENT/);
      expect(() => git(r, ["status"])).toThrow(/ENOENT/);
    } finally { process.env.PATH = saved; }
  });
  it("protects settings, hooks and tool config at any depth, and the whole repo when hooksPath is the root", () => {
    expect(["pkg/.claude/settings.json", "a/b/.codex/config.toml", "pkg/.mcp.json", "docs/paseo.json", "pkg/.husky/x", "sub/.githooks"].map((p) => isProtectedPath(p, null))).toEqual([true, true, true, true, true, true]);
    expect(isProtectedPath("frontend/.husky/pre-commit", "frontend/.husky/_")).toBe(true);
    expect(isProtectedPath("frontend/.husky/_/h", "frontend/.husky/_")).toBe(true);
    expect(isProtectedPath("tools/hooks/pre-commit", "tools/hooks/_")).toBe(true);
    expect(isProtectedPath("tools/hooks/_/h", "tools/hooks/_")).toBe(true);
    expect(["src/a.ts", "README.md", "x/y/z.txt"].map((p) => isProtectedPath(p, "."))).toEqual([true, true, true]);
    expect(["src/a.ts", "README.md"].map((p) => isProtectedPath(p, "./"))).toEqual([true, true]);
    expect([".claudeignore", "src/claude/x.ts", "src/my.mcp.json.bak", "src/paseo.json.bak"].map((p) => isProtectedPath(p, "hooks"))).toEqual([false, false, false, false]);
  });
  it("reads core.hooksPath of . or ./ as the repo root, and keeps null for unset or absolute", () => {
    const r = repo();
    expect(hooksDir(r)).toBeNull();
    sh(r, "git", ["config", "core.hooksPath", "."]); expect(hooksDir(r)).toBe(".");
    sh(r, "git", ["config", "core.hooksPath", "./"]); expect(hooksDir(r)).toBe(".");
    sh(r, "git", ["config", "core.hooksPath", "./frontend/.husky/_/"]); expect(hooksDir(r)).toBe("frontend/.husky/_");
    sh(r, "git", ["config", "core.hooksPath", "/abs/hooks"]); expect(hooksDir(r)).toBeNull();
  });
});

describe("resolveBaseBranch (rev 5.11)", () => {
  function withRemote(name = "origin"): { r: string; bare: string } {
    const r = repo(); const bare = join(tmpDir(), `${name}.git`);
    sh(r, "git", ["init", "-q", "--bare", bare]); sh(r, "git", ["remote", "add", name, bare]);
    return { r, bare };
  }
  it("prefers <remote>/HEAD", () => {
    const { r } = withRemote();
    sh(r, "git", ["push", "-q", "origin", "main:main", "main:trunk"]); sh(r, "git", ["fetch", "-q", "origin"]); sh(r, "git", ["remote", "set-head", "origin", "trunk"]);
    expect(resolveBaseBranch(r, "origin")).toBe("origin/trunk");
  });
  it("skips an origin/HEAD whose branch is gone, then uses the current branch's upstream", () => {
    const { r } = withRemote();
    sh(r, "git", ["push", "-q", "origin", "main:dev", "main:trunk"]); sh(r, "git", ["fetch", "-q", "origin"]); sh(r, "git", ["remote", "set-head", "origin", "trunk"]);
    sh(r, "git", ["push", "-q", "origin", ":trunk"]); sh(r, "git", ["fetch", "-q", "--prune", "origin"]);
    sh(r, "git", ["branch", "-q", "-u", "origin/dev"]);
    expect(resolveBaseBranch(r, "origin")).toBe("origin/dev");
  });
  it("falls back to <remote>/main, then <remote>/master", () => {
    const a = withRemote(); sh(a.r, "git", ["push", "-q", "origin", "main"]);
    expect(resolveBaseBranch(a.r, "origin")).toBe("origin/main");
    const b = withRemote(); sh(b.r, "git", ["push", "-q", "origin", "main:master"]);
    expect(resolveBaseBranch(b.r, "origin")).toBe("origin/master");
  });
  it("fetches first, so a commit pushed from another clone is the base", () => {
    const { r, bare } = withRemote(); sh(r, "git", ["push", "-q", "origin", "main"]);
    const other = join(tmpDir(), "other"); sh(tmpDir(), "git", ["clone", "-q", bare, other]);
    writeFileSync(join(other, "n.txt"), "n"); sh(other, "git", ["add", "."]); sh(other, "git", ["-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "remote moves"]); sh(other, "git", ["push", "-q", "origin", "HEAD:main"]);
    expect(resolveBaseBranch(r, "origin")).toBe("origin/main");
    expect(sh(r, "git", ["rev-parse", "origin/main"])).toBe(sh(other, "git", ["rev-parse", "HEAD"]));
  });
  it("works with a remote not named origin", () => {
    const { r } = withRemote("upstream"); sh(r, "git", ["push", "-q", "upstream", "main"]);
    expect(resolveBaseBranch(r, "upstream")).toBe("upstream/main");
  });
  it("names what it tried when no branch fits", () => {
    const { r } = withRemote();
    expect(() => resolveBaseBranch(r, "origin")).toThrow(/tried origin\/HEAD, the upstream of the current branch, origin\/main and origin\/master/);
  });
});
