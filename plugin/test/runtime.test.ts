import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../server/runtime";
import { FAKE_RUNNER, FakePaseo, initRepo, tmpDir } from "./helpers";

describe("runtime", () => {
  const saved = process.env.SLP_HOME;
  afterEach(() => { process.env.SLP_HOME = saved; });
  it("never blocks or breaks non-SLP agents when the SLP role setup is unusable", async () => {
    const home = tmpDir(); process.env.SLP_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ projects: { demo: { repo: initRepo(), verify: ["true"] } }, sandbox: { runner: FAKE_RUNNER }, mcp: { port: 0 }, runtime: { claudePluginDir: home } }));
    const rt = createRuntime();
    const paseo = new FakePaseo();
    paseo.daemonConfig = { agents: { providers: {} } }; // file-shaped config: no top-level providers, so setup fails
    await rt.capture(paseo);
    const plain = { config: { provider: "claude/claude-haiku-4-5", cwd: "/x" } };
    expect(await rt.transformCreate(plain)).toBe(plain);
    await expect(rt.transformCreate({ config: { provider: "slp-supervisor", cwd: "/x" } })).rejects.toThrow(/slp-supervisor must exist/);
    await rt.close();
  });
});
