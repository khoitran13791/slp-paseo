import { randomUUID } from "node:crypto";
import type { Identity } from "./identity";
import { readJson, writeJson } from "./jsonFile";
import type { Role } from "./roles";

export interface Address { role: Role; project: string; feature: string | null; task?: string | null }
export type SendMode = "queue" | "steer" | "interrupt";
export interface Delivery { id: string; to: Address; text: string; messageId: string; enqueuedAt: string; attempts: number; lastError: string | null; mode?: SendMode; key?: string | null }
export interface RouterDeps {
  file: string;
  resolve(to: Address): string | null;
  status(agentId: string): Promise<string | null>;
  /** behavior: null when the recipient is idle; otherwise how to treat its running turn. */
  send(agentId: string, text: string, messageId: string, behavior: "steer" | "interrupt" | null): Promise<void>;
  now(): Date;
  /** The queue file could not be written; the queue stays in memory and the next save retries. */
  onError?(error: unknown): void;
}
interface RouterState { queue: Delivery[] }
const PLUGIN_ID_PREFIX = "slp-";

/** Every edge stays inside one feature: a Supervisor talks only to its own Lead (spec §7.3). */
export function edgeAllowed(from: Identity, to: Address): boolean {
  if (from.project !== to.project || from.feature === null || to.feature !== from.feature) return false;
  switch (from.role) {
    case "supervisor": return to.role === "lead";
    case "lead": return to.role === "supervisor" || to.role === "peer-impl" || to.role === "peer-review";
    case "peer-impl": case "peer-review": return to.role === "lead";
  }
}

/** Only a Supervisor to its Lead, and a Lead to its own Peers, may cut into a running turn. */
export function steerAllowed(from: Identity, to: Address): boolean {
  return edgeAllowed(from, to) && ((from.role === "supervisor" && to.role === "lead") || (from.role === "lead" && (to.role === "peer-impl" || to.role === "peer-review")));
}

export class Router {
  private state: RouterState;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RouterDeps) {
    this.state = readJson<RouterState>(deps.file, { queue: [] });
  }

  /** Message ids the plugin sends with. The app gives human prompts random UUIDs, so the prefix is enough. */
  issue(): string {
    return `${PLUGIN_ID_PREFIX}${randomUUID()}`;
  }

  /** A message with a key replaces an undelivered message with the same key (the watch pack, T19). */
  enqueue(to: Address, text: string, opts: { mode?: SendMode; key?: string } = {}): Delivery {
    if (opts.key) this.state.queue = this.state.queue.filter((d) => d.key !== opts.key);
    const d: Delivery = { id: randomUUID(), to, text, messageId: this.issue(), enqueuedAt: this.deps.now().toISOString(), attempts: 0, lastError: null, mode: opts.mode ?? "queue", key: opts.key ?? null };
    this.state.queue.push(d);
    this.save();
    return d;
  }

  isPluginMessageId(id: string | null | undefined): boolean {
    return !!id && id.startsWith(PLUGIN_ID_PREFIX);
  }

  pending(): readonly Delivery[] {
    return this.state.queue;
  }

  /** Flushes run one at a time; a second call waits for the first, so nothing is sent twice. */
  flush(): Promise<number> {
    const run = this.chain.then(() => this.flushOnce());
    this.chain = run.catch(() => 0);
    return run;
  }

  private async flushOnce(): Promise<number> {
    const groups = new Map<string, Delivery[]>();
    for (const d of this.state.queue) {
      const agentId = this.deps.resolve(d.to);
      if (!agentId) continue;
      groups.set(agentId, [...(groups.get(agentId) ?? []), d]);
    }
    let delivered = 0;
    for (const [agentId, items] of groups) {
      const status = await this.deps.status(agentId);
      const urgent = items.some((d) => d.mode === "interrupt") ? "interrupt" : items.some((d) => d.mode === "steer") ? "steer" : null;
      if (status !== "idle" && !(status === "running" && urgent)) continue;
      try {
        await this.deps.send(agentId, items.map((d) => d.text).join("\n\n---\n\n"), items[0]!.messageId, status === "running" ? urgent : null);
        const ids = new Set(items.map((d) => d.id));
        this.state.queue = this.state.queue.filter((d) => !ids.has(d.id));
        delivered += items.length;
      } catch (error) {
        for (const d of items) { d.attempts += 1; d.lastError = String(error); }
      }
      this.save();
    }
    return delivered;
  }

  private save(): void {
    try { writeJson(this.deps.file, this.state); } catch (error) { this.deps.onError?.(error); }
  }
}
