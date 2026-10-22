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
    const timers: NodeJS.Timeout[] = [];
    const after = (ms: number, fn: () => void) => { if (!done) timers.push(setTimeout(fn, ms)); };
    const finish = (exitCode: number | null) => {
      if (done) return; done = true;
      for (const t of timers) clearTimeout(t);
      killGroup("SIGKILL"); // nothing the command started in its group outlives the run
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ exitCode, timedOut, stdoutTail: out, stderrTail: err, durationMs: Date.now() - started });
    };
    const child = spawn(argv[0]!, argv.slice(1), { cwd: worktree, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* already gone */ } };
    after(timeoutSec * 1000, () => {
      timedOut = true; killGroup("SIGTERM");
      after(2000, () => { killGroup("SIGKILL"); after(1000, () => finish(null)); }); // hard bound: resolve even if pipes stay open
    });
    child.stdout.on("data", (d) => { out = tail(out + d); });
    child.stderr.on("data", (d) => { err = tail(err + d); });
    child.on("error", (e) => { err = tail(`${err}${String(e)}`); finish(null); });
    child.on("exit", (code) => after(300, () => finish(timedOut ? null : code))); // drain window: descendants may still hold stdout
    child.on("close", (code) => finish(timedOut ? null : code));
  });
};

export async function checkRunner(runner: readonly string[], dir: string): Promise<string | null> {
  const r = await runSandboxed(runner, dir, "true", 30);
  return r.exitCode === 0 ? null : `sandbox runner failed (exit ${r.exitCode}): ${r.stderrTail.trim().slice(-300)}`;
}
