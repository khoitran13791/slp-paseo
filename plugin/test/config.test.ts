import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandHome, loadSlpConfig, parseSlpConfig } from "../server/config";
import { tmpDir } from "./helpers";

describe("parseSlpConfig", () => {
  it("defaults the runner to the slp-verify profile and denies the state dirs to every sandbox", () => {
    const c = parseSlpConfig({});
    expect(c.sandbox.runner).toEqual(["codex", "sandbox", "-P", "slp-verify", "-C", "{worktree}", "--"]);
    expect(c.sandbox.denyRead).toEqual(["~/.slp", "~/.paseo"]);
    expect(expandHome("~/.ssh")).toBe(join(homedir(), ".ssh"));
  });
  it("applies every default from the spec", () => {
    const c = parseSlpConfig({});
    expect(c.flags).toEqual({ ask: true, evidenceCheck: true, touchSetGuard: true, crossVendorReview: true, supervisorPlanApproval: true, autoResume: true, watch: true });
    expect(c.limits).toEqual({ resumeMaxAttempts: 6, challengeAnswerMinutes: 30, noReportNudges: 1, verifyTimeoutSeconds: 900, maxCommitFiles: 500, humanReminderMinutes: 30, maxWriters: 2 });
    expect(c.sandbox.runner).toEqual(["codex", "sandbox", "-P", "slp-verify", "-C", "{worktree}", "--"]);
    expect(c.sandbox.claudeAllowedDomains).toEqual(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
    expect(c.rotation).toEqual({ contextRatio: 0.6, maxTurns: 200 });
    expect(c.watch).toEqual({ intervalMinutes: 15, packToolCalls: 10 });
    expect(c.mcp.port).toBe(47320);
    expect(c.ship).toEqual({ remote: "origin", openPr: true });
    expect(c.models.allowed).toEqual([]);
    expect(c.runtime).toEqual({ claudePluginDir: null });
  });
});

describe("loadSlpConfig (rev 5.11)", () => {
  it("runs on defaults when ~/.slp/config.json is missing", () => {
    expect(loadSlpConfig(join(tmpDir(), "none.json")).limits.maxWriters).toBe(2);
  });
  it("ignores a leftover projects section and says so once", () => {
    const file = join(tmpDir(), "config.json"); writeFileSync(file, JSON.stringify({ projects: { demo: { repo: "/r", verify: ["x"] } }, watch: { intervalMinutes: 2 } }));
    const logs: string[] = [];
    const c = loadSlpConfig(file, (m) => logs.push(m));
    expect(c.watch.intervalMinutes).toBe(2);
    expect("projects" in c).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/projects in .*config\.json is no longer used/)]);
  });
});
