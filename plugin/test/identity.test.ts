import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashToken, IdentityRegistry } from "../server/identity";
import { tmpDir } from "./helpers";

const meta = { role: "lead" as const, project: "p", feature: "f", task: null, reviewCommit: null, parentAgentId: "sup" };

describe("IdentityRegistry", () => {
  it("mints unguessable tokens, stores only their hash, binds once, and persists owner-only", () => {
    const file = join(tmpDir(), "identities.json");
    const r = new IdentityRegistry(file);
    const a = r.mint(meta);
    expect(a.token).toMatch(/^[0-9a-f]{48}$/);
    expect(a.tokenHash).toBe(hashToken(a.token));
    expect(readFileSync(file, "utf8")).not.toContain(a.token);
    r.bind(a.token, "agent-1");
    r.bind(a.token, "agent-1");
    expect(() => r.bind(a.token, "agent-2")).toThrow(/already bound/);
    expect(() => r.bind("nope", "agent-1")).toThrow(/unknown SLP token/);
    expect(() => r.bind(a.tokenHash, "agent-1")).toThrow(/unknown SLP token/);
    const r2 = new IdentityRegistry(file);
    expect(r2.byAgent("agent-1")?.tokenHash).toBe(a.tokenHash);
    expect(r2.byToken(a.token)?.agentId).toBe("agent-1");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("records the placement Paseo chose", () => {
    const r = new IdentityRegistry(join(tmpDir(), "i.json"));
    const a = r.mint(meta);
    r.place(a.tokenHash, { worktree: "/wt/feat-f", workspaceId: "ws-1", branch: "feat/f" });
    expect(r.byToken(a.token)).toMatchObject({ worktree: "/wt/feat-f", workspaceId: "ws-1", branch: "feat/f" });
  });
  it("gives a Supervisor its feature once", () => {
    const r = new IdentityRegistry(join(tmpDir(), "i.json"));
    const s = r.mint({ ...meta, role: "supervisor", feature: null, parentAgentId: null }); r.bind(s.token, "sup-1");
    r.setFeature(s.tokenHash, "cache");
    expect(r.current("supervisor", "p", "cache")?.agentId).toBe("sup-1");
    r.setFeature(s.tokenHash, "cache");
    expect(() => r.setFeature(s.tokenHash, "other")).toThrow(/already belongs to feature cache/);
  });
  it("resolves the current agent for a role after rotation and hides retired identities", () => {
    const r = new IdentityRegistry(join(tmpDir(), "i.json"));
    const old = r.mint(meta); r.bind(old.token, "lead-1");
    const fresh = r.mint(meta); r.bind(fresh.token, "lead-2"); r.place(fresh.tokenHash, { worktree: "/w", branch: "feat/f", workspaceId: "ws-2" });
    r.retire(old.tokenHash);
    expect(r.current("lead", "p", "f")?.agentId).toBe("lead-2");
    expect(r.byToken(old.token)).toBeNull();
    expect(r.byAgent("lead-1")).toBeNull();
    expect(r.active("p").map((i) => i.agentId)).toEqual(["lead-2"]);
    r.retire(fresh.tokenHash);
    expect(r.current("lead", "p", "f")).toBeNull();
    expect(r.last("lead", "p", "f")?.agentId).toBe("lead-2");
    const failed = r.mint(meta); r.retire(failed.tokenHash); // a create that failed: no workspace
    expect(r.last("lead", "p", "f")?.agentId).toBe("lead-2");
  });
});
