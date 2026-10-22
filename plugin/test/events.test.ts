import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../server/store/events";
import { tmpDir } from "./helpers";

const base = { feature: "f", by_role: "lead" as const, by_agent: "a1" };

describe("EventStore", () => {
  it("assigns increasing seq and per-prefix ids, persisted across instances", () => {
    const file = join(tmpDir(), "x", "events.jsonl");
    const s1 = new EventStore(file);
    const a = s1.append({ ...base, kind: "premise", idPrefix: "D", data: { kind: "decision", title: "t" } });
    const b = s1.append({ ...base, kind: "premise", idPrefix: "H", data: { kind: "hypothesis", title: "h" } });
    const c = s1.append({ ...base, kind: "premise", idPrefix: "D", data: { kind: "decision", title: "u" } });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect([a.id, b.id, c.id]).toEqual(["D1", "H1", "D2"]);
    const s2 = new EventStore(file);
    expect(s2.all()).toHaveLength(3);
    expect(s2.append({ ...base, kind: "ruling", idPrefix: "R" }).id).toBe("R1");
    expect(s2.append({ ...base, kind: "premise", idPrefix: "D" }).id).toBe("D3");
  });
  it("writes one JSON object per line and fills defaults", () => {
    const file = join(tmpDir(), "events.jsonl");
    new EventStore(file).append({ ...base, kind: "spec" }, new Date("2026-10-22T00:00:00Z"));
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line).toEqual({ seq: 1, ts: "2026-10-22T00:00:00.000Z", feature: "f", kind: "spec", id: null, by_role: "lead", by_agent: "a1", refs: [], supersedes: null, data: {} });
  });
  it("rejects unknown kinds", () => {
    const s = new EventStore(join(tmpDir(), "e.jsonl"));
    expect(() => s.append({ ...base, kind: "bogus" as never })).toThrow(/unknown event kind/);
  });
  it("fails closed on a corrupt line", () => {
    const file = join(tmpDir(), "e.jsonl");
    writeFileSync(file, '{"seq":1}\nnot json\n');
    expect(() => new EventStore(file)).toThrow(/line 2/);
  });
  it("drops a last line cut off mid-append, trims the file, and keeps appending", () => {
    const file = join(tmpDir(), "e.jsonl");
    new EventStore(file).append({ ...base, kind: "spec" });
    appendFileSync(file, '{"seq":2,"ts":"2026-10');
    const s = new EventStore(file);
    expect(s.all()).toHaveLength(1);
    expect(s.truncatedTail).toBe('{"seq":2,"ts":"2026-10');
    expect(s.append({ ...base, kind: "plan" }).seq).toBe(2);
    expect(new EventStore(file).all().map((e) => e.kind)).toEqual(["spec", "plan"]);
    expect(new EventStore(file).truncatedTail).toBeNull();
  });
});
