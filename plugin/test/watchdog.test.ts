import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLimitTurn, NudgeTracker, ResumeQueue, resumeAt, usageWindowsFrom } from "../server/watchdog";
import { tmpDir } from "./helpers";

describe("isLimitTurn", () => {
  it("detects failed turns caused by limits", () => {
    expect(isLimitTurn({ kind: "failed", error: { message: "429 Too Many Requests" } }, null)).toBe(true);
    expect(isLimitTurn({ kind: "failed", error: { message: "quota exceeded for this account" } }, null)).toBe(true);
    expect(isLimitTurn({ kind: "failed", error: { message: "ENOENT: no such file" } }, null)).toBe(false);
    expect(isLimitTurn({ kind: "failed", error: { message: "You exceeded your current quota, please check your plan" } }, null)).toBe(true);
  });
  it("never treats a full disk as a usage limit", () => {
    expect(isLimitTurn({ kind: "failed", error: { message: "EDQUOT: disk quota exceeded, write '/w/a.ts'" } }, null)).toBe(false);
    expect(isLimitTurn({ kind: "failed", error: { message: "ENOSPC: no space left on device" } }, null)).toBe(false);
    expect(isLimitTurn({ kind: "completed" }, "Disk quota exceeded.")).toBe(false);
  });
  it("detects short completed turns that only report a limit", () => {
    expect(isLimitTurn({ kind: "completed" }, "You've hit your usage limit · resets at 3pm")).toBe(true);
    expect(isLimitTurn({ kind: "completed" }, "Claude usage limit reached. Your limit will reset at 18:00.")).toBe(true);
  });
  it("ignores normal work that mentions rate limits", () => {
    expect(isLimitTurn({ kind: "completed" }, "Implemented the rate limit middleware: requests over 100/min get 429.")).toBe(false);
    expect(isLimitTurn({ kind: "completed" }, `Done. ${"details ".repeat(80)} usage limit reached in tests`)).toBe(false);
    expect(isLimitTurn({ kind: "canceled" }, "usage limit reached")).toBe(false);
  });
});

describe("usage windows and resume time", () => {
  const payload = {
    requestId: "r", fetchedAt: "2026-10-22T17:00:00Z",
    providers: [
      { providerId: "claude", displayName: "Claude", status: "available", planLabel: "Max", windows: [{ id: "5h", label: "5 hours", usedPct: 100, resetsAt: "2026-10-22T18:10:00Z" }, { id: "wk", label: "Week", usedPct: 27, resetsAt: "2026-10-24T01:00:00Z" }] },
      { providerId: "codex", displayName: "ChatGPT", status: "available", planLabel: null, windows: [{ id: "5h", label: "5 hours", usedPct: 10, resetsAt: "2026-10-22T20:00:00Z" }] },
      { providerId: "cursor", displayName: "Cursor", status: "unavailable", planLabel: null, windows: [] },
    ],
  };
  it("maps providers to vendors", () => {
    expect(usageWindowsFrom(payload)).toEqual([
      { vendor: "claude", usedPct: 100, resetsAt: "2026-10-22T18:10:00Z" }, { vendor: "claude", usedPct: 27, resetsAt: "2026-10-24T01:00:00Z" },
      { vendor: "codex", usedPct: 10, resetsAt: "2026-10-22T20:00:00Z" }]);
    expect(usageWindowsFrom([payload.providers[0]])).toEqual([]);
    expect(usageWindowsFrom(null)).toEqual([]);
  });
  it("waits for the latest exhausted window plus a minute, else backs off", () => {
    const now = new Date("2026-10-22T17:00:00Z");
    expect(resumeAt(usageWindowsFrom(payload), "claude", now, 0).toISOString()).toBe("2026-10-22T18:11:00.000Z");
    expect(resumeAt(usageWindowsFrom(payload), "codex", now, 2).toISOString()).toBe("2026-10-22T17:04:00.000Z");
    expect(resumeAt([], "codex", now, 10).toISOString()).toBe("2026-10-22T17:30:00.000Z");
  });
});

describe("persisted queues", () => {
  it("keeps resume jobs and attempt counts across restarts and returns only due ones", () => {
    const file = join(tmpDir(), "resume.json");
    new ResumeQueue(file).schedule({ agentId: "a", vendor: "claude", at: "2026-10-22T18:00:00Z", attempt: 1 });
    new ResumeQueue(file).schedule({ agentId: "b", vendor: "codex", at: "2026-10-22T19:00:00Z", attempt: 2 });
    const q = new ResumeQueue(file);
    expect(q.attemptOf("b")).toBe(2);
    expect(q.due(new Date("2026-10-22T18:30:00Z")).map((j) => j.agentId)).toEqual(["a"]);
    expect(new ResumeQueue(file).jobs().map((j) => j.agentId)).toEqual(["a", "b"]);
    q.done("a", { attempt: 9, at: "2026-10-22T18:00:00Z" });
    expect(new ResumeQueue(file).jobs().map((j) => j.agentId)).toEqual(["a", "b"]);
    q.done("a", { attempt: 1, at: "2026-10-22T18:00:00Z" });
    expect(new ResumeQueue(file).jobs().map((j) => j.agentId)).toEqual(["b"]);
    q.postpone({ agentId: "b", vendor: "codex", at: "2026-10-22T18:59:00Z", attempt: 2 }, "2026-10-22T20:00:00Z");
    expect(new ResumeQueue(file).jobs()[0]!.at).toBe("2026-10-22T19:00:00Z");
    expect(new ResumeQueue(file).attemptOf("a")).toBe(1);
    q.clear("a"); q.clear("b");
    expect(new ResumeQueue(file).jobs()).toEqual([]);
    expect(new ResumeQueue(file).attemptOf("a")).toBe(0);
  });
  it("nudges at most max times per agent until reset", () => {
    const n = new NudgeTracker(join(tmpDir(), "nudge.json"));
    expect([n.shouldNudge("a", 1), n.shouldNudge("a", 1)]).toEqual([true, false]);
    n.reset("a");
    expect(n.shouldNudge("a", 1)).toBe(true);
    expect(n.shouldNudge("b", 0)).toBe(false);
  });
});
