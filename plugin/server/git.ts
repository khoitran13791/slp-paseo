import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { matchTouch } from "./touch";

const HARDEN = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
export interface GitResult { code: number; stdout: string; stderr: string }
export class UntrustedGitDirError extends Error {}

const trusted = new Set<string>(); // realpath of each registered repo's common dir

function spawnGit(cwd: string, args: string[], allowFail: boolean): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  const out = { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (!allowFail && out.code !== 0) throw new Error(`git ${args.join(" ")} failed (${out.code}): ${out.stderr.trim()}`);
  return out;
}

/** Registers a project repo. Its common dir is the only source the plugin trusts for git metadata. */
export function trustRepo(repo: string): void {
  const dotGit = join(realpathSync(repo), ".git");
  if (!existsSync(join(dotGit, "HEAD"))) throw new UntrustedGitDirError(`SLP: ${repo} is not the main checkout of a git repo`);
  trusted.add(dotGit);
}

const safeReal = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

function gitDirFor(cwd: string): string {
  const real = safeReal(cwd);
  if (real) {
    for (const common of trusted) {
      if (real === dirname(common)) return common;
      const admin = join(common, "worktrees");
      for (const name of existsSync(admin) ? readdirSync(admin) : []) {
        let back: string;
        try { back = readFileSync(join(admin, name, "gitdir"), "utf8").trim(); } catch { continue; }
        if (safeReal(dirname(back)) === real) return join(admin, name);
      }
    }
  }
  throw new UntrustedGitDirError(`SLP: ${cwd} is not a registered repo or one of its worktrees`);
}

function run(cwd: string, args: string[], allowFail: boolean, harden: string[]): GitResult {
  return spawnGit(cwd, [...harden, `--git-dir=${gitDirFor(cwd)}`, `--work-tree=${cwd}`, ...args], allowFail);
}

/** Every plugin git call: hooks and fsmonitor off, git dir pinned from the trusted common dir. */
export function git(cwd: string, args: string[], allowFail = false): GitResult {
  return run(cwd, args, allowFail, HARDEN);
}

export const headOf = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
export const currentBranch = (cwd: string): string => git(cwd, ["branch", "--show-current"]).stdout.trim();
export const gitCommonDir = (cwd: string): string => realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim());
export const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean => git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], true).code === 0;
export const diffStat = (cwd: string, from: string, to: string): string => git(cwd, ["diff", "--stat", `${from}...${to}`]).stdout.trim();
export const deleteBranch = (repo: string, branch: string): void => { git(repo, ["branch", "-D", branch], true); };

function porcelain(worktree: string, untracked: "all" | "no"): string[] {
  const parts = git(worktree, ["status", "--porcelain=v1", "-z", `--untracked-files=${untracked}`]).stdout.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // skip the rename source path
  }
  return files;
}
export const changedFiles = (worktree: string): string[] => porcelain(worktree, "all");
export const trackedChanges = (worktree: string): string[] => porcelain(worktree, "no");

const SENSITIVE = [/^\.env(\..*)?$/, /\.pem$/, /\.key$/, /^id_(rsa|ed25519|ecdsa)(\.pub)?$/, /\.p12$/, /^credentials\.json$/];
export const isSensitivePath = (p: string): boolean => SENSITIVE.some((re) => re.test(basename(p)));

/** Repo-relative core.hooksPath (husky: ".husky"); null when unset or absolute. Read without the hooksPath override. */
export function hooksDir(cwd: string): string | null {
  const v = run(cwd, ["config", "--get", "core.hooksPath"], true, ["-c", "core.fsmonitor=false"]).stdout.trim();
  return v && !isAbsolute(v) ? v.replace(/^\.\//, "").replace(/\/$/, "") : null;
}

/**
 * Files run outside any sandbox: git hooks and paseo.json when Paseo creates a worktree, and agent settings
 * (.claude/, .codex/, .mcp.json: hooks and MCP servers) when an agent session opens in a checkout of the branch.
 */
export function isProtectedPath(p: string, hookDir: string | null): boolean {
  if (p === "paseo.json" || p === ".mcp.json") return true;
  return [".husky", ".githooks", ".claude", ".codex", ...(hookDir ? [hookDir] : [])].some((d) => p.startsWith(`${d}/`));
}

/**
 * SLP's own worktree, made with hooks off (HARDEN). Paseo never creates or archives it: the agent gets a "directory" workspace,
 * and Paseo runs worktree.setup only when it creates a worktree and worktree.teardown only for worktrees under ~/.paseo/worktrees
 * (paseo 0.12 session.ts handleWorkspaceCreateLocal, workspace-archive-service.ts maybeRemoveDirectory). So no repo hook, setup,
 * teardown or terminal command runs outside the sandbox for an SLP agent (review Codex 2026-10-22, round 3).
 */
export function addWorktree(repo: string, path: string, branch: string, base: string): void {
  if (existsSync(path)) throw new Error(`${path} already exists; SLP neither reuses nor overwrites it`);
  mkdirSync(dirname(path), { recursive: true });
  // No checkout yet: checkout runs smudge filters, and config can depend on the new branch (includeIf onbranch). Check this
  // worktree's own config first, then populate it (review Codex 2026-10-22, round 5).
  git(repo, ["worktree", "add", "-q", "--no-checkout", "-b", branch, path, base]);
  try {
    const drivers = unsafeGitDrivers(path);
    if (drivers.length) throw new Error(`git config for ${branch} runs commands on checkout/add/status that a Peer could change (${drivers.join("; ")})`);
    git(path, ["reset", "-q", "--hard", "HEAD"]);
  } catch (error) {
    // Any failure after the worktree exists (a driver, a failed LFS download during reset): undo it, branch last (review Codex 2026-10-22, round 6).
    if (removeWorktree(repo, path)) git(repo, ["branch", "-D", branch], true);
    throw error;
  }
}

/** Removes an SLP worktree through git only (hooks off), keeping its branch. A path git does not know as a worktree is left alone. */
export function removeWorktree(repo: string, path: string): boolean {
  const r = git(repo, ["worktree", "remove", "--force", path], true);
  git(repo, ["worktree", "prune"], true);
  return r.code === 0;
}

/**
 * Git config commands that run on `git add`, `status`, `merge` or `diff` (clean/smudge/process filters, merge drivers,
 * textconv): `.gitattributes` in the tree picks them, so they can run files a Peer edits, outside any sandbox, in the
 * plugin's git and in Paseo's own status refresh (review Codex 2026-10-22, round 4). git-lfs is a program, not a repo file.
 */
export function unsafeGitDrivers(cwd: string): string[] {
  const keys = "^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|diff\\..*\\.(textconv|command))$";
  return run(cwd, ["config", "--get-regexp", keys], true, ["-c", "core.fsmonitor=false"]).stdout.split("\n").filter(Boolean)
    .filter((line) => !LFS.has(line.trim().replace(/\s+/g, " ")));
}
/** Exactly what `git lfs install` writes; anything more ("git-lfs clean -- %f; node x.js") is a shell command (review Codex 2026-10-22, round 5). */
const LFS = new Set(["filter.lfs.clean git-lfs clean -- %f", "filter.lfs.smudge git-lfs smudge -- %f", "filter.lfs.process git-lfs filter-process"]);

export class NoChangesError extends Error {}

/** Stages everything except `exclude` and commits with hooks off. Commits a pending merge as a merge commit. */
export function commitAll(worktree: string, opts: { message: string; trailers: Record<string, string>; exclude: string[] }): string {
  git(worktree, ["add", "-A", "--", ".", ...opts.exclude.map((p) => `:(exclude,literal)${p}`)]);
  const merging = git(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], true).code === 0;
  if (!merging && git(worktree, ["diff", "--cached", "--quiet"], true).code === 0) throw new NoChangesError("nothing to commit");
  const trailers = Object.entries(opts.trailers).map(([k, v]) => `${k}: ${v}`).join("\n");
  git(worktree, ["commit", "--no-verify", "-q", "-m", trailers ? `${opts.message}\n\n${trailers}` : opts.message]);
  return headOf(worktree);
}

export function commitTrailer(cwd: string, rev: string, key: string): string | null {
  const v = git(cwd, ["log", "-1", `--format=%(trailers:key=${key},valueonly)`, rev], true).stdout.trim();
  return v || null;
}

export function mergeNoHooks(worktree: string, ref: string, message: string): { ok: true; hash: string } | { ok: false; conflicts: string[] } {
  const r = git(worktree, ["merge", "--no-ff", "--no-verify", "-m", message, ref], true);
  if (r.code === 0) return { ok: true, hash: headOf(worktree) };
  const conflicts = git(worktree, ["diff", "--name-only", "--diff-filter=U"], true).stdout.split("\n").filter(Boolean);
  git(worktree, ["merge", "--abort"], true);
  return { ok: false, conflicts };
}

/** Starts `git merge --no-commit` and leaves conflict markers in place for a Peer to resolve. Returns conflicted files. */
export function startMerge(worktree: string, ref: string): string[] {
  git(worktree, ["merge", "--no-ff", "--no-commit", "--no-verify", ref], true);
  return git(worktree, ["diff", "--name-only", "--diff-filter=U"], true).stdout.split("\n").filter(Boolean);
}

/**
 * Push from the project's main checkout, not a worktree: transport config (core.sshCommand, credential helpers) may name a
 * relative script, which must resolve in the tree only the human writes (review Codex 2026-10-22, round 6).
 */
export function pushNoHooks(repo: string, remote: string, branch: string): void {
  git(repo, ["push", "--no-verify", remote, `${branch}:${branch}`]);
}

export function filesOutside(files: string[], touchSet: string[]): string[] {
  return files.filter((f) => !touchSet.some((t) => matchTouch(t, f)));
}

export function hookFile(worktree: string, name: string): string | null {
  // core.hooksPath (e.g. husky's ".husky") is relative to the worktree root; otherwise use the repo's hooks dir.
  const configured = run(worktree, ["config", "--get", "core.hooksPath"], true, ["-c", "core.fsmonitor=false"]).stdout.trim();
  const p = configured
    ? join(isAbsolute(configured) ? configured : join(git(worktree, ["rev-parse", "--show-toplevel"]).stdout.trim(), configured), name)
    : run(worktree, ["rev-parse", "--git-path", `hooks/${name}`], false, ["-c", "core.fsmonitor=false"]).stdout.trim();
  const abs = isAbsolute(p) ? p : join(worktree, p);
  return existsSync(abs) ? abs : null;
}
