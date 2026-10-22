import { spawn } from "node:child_process";

export interface SandboxResult { exitCode: number | null; timedOut: boolean; stdoutTail: string; stderrTail: string; durationMs: number }
export type RunFn = (runner: readonly string[], worktree: string, command: string, timeoutSec: number) => Promise<SandboxResult>;

const TAIL = 4000;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

export function runnerArgv(runner: readonly string[], worktree: string, command: string): string[] {
  return [...runner.map((a) => a.replaceAll("{worktree}", worktree)), "sh", "-c", command];
}

export const runSandboxed: RunFn = (runner, worktree, command, timeoutSec) => {
  const argv = runnerArgv(runner, worktree, command);
  const started = Date.now();
  return new Promise((resolve) => {
    let out = ""; let err = ""; let timedOut = false; let done = false;
    const finish = (exitCode: number | null) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ exitCode, timedOut, stdoutTail: out, stderrTail: err, durationMs: Date.now() - started });
    };
    const child = spawn(argv[0]!, argv.slice(1), { cwd: worktree, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 2000).unref(); }, timeoutSec * 1000);
    child.stdout.on("data", (d) => { out = tail(out + d); });
    child.stderr.on("data", (d) => { err = tail(err + d); });
    child.on("error", (e) => { err = tail(`${err}${String(e)}`); finish(null); });
    child.on("close", (code) => finish(timedOut ? null : code));
  });
};

export async function checkRunner(runner: readonly string[], dir: string): Promise<string | null> {
  const r = await runSandboxed(runner, dir, "true", 30);
  return r.exitCode === 0 ? null : `sandbox runner failed (exit ${r.exitCode}): ${r.stderrTail.trim().slice(-300)}`;
}
