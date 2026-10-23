import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpDir(prefix = "slp-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}
export function initRepo(): string {
  const dir = tmpDir("slp-repo-");
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.name", "SLP Test"]);
  sh(dir, "git", ["config", "user.email", "slp@test.local"]);
  writeFileSync(join(dir, "README.md"), "# t\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "init"]);
  return dir;
}
/** Test-only runner: runs the command inside {worktree} WITHOUT any sandbox. */
export const FAKE_RUNNER = ["sh", "-c", 'cd "$0" && exec "$@"', "{worktree}"];

import { join as pjoin } from "node:path";
import { bindSession, transformCreate, type CreateRequest } from "../server/agentConfig";
import { parseSlpConfig, type SlpConfig } from "../server/config";
import type { AgentRefLike, CreateOptions, Ctx, PaseoLike } from "../server/context";
import { trustRepo } from "../server/git";
import { SeenIds, TimelineMarks } from "../server/human";
import { IdentityRegistry, type Identity, type IdentityMeta } from "../server/identity";
import { Router } from "../server/router";
import type { RoleSetup } from "../server/roles";
import { runSandboxed } from "../server/sandbox";
import { StoreRegistry } from "../server/store/registry";
import { NudgeTracker, ResumeQueue } from "../server/watchdog";

/**
 * Mimics the parts of Paseo 0.12 the plugin relies on:
 * - `workspaces.create({ source: { kind: "directory" } })` makes a workspace for an existing directory, and its agents run there;
 * - a child with `parent` and no workspace runs in the parent's cwd (create-agent/intent.ts resolvePlacement);
 * - `beforeCreate` plays the `before agent.create` hook, `onSessionOpen` plays `before agent.session_open`.
 */
export class FakePaseo implements PaseoLike {
  sent: Array<{ agentId: string; text: string; messageId?: string; behavior?: string }> = [];
  /** Agents the daemon no longer knows: refresh() resolves to null. */
  gone = new Set<string>();
  failSend = new Set<string>();
  /** Fail the next N workspaces.create / workspace agents.create calls. */
  failWorkspaceCreate = 0;
  failWorkspaceAgentCreate = 0;
  created: Array<Record<string, unknown> & { id: string; cwd: string; workspaceId: string }> = [];
  responses: Array<{ agentId: string; requestId: string; behavior: string; message?: string }> = [];
  archived: string[] = [];
  archivedWorkspaces: string[] = [];
  createdWorkspaces: Array<{ id: string; source: { kind: string; path: string; projectId?: string }; title?: string; background?: boolean }> = [];
  projectsList: Array<{ projectId: string; projectRootPath: string }> = [];
  projects = { list: async () => ({ projects: this.projectsList }) };
  openedWorkspaces: string[] = [];
  openFails = false;
  beforeCreate: ((req: CreateRequest) => CreateRequest) | null = null;
  onSessionOpen: ((agentId: string, env: Record<string, string>) => void) | null = null;
  private cwdOfAgent = new Map<string, string>();
  private cwdOfWorkspace = new Map<string, string>();
  statuses = new Map<string, string>();
  timelines = new Map<string, unknown[]>();
  epochs = new Map<string, string>();
  usageOf = new Map<string, { contextWindowUsedTokens: number; contextWindowMaxTokens: number }>();
  usage: unknown = [];
  daemonConfig: unknown = {};
  agents = {
    ref: (id: string): AgentRefLike => {
      const self = this;
      return {
        refresh: async () => (self.gone.has(id) ? null : {}),
        get status() { return self.statuses.get(id) ?? "idle"; },
        get lastUsage() { return self.usageOf.get(id) ?? null; },
        timeline: { refetch: async () => ({ epoch: self.epochs.get(id) ?? "e1", entries: (self.timelines.get(id) ?? []).map((item) => ({ item, timestamp: (item as { timestamp?: string }).timestamp })) }) },
        send: async (text, o) => { if (self.failSend.has(id)) throw new Error("send failed"); self.sent.push({ agentId: id, text, messageId: o?.messageId, behavior: o?.activeTurnBehavior }); },
        respondToPermission: async (o) => { self.responses.push({ agentId: id, requestId: o.requestId, behavior: o.response.behavior, message: o.response.message }); },
        archive: async () => { self.archived.push(id); return {}; },
      };
    },
    create: async (o: CreateOptions & { cwd: string }) => this.register(o, o.parent ? this.cwdOfAgent.get(o.parent) ?? o.cwd : o.cwd, null),
  };
  workspaces = {
    ref: (wsId: string) => ({
      agents: { create: async (o: CreateOptions) => { if (this.failWorkspaceAgentCreate > 0) { this.failWorkspaceAgentCreate--; throw new Error("agent create failed"); } return this.register(o, this.cwdOfWorkspace.get(wsId)!, wsId); } },
      archive: async () => { this.archivedWorkspaces.push(wsId); return {}; },
    }),
    create: async (o: { source: { kind: "directory"; path: string; projectId?: string }; title?: string; background?: boolean }) => {
      if (this.failWorkspaceCreate > 0) { this.failWorkspaceCreate--; throw new Error("workspace create failed"); }
      const id = `ws-dir-${this.createdWorkspaces.length + 1}`;
      this.createdWorkspaces.push({ id, ...o });
      this.cwdOfWorkspace.set(id, o.source.path);
      return { id, agents: { create: async (a: CreateOptions) => this.register(a, o.source.path, id) } };
    },
    open: async (cwd: string) => {
      if (this.openFails) throw new Error("open failed");
      this.openedWorkspaces.push(cwd);
      return { id: `ws-open-${this.openedWorkspaces.length}`, projectId: "prj-opened" };
    },
  };
  providers = { listUsage: async () => this.usage };
  config = { get: async () => ({ config: this.daemonConfig }) };

  private register(o: CreateOptions, cwd: string, workspaceId: string | null): { id: string; workspaceId: string } {
    const id = `agent-${this.created.length + 1}`;
    const req: CreateRequest = { config: { ...o.config, provider: String(o.config.provider), cwd }, env: o.env };
    const out = this.beforeCreate ? this.beforeCreate(req) : req;
    const ws = workspaceId ?? `ws-${id}`;
    this.cwdOfAgent.set(id, cwd); this.cwdOfWorkspace.set(ws, cwd);
    this.created.push({ ...o, cwd, env: out.env, finalConfig: out.config, id, workspaceId: ws });
    this.onSessionOpen?.(id, out.env ?? {});
    return { id, workspaceId: ws };
  }
}

export const TEST_SETUP: RoleSetup = {
  vendor: { supervisor: "claude", lead: "claude", "peer-impl": "claude", "peer-review": "codex" },
  profile: { supervisor: { model: "claude-opus-5-5" }, lead: { model: "claude-opus-5-5" }, "peer-impl": { model: "claude-sonnet-5" }, "peer-review": { model: "gpt-6-astra" } },
};

export function makeCtx(over: Record<string, unknown> = {}): { ctx: Ctx; paseo: FakePaseo; repo: string; home: string; config: SlpConfig } {
  const repo = initRepo(); trustRepo(repo);
  const home = tmpDir("slp-home-");
  const config = parseSlpConfig({ projects: { demo: { repo, baseBranch: "main", verify: ["true"] } }, sandbox: { runner: FAKE_RUNNER }, ...over });
  const paseo = new FakePaseo();
  paseo.projectsList = [{ projectId: "prj-demo", projectRootPath: repo }];
  const identities = new IdentityRegistry(pjoin(home, "identities.json"));
  const router = new Router({ file: pjoin(home, "router.json"), now: () => new Date(), resolve: (to) => identities.current(to.role, to.project, to.feature, to.task ?? null)?.agentId ?? null, status: async (a) => paseo.agents.ref(a).status, send: (a, t, m, b) => paseo.agents.ref(a).send(t, { messageId: m, ...(b ? { activeTurnBehavior: b } : {}) }) });
  const ctx: Ctx = {
    config, setup: () => TEST_SETUP, refreshSetup: async () => TEST_SETUP, identities, stores: new StoreRegistry(home), router,
    seen: new SeenIds(pjoin(home, "seen.json")), marks: new TimelineMarks(pjoin(home, "timeline-marks.json")), resumes: new ResumeQueue(pjoin(home, "resume.json")), nudges: new NudgeTracker(pjoin(home, "nudges.json")),
    paseo: () => paseo, run: runSandboxed, now: () => new Date(), toolCalls: new Map(), turnStarts: new Map(), flags: { checkpointAsked: new Set(), challengeNudged: new Set() }, stateDirs: [home], worktreeRoot: tmpDir("slp-wts-"),
    pendingPermissions: new Map(), log: () => undefined,
  };
  paseo.beforeCreate = (req) => transformCreate(req, { identities, config, setup: () => TEST_SETUP, mcpUrl: () => "http://127.0.0.1:1/mcp", promptFor: (i) => `PROMPT ${i.role}`, toolNames: () => [], stateDirs: [], claudePluginDir: null, codexHome: () => pjoin(home, "codex-home") });
  paseo.onSessionOpen = (agentId, env) => bindSession({ agentId, env }, identities);
  return { ctx, paseo, repo, home, config };
}

export function bound(ctx: Ctx, meta: IdentityMeta & { worktree?: string | null }, agentId: string): Identity {
  const id = ctx.identities.mint(meta);
  if (meta.worktree) ctx.identities.place(id.tokenHash, { worktree: meta.worktree, workspaceId: null, branch: null });
  return ctx.identities.bind(id.token, agentId);
}

/** A prompt the human types to an agent; it shows up in that agent's timeline. */
export function humanSays(paseo: FakePaseo, agentId: string): (text: string) => Promise<void> {
  return async (text) => {
    await new Promise((r) => setTimeout(r, 5)); // the human answers after the item under approval
    paseo.timelines.set(agentId, [...(paseo.timelines.get(agentId) ?? []), { type: "user_message", text, messageId: `h-${agentId}-${Date.now()}-${Math.random()}` }]);
  };
}
