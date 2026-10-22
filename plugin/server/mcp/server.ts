import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Identity } from "../identity";
import type { Role } from "../roles";

export interface ToolResult { text: string; isError?: boolean }
export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; roles: readonly Role[]; handler(caller: Identity, args: unknown): Promise<ToolResult> }
interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

export async function startMcpServer(opts: {
  port: number; resolve(token: string): Identity | null; tools(): readonly ToolDef[]; onCall?(caller: Identity, tool: string): void;
}): Promise<{ url: string; port: number; close(): Promise<void> }> {
  async function rpc(m: RpcMessage, caller: Identity): Promise<unknown> {
    if (m.id === undefined || m.id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        return ok({ protocolVersion: (m.params?.protocolVersion as string | undefined) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slp", version: "0.1.0" } });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: opts.tools().filter((t) => t.roles.includes(caller.role)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const tool = opts.tools().find((t) => t.name === name);
        if (!tool || !tool.roles.includes(caller.role)) return ok({ content: [{ type: "text", text: `Tool ${name} is not available to role ${caller.role}.` }], isError: true });
        opts.onCall?.(caller, name);
        try {
          const r = await tool.handler(caller, m.params?.arguments ?? {});
          return ok({ content: [{ type: "text", text: r.text }], isError: r.isError === true });
        } catch (error) {
          return ok({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.url ?? "").split("?")[0] !== "/mcp") { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const auth = req.headers.authorization ?? "";
    const caller = auth.startsWith("Bearer ") ? opts.resolve(auth.slice(7)) : null;
    if (!caller) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown or retired SLP token" } }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const replies = (await Promise.all(batch.map((m) => rpc(m as RpcMessage, caller)))).filter((r) => r !== null);
    if (replies.length === 0) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  }

  const server = createServer((req, res) => { void handle(req, res).catch(() => res.writeHead(500).end()); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port, "127.0.0.1", () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())) };
}
