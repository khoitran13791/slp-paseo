import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Role } from "./roles";

export interface Identity {
  tokenHash: string; role: Role; project: string; feature: string | null; task: string | null;
  worktree: string | null; workspaceId: string | null; branch: string | null;
  reviewCommit: string | null; agentId: string | null; parentAgentId: string | null;
  createdAt: string; retiredAt: string | null;
}
export type IdentityMeta = Pick<Identity, "role" | "project" | "feature" | "task" | "reviewCommit" | "parentAgentId">;
export type Placement = Pick<Identity, "worktree" | "workspaceId" | "branch">;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class IdentityRegistry {
  private readonly items: Identity[];

  constructor(private readonly file: string) {
    this.items = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Identity[]) : [];
  }

  /** The raw token is returned once and never stored. */
  mint(meta: IdentityMeta, now = new Date()): Identity & { token: string } {
    const token = randomBytes(24).toString("hex");
    const id: Identity = { ...meta, tokenHash: hashToken(token), worktree: null, workspaceId: null, branch: null, agentId: null, createdAt: now.toISOString(), retiredAt: null };
    this.items.push(id);
    this.save();
    return { ...id, token };
  }

  bind(token: string, agentId: string): Identity {
    const id = this.byToken(token);
    if (!id) throw new Error("unknown SLP token");
    if (id.agentId && id.agentId !== agentId) throw new Error("SLP token already bound to another agent");
    if (!id.agentId) { id.agentId = agentId; this.save(); }
    return id;
  }

  byToken(token: string): Identity | null {
    const h = hashToken(token);
    return this.items.find((i) => i.tokenHash === h && !i.retiredAt) ?? null;
  }

  place(tokenHash: string, placement: Placement): void {
    const id = this.items.find((i) => i.tokenHash === tokenHash);
    if (!id) throw new Error("unknown SLP identity");
    Object.assign(id, placement);
    this.save();
  }

  /** A Supervisor gets its feature from its first brief; it never changes afterwards. */
  setFeature(tokenHash: string, feature: string): void {
    const id = this.items.find((i) => i.tokenHash === tokenHash);
    if (!id) throw new Error("unknown SLP identity");
    if (id.feature && id.feature !== feature) throw new Error(`SLP identity already belongs to feature ${id.feature}`);
    if (!id.feature) { id.feature = feature; this.save(); }
  }

  byAgent(agentId: string): Identity | null {
    return this.items.find((i) => i.agentId === agentId && !i.retiredAt) ?? null;
  }

  current(role: Role, project: string, feature: string | null, task: string | null = null): Identity | null {
    return [...this.items].reverse().find((i) => i.role === role && i.project === project && i.feature === feature && (task === null || i.task === task) && !i.retiredAt && i.agentId) ?? null;
  }

  /** The newest identity of a role in a feature (and task) that got a workspace, retired or not: a Lead or Peer that died restarts there. One whose create failed has none and is skipped. */
  last(role: Role, project: string, feature: string | null, task?: string): Identity | null {
    return [...this.items].reverse().find((i) => i.role === role && i.project === project && i.feature === feature && (task === undefined || i.task === task) && i.workspaceId) ?? null;
  }

  active(project: string): Identity[] {
    return this.items.filter((i) => i.project === project && !i.retiredAt);
  }

  retire(tokenHash: string, now = new Date()): void {
    const id = this.items.find((i) => i.tokenHash === tokenHash);
    if (id && !id.retiredAt) { id.retiredAt = now.toISOString(); this.save(); }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
