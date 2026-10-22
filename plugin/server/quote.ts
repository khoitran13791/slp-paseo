import type { SlpEvent } from "./store/events";

export type QuoteResult = { ok: true; seq: number; messageId: string } | { ok: false; reason: string };

const norm = (s: string) => s.normalize("NFC").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
const WORD = /[\p{L}\p{M}\p{N}']/u;
const CLAUSE_BREAK = /[.!?;,:…]/;
/** A clause holding one of these is not an approval: "chưa duyệt", "duyệt không", "don't ship". */
const NEGATIONS = new Set(["không", "khong", "ko", "k", "hông", "chưa", "chua", "đừng", "chẳng", "chả", "khoan", "đợi", "chờ", "no", "not", "don't", "dont", "never", "wait"]);

/** An approval clause needs one of these and nothing but these, FILLER, version numbers and the feature's name. */
const APPROVE = new Set(["duyệt", "ok", "oke", "okay", "okie", "ổn", "đồng", "ý", "được", "chốt", "ship", "push", "approve", "approved", "yes", "lgtm", "go"]);
const FILLER = new Set(["đi", "nhé", "nha", "luôn", "rồi", "này", "đó", "đấy", "cái", "cho", "mình", "em", "anh", "bạn", "thôi", "vậy", "ạ", "á", "à", "ừ", "vâng", "dạ", "brief", "spec", "plan", "it", "this", "the", "please"]);
const words = (s: string) => s.split(/[^\p{L}\p{M}\p{N}']+/u).filter(Boolean);

/** The clause around each whole-word occurrence of `q` that is neither negated nor a question. */
function clausesWith(text: string, q: string): string[] {
  const out: string[] = [];
  if (q.includes("?")) return out;
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
    const end = i + q.length;
    if (WORD.test(text[i - 1] ?? "") || WORD.test(text[end] ?? "")) continue;
    let start = i;
    while (start > 0 && !CLAUSE_BREAK.test(text[start - 1]!)) start -= 1;
    let stop = end;
    while (stop < text.length && !CLAUSE_BREAK.test(text[stop]!)) stop += 1;
    if (text[stop] === "?") continue;
    const clause = text.slice(start, stop);
    if (words(clause).some((w) => NEGATIONS.has(w))) continue;
    out.push(clause);
  }
  return out;
}

const saysYes = (clause: string, extra: ReadonlySet<string>): boolean => {
  const ws = words(clause);
  return ws.some((w) => APPROVE.has(w)) && ws.every((w) => APPROVE.has(w) || FILLER.has(w) || extra.has(w) || /^v?\d+$/.test(w));
};

/**
 * The human's latest message after the item decides, so a later "khoan, chưa duyệt" or "wait, stop" overrides an earlier "duyệt".
 * The quote must sit in it as whole words, in a clause with no negation and no question mark. With `affirm` (approvals) that
 * clause must say yes and nothing else, so "explain the risks" or "ok để mình nghĩ thêm" approve nothing (review 2026-10-22).
 */
export function findHumanQuote(messages: readonly SlpEvent[], opts: { agentId: string; quote: string; after: string; affirm?: boolean; extraWords?: string[] }): QuoteResult {
  const q = norm(opts.quote);
  if (q.length < 2) return { ok: false, reason: "quote too short" };
  const after = Date.parse(opts.after);
  const latest = [...messages].reverse().find((e) => e.kind === "human_message" && e.data.agentId === opts.agentId && Date.parse(e.ts) > after);
  if (!latest) return { ok: false, reason: "no message from the human after the item under approval" };
  const text = norm(String(latest.data.text ?? ""));
  if (!text.includes(q)) return { ok: false, reason: "the human's latest message does not contain that quote; quote their latest answer, or ask them to confirm plainly" };
  const clauses = clausesWith(text, q);
  const extra = new Set((opts.extraWords ?? []).flatMap((w) => words(norm(w))));
  // Approvals: every clause of the message must be a plain yes. A blacklist of stop words cannot catch "If CI passes, ship." or
  // "OK, but first explain the risks."; a whitelist can (review Codex 2026-10-22, round 3). Notes go in a separate message.
  const allClauses = text.split(CLAUSE_BREAK).filter((c) => words(c).length > 0);
  if (!clauses.length || (opts.affirm && (text.includes("?") || !allClauses.every((c) => saysYes(c, extra))))) {
    return { ok: false, reason: "in the human's latest message that quote is part of a word, negated, a question, or more than a plain yes; ask them to confirm plainly, e.g. \"duyệt\"" };
  }
  return { ok: true, seq: latest.seq, messageId: String(latest.data.messageId ?? latest.seq) };
}

/** One human message backs one decision; the same decision on the same target may be recorded again (a retried ship). */
export function messageUsed(featureEvents: readonly SlpEvent[], messageId: string, decides: string, target: string): boolean {
  return featureEvents.some((e) => e.kind === "human_decision" && e.data.messageId === messageId && !(e.data.decides === decides && e.data.target === target));
}

export function verifyShipApproval(featureEvents: readonly SlpEvent[], messages: readonly SlpEvent[], opts: { agentId: string; quote: string; commit: string; extraWords?: string[] }): QuoteResult {
  const pkg = [...featureEvents].reverse().find((e) => e.kind === "ship_package");
  if (!pkg) return { ok: false, reason: "no ship package" };
  if (pkg.data.commit !== opts.commit) return { ok: false, reason: `commit ${opts.commit} is not the latest ship package (${String(pkg.data.commit)})` };
  const q = findHumanQuote(messages, { agentId: opts.agentId, quote: opts.quote, after: pkg.ts, affirm: true, extraWords: opts.extraWords });
  if (q.ok && messageUsed(featureEvents, q.messageId, "approve_ship", opts.commit)) return { ok: false, reason: "that message already backs another decision; ask the human about the ship separately" };
  return q;
}
