import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractHumanMessages, SeenIds } from "../server/human";
import { tmpDir } from "./helpers";

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
    expect(extractHumanMessages(items, (id) => id.startsWith("slp-"), seen)).toEqual([{ messageId: "h1", text: "hãy đổi hướng" }]);
    expect(extractHumanMessages(items, (id) => id.startsWith("slp-"), seen)).toEqual([]);
  });
  it("remembers seen ids across restarts", () => {
    const file = join(tmpDir(), "seen.json");
    extractHumanMessages([{ type: "user_message", text: "a", clientMessageId: "c1" }], () => false, new SeenIds(file));
    expect(extractHumanMessages([{ type: "user_message", text: "a", clientMessageId: "c1" }], () => false, new SeenIds(file))).toEqual([]);
  });
});
