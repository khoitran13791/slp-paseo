import { readJson, writeJson } from "./jsonFile";

export interface TimelineItemLike { type?: string; text?: string; messageId?: string | null; clientMessageId?: string | null; name?: string }

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

const ENVELOPE = /^<paseo-system[\s>]/;

export function extractHumanMessages(items: readonly TimelineItemLike[], isPluginId: (id: string) => boolean, seen: SeenIds): Array<{ messageId: string; text: string }> {
  const out: Array<{ messageId: string; text: string }> = [];
  for (const it of items) {
    if (it.type !== "user_message" || typeof it.text !== "string" || ENVELOPE.test(it.text)) continue;
    const ids = [it.messageId, it.clientMessageId].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (!ids.length || ids.some(isPluginId)) continue;
    const id = ids[0]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ messageId: id, text: it.text });
  }
  return out;
}
