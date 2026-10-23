import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Identity } from "../server/identity";
import { writeFileSync } from "node:fs";
import { edgeAllowed, Router, steerAllowed } from "../server/router";
import { tmpDir } from "./helpers";

const id = (role: Identity["role"], feature: string | null, project = "p"): Identity =>
  ({ tokenHash: role, role, project, feature, task: null, worktree: null, workspaceId: null, branch: null, reviewCommit: null, agentId: `${role}-${feature}`, parentAgentId: null, createdAt: "", retiredAt: null });

describe("edgeAllowed (spec §7.3)", () => {
  it("allows only Supervisor⇄its Lead and Lead⇄own Peers, all inside one feature", () => {
    expect(edgeAllowed(id("supervisor", "a"), { role: "lead", project: "p", feature: "a" })).toBe(true);
    expect(edgeAllowed(id("lead", "a"), { role: "supervisor", project: "p", feature: "a" })).toBe(true);
    expect(edgeAllowed(id("lead", "a"), { role: "peer-impl", project: "p", feature: "a" })).toBe(true);
    expect(edgeAllowed(id("peer-review", "a"), { role: "lead", project: "p", feature: "a" })).toBe(true);
    expect(edgeAllowed(id("supervisor", "a"), { role: "lead", project: "p", feature: "b" })).toBe(false);
    expect(edgeAllowed(id("supervisor", null), { role: "lead", project: "p", feature: null })).toBe(false);
    expect(edgeAllowed(id("lead", "a"), { role: "supervisor", project: "p", feature: "b" })).toBe(false);
    expect(edgeAllowed(id("supervisor", "a"), { role: "peer-impl", project: "p", feature: "a" })).toBe(false);
    expect(edgeAllowed(id("supervisor", "a"), { role: "supervisor", project: "p", feature: "b" })).toBe(false);
    expect(edgeAllowed(id("peer-impl", "a"), { role: "supervisor", project: "p", feature: "a" })).toBe(false);
    expect(edgeAllowed(id("peer-impl", "a"), { role: "peer-review", project: "p", feature: "a" })).toBe(false);
    expect(edgeAllowed(id("lead", "a"), { role: "peer-impl", project: "p", feature: "b" })).toBe(false);
    expect(edgeAllowed(id("lead", "a", "p"), { role: "supervisor", project: "q", feature: "a" })).toBe(false);
  });
  it("lets only a Supervisor steer its Lead and a Lead steer its Peers", () => {
    expect(steerAllowed(id("supervisor", "a"), { role: "lead", project: "p", feature: "a" })).toBe(true);
    expect(steerAllowed(id("lead", "a"), { role: "peer-impl", project: "p", feature: "a", task: "T1" })).toBe(true);
    expect(steerAllowed(id("lead", "a"), { role: "supervisor", project: "p", feature: "a" })).toBe(false);
    expect(steerAllowed(id("peer-impl", "a"), { role: "lead", project: "p", feature: "a" })).toBe(false);
  });
});

describe("Router", () => {
  function make(file: string, statuses: Map<string, string>, sent: Array<[string, string, string]>) {
    return new Router({ file, now: () => new Date("2026-10-22T00:00:00Z"), resolve: (to) => `${to.role}-${to.feature}`, status: async (a) => statuses.get(a) ?? null, send: async (a, t, m) => { sent.push([a, t, m]); } });
  }
  it("holds messages until the target is idle, then delivers them as one prompt", async () => {
    const file = join(tmpDir(), "router.json"); const statuses = new Map([["lead-a", "running"]]); const sent: Array<[string, string, string]> = [];
    const r = make(file, statuses, sent);
    const d1 = r.enqueue({ role: "lead", project: "p", feature: "a" }, "first");
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "second");
    expect(await r.flush()).toBe(0);
    statuses.set("lead-a", "idle");
    expect(await r.flush()).toBe(2);
    expect(sent).toEqual([["lead-a", "first\n\n---\n\nsecond", d1.messageId]]);
    expect(r.pending()).toEqual([]);
  });
  it("survives a restart: the queue is persisted; plugin ids are recognised by their prefix", async () => {
    const file = join(tmpDir(), "router.json"); const sent: Array<[string, string, string]> = [];
    const r1 = make(file, new Map(), sent);
    const d = r1.enqueue({ role: "lead", project: "p", feature: "a" }, "hello");
    const r2 = make(file, new Map([["lead-a", "idle"]]), sent);
    expect(r2.isPluginMessageId(d.messageId)).toBe(true);
    expect(r2.isPluginMessageId(r1.issue())).toBe(true);
    expect(r2.isPluginMessageId("8f14e45f-ceea-467f-a0e6-1d9b0a5e8f31")).toBe(false);
    expect(await r2.flush()).toBe(1);
  });
  it("keeps a message and counts the attempt when sending fails", async () => {
    const file = join(tmpDir(), "router.json");
    const r = new Router({ file, now: () => new Date(), resolve: () => "x", status: async () => "idle", send: async () => { throw new Error("boom"); } });
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "m");
    expect(await r.flush()).toBe(0);
    expect(r.pending()[0]).toMatchObject({ attempts: 1, lastError: "Error: boom" });
  });
  it("drops the undelivered messages whose address matches, and keeps the drop across a restart", () => {
    const file = join(tmpDir(), "router.json");
    const r = make(file, new Map(), []);
    r.enqueue({ role: "peer-impl", project: "p", feature: "a", task: "T1" }, "old notice");
    r.enqueue({ role: "peer-impl", project: "p", feature: "a", task: "T1" }, "another old notice");
    r.enqueue({ role: "peer-impl", project: "p", feature: "a", task: "T2" }, "other task");
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "for the lead");
    expect(r.drop((to) => to.role === "peer-impl" && to.task === "T1")).toBe(2);
    expect(r.pending().map((d) => d.text)).toEqual(["other task", "for the lead"]);
    expect(r.drop((to) => to.role === "peer-review")).toBe(0);
    expect(make(file, new Map(), []).pending().map((d) => d.text)).toEqual(["other task", "for the lead"]);
  });
  it("issues ids with the slp- prefix", () => {
    expect(make(join(tmpDir(), "r.json"), new Map(), []).issue()).toMatch(/^slp-/);
  });
  it("serializes concurrent flushes so a message is delivered once", async () => {
    const sent: Array<[string, string, string]> = [];
    const r = make(join(tmpDir(), "r.json"), new Map([["lead-a", "idle"]]), sent);
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "once");
    await Promise.all([r.flush(), r.flush()]);
    expect(sent).toHaveLength(1);
  });
  it("cuts into a running turn only for steer or interrupt, taking queued messages along", async () => {
    const sent: Array<[string, string, string | null]> = [];
    const statuses = new Map([["lead-a", "running"]]);
    const r = new Router({ file: join(tmpDir(), "r.json"), now: () => new Date(), resolve: (to) => `${to.role}-${to.feature}`, status: async (a) => statuses.get(a) ?? null, send: async (a, t, _m, b) => { sent.push([a, t, b]); } });
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "fyi");
    expect(await r.flush()).toBe(0);
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "stop looping", { mode: "steer" });
    expect(await r.flush()).toBe(2);
    expect(sent).toEqual([["lead-a", "fyi\n\n---\n\nstop looping", "steer"]]);
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "a", { mode: "steer" });
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "b", { mode: "interrupt" });
    await r.flush();
    expect(sent.at(-1)![2]).toBe("interrupt");
    statuses.set("lead-a", "idle");
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "c", { mode: "steer" });
    await r.flush();
    expect(sent.at(-1)![2]).toBeNull();
  });
  it("replaces an undelivered message that has the same key", () => {
    const r = make(join(tmpDir(), "r.json"), new Map(), []);
    r.enqueue({ role: "supervisor", project: "p", feature: "a" }, "pack #1", { key: "watch:p:a" });
    r.enqueue({ role: "lead", project: "p", feature: "a" }, "other");
    r.enqueue({ role: "supervisor", project: "p", feature: "a" }, "pack #2", { key: "watch:p:a" });
    expect(r.pending().map((d) => d.text)).toEqual(["other", "pack #2"]);
  });
  it("keeps working in memory when the queue file cannot be written", async () => {
    const dir = tmpDir(); const blocker = join(dir, "blocker"); writeFileSync(blocker, "not a directory");
    const errors: unknown[] = []; const sent: string[] = [];
    const r = new Router({ file: join(blocker, "router.json"), now: () => new Date(), resolve: () => "x", status: async () => "idle", send: async (_a, t) => { sent.push(t); }, onError: (e) => errors.push(e) });
    expect(() => r.enqueue({ role: "lead", project: "p", feature: "a" }, "m")).not.toThrow();
    expect(r.pending()).toHaveLength(1);
    expect(await r.flush()).toBe(1);
    expect(sent).toEqual(["m"]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
