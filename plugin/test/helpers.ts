import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpDir(prefix = "slp-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}
export function initRepo(): string {
  const dir = tmpDir("slp-repo-");
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.name", "SLP Test"]);
  sh(dir, "git", ["config", "user.email", "slp@test.local"]);
  writeFileSync(join(dir, "README.md"), "# t\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "init"]);
  return dir;
}
/** Test-only runner: runs the command inside {worktree} WITHOUT any sandbox. */
export const FAKE_RUNNER = ["sh", "-c", 'cd "$0" && exec "$@"', "{worktree}"];
