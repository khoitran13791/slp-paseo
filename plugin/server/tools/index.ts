import type { Ctx } from "../context";
import type { ToolDef } from "../mcp/server";
import { decisionTools } from "./decisions";
import { workTools } from "./work";

export function buildTools(ctx: Ctx): ToolDef[] {
  return [...decisionTools(ctx), ...workTools(ctx)];
}
