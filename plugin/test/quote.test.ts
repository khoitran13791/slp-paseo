import { describe, expect, it } from "vitest";
import type { SlpEvent } from "../server/store/events";
import { findHumanQuote, messageUsed, verifyShipApproval } from "../server/quote";

const msg = (seq: number, ts: string, agentId: string, text: string): SlpEvent =>
  ({ seq, ts, feature: null, kind: "human_message", id: null, by_role: "plugin", by_agent: null, refs: [], supersedes: null, data: { agentId, text, messageId: `m${seq}` } });

describe("findHumanQuote", () => {
  const messages = [msg(1, "2026-10-22T01:00:00.000Z", "sup", "chưa, sửa lại"), msg(2, "2026-10-22T03:00:00.000Z", "sup", "OK  duyệt   brief này")];
  it("finds a quote sent after the item, normalizing whitespace and case", () => {
    expect(findHumanQuote(messages, { agentId: "sup", quote: "ok duyệt brief", after: "2026-10-22T02:00:00.000Z" })).toEqual({ ok: true, seq: 2, messageId: "m2" });
  });
  it("matches Vietnamese text written in decomposed Unicode", () => {
    expect(findHumanQuote(messages, { agentId: "sup", quote: "duyệt".normalize("NFD"), after: "2026-10-22T02:00:00.000Z" }).ok).toBe(true);
  });
  it("rejects quotes sent before the item, by another agent's human, or too short", () => {
    expect(findHumanQuote(messages, { agentId: "sup", quote: "sửa lại", after: "2026-10-22T02:00:00.000Z" }).ok).toBe(false);
    expect(findHumanQuote(messages, { agentId: "lead", quote: "duyệt", after: "2026-10-22T00:00:00.000Z" }).ok).toBe(false);
    expect(findHumanQuote(messages, { agentId: "sup", quote: " ", after: "2026-10-22T00:00:00.000Z" })).toEqual({ ok: false, reason: "quote too short" });
  });
  it("refuses a quote that is part of a word, in a negated clause, or in a question", () => {
    const at = (text: string) => [msg(3, "2026-10-22T04:00:00.000Z", "sup", text)];
    const cases: Array<[string, string]> = [["chưa duyệt", "duyệt"], ["Ko duyệt nhé", "duyệt"], ["duyệt không?", "duyệt"], ["ship được chưa", "ship"], ["don’t ship yet", "ship"], ["relationship ổn", "ship"], ["ok?", "ok"]];
    for (const [text, quote] of cases) {
      expect(findHumanQuote(at(text), { agentId: "sup", quote, after: "2026-10-22T02:00:00.000Z" })).toEqual({ ok: false, reason: expect.stringMatching(/confirm plainly/) });
    }
  });
  it("accepts the quote from its own clause, and lets a later retraction win", () => {
    const one = [msg(3, "2026-10-22T04:00:00.000Z", "sup", "Ổn rồi. Duyệt, ship đi")];
    expect(findHumanQuote(one, { agentId: "sup", quote: "duyệt", after: "2026-10-22T02:00:00.000Z", affirm: true })).toMatchObject({ ok: true, seq: 3 });
    expect(findHumanQuote(one, { agentId: "sup", quote: "duyệt, ship đi", after: "2026-10-22T02:00:00.000Z", affirm: true })).toMatchObject({ ok: true, seq: 3 });
    const noted = [msg(3, "2026-10-22T04:00:00.000Z", "sup", "Không vấn đề gì. Dùng Redis")];
    expect(findHumanQuote(noted, { agentId: "sup", quote: "dùng redis", after: "2026-10-22T02:00:00.000Z" }).ok).toBe(true);
    const retracted = [msg(3, "2026-10-22T04:00:00.000Z", "sup", "duyệt"), msg(4, "2026-10-22T04:05:00.000Z", "sup", "khoan, chưa duyệt")];
    expect(findHumanQuote(retracted, { agentId: "sup", quote: "duyệt", after: "2026-10-22T02:00:00.000Z" }).ok).toBe(false);
    const stopped = [msg(3, "2026-10-22T04:00:00.000Z", "sup", "ship"), msg(4, "2026-10-22T04:05:00.000Z", "sup", "wait, stop")];
    expect(findHumanQuote(stopped, { agentId: "sup", quote: "ship", after: "2026-10-22T02:00:00.000Z" })).toEqual({ ok: false, reason: expect.stringMatching(/latest message does not contain/) });
  });
  it("approves only with a plain yes: not a request, not a yes followed by more, but the feature name and a version are fine", () => {
    const at = (text: string) => [msg(3, "2026-10-22T04:00:00.000Z", "sup", text)];
    const yes = (text: string, quote: string) => findHumanQuote(at(text), { agentId: "sup", quote, after: "2026-10-22T02:00:00.000Z", affirm: true, extraWords: ["cache-layer"] }).ok;
    expect(yes("please explain the risks", "explain the risks")).toBe(false);
    expect(yes("ok để mình nghĩ thêm", "ok")).toBe(false);
    expect(yes("Duyệt spec cache layer v2 nhé", "duyệt spec cache layer v2")).toBe(true);
    expect(yes("đồng ý, nhưng thêm test X sau", "đồng ý")).toBe(false);
    expect(yes("If CI passes, ship.", "ship")).toBe(false);
    expect(yes("OK, but first explain the risks.", "ok")).toBe(false);
    expect(yes("Nếu CI xanh thì: ship.", "ship")).toBe(false);
    expect(yes("Ok. Ship đi!", "ship đi")).toBe(true);
    expect(yes("OK, ship?", "ok")).toBe(false);
    expect(yes("OK, wait, stop.", "ok")).toBe(false);
    expect(yes("OK. Do not ship.", "ok")).toBe(false);
    expect(yes("Không vấn đề gì. Duyệt", "duyệt")).toBe(false);
    expect(findHumanQuote(at("please explain the risks"), { agentId: "sup", quote: "explain the risks", after: "2026-10-22T02:00:00.000Z" }).ok).toBe(true);
  });
  it("lets one message back only one decision, except the same decision on the same target", () => {
    const d = (messageId: string, decides: string, target: string): SlpEvent =>
      ({ seq: 1, ts: "2026-10-22T04:00:00.000Z", feature: "f", kind: "human_decision", id: null, by_role: "supervisor", by_agent: "sup", refs: [], supersedes: null, data: { decides, target, quote: "ok", messageId } });
    const events = [d("m3", "approve_spec", "s1")];
    expect(messageUsed(events, "m3", "approve_ship", "c1")).toBe(true);
    expect(messageUsed(events, "m3", "approve_spec", "s1")).toBe(false);
    expect(messageUsed(events, "m4", "approve_ship", "c1")).toBe(false);
  });
});

describe("verifyShipApproval", () => {
  const pkg = (seq: number, ts: string, commit: string): SlpEvent =>
    ({ seq, ts, feature: "f", kind: "ship_package", id: null, by_role: "supervisor", by_agent: "sup", refs: [], supersedes: null, data: { commit } });
  it("requires the latest package commit and a human quote after it", () => {
    const feature = [pkg(1, "2026-10-22T01:00:00.000Z", "aaa"), pkg(2, "2026-10-22T02:00:00.000Z", "bbb")];
    const messages = [msg(1, "2026-10-22T01:30:00.000Z", "sup", "ship"), msg(2, "2026-10-22T02:30:00.000Z", "sup", "ship đi")];
    expect(verifyShipApproval(feature, messages, { agentId: "sup", quote: "ship đi", commit: "bbb" }).ok).toBe(true);
    expect(verifyShipApproval(feature, messages, { agentId: "sup", quote: "ship", commit: "aaa" })).toEqual({ ok: false, reason: "commit aaa is not the latest ship package (bbb)" });
    expect(verifyShipApproval(feature, [messages[0]!], { agentId: "sup", quote: "ship", commit: "bbb" }).ok).toBe(false);
    expect(verifyShipApproval([], messages, { agentId: "sup", quote: "ship", commit: "bbb" })).toEqual({ ok: false, reason: "no ship package" });
  });
});
