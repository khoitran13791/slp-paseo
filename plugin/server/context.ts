import { assertCanWrite } from "./authority";
import type { SlpConfig } from "./config";
import { extractHumanMessages, type SeenIds, type TimelineItemLike } from "./human";
import type { Identity, IdentityRegistry } from "./identity";
import { contractQueues, holderOf } from "./planCheck";
import { edgeAllowed, steerAllowed, type Address, type Router, type SendMode } from "./router";
import type { RoleSetup } from "./roles";
import type { RunFn } from "./sandbox";
import { deriveFeature } from "./store/derive";
import { renderDigest } from "./store/digest";
import type { NewEvent, SlpEvent } from "./store/events";
import type { StoreRegistry } from "./store/registry";
import { ToolError } from "./tools/define";
import { matchTouch } from "./touch";
import type { NudgeTracker, ResumeQueue } from "./watchdog";

export interface AgentRefLike {
  refresh(): Promise<unknown>;
  readonly status: string | null;
  readonly lastUsage: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null;
  timeline: { refetch(o: { direction: "tail"; limit: number }): Promise<{ entries?: Array<{ item?: unknown }> }> };
  send(text: string, o?: { messageId?: string; activeTurnBehavior?: "steer" | "interrupt" }): Promise<void>;
  respondToPermission(o: { requestId: string; response: { behavior: "allow" | "deny"; message?: string } }): Promise<void>;
  archive(): Promise<unknown>;
}
export interface CreateOptions { config: Record<string, unknown>; parent?: string; title?: string; env?: Record<string, string>; prompt?: string; clientMessageId?: string }
export interface PaseoLike {
  agents: {
    ref(id: string): AgentRefLike;
    create(o: CreateOptions & { cwd: string }): Promise<{ id: string; workspaceId?: string | null }>;
  };
  workspaces: {
    ref(id: string): { agents: { create(o: CreateOptions): Promise<{ id: string; workspaceId?: string | null }> }; archive(): Promise<unknown> };
    /** SDK workspaces.create with source "directory": Paseo runs no setup for it (T18). */
    create(o: { source: { kind: "directory"; path: string }; title?: string }): Promise<{ id: string; agents: { create(o: CreateOptions): Promise<{ id: string; workspaceId?: string | null }> } }>;
  };
  providers: { listUsage(): Promise<unknown> };
  config: { get(): Promise<{ config: unknown }> };
}

export interface Ctx {
  config: SlpConfig;
  setup(): RoleSetup;
  identities: IdentityRegistry;
  stores: StoreRegistry;
  router: Router;
  seen: SeenIds;
  resumes: ResumeQueue;
  nudges: NudgeTracker;
  paseo(): PaseoLike;
  run: RunFn;
  now(): Date;
  toolCalls: Map<string, number>;
  turnStarts: Map<string, number>;
  flags: { checkpointAsked: Set<string>; challengeNudged: Set<string> };
  /** ~/.slp and ~/.paseo: no agent tool may touch them (T14). */
  stateDirs: string[];
  /** Where SLP creates its own worktrees: outside ~/.paseo/worktrees, so Paseo treats them as plain directories (T9). */
  worktreeRoot: string;
  /** Permission requests left to the human, by agent (T20 records them; the watch pack, T19, shows them). */
  pendingPermissions: Map<string, { name: string; since: number }>;
  log(message: string, error?: unknown): void;
}

export const leadAddress = (project: string, feature: string): Address => ({ role: "lead", project, feature });
export const supervisorAddress = (project: string, feature: string): Address => ({ role: "supervisor", project, feature });

export function refreshDigest(ctx: Ctx, project: string, feature: string): string {
  const events = ctx.stores.feature(project, feature).all();
  const text = renderDigest(deriveFeature(feature, events), events.filter((e) => e.kind === "ops"), ctx.now());
  ctx.stores.writeDigest(project, feature, text);
  return text;
}

export function appendAs(ctx: Ctx, ident: Identity, feature: string, e: Omit<NewEvent, "feature" | "by_role" | "by_agent">): SlpEvent {
  assertCanWrite(ident.role, e.kind);
  const ev = ctx.stores.feature(ident.project, feature).append({ ...e, feature, by_role: ident.role, by_agent: ident.agentId }, ctx.now());
  refreshDigest(ctx, ident.project, feature);
  return ev;
}

export function appendPlugin(ctx: Ctx, project: string, feature: string | null, e: Omit<NewEvent, "feature" | "by_role" | "by_agent">): SlpEvent {
  const store = feature ? ctx.stores.feature(project, feature) : ctx.stores.project(project);
  const ev = store.append({ ...e, feature, by_role: "plugin", by_agent: null }, ctx.now());
  if (feature) refreshDigest(ctx, project, feature);
  return ev;
}

export function routeFrom(ctx: Ctx, from: Identity, to: Address, text: string, mode: SendMode = "queue"): void {
  if (!edgeAllowed(from, to)) throw new ToolError(`role ${from.role} cannot message ${to.role}${to.feature ? ` of ${to.feature}` : ""}`);
  if (mode !== "queue" && !steerAllowed(from, to)) throw new ToolError(`role ${from.role} cannot ${mode} ${to.role}`);
  ctx.router.enqueue(to, `[SLP from ${from.role}${from.task ? ` ${from.task}` : ""} · ${from.feature ?? from.project}] ${text}`, { mode });
  void ctx.router.flush().catch((e) => ctx.log("router flush failed", e));
}

export function notify(ctx: Ctx, to: Address, text: string): void {
  ctx.router.enqueue(to, `[SLP plugin] ${text}`);
  void ctx.router.flush().catch((e) => ctx.log("router flush failed", e));
}

/** Contracts that a feature other than `feature` holds, with their holder. */
/** For every other running feature: the features its unfinished tasks wait on. */
export function waitsOfOthers(ctx: Ctx, project: string, feature: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const slug of ctx.stores.features(project)) {
    if (slug === feature) continue;
    const events = ctx.stores.feature(project, slug).all();
    const st = deriveFeature(slug, events);
    if (st.halted || events.some((e) => e.kind === "shipped")) continue;
    out.set(slug, [...new Set([...st.tasks.values()].filter((t) => t.status !== "accepted" && t.status !== "dropped").flatMap((t) => t.waitsOn ?? []))]);
  }
  return out;
}

export function heldByOthers(ctx: Ctx, project: string, feature: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [contract, queue] of contractQueues(ctx.stores.project(project).all())) if (queue[0] && queue[0] !== feature) out.set(contract, queue[0]);
  return out;
}

function releaseOne(ctx: Ctx, project: string, feature: string, contract: string): void {
  const before = holderOf(contractQueues(ctx.stores.project(project).all()), contract);
  appendPlugin(ctx, project, null, { kind: "contract_release", data: { contract, feature } });
  const after = holderOf(contractQueues(ctx.stores.project(project).all()), contract);
  if (after && after !== before) {
    notify(ctx, leadAddress(project, after), `${contract} is now held by your feature (${feature} released it). Tasks waiting on it can start.`);
    notify(ctx, supervisorAddress(project, after), `${contract} is now held by ${after}; ${feature} released it.`);
  }
}

/** At plan approval: queue the feature for every contract its plan touches, and leave the ones it no longer touches. */
export function claimContracts(ctx: Ctx, project: string, feature: string, contracts: string[]): void {
  const queues = contractQueues(ctx.stores.project(project).all());
  for (const [contract, queue] of queues) if (queue.includes(feature) && !contracts.includes(contract)) releaseOne(ctx, project, feature, contract);
  for (const contract of contracts) if (!(queues.get(contract) ?? []).includes(feature)) appendPlugin(ctx, project, null, { kind: "contract_claim", data: { contract, feature } });
}

/** A feature shipped or stopped: it leaves every contract queue, and the next feature in line is told. */
export function releaseContracts(ctx: Ctx, project: string, feature: string): void {
  for (const [contract, queue] of contractQueues(ctx.stores.project(project).all())) if (queue.includes(feature)) releaseOne(ctx, project, feature, contract);
}

/** Other running features whose unfinished tasks list any of `files` in their touch sets. */
export function featuresTouching(ctx: Ctx, project: string, feature: string, files: string[]): Array<{ slug: string; files: string[] }> {
  const out: Array<{ slug: string; files: string[] }> = [];
  for (const slug of ctx.stores.features(project)) {
    if (slug === feature) continue;
    const events = ctx.stores.feature(project, slug).all();
    const st = deriveFeature(slug, events);
    if (st.halted || events.some((e) => e.kind === "shipped")) continue;
    const touch = [...st.tasks.values()].filter((t) => t.status !== "accepted" && t.status !== "dropped").flatMap((t) => t.touchSet);
    const hits = files.filter((f) => touch.some((entry) => matchTouch(entry, f)));
    if (hits.length) out.push({ slug, files: hits });
  }
  return out;
}

/** The human's messages to a Supervisor stay in the project store, also after it gets a feature. */
const humanStoreFeature = (ident: Identity): string | null => (ident.role === "supervisor" ? null : ident.feature);

/** Records the human's new prompts to this agent. Safe to call concurrently: seen ids are checked and added synchronously. */
export async function syncHumanMessages(ctx: Ctx, ident: Identity): Promise<void> {
  if (!ident.agentId) return;
  const page = await ctx.paseo().agents.ref(ident.agentId).timeline.refetch({ direction: "tail", limit: 30 });
  const items = (page.entries ?? []).map((e) => (e.item ?? e) as TimelineItemLike);
  for (const m of extractHumanMessages(items, (id) => ctx.router.isPluginMessageId(id), ctx.seen)) {
    appendPlugin(ctx, ident.project, humanStoreFeature(ident), { kind: "human_message", data: { agentId: ident.agentId, text: m.text, messageId: m.messageId, role: ident.role } });
    if (ident.role === "peer-impl" || ident.role === "peer-review") {
      notify(ctx, leadAddress(ident.project, ident.feature!), `The human messaged Peer ${ident.task} directly: "${m.text.slice(0, 500)}". Decide whether it changes direction and record it (slp_rule or slp_challenge).`);
    }
  }
}

export function humanMessagesFor(ctx: Ctx, ident: Identity): readonly SlpEvent[] {
  const feature = humanStoreFeature(ident);
  const store = feature ? ctx.stores.feature(ident.project, feature) : ctx.stores.project(ident.project);
  return store.all().filter((e) => e.kind === "human_message" && e.data.agentId === ident.agentId);
}

/** Every role works inside one feature; a Supervisor has none until its first brief. */
export function requireFeature(ident: Identity, feature: string | undefined): string {
  if (!ident.feature) throw new ToolError("you have no feature yet: write the brief first (slp_brief)");
  if (feature && feature !== ident.feature) throw new ToolError(`you belong to feature ${ident.feature}`);
  return ident.feature;
}
