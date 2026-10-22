import { z } from "zod";
import type { Identity } from "../identity";
import type { ToolDef } from "../mcp/server";
import type { Role } from "../roles";

export class ToolError extends Error {}

export function defineTool<S extends z.ZodType>(def: {
  name: string; description: string; roles: readonly Role[]; input: S;
  run(caller: Identity, args: z.infer<S>): Promise<string> | string;
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    roles: def.roles,
    inputSchema: z.toJSONSchema(def.input) as Record<string, unknown>,
    async handler(caller, raw) {
      const parsed = def.input.safeParse(raw ?? {});
      if (!parsed.success) return { text: `Invalid arguments: ${z.prettifyError(parsed.error)}`, isError: true };
      return { text: await def.run(caller, parsed.data) };
    },
  };
}
