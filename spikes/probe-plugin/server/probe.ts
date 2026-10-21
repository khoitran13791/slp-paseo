// THROWAWAY spike code. Markers in the agent title select behaviour:
//   [probe-mcp]    inject the probe MCP server with a per-agent bearer token (S1)
//   [probe-s9]     Codex: add the repo's git common dir to writable_roots (S9)
//   [probe-parent] after its first turn, the plugin creates a child with `parent` (S8)
//   [probe-s4]     after its first turn, the plugin sends a tagged prompt (S4)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const LOG_DIR = "/tmp/slp-probe";
const LOG_FILE = `${LOG_DIR}/events.jsonl`;
const PORT = 47123;
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;

interface Binding {
  token: string;
  title: string | null;
  provider: string;
  agentId: string | null;
}

function log(kind: string, data: Record<string, unknown>): void {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n");
}

function short(text: unknown, max = 160): string {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? null);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function gitCommonDir(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function summarizeItem(item: any): Record<string, unknown> {
  if (item?.type === "user_message") {
    return {
      type: item.type,
      text: short(item.text, 120),
      messageId: item.messageId ?? null,
      clientMessageId: item.clientMessageId ?? null,
    };
  }
  if (item?.type === "tool_call") {
    return {
      type: item.type,
      name: item.name,
      sender: item.agentMessage?.sender ?? null,
      event: item.agentMessage?.event ?? null,
    };
  }
  if (item?.type === "assistant_message") return { type: item.type, text: short(item.text, 200) };
  return { type: item?.type ?? "unknown" };
}

export function startProbe(server: PluginServerContext) {
  const bindings = new Map<string, Binding>();
  const once = new Set<string>();
  const sentMessageIds = new Set<string>();

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split("?")[0] !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const binding = bindings.get(token) ?? null;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let messages: any;
      try {
        messages = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const batch = Array.isArray(messages) ? messages : [messages];
      const replies = batch.map((m: any) => handleRpc(m, binding, token)).filter((r) => r !== null);
      if (replies.length === 0) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.isArray(messages) ? replies : replies[0]));
    });
  });

  function handleRpc(m: any, binding: Binding | null, token: string): unknown {
    log("mcp.request", {
      method: m?.method,
      tokenKnown: binding !== null,
      tokenPrefix: token.slice(0, 8),
      boundAgentId: binding?.agentId ?? null,
    });
    if (m?.id === undefined || m?.id === null) return null; // notification
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        return ok({
          protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "slp-probe", version: "0.0.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: [
            {
              name: "slp_whoami",
              description: "SLP probe: returns the caller identity as seen by the plugin.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        });
      case "tools/call": {
        const identity = {
          tokenKnown: binding !== null,
          boundAgentId: binding?.agentId ?? null,
          title: binding?.title ?? null,
          provider: binding?.provider ?? null,
        };
        log("mcp.whoami", identity);
        return ok({ content: [{ type: "text", text: JSON.stringify(identity) }] });
      }
      default:
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
    }
  }

  http.on("error", (error) => log("http.error", { message: String(error) }));
  http.listen(PORT, "127.0.0.1", () => log("http.listening", { url: MCP_URL }));

  server.before("agent.create", ({ request }) => {
    const config = request.config;
    const title = config.title ?? "";
    log("before.agent.create", {
      provider: config.provider,
      model: config.model ?? null,
      modeId: config.modeId ?? null,
      title,
      cwd: config.cwd,
      hasProviderOptions: config.providerOptions !== undefined,
      mcpServerNames: Object.keys(config.mcpServers ?? {}),
    });
    let next = request;
    if (title.includes("[probe-mcp]")) {
      const token = randomUUID();
      bindings.set(token, { token, title, provider: String(config.provider), agentId: null });
      next = {
        ...next,
        config: {
          ...next.config,
          mcpServers: {
            ...next.config.mcpServers,
            slpprobe: { type: "http", url: MCP_URL, headers: { Authorization: `Bearer ${token}` } },
          },
        },
        env: { ...next.env, SLP_TOKEN: token },
      };
    }
    if (title.includes("[probe-s9]")) {
      const commonDir = gitCommonDir(config.cwd);
      log("s9.commonDir", { cwd: config.cwd, commonDir });
      if (commonDir) {
        next = {
          ...next,
          config: {
            ...next.config,
            providerOptions: {
              ...(next.config.providerOptions as Record<string, unknown> | undefined),
              sandbox_mode: "workspace-write",
              sandbox_workspace_write: { writable_roots: [commonDir], network_access: false },
            } as any,
          },
        };
      }
    }
    return next;
  });

  server.before("agent.session_open", ({ request }) => {
    const token = request.env?.SLP_TOKEN;
    const binding = token ? bindings.get(token) : undefined;
    if (binding && !binding.agentId) binding.agentId = request.agentId;
    log("before.session_open", {
      agentId: request.agentId,
      provider: request.provider,
      reason: request.reason,
      purpose: request.purpose,
      hasSlpToken: Boolean(token),
      bound: Boolean(binding),
    });
    return undefined;
  });

  server.on("agent.created", ({ agent }) => log("agent.created", { agent }));
  server.on("agent.closed", ({ agent }) => log("agent.closed", { agentId: agent.id }));
  server.on("agent.turn_started", ({ agent, turnId }) =>
    log("agent.turn_started", { agentId: agent.id, title: agent.title, turnId }),
  );

  server.on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
    const ref = paseo.agents.ref(agent.id);
    let items: Record<string, unknown>[] = [];
    try {
      const page: any = await ref.timeline.refetch({ direction: "tail", limit: 15 });
      items = (page?.entries ?? []).map((entry: any) => summarizeItem(entry.item ?? entry));
    } catch (error) {
      items = [{ error: String(error) }];
    }
    let usage: unknown = null;
    let status: unknown = null;
    try {
      await ref.refresh();
      usage = ref.lastUsage;
      status = ref.status;
    } catch (error) {
      usage = { error: String(error) };
    }
    log("agent.turn_ended", {
      agentId: agent.id,
      title: agent.title,
      provider: agent.provider,
      parentAgentId: agent.parentAgentId,
      outcome,
      status,
      usage,
      tail: items,
      pluginSentIds: [...sentMessageIds],
    });

    const title = agent.title ?? "";
    if (title.includes("[probe-parent]") && !once.has(`parent:${agent.id}`)) {
      once.add(`parent:${agent.id}`);
      try {
        const child = await paseo.agents.create({
          config: { provider: "claude/claude-haiku-4-5", modeId: "plan" },
          cwd: agent.cwd,
          parent: agent.id,
          title: "[probe-child] S8",
          prompt: "Reply with the single word: child",
        });
        log("s8.child_created", { parentId: agent.id, childId: child.id });
      } catch (error) {
        log("s8.child_error", { message: String(error) });
      }
    }
    if (title.includes("[probe-s4]") && !once.has(`s4:${agent.id}`)) {
      once.add(`s4:${agent.id}`);
      const messageId = `slp-probe-${randomUUID()}`;
      sentMessageIds.add(messageId);
      try {
        await ref.send("Reply with the single word: plugin", { messageId });
        log("s4.plugin_sent", { agentId: agent.id, messageId });
      } catch (error) {
        log("s4.send_error", { message: String(error) });
      }
    }
  });

  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    const r: any = request;
    const command: string | null = r?.input?.command ?? r?.detail?.command ?? null;
    log("agent.permission_requested", {
      agentId: agent.id,
      title: agent.title,
      provider: agent.provider,
      name: r?.name,
      kind: r?.kind,
      command,
      detailType: r?.detail?.type ?? null,
    });
    if (command && /(^|[\s/])paseo(\s|$)/.test(command)) {
      try {
        await paseo.agents.ref(agent.id).respondToPermission({
          requestId: r.id,
          response: { behavior: "deny", message: "SLP probe: the paseo CLI is blocked for agents." },
        });
        log("permission.denied_by_plugin", { agentId: agent.id, command });
      } catch (error) {
        log("permission.deny_error", { message: String(error) });
      }
    }
  });

  server.on("agent.permission_resolved", ({ agent, requestId, resolution }) =>
    log("agent.permission_resolved", { agentId: agent.id, requestId, resolution }),
  );

  return () =>
    new Promise<void>((resolve) => {
      http.close(() => resolve());
    });
}
