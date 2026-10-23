import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRunner, makeRunSandboxed, runnerArgv, runSandboxed } from "../server/sandbox";
import { FAKE_RUNNER, tmpDir } from "./helpers";

describe("sandbox runner", () => {
  it("passes extra env, such as the runner's CODEX_HOME, to the sandboxed command", async () => {
    const run = makeRunSandboxed({ CODEX_HOME: "/x/codex-runner" });
    const r = await run(FAKE_RUNNER, tmpDir(), 'printf %s "$CODEX_HOME"', 10);
    expect(r.stdoutTail).toBe("/x/codex-runner");
  });
  it("substitutes {worktree} and appends sh -c", () => {
    expect(runnerArgv(["codex", "sandbox", "-P", ":workspace", "-C", "{worktree}", "--"], "/w", "npm test"))
      .toEqual(["codex", "sandbox", "-P", ":workspace", "-C", "/w", "--", "sh", "-c", "npm test"]);
  });
  it("propagates exit codes, runs inside the worktree, and keeps output tails", async () => {
    const dir = tmpDir();
    expect((await runSandboxed(FAKE_RUNNER, dir, "exit 3", 10)).exitCode).toBe(3);
    const r = await runSandboxed(FAKE_RUNNER, dir, "pwd; echo err >&2", 10);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, stdoutTail: `${dir}\n`, stderrTail: "err\n" });
  });
  it("kills the whole process group on timeout", async () => {
    const r = await runSandboxed(FAKE_RUNNER, tmpDir(), "sleep 30 & sleep 30", 1);
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });
  it("resolves at the timeout when a descendant escapes the group and keeps stdout open", async () => {
    const dir = tmpDir();
    // The parent waits for a child that calls setsid and holds stdout; the escapee's pid goes to escaped.pid.
    const escapee = `perl -MPOSIX -e 'if (fork == 0) { POSIX::setsid(); open(F, ">escaped.pid"); print F $$; close(F); exec("sleep", "10") } wait'`;
    try {
      const r = await runSandboxed(FAKE_RUNNER, dir, escapee, 1);
      expect(r.timedOut).toBe(true);
      expect(r.durationMs).toBeLessThan(5000);
    } finally {
      const pidFile = join(dir, "escaped.pid");
      if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ } }
    }
  });
  it("does not wait for a background child that keeps stdout open after the command exits", async () => {
    const r = await runSandboxed(FAKE_RUNNER, tmpDir(), "sleep 20 & echo started", 10);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.stdoutTail).toContain("started");
    expect(r.durationMs).toBeLessThan(3000);
  });
  it("runs the command with a minimal environment, not the plugin's own", async () => {
    process.env.SLP_SECRET_TEST = "x";
    try {
      const r = await runSandboxed(FAKE_RUNNER, tmpDir(), "printenv SLP_SECRET_TEST || true; echo done", 10);
      expect(r.exitCode).toBe(0);
      expect(r.stdoutTail).toBe("done\n");
      const env = await runSandboxed(FAKE_RUNNER, tmpDir(), "env", 10);
      const keys = env.stdoutTail.split("\n").filter(Boolean).map((l) => l.slice(0, l.indexOf("=")));
      expect(keys).toContain("PATH");
      expect(keys).toContain("CI");
      expect(keys.filter((k) => !["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "CI", "PWD", "SHLVL", "_", "OLDPWD"].includes(k))).toEqual([]);
    } finally { delete process.env.SLP_SECRET_TEST; }
  });
  it("reports a missing runner binary as a failure, not a pass", async () => {
    const r = await runSandboxed(["/nonexistent/runner"], tmpDir(), "true", 5);
    expect(r.exitCode).toBeNull();
    expect(await checkRunner(["/nonexistent/runner"], tmpDir())).toMatch(/sandbox runner failed/);
    expect(await checkRunner(FAKE_RUNNER, tmpDir())).toBeNull();
  });
  it.runIf(process.env.SLP_IT === "1")("real codex runner blocks writes outside the worktree and loopback", async () => {
    const runner = ["codex", "sandbox", "-P", ":workspace", "-C", "{worktree}", "--"];
    const dir = tmpDir(); const escape = join(homedir(), `.slp-it-${process.pid}`);
    try {
      expect((await runSandboxed(runner, dir, `echo x > "${escape}"`, 30)).exitCode).not.toBe(0);
      expect(existsSync(escape)).toBe(false);
      expect((await runSandboxed(runner, dir, "echo x > inside.txt", 30)).exitCode).toBe(0);
      expect((await runSandboxed(runner, dir, "curl -s -m 3 http://127.0.0.1:6767/ >/dev/null", 30)).exitCode).not.toBe(0);
    } finally { rmSync(escape, { force: true }); }
  });
});
