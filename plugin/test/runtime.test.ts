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
  it("reads agent profiles again each time, so a profile made after start is used (T21 B-1)", async () => {
    const home = tmpDir(); process.env.SLP_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ projects: { demo: { repo: initRepo(), verify: ["true"] } }, sandbox: { runner: FAKE_RUNNER }, mcp: { port: 0 }, runtime: { claudePluginDir: home } }));
    const rt = createRuntime();
    const paseo = new FakePaseo();
    const off = { enabled: false };
    const providers = { "slp-supervisor": { extends: "claude", paseoTools: off }, "slp-lead": { extends: "claude", paseoTools: off }, "slp-peer-impl": { extends: "claude", paseoTools: off }, "slp-peer-review": { extends: "codex", paseoTools: off } };
    paseo.daemonConfig = { providers, agentProfiles: [] };
    await rt.capture(paseo);
    expect((await rt.ctx.refreshSetup()).profile.lead).toBeUndefined();
    paseo.daemonConfig = { providers, agentProfiles: [{ provider: "slp-lead", model: "claude-opus-5-5", thinkingOptionId: "xhigh" }] };
    expect((await rt.ctx.refreshSetup()).profile.lead).toMatchObject({ model: "claude-opus-5-5" });
    expect(rt.ctx.setup().profile.lead?.model).toBe("claude-opus-5-5");
    await rt.close();
  });
  it("recovers from a broken setup at start once the config is fixed, without a plugin reload", async () => {
    const home = tmpDir(); process.env.SLP_HOME = home;
    const repo = initRepo();
    writeFileSync(join(home, "config.json"), JSON.stringify({ projects: { demo: { repo, verify: ["true"] } }, sandbox: { runner: FAKE_RUNNER }, mcp: { port: 0 }, runtime: { claudePluginDir: home } }));
    const rt = createRuntime();
    const paseo = new FakePaseo();
    paseo.daemonConfig = { providers: {} }; // no slp-* providers yet: the setup at capture fails
    await rt.capture(paseo);
    const off = { enabled: false };
    paseo.daemonConfig = { providers: { "slp-supervisor": { extends: "claude", paseoTools: off }, "slp-lead": { extends: "claude", paseoTools: off }, "slp-peer-impl": { extends: "claude", paseoTools: off }, "slp-peer-review": { extends: "codex", paseoTools: off } }, agentProfiles: [] };
    const token = rt.ctx.identities.mint({ role: "supervisor", project: "demo", feature: null, task: null, reviewCommit: null, parentAgentId: null }).token;
    const out = await rt.transformCreate({ config: { provider: "slp-supervisor/claude-opus-5-5", cwd: repo }, env: { SLP_TOKEN: token } } as never);
    expect((out as { config: { modeId?: string } }).config.modeId).toBe("default");
    await rt.close();
  });
  it("wakes without any agent hook: the plugin gets its Paseo client, and a broken setup does not throw", async () => {
    const home = tmpDir(); process.env.SLP_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ projects: {}, sandbox: { runner: FAKE_RUNNER }, mcp: { port: 0 }, runtime: { claudePluginDir: home } }));
    const rt = createRuntime();
    const paseo = new FakePaseo();
    paseo.daemonConfig = { agents: { providers: {} } }; // setup fails
    await expect(rt.wake(paseo)).resolves.toBeUndefined();
    expect(rt.ctx.paseo()).toBe(paseo);
    await rt.close();
  });
  it("does not tick on wake: the 30 s timer alone paces ticks and resumes, however many clients wake it", async () => {
    const home = tmpDir(); process.env.SLP_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ projects: {}, sandbox: { runner: FAKE_RUNNER }, mcp: { port: 0 }, runtime: { claudePluginDir: home } }));
    const rt = createRuntime();
    const paseo = new FakePaseo();
    await rt.wake(paseo);
    rt.ctx.resumes.schedule({ agentId: "agent-x", vendor: "claude", at: new Date(0).toISOString(), attempt: 1 }); // a due resume job
    for (let i = 0; i < 3; i++) await rt.wake(paseo);
    expect(paseo.sent).toEqual([]); // no resume sent outside the timer
    expect(rt.ctx.resumes.jobs()).toHaveLength(1);
    await rt.close();
  });
});
