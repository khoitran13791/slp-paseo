import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isProtectedPath } from "./git";
import type { Identity } from "./identity";

export interface PermissionLike { id: string; name?: string; kind?: string; title?: string; description?: string; input?: Record<string, unknown>; detail?: { type?: string; command?: string } }
export type PermissionDecision = { action: "allow" } | { action: "deny"; message: string } | { action: "defer"; reason: string } | { action: "ignore" };
export interface PermissionOptions { deniedRoots: string[]; realpath?: (p: string) => string }
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i;

const SHELL = new Set(["Bash", "CodexBash", "shell", "exec_command"]);
const WRITE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const RESERVED = [
  /(^|[\s;&|(`'"/])paseo(\s|$)/,
  /\bgit\s+(-c\s+\S+\s+)*(push|commit|merge|rebase|worktree|reset\s+--hard)\b/,
  /dangerouslyDisableSandbox/,
];

function resolveExisting(p: string, realpath: (p: string) => string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpath(cur), ...rest.reverse()); } catch { /* walk up */ }
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
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = req.input?.[key];
    if (typeof v !== "string" || !v) continue;
    const target = resolveExisting(v, realpath);
    if (opts.deniedRoots.some((root) => inside(target, resolveExisting(root, realpath)))) return { action: "deny", message: "SLP: plugin and Paseo state are off limits. Use slp_state." };
  }
  if (name === "WebFetch" && typeof req.input?.url === "string") {
    let host = "";
    try { host = new URL(req.input.url).hostname; } catch { /* not a URL */ }
    if (LOOPBACK.test(host)) return { action: "deny", message: "SLP: local network services are off limits." };
  }
  if (SHELL.has(name)) {
    const command = String(req.input?.command ?? req.detail?.command ?? "");
    if (req.input?.dangerouslyDisableSandbox === true) return { action: "deny", message: "SLP: running outside the sandbox is not allowed." };
    if (RESERVED.some((re) => re.test(command))) return { action: "deny", message: `SLP: this command is reserved for the plugin (${command.slice(0, 80)}). Use the slp_* tools.` };
    return { action: "defer", reason: `shell: ${command.slice(0, 200)}` };
  }
  if (WRITE.has(name)) {
    if (ident.role !== "peer-impl" || !ident.worktree) return { action: "deny", message: `SLP: role ${ident.role} does not edit files.` };
    const target = String(req.input?.file_path ?? req.input?.notebook_path ?? "");
    const wt = resolveExisting(ident.worktree, realpath);
    const abs = resolveExisting(target, realpath);
    const rel = relative(wt, abs).split(sep).join("/");
    const folded = rel.toUpperCase().toLowerCase();
    if (folded === ".git" || folded.startsWith(".git/")) return { action: "deny", message: "SLP: the worktree's .git link is managed by the plugin." };
    if (isProtectedPath(rel, null)) return { action: "deny", message: "SLP: paseo.json, git hooks and agent settings (.claude/, .codex/, .mcp.json) run outside the sandbox; only a human edits them." };
    return inside(abs, wt) ? { action: "allow" } : { action: "deny", message: `SLP: ${target} is outside your worktree.` };
  }
  return { action: "defer", reason: `${req.kind ?? "tool"}: ${name}` };
}
