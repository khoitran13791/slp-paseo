import type { PluginServerContext } from "@getpaseo/plugin/server";
import { onAgentArchived, onAgentClosed, onPermissionRequested, onPermissionResolved, onTurnEnded, onTurnStarted } from "./server/hooks";
import { createRuntime } from "./server/runtime";
import { WAKE } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const rt = createRuntime();
  const guard = (label: string, fn: () => Promise<void> | void) => Promise.resolve().then(fn).catch((e) => console.error(`[slp] ${label} failed`, e));
  // handle() returns no cleanup, so it stays out of offs; the plugin session ends its RPCs on stop.
  server.handle(WAKE, async (_input, { paseo }) => { await rt.wake(paseo); return { ok: true }; });
  const offs = [
    server.before("agent.create", async ({ request }, { paseo }) => { await rt.capture(paseo); return (await rt.transformCreate(request as never)) as never; }),
    server.before("agent.session_open", async ({ request }, { paseo }) => { await rt.capture(paseo); return (await rt.openSession(request as never)) as never; }),
    server.on("agent.turn_started", async ({ agent }, { paseo }) => { await rt.capture(paseo); void guard("turn_started", () => onTurnStarted(rt.ctx, agent.id)); }),
    // turn_ended may run verify for up to verifyTimeoutSeconds: return at once; onTurnEnded serializes per agent.
    server.on("agent.turn_ended", async (ev, { paseo }) => { await rt.capture(paseo); void guard("turn_ended", () => onTurnEnded(rt.ctx, ev)); }),
    server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => { await rt.capture(paseo); await guard("permission", () => onPermissionRequested(rt.ctx, agent.id, request as never)); }),
    server.on("agent.permission_resolved", async ({ agent }, { paseo }) => { await rt.capture(paseo); onPermissionResolved(rt.ctx, agent.id); }),
    server.on("agent.archived", async ({ agent }, { paseo }) => { await rt.capture(paseo); onAgentArchived(rt.ctx, agent.id); }),
    server.on("agent.closed", async ({ agent }, { paseo }) => { await rt.capture(paseo); onAgentClosed(rt.ctx, agent.id); }),
  ];
  return async () => { for (const off of offs) off(); await rt.close(); };
}
