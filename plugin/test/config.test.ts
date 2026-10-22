import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSlpConfig, projectForCwd } from "../server/config";
import { tmpDir } from "./helpers";

const minimal = { projects: { demo: { repo: "/r", verify: ["npm test"] } } };

describe("parseSlpConfig", () => {
  it("applies every default from the spec", () => {
    const c = parseSlpConfig(minimal);
    expect(c.projects.demo).toMatchObject({ baseBranch: "origin/main", maxWriters: 2 });
    expect(c.flags).toEqual({ ask: true, evidenceCheck: true, touchSetGuard: true, crossVendorReview: true, supervisorPlanApproval: true, autoResume: true, watch: true });
    expect(c.limits).toEqual({ resumeMaxAttempts: 6, challengeAnswerMinutes: 30, noReportNudges: 1, verifyTimeoutSeconds: 900, maxCommitFiles: 500 });
    expect(c.sandbox.runner).toEqual(["codex", "sandbox", "-P", ":workspace", "-C", "{worktree}", "--"]);
    expect(c.sandbox.claudeAllowedDomains).toEqual(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
    expect(c.rotation).toEqual({ contextRatio: 0.6, maxTurns: 200 });
    expect(c.watch).toEqual({ intervalMinutes: 15, packToolCalls: 10 });
    expect(c.mcp.port).toBe(47320);
    expect(c.ship).toEqual({ remote: "origin", openPr: true });
    expect(c.models.allowed).toEqual([]);
    expect(c.runtime).toEqual({ claudePluginDir: null });
  });
  it("rejects a project without a verify command", () => {
    expect(() => parseSlpConfig({ projects: { demo: { repo: "/r", verify: [] } } })).toThrow(/verify/);
  });
  it("rejects a project name that is not a slug", () => {
    expect(() => parseSlpConfig({ projects: { "My Proj": { repo: "/r", verify: ["x"] } } })).toThrow(/SLP config invalid/);
  });
});

describe("projectForCwd", () => {
  it("matches a cwd reached through a symlink and a subdirectory", () => {
    const root = tmpDir(); const real = join(root, "real"); mkdirSync(join(real, "sub"), { recursive: true });
    symlinkSync(real, join(root, "link"));
    const c = parseSlpConfig({ projects: { demo: { repo: real, verify: ["x"] } } });
    expect(projectForCwd(c, join(root, "link", "sub"))?.name).toBe("demo");
  });
  it("returns null outside every project, including a sibling with the same prefix", () => {
    const root = tmpDir(); mkdirSync(join(root, "app")); mkdirSync(join(root, "app-2"));
    const c = parseSlpConfig({ projects: { demo: { repo: join(root, "app"), verify: ["x"] } } });
    expect(projectForCwd(c, join(root, "app-2"))).toBeNull();
  });
});
