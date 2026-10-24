import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { git, trustRepo, unsafeGitDrivers } from "./git";

/** A repo SLP has taken on (spec §7.4 rev 5.11); `repo` is the realpath of its main checkout. */
export interface ProjectEntry { repo: string }
export class ProjectError extends Error {}

/** Walks up from `cwd` to the first folder holding `.git`, reading the file system only: no git runs in a folder SLP does not trust yet. */
export function findRepoRoot(cwd: string): { root: string; dotGit: "dir" | "file" } | null {
  let dir = realpathSync(cwd);
  for (;;) {
    const p = join(dir, ".git");
    if (existsSync(p)) return { root: dir, dotGit: statSync(p).isDirectory() ? "dir" : "file" };
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** A projects.json value SLP can use: a map of names to `{ repo }` (final review I3). */
const isEntries = (v: unknown): v is Record<string, ProjectEntry> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((p) => p !== null && typeof p === "object" && typeof (p as { repo?: unknown }).repo === "string");
const within = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
const realHome = (): string => { try { return realpathSync(homedir()); } catch { return homedir(); } };

export const projectSlug = (dir: string): string => basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";

/** `~/.slp/projects.json`: the repos SLP registered when a Supervisor started in them. Only the plugin writes it. */
export class ProjectRegistry {
  private entries: Record<string, ProjectEntry> = {};
  private corrupt = false;
  constructor(private readonly file: string, private readonly log: (message: string, error?: unknown) => void = () => undefined) {
    this.load();
  }

  /** Reads the file again, so an entry the human deleted stays deleted (spec §8; final review I4). */
  private load(): void {
    this.entries = {}; this.corrupt = false;
    if (!existsSync(this.file)) return;
    const kept = "starting with no projects, the file is kept as projects.json.bad on the next write";
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); } catch (error) { this.corrupt = true; this.log(`${this.file}: projects.json is not valid JSON; ${kept}`, error); return; }
    if (isEntries(raw)) this.entries = raw;
    else { this.corrupt = true; this.log(`${this.file}: projects.json is not a map of project names to { repo }; ${kept}`); }
  }

  /** After a restart: trust every registered repo again. A repo that is gone or now runs git drivers is logged and left untrusted. */
  trustAll(): void {
    for (const [name, p] of Object.entries(this.entries)) {
      try {
        trustRepo(p.repo);
        const drivers = unsafeGitDrivers(p.repo);
        if (drivers.length) this.log(`project ${name}: git config runs commands a Peer could change (${drivers.join("; ")}); SLP will refuse to start agents here until they are removed.`);
      } catch (error) { this.log(`project ${name}: ${String(error)}; skipped`); }
    }
  }

  names(): string[] { return Object.keys(this.entries); }
  get(name: string): ProjectEntry | null { return this.entries[name] ?? null; }

  /** The project of a Supervisor started in `cwd`, registered on first use. Throws ProjectError saying how to fix the repo. */
  register(cwd: string, remote: string): { name: string; repo: string } {
    const found = findRepoRoot(cwd);
    if (!found) throw new ProjectError(`SLP: ${cwd} is not inside a git repo. Open a git repo's folder in Paseo and start the Supervisor there.`);
    if (found.dotGit === "file") throw new ProjectError(`SLP: ${found.root} is a git worktree or submodule. Open the repo's main checkout in Paseo and start the Supervisor there.`);
    const repo = found.root;
    // A Supervisor in a plain folder under a home kept in git would otherwise take on the whole home, ~/.ssh included (final review I2).
    if (within(realHome(), repo)) throw new ProjectError(`SLP: ${repo} is your home folder or a folder above it, so SLP will not take it on. Open a project's own repo (with its own .git, below your home) in Paseo and start the Supervisor there.`);
    trustRepo(repo); // throws when .git has no HEAD
    const drivers = unsafeGitDrivers(repo);
    if (drivers.length) throw new ProjectError(`SLP: ${repo}'s git config runs commands a Peer could change (${drivers.join("; ")}). Remove them, or keep this repo out of SLP.`);
    if (git(repo, ["remote", "get-url", remote], true).code !== 0) throw new ProjectError(`SLP: ${repo} has no remote "${remote}". Push the repo to a remote first: features start from it and ship pushes to it.`);
    this.load();
    const known = Object.entries(this.entries).find(([, p]) => p.repo === repo);
    if (known) return { name: known[0], repo };
    let name = projectSlug(repo);
    if (this.entries[name]) name = `${name}-${createHash("sha256").update(repo).digest("hex").slice(0, 4)}`;
    this.entries[name] = { repo };
    mkdirSync(dirname(this.file), { recursive: true });
    if (this.corrupt) { copyFileSync(this.file, `${this.file}.bad`); this.corrupt = false; }
    writeFileSync(this.file, `${JSON.stringify(this.entries, null, 2)}\n`, { mode: 0o600 });
    return { name, repo };
  }
}
