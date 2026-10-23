import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractHumanMessages, SeenIds, TimelineMarks, type TimelineItemLike } from "../server/human";
import { tmpDir } from "./helpers";

const um = (text: string, messageId: string, timestamp?: string) => ({ item: { type: "user_message", text, messageId }, timestamp });
const notPlugin = (id: string) => id.startsWith("slp-");
/** A fresh agent's page: no mark, nothing recorded yet. */
const fresh = (items: TimelineItemLike[], isPluginId: (id: string) => boolean, seen: SeenIds) =>
  extractHumanMessages(items.map((item) => ({ item })), "e1", undefined, isPluginId, seen, new Set()).messages;

describe("extractHumanMessages", () => {
  it("keeps only new human user messages", () => {
    const seen = new SeenIds(join(tmpDir(), "seen.json"));
    const items = [
      { type: "user_message", text: "hãy đổi hướng", messageId: "h1" },
      { type: "user_message", text: "[SLP plugin] continue", messageId: "slp-1" },
      { type: "user_message", text: "<paseo-system>\nSchedule fired\n</paseo-system>", messageId: "s1" },
      { type: "user_message", text: '<paseo-system version="1" message-id="x">hi</paseo-system>', clientMessageId: "x" },
      { type: "tool_call", name: "agent_message" },
      { type: "user_message", text: "no id" },
      { type: "assistant_message", text: "ok" },
    ];
    expect(fresh(items, notPlugin, seen)).toEqual([{ messageId: "h1", text: "hãy đổi hướng", timestamp: null }]);
    expect(fresh(items, notPlugin, seen)).toEqual([]);
  });
  it("remembers seen ids across restarts", () => {
    const file = join(tmpDir(), "seen.json");
    fresh([{ type: "user_message", text: "a", clientMessageId: "c1" }], () => false, new SeenIds(file));
    expect(fresh([{ type: "user_message", text: "a", clientMessageId: "c1" }], () => false, new SeenIds(file))).toEqual([]);
  });
  it("still returns a message when the seen file cannot be written, and does not return it twice", () => {
    const dir = tmpDir(); const blocker = join(dir, "blocker"); writeFileSync(blocker, "not a directory");
    const errors: unknown[] = [];
    const seen = new SeenIds(join(blocker, "seen.json"), (e) => errors.push(e));
    const items = [{ type: "user_message", text: "hello", messageId: "h9" }];
    expect(fresh(items, () => false, seen)).toEqual([{ messageId: "h9", text: "hello", timestamp: null }]);
    expect(errors.length).toBeGreaterThan(0);
    expect(fresh(items, () => false, seen)).toEqual([]);
  });
  it("treats an item as a plugin message if either of its ids is a plugin id", () => {
    const seen = new SeenIds(join(tmpDir(), "seen.json"));
    expect(fresh([{ type: "user_message", text: "hi", messageId: "uuid-1", clientMessageId: "slp-x" }], notPlugin, seen)).toEqual([]);
    expect(fresh([{ type: "user_message", text: "yo", messageId: "uuid-2", clientMessageId: "uuid-3" }], notPlugin, seen)).toEqual([{ messageId: "uuid-2", text: "yo", timestamp: null }]);
  });
  it("records a human prompt once and never a plugin message, even one re-ided by a reload", () => {
    const seen = new SeenIds(join(tmpDir(), "seen.json"));
    const r = extractHumanMessages([um("duyệt", "h-1", "2026-10-23T04:12:41.000Z"), um("[SLP from supervisor · f] plan v1 approved", "u-9", "2026-10-23T04:13:00.000Z"), um("[SLP plugin] T1 committed", "u-10")], "e1", undefined, notPlugin, seen, new Set());
    expect(r.messages.map((m) => m.text)).toEqual(["duyệt"]);
    expect(r.mark).toEqual({ epoch: "e1", lastTs: "2026-10-23T04:12:41.000Z" });
    expect(extractHumanMessages([um("duyệt", "h-1", "2026-10-23T04:12:41.000Z")], "e1", r.mark, notPlugin, seen, new Set(["duyệt"])).messages).toEqual([]);
  });
  it("skips history replayed after an agent reload: new ids, old timestamps (T21 B-4)", () => {
    const seen = new SeenIds(join(tmpDir(), "seen.json"));
    const mark = { epoch: "e1", lastTs: "2026-10-23T04:12:41.000Z" };
    const r = extractHumanMessages([um("duyệt", "4347d244-uuid", "2026-10-23T04:12:41.000Z")], "e2", mark, notPlugin, seen, new Set(["duyệt"]));
    expect(r.messages).toEqual([]);
    expect(r.replayed).toBe(1);
  });
  it("skips replayed history even when the reload restamps it, by matching texts already recorded", () => {
    const seen = new SeenIds(join(tmpDir(), "seen.json"));
    const mark = { epoch: "e1", lastTs: "2026-10-23T04:12:41.000Z" };
    const r = extractHumanMessages([um("duyệt", "u-1", "2026-10-23T04:17:51.864Z"), um("ok ship", "u-2", "2026-10-23T04:18:30.000Z")], "e2", mark, notPlugin, seen, new Set(["duyệt"]));
    expect(r.messages.map((m) => m.text)).toEqual(["ok ship"]);
    expect(r.replayed).toBe(1);
  });
  it("fails safe on a genuine repeat right after a reload: the human types it again", () => {
    // Review focus: a real "duyệt" typed just after a reload equals an old one; dropping it only makes the Supervisor ask again.
    const seen = new SeenIds(join(tmpDir(), "seen.json"));
    const r = extractHumanMessages([um("duyệt", "h-new", "2026-10-23T05:00:00.000Z")], "e2", { epoch: "e1", lastTs: "2026-10-23T04:12:41.000Z" }, notPlugin, seen, new Set(["duyệt"]));
    expect(r.messages).toEqual([]);
    const again = extractHumanMessages([um("duyệt", "h-new2", "2026-10-23T05:01:00.000Z")], "e2", r.mark, notPlugin, seen, new Set(["duyệt"]));
    expect(again.messages.map((m) => m.text)).toEqual(["duyệt"]); // same epoch: a new message is recorded
  });
  it("treats an agent with recorded messages but no mark as possibly replayed (agents from before this version)", () => {
    // No timeline-marks.json yet, the agent was reloaded: a replayed "duyệt" with a fresh id must not become a new approval (review Codex 2026-10-23).
    const seen = new SeenIds(join(tmpDir(), "seen.json"));
    const r = extractHumanMessages([um("duyệt", "u-fresh", "2026-10-23T06:00:00.000Z"), um("thêm test cho 2d", "u-new", "2026-10-23T06:01:00.000Z")], "e9", undefined, notPlugin, seen, new Set(["duyệt"]));
    expect(r.messages.map((m) => m.text)).toEqual(["thêm test cho 2d"]);
    expect(r.mark).toEqual({ epoch: "e9", lastTs: "2026-10-23T06:01:00.000Z" });
    // A brand-new agent has no recorded messages: its first prompt is recorded.
    expect(extractHumanMessages([um("duyệt", "h-1", "2026-10-23T06:02:00.000Z")], "e1", undefined, notPlugin, new SeenIds(join(tmpDir(), "s.json")), new Set()).messages).toHaveLength(1);
  });
});

describe("TimelineMarks", () => {
  it("persists marks per agent", () => {
    const file = join(tmpDir(), "marks.json");
    new TimelineMarks(file).set("a1", { epoch: "e1", lastTs: "t" });
    expect(new TimelineMarks(file).get("a1")).toEqual({ epoch: "e1", lastTs: "t" });
  });
});
