import type { Ctx } from "../context";
import type { ToolDef } from "../mcp/server";
import { decisionTools } from "./decisions";
import { watchTools } from "./watch";
import { workTools } from "./work";

export function buildTools(ctx: Ctx): ToolDef[] {
  return [...decisionTools(ctx), ...workTools(ctx), ...watchTools(ctx)];
}
