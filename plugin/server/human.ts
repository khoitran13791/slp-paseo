import { readJson, writeJson } from "./jsonFile";

export interface TimelineItemLike { type?: string; text?: string; messageId?: string | null; clientMessageId?: string | null; name?: string }
export interface TimelineEntryLike { item: TimelineItemLike; timestamp?: string }
export interface AgentTimelineMark { epoch: string | null; lastTs: string | null }

export class SeenIds {
  private readonly ids: string[];
  constructor(private readonly file: string, private readonly onError?: (error: unknown) => void) { this.ids = readJson<string[]>(file, []); }
  has(id: string): boolean { return this.ids.includes(id); }
  add(id: string): void {
    this.ids.push(id);
    if (this.ids.length > 20000) this.ids.splice(0, this.ids.length - 20000);
    try { writeJson(this.file, this.ids); } catch (error) { this.onError?.(error); }
  }
}

export class TimelineMarks {
  private readonly marks: Record<string, AgentTimelineMark>;
  constructor(private readonly file: string, private readonly onError?: (error: unknown) => void) { this.marks = readJson<Record<string, AgentTimelineMark>>(file, {}); }
  get(agentId: string): AgentTimelineMark | undefined { return this.marks[agentId]; }
  set(agentId: string, mark: AgentTimelineMark): void {
    this.marks[agentId] = mark;
    try { writeJson(this.file, this.marks); } catch (error) { this.onError?.(error); }
  }
}

const ENVELOPE = /^<paseo-system[\s>]/;
/** Router deliveries: "[SLP plugin] …", "[SLP from lead · f] …", "[SLP watch #3 · f]", "[SLP] You are the Lead …". */
const PLUGIN_TEXT = /^\[SLP[\s\]]/;

/**
 * New human prompts in a timeline page. `agent reload` replays the history with new message ids (T21 B-4): an item no newer than the newest
 * recorded one is history, and after the timeline epoch changes, a text the human already sent is treated as history too. Dropping a genuine
 * repeat only makes the Supervisor ask again; recording a replay would forge an approval.
 */
export function extractHumanMessages(
  entries: readonly TimelineEntryLike[], epoch: string | null, mark: AgentTimelineMark | undefined,
  isPluginId: (id: string) => boolean, seen: SeenIds, priorTexts: ReadonlySet<string>,
): { messages: Array<{ messageId: string; text: string; timestamp: string | null }>; mark: AgentTimelineMark; replayed: number } {
  // No mark but messages already recorded: the agent predates the marks, so its timeline may be a replay too (fail closed).
  const replay = (mark === undefined && priorTexts.size > 0) || (mark?.epoch != null && epoch != null && epoch !== mark.epoch);
  let lastTs = mark?.lastTs ?? null;
  let replayed = 0;
  const messages: Array<{ messageId: string; text: string; timestamp: string | null }> = [];
  for (const { item: it, timestamp } of entries) {
    if (it.type !== "user_message" || typeof it.text !== "string" || ENVELOPE.test(it.text) || PLUGIN_TEXT.test(it.text)) continue;
    const ids = [it.messageId, it.clientMessageId].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (!ids.length || ids.some(isPluginId)) continue;
    const id = ids[0]!;
    if (seen.has(id)) continue;
    const ts = typeof timestamp === "string" ? timestamp : null;
    const old = ts !== null && mark?.lastTs != null && ts <= mark.lastTs; // ISO 8601 strings compare in time order
    if (old || (replay && priorTexts.has(it.text))) { seen.add(id); replayed += 1; continue; }
    seen.add(id);
    messages.push({ messageId: id, text: it.text, timestamp: ts });
    if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
  }
  return { messages, mark: { epoch: epoch ?? mark?.epoch ?? null, lastTs }, replayed };
}
