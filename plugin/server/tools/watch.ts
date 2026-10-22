import { z } from "zod";
import { appendAs, requireFeature, type Ctx } from "../context";
import type { ToolDef } from "../mcp/server";
import { openItems, summarizeItem } from "../watch";
import { defineTool, ToolError } from "./define";

export function watchTools(ctx: Ctx): ToolDef[] {
  return [
    defineTool({
      name: "slp_watch_result", description: "Record your verdict on every agent of a watch pack: ok, watch (look again next time) or intervene.",
      roles: ctx.config.flags.watch ? ["supervisor"] : [],
      input: z.object({ tick: z.number().int().positive(), verdicts: z.array(z.object({ agent: z.string().min(1), verdict: z.enum(["ok", "watch", "intervene"]), note: z.string().optional() })) }),
      run(who, a) {
        const feature = requireFeature(who, undefined);
        const sent = ctx.stores.feature(who.project, feature).all().some((e) => e.kind === "ops" && e.data.type === "watch_sent" && Number(e.data.tick) === a.tick);
        if (!sent) throw new ToolError(`no watch pack #${a.tick} was sent for ${feature}`);
        const open = openItems(ctx.stores.feature(who.project, feature).all());
        const bare = a.verdicts.filter((v) => v.verdict === "ok" && open.has(v.agent) && !v.note?.trim()).map((v) => v.agent);
        if (bare.length) throw new ToolError(`${bare.join(", ")} had an open item; closing it needs a note saying what resolved it (the repaired report and the Lead's decision, not an acknowledgment)`);
        appendAs(ctx, who, feature, { kind: "watch_result", data: { tick: a.tick, verdicts: a.verdicts } });
        const flagged = a.verdicts.filter((v) => v.verdict === "intervene").map((v) => v.agent);
        return flagged.length ? `Recorded #${a.tick}. You flagged ${flagged.join(", ")}: steer the Lead now (slp_send { to: "lead", mode: "steer" }).` : `Recorded #${a.tick}.`;
      },
    }),
    defineTool({
      name: "slp_activity", description: 'Read the recent timeline of an agent in your feature, summarized: "lead" (Supervisor only), a task id for its Peer-impl, or "review <task id>" for its reviewer.',
      roles: ["supervisor", "lead"],
      input: z.object({ agent: z.string().min(1), n: z.number().int().min(1).max(50).default(20) }),
      async run(who, a) {
        const feature = requireFeature(who, undefined);
        const review = a.agent.match(/^review (T\d+[a-z]?)$/);
        const target = a.agent === "lead" ? (who.role === "supervisor" ? ctx.identities.current("lead", who.project, feature) : null)
          : ctx.identities.current(review ? "peer-review" : "peer-impl", who.project, feature, review ? review[1]! : a.agent);
        if (!target?.agentId) throw new ToolError(`no agent "${a.agent}" you may read in feature ${feature}`);
        const page = await ctx.paseo().agents.ref(target.agentId).timeline.refetch({ direction: "tail", limit: a.n }).catch(() => ({ entries: [] }));
        const lines = (page.entries ?? []).map((e) => summarizeItem(e.item ?? e)).filter((s): s is string => s !== null);
        return lines.length ? lines.map((l) => `- ${l}`).join("\n") : "No recent activity.";
      },
    }),
  ];
}
