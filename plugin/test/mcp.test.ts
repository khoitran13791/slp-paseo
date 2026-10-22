import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Identity } from "../server/identity";
import { startMcpServer } from "../server/mcp/server";
import { defineTool, ToolError } from "../server/tools/define";

const ident = (role: Identity["role"], token: string): Identity =>
  ({ tokenHash: token, role, project: "p", feature: "f", task: null, worktree: null, workspaceId: null, branch: null, reviewCommit: null, agentId: `${role}-1`, parentAgentId: null, createdAt: "", retiredAt: null });
const ids = new Map([["tok-peer", ident("peer-impl", "tok-peer")], ["tok-lead", ident("lead", "tok-lead")]]);
const calls: string[] = [];
const tools = [
  defineTool({ name: "slp_echo", description: "echo", roles: ["peer-impl", "lead"], input: z.object({ text: z.string() }), run: (c, a) => `${c.role}:${a.text}` }),
  defineTool({ name: "slp_lead_only", description: "lead", roles: ["lead"], input: z.object({}), run: () => "ok" }),
  defineTool({ name: "slp_store", description: "store", roles: ["lead"], input: z.object({ text: z.string() }), run: (_c, a) => a.text }),
  defineTool({ name: "slp_refuse", description: "refuse", roles: ["peer-impl"], input: z.object({}), run: () => { throw new ToolError("not now"); } }),
];
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function server() {
  const s = await startMcpServer({ port: 0, resolve: (t) => ids.get(t) ?? null, tools: () => tools, onCall: (c, t) => calls.push(`${c.role}:${t}`) });
  close = s.close;
  return (token: string | null, body: unknown) => fetch(s.url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

describe("MCP server", () => {
  it("rejects unknown tokens with 401", async () => {
    const post = await server();
    expect((await post("bad", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await post(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });
  it("lists only the caller's tools, answers initialize, and accepts notifications", async () => {
    const post = await server();
    const init: any = await (await post("tok-peer", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(init.result.serverInfo.name).toBe("slp");
    const list: any = await (await post("tok-peer", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["slp_echo", "slp_refuse"]);
    expect(list.result.tools[0].inputSchema.properties.text.type).toBe("string");
    expect((await post("tok-peer", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
  it("calls tools, refuses tools outside the role, validates args, and reports handler errors", async () => {
    const post = await server();
    const call = async (token: string, name: string, args: unknown) => ((await (await post(token, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } })).json()) as any).result;
    expect(await call("tok-peer", "slp_echo", { text: "hi" })).toEqual({ content: [{ type: "text", text: "peer-impl:hi" }], isError: false });
    expect(await call("tok-peer", "slp_lead_only", {})).toMatchObject({ isError: true, content: [{ text: "Tool slp_lead_only is not available to role peer-impl." }] });
    expect((await call("tok-peer", "slp_echo", { text: 3 })).isError).toBe(true);
    expect(await call("tok-peer", "slp_refuse", {})).toMatchObject({ isError: true, content: [{ text: "not now" }] });
    expect(calls).toContain("peer-impl:slp_echo");
  });
  it("answers batches", async () => {
    const post = await server();
    const res = await (await post("tok-lead", [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }])).json();
    expect(res).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });
  it("decodes a body that spans several chunks without corrupting multibyte characters", async () => {
    const post = await server();
    const big = "ế".repeat(300_000);
    const res: any = await (await post("tok-lead", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slp_store", arguments: { text: big } } })).json();
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text === big).toBe(true);
  });
  it("advertises a schema whose defaulted fields are not required", () => {
    const t = defineTool({ name: "slp_defaults", description: "d", roles: ["lead"], input: z.object({ text: z.string(), n: z.number().default(3) }), run: () => "ok" });
    expect(t.inputSchema.required).toEqual(["text"]);
  });
});
