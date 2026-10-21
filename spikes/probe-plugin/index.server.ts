// THROWAWAY spike plugin for SLP-on-Paseo (docs/research/spikes-2026-10-21.md).
// Logs lifecycle hooks, serves a tiny MCP endpoint with per-agent tokens, and
// exercises before-hooks. Not production code.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startProbe } from "./server/probe";

export default function contribute(server: PluginServerContext) {
  return startProbe(server);
}
