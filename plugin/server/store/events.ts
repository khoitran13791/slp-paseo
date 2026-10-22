import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import type { Role } from "../roles";

export const EVENT_KINDS = [
  "brief", "premise", "human_decision", "supersede", "spec", "plan", "plan_approved",
  "assign", "release", "report", "commit", "merge", "evidence", "review",
  "challenge", "challenge_resolved", "ask", "answer", "ruling", "confirms",
  "human_message", "ops", "ship_package", "shipped", "checkpoint", "feature_record",
  "watch_result", "contract_claim", "contract_release",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type Actor = Role | "plugin";
export type IdPrefix = "D" | "H" | "R" | "C" | "Q";

export interface SlpEvent {
  seq: number;
  ts: string;
  feature: string | null;
  kind: EventKind;
  id: string | null;
  by_role: Actor;
  by_agent: string | null;
  refs: string[];
  supersedes: string | null;
  data: Record<string, unknown>;
}

export interface NewEvent {
  feature: string | null;
  kind: EventKind;
  by_role: Actor;
  by_agent: string | null;
  refs?: string[];
  supersedes?: string | null;
  data?: Record<string, unknown>;
  idPrefix?: IdPrefix;
}

export class EventStore {
  private readonly events: SlpEvent[];
  /** The incomplete last line dropped at load (the plugin died mid-append), or null. */
  readonly truncatedTail: string | null;

  constructor(readonly file: string) {
    const loaded = existsSync(file) ? load(file) : { events: [], truncatedTail: null };
    this.events = loaded.events;
    this.truncatedTail = loaded.truncatedTail;
  }

  all(): readonly SlpEvent[] {
    return this.events;
  }

  append(e: NewEvent, now: Date = new Date()): SlpEvent {
    if (!(EVENT_KINDS as readonly string[]).includes(e.kind)) throw new Error(`unknown event kind ${e.kind}`);
    const event: SlpEvent = {
      seq: (this.events.at(-1)?.seq ?? 0) + 1,
      ts: now.toISOString(),
      feature: e.feature,
      kind: e.kind,
      id: e.idPrefix ? this.nextId(e.idPrefix) : null,
      by_role: e.by_role,
      by_agent: e.by_agent,
      refs: e.refs ?? [],
      supersedes: e.supersedes ?? null,
      data: e.data ?? {},
    };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(event) + "\n", { mode: 0o600 });
    this.events.push(event);
    return event;
  }

  nextId(prefix: IdPrefix): string {
    let max = 0;
    for (const ev of this.events) {
      const m = ev.id?.match(/^([A-Z])(\d+)$/);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    }
    return `${prefix}${max + 1}`;
  }
}

/** Every line append() writes ends with "\n"; a last line without one was cut off mid-write. */
function load(file: string): { events: SlpEvent[]; truncatedTail: string | null } {
  const buf = readFileSync(file);
  const end = buf.lastIndexOf(0x0a) + 1;
  const tail = buf.subarray(end).toString("utf8");
  const cut = tail.trim() !== "";
  if (cut) truncateSync(file, end);
  return { events: parseLines(file, buf.subarray(0, end).toString("utf8")), truncatedTail: cut ? tail : null };
}

function parseLines(file: string, text: string): SlpEvent[] {
  return text.split("\n").flatMap((line, i) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as SlpEvent];
    } catch {
      throw new Error(`corrupt event log ${file} at line ${i + 1}`);
    }
  });
}
