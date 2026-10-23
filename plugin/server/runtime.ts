import { homedir } from "node:os";
import { join } from "node:path";
import { bindSession, ensureCodexHome, findSuperpowersDir, transformCreate, type CreateRequest } from "./agentConfig";
import { loadSlpConfig, slpHome, type SlpConfig } from "./config";
import type { Ctx, PaseoLike } from "./context";
import { trustRepo, unsafeGitDrivers } from "./git";
import { reconcile, tick } from "./hooks";
import { SeenIds, TimelineMarks } from "./human";
import { IdentityRegistry } from "./identity";
import { startMcpServer } from "./mcp/server";
import { promptFor } from "./prompts";
import { resolveRoleSetup, roleOfProvider, type RoleSetup } from "./roles";
import { Router } from "./router";
import { runSandboxed, checkRunner } from "./sandbox";
import { deriveFeature } from "./store/derive";
import { StoreRegistry } from "./store/registry";
import { buildTools } from "./tools";
import { NudgeTracker, ResumeQueue } from "./watchdog";

export interface Runtime { ctx: Ctx; capture(paseo: unknown): Promise<void>; transformCreate(req: CreateRequest): Promise<CreateRequest>; bindSession(req: { agentId: string; env: Record<string, string> }): void; close(): Promise<void> }

export function createRuntime(): Runtime {
  const home = slpHome();
  const config: SlpConfig = loadSlpConfig();
  let paseo: PaseoLike | null = null;
  let setup: RoleSetup | null = null;
  let setupPromise: Promise<RoleSetup> | null = null;
  for (const [name, project] of Object.entries(config.projects)) {
    try {
      trustRepo(project.repo);
      const drivers = unsafeGitDrivers(project.repo);
      if (drivers.length) console.error(`[slp] project ${name}: git config runs commands a Peer could change (${drivers.join("; ")}); SLP will refuse to start agents here until they are removed.`);
    } catch (e) { console.error(`[slp] project ${name}: ${String(e)}`); }
  }
  const stateDirs = [home, process.env.PASEO_HOME ?? join(homedir(), ".paseo")]; // SLP worktrees live in ~/.slp-worktrees, outside both
  const claudePluginDir = config.runtime.claudePluginDir ?? findSuperpowersDir(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  if (!claudePluginDir) console.error("[slp] Superpowers not found in Claude Code's plugin cache; Claude roles start without it. Set runtime.claudePluginDir in ~/.slp/config.json.");
  const identities = new IdentityRegistry(join(home, "identities.json"));
  const router = new Router({
    file: join(home, "router.json"), now: () => new Date(),
    resolve: (to) => identities.current(to.role, to.project, to.feature, to.task ?? null)?.agentId ?? null,
    status: async (agentId) => { const ref = paseo!.agents.ref(agentId); await ref.refresh().catch(() => undefined); return ref.status; },
    // activeTurnBehavior: SDK SendMessageOptions (@getpaseo/client 0.12); omitted means the daemon would interrupt, so idle-only messages pass null.
    send: (agentId, text, messageId, behavior) => paseo!.agents.ref(agentId).send(text, { messageId, ...(behavior ? { activeTurnBehavior: behavior } : {}) }),
    onError: (e) => console.error("[slp] could not write router.json; keeping the queue in memory", e),
  });
  const ctx: Ctx = {
    config, identities, router, stores: new StoreRegistry(home), seen: new SeenIds(join(home, "seen.json"), (e) => console.error("[slp] could not write seen.json; keeping ids in memory", e)),
    resumes: new ResumeQueue(join(home, "resume.json")), nudges: new NudgeTracker(join(home, "nudges.json")),
    marks: new TimelineMarks(join(home, "timeline-marks.json"), (e) => console.error("[slp] could not write timeline-marks.json; keeping marks in memory", e)),
    setup: () => { if (!setup) throw new Error("SLP: role setup not loaded yet"); return setup; },
    paseo: () => { if (!paseo) throw new Error("SLP: no Paseo client captured yet"); return paseo; },
    run: runSandboxed, now: () => new Date(), toolCalls: new Map(), turnStarts: new Map(), flags: { checkpointAsked: new Set(), challengeNudged: new Set() }, stateDirs, worktreeRoot: process.env.SLP_WORKTREES ?? join(homedir(), ".slp-worktrees"),
    pendingPermissions: new Map(), log: (message, error) => console.error(`[slp] ${message}`, error ?? ""),
    refreshSetup,
  };
  const tools = buildTools(ctx);
  // No onCall: only the report tools mark ctx.toolCalls themselves (review m1).
  const mcp = startMcpServer({ port: config.mcp.port, resolve: (t) => identities.byToken(t), tools: () => tools });
  mcp.catch((e) => console.error(`[slp] MCP server failed to listen on ${config.mcp.port}`, e));
  const timer = setInterval(() => { if (paseo) void tick(ctx).catch((e) => console.error("[slp] tick failed", e)); }, 30_000); // tick is single-flight
  timer.unref();

  let reconciled = false;
  async function refreshSetup(): Promise<RoleSetup> {
    if (!paseo) throw new Error("SLP: no Paseo client captured yet");
    const r = await paseo.config.get();
    setup = resolveRoleSetup(r.config, { crossVendorReview: config.flags.crossVendorReview });
    // The setup at capture failed (profiles or providers made later, T21): the restart reconcile never ran, so run it now, once.
    if (!reconciled) { reconciled = true; void reconcile(ctx).catch((e) => console.error("[slp] reconcile failed", e)); }
    return setup;
  }

  // Never awaited by hooks: non-SLP agents must not wait for, or fail on, SLP's setup (review B4).
  async function capture(p: unknown): Promise<void> {
    if (paseo) return;
    paseo = p as PaseoLike;
    setupPromise = paseo.config.get().then((r) => (setup = resolveRoleSetup(r.config, { crossVendorReview: config.flags.crossVendorReview })));
    setupPromise.catch((e) => console.error("[slp] role setup failed; SLP agents cannot be created until ~/.paseo/config.json is fixed", e));
    void checkRunner(config.sandbox.runner, home).then((problem) => { if (problem) console.error(`[slp] ${problem}. Verification will fail closed until this is fixed.`); });
    void setupPromise.then(() => { if (!reconciled) { reconciled = true; return reconcile(ctx); } }).catch((e) => console.error("[slp] reconcile failed", e));
  }

  return {
    ctx, capture,
    async transformCreate(req) {
      if (!roleOfProvider(req.config.provider)) return req;
      // Not `await setupPromise`: once that promise rejected, a fixed config could never get through (review Codex 2026-10-23).
      await refreshSetup(); // throws the config error for an SLP agent, never for a non-SLP one
      return transformCreate(req, {
        identities, config, setup: () => ctx.setup(), mcpUrl: () => `http://127.0.0.1:${config.mcp.port}/mcp`,
        promptFor: (ident) => promptFor(ident, { task: ident.feature && ident.task ? deriveFeature(ident.feature, ctx.stores.feature(ident.project, ident.feature).all()).tasks.get(ident.task) ?? null : null }),
        toolNames: (role) => tools.filter((t) => t.roles.includes(role)).map((t) => t.name),
        stateDirs, claudePluginDir,
        codexHome: () => ensureCodexHome(join(home, "codex-home"), process.env.CODEX_HOME ?? join(homedir(), ".codex")),
      });
    },
    bindSession: (req) => bindSession(req, identities),
    async close() { clearInterval(timer); await (await mcp).close(); },
  };
}
