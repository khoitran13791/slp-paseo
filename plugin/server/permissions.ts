import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isProtectedPath } from "./git";
import type { Identity } from "./identity";

export interface PermissionLike { id: string; name?: string; kind?: string; title?: string; description?: string; input?: Record<string, unknown>; detail?: { type?: string; command?: string } }
export type PermissionDecision = { action: "allow" } | { action: "deny"; message: string } | { action: "defer"; reason: string } | { action: "ignore" };
export interface PermissionOptions { deniedRoots: string[]; readRoots?: string[]; vendor?: "claude" | "codex"; realpath?: (p: string) => string }
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i;

const SHELL = new Set(["Bash", "CodexBash", "shell", "exec_command"]);
const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ = new Set(["Read", "Grep", "Glob", "LS"]);
const RESERVED = [
  /(^|[\s;&|(`/])paseo(\s|$|\))/,
  /\bgit(\s+(-[cC]\s+\S+|--?[\w-]+(=\S+)?))*\s+(push|commit|merge|rebase|worktree|reset\s+--hard)\b/,
  /dangerouslyDisableSandbox/,
];
/**
 * Two readings of a command, so quoting does not hide a reserved word (review Codex 2026-10-23): quotes and backslashes removed
 * ("paseo" ls, pa""seo, p\aseo), and each quoted string squashed into one word (git -C '/repo with spaces' commit). Nested quotes,
 * variables and eval still get through; this guard catches mistakes, and the sandbox is the boundary (spec §4).
 */
const readings = (command: string): string[] => [
  command.replace(/["'\\]/g, ""),
  command.replace(/'([^']*)'|"([^"]*)"/g, (_m, a: string | undefined, b: string | undefined) => (a ?? b ?? "").replace(/\s+/g, "_") || "_"),
];

const UNRESOLVABLE = "\0unresolvable:";

function resolveExisting(p: string, realpath: (p: string) => string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpath(cur), ...rest.reverse()); } catch { /* walk up */ }
    // The entry exists but does not resolve (dangling symlink, loop, unreadable): it is not absent, so never walk past it.
    try { lstatSync(cur); return UNRESOLVABLE + resolve(p); } catch { /* does not exist: walk up */ }
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    rest.push(basename(cur));
    cur = parent;
  }
}
const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);

export function decidePermission(req: PermissionLike, ident: Identity | null, opts: PermissionOptions = { deniedRoots: [] }): PermissionDecision {
  if (!ident) return { action: "ignore" };
  const realpath = opts.realpath ?? realpathSync;
  const name = req.name ?? "";
  const expand = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : isAbsolute(p) ? p : resolve(ident.worktree ?? process.cwd(), p));
  const fold = (s: string) => s.toUpperCase().toLowerCase();
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = req.input?.[key];
    if (typeof v !== "string" || !v) continue;
    const target = fold(resolveExisting(expand(v), realpath));
    if (opts.deniedRoots.some((root) => inside(target, fold(resolveExisting(root, realpath))))) return { action: "deny", message: "SLP: plugin and Paseo state are off limits. Use slp_state." };
  }
  if (name.startsWith("mcp__paseo__")) return { action: "deny", message: "SLP: Paseo tools are off for SLP roles. Use the slp_* tools." };
  if (name === "WebFetch" && typeof req.input?.url === "string") {
    let host = "";
    try { host = new URL(req.input.url).hostname; } catch { /* not a URL */ }
    if (LOOPBACK.test(host)) return { action: "deny", message: "SLP: local network services are off limits." };
  }
  if (SHELL.has(name)) {
    const command = String(req.input?.command ?? req.detail?.command ?? "");
    if (req.input?.dangerouslyDisableSandbox === true) return { action: "deny", message: "SLP: running outside the sandbox is not allowed." };
    if (readings(command).some((c) => RESERVED.some((re) => re.test(c)))) return { action: "deny", message: `SLP: this command is reserved for the plugin (${command.slice(0, 80)}). Use the slp_* tools.` };
    // Codex asks for approval only to escalate out of its sandbox; Claude's sandbox (allowUnsandboxedCommands: false) holds whatever is approved (T21 B-8).
    if (opts.vendor === "codex") return { action: "deny", message: "SLP: this asks to run outside the Codex sandbox. Stay inside it; the sandbox blocks network and writes outside your worktree." };
    if (opts.vendor === "claude") return { action: "allow" };
    return { action: "defer", reason: `shell: ${command.slice(0, 200)}` };
  }
  if (READ.has(name)) {
    // Read is not sandboxed: allow it only inside the project's repo and SLP worktrees, after resolving symlinks.
    const roots = (opts.readRoots ?? []).map((r) => fold(resolveExisting(r, realpath)));
    const targets = ["file_path", "path", "notebook_path"].map((k) => req.input?.[k]).filter((v): v is string => typeof v === "string" && v !== "");
    const insideRoots = (t: string) => roots.some((r) => inside(fold(resolveExisting(expand(t), realpath)), r));
    // Glob's pattern can name its own root ("/home/u/.paseo/**", "../x"); only a relative pattern without ".." stays under `path` (review Codex 2026-10-23).
    const pattern = name === "Glob" && typeof req.input?.pattern === "string" ? req.input.pattern : "";
    if (pattern && (isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]+/).includes(".."))) return { action: "defer", reason: `Glob: pattern ${pattern.slice(0, 80)} reaches outside` };
    if (roots.length && targets.every(insideRoots)) return { action: "allow" };
    return { action: "defer", reason: `${name}: outside the project` };
  }
  if (WRITE.has(name)) {
    if (ident.role !== "peer-impl" || !ident.worktree) return { action: "deny", message: `SLP: role ${ident.role} does not edit files.` };
    // A tool may carry several path keys (NotebookEdit: file_path and notebook_path); every one must pass.
    const targets = ["file_path", "notebook_path", "path"].map((k) => req.input?.[k]).filter((v): v is string => typeof v === "string" && v !== "");
    if (!targets.length) return { action: "deny", message: "SLP: this edit names no file path." };
    const wt = resolveExisting(ident.worktree, realpath);
    for (const target of targets) {
      if (target.split(/[\\/]+/).includes("..")) return { action: "deny", message: `SLP: ${target} is outside your worktree.` };
      const abs = resolveExisting(target, realpath);
      const rel = relative(wt, abs).split(sep).join("/");
      const folded = rel.toUpperCase().toLowerCase();
      if (folded === ".git" || folded.startsWith(".git/")) return { action: "deny", message: "SLP: the worktree's .git link is managed by the plugin." };
      if (isProtectedPath(rel, null)) return { action: "deny", message: "SLP: paseo.json, git hooks and agent settings (.claude/, .codex/, .mcp.json) run outside the sandbox; only a human edits them." };
      if (!inside(abs, wt)) return { action: "deny", message: `SLP: ${target} is outside your worktree.` };
    }
    return { action: "allow" };
  }
  return { action: "defer", reason: `${req.kind ?? "tool"}: ${name}` };
}
