import { z } from "zod";
import { appendAs, claimContracts, heldByOthers, humanMessagesFor, leadAddress, notify, refreshDigest, releaseContracts, requireFeature, routeFrom, supervisorAddress, syncHumanMessages, waitsOfOthers, type Ctx } from "../context";
import type { Identity } from "../identity";
import type { ToolDef } from "../mcp/server";
import { checkPlan, contractsOf } from "../planCheck";
import { findHumanQuote, messageUsed } from "../quote";
import type { Address } from "../router";
import type { Role } from "../roles";
import { deriveFeature, type PlanTask } from "../store/derive";
import { defineTool, ToolError } from "./define";

const haltedMessage = (feature: string): string => `feature ${feature} is halted: the human changed the goal; start a new feature`;
const SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const Premise = z.object({ kind: z.enum(["decision", "hypothesis"]), title: z.string().min(1), verify_by: z.string().min(1).optional() });
const Task = z.object({ id: z.string().regex(/^T\d+[a-z]?$/), title: z.string().min(1), outcome: z.string().min(1).optional(), dependsOn: z.array(z.string()).default([]), verifies: z.array(z.string()).default([]), touchSet: z.array(z.string()).default([]), verify: z.string(), model: z.string().optional(), waitsOn: z.array(SLUG).default([]) });

function addPremises(ctx: Ctx, who: Identity, feature: string, premises: z.infer<typeof Premise>[], spec?: string): string[] {
  for (const p of premises) if (p.kind === "hypothesis" && !p.verify_by) throw new ToolError(`hypothesis "${p.title}" needs verify_by: a measurement that can fail`);
  return premises.map((p) => appendAs(ctx, who, feature, { kind: "premise", idPrefix: p.kind === "decision" ? "D" : "H", data: { ...p, spec } }).id!);
}

function otherFeatures(ctx: Ctx, project: string, feature: string) {
  return ctx.stores.features(project).filter((f) => f !== feature).map((slug) => ({ slug, touchSet: [...deriveFeature(slug, ctx.stores.feature(project, slug).all()).tasks.values()].filter((t) => t.status !== "accepted" && t.status !== "dropped").flatMap((t) => t.touchSet) }));
}

/** Who answers an item raised by `role`: resolving and answering go down the tree, never up. */
const parentRoleOf = (role: Role): Role | null => (role === "peer-impl" || role === "peer-review" ? "lead" : role === "lead" ? "supervisor" : null);

function parentAddress(ident: Identity): Address | null {
  if (ident.role === "peer-impl" || ident.role === "peer-review") return leadAddress(ident.project, ident.feature!);
  if (ident.role === "lead") return supervisorAddress(ident.project, ident.feature!);
  return null;
}

export function decisionTools(ctx: Ctx): ToolDef[] {
  const markCall = (who: Identity) => { if (who.agentId) ctx.toolCalls.set(who.agentId, Date.now()); };
  return [
    defineTool({
      name: "slp_state", description: "Read your feature's digest (and optionally a document). A Supervisor may also read another feature (feature) or every feature (all: true), read-only.",
      roles: ["supervisor", "lead", "peer-impl", "peer-review"],
      input: z.object({ feature: SLUG.optional(), doc: z.enum(["brief", "spec", "plan"]).optional(), all: z.boolean().optional() }),
      run(who, a) {
        if (who.role === "supervisor" && (a.all || (!who.feature && !a.feature))) {
          const features = ctx.stores.features(who.project);
          return features.length ? features.map((f) => refreshDigest(ctx, who.project, f)).join("\n") : "No features yet.";
        }
        const feature = who.role === "supervisor" && a.feature ? a.feature : requireFeature(who, a.feature);
        if (feature !== who.feature && !ctx.stores.features(who.project).includes(feature)) throw new ToolError(`unknown feature ${feature}`);
        const digest = refreshDigest(ctx, who.project, feature);
        if (!a.doc) return digest;
        const doc = deriveFeature(feature, ctx.stores.feature(who.project, feature).all())[a.doc];
        return doc ? `${digest}\n---\n${ctx.stores.readDoc(doc.path)}` : `${digest}\n---\nNo ${a.doc} yet.`;
      },
    }),
    defineTool({
      name: "slp_brief", description: "Save a new brief version with its premises D#/H#. Your first brief names a new feature slug and binds you to that feature.",
      roles: ["supervisor"],
      input: z.object({ feature: SLUG.optional(), title: z.string().min(1), markdown: z.string().min(1), premises: z.array(Premise).default([]) }),
      async run(who, a) {
        await syncHumanMessages(ctx, who); // a reply the human already sent belongs before this version
        for (const p of a.premises) if (p.kind === "hypothesis" && !p.verify_by) throw new ToolError(`hypothesis "${p.title}" needs verify_by: a measurement that can fail`);
        if (who.feature && a.feature && a.feature !== who.feature) throw new ToolError(`you belong to feature ${who.feature}; another idea needs its own Supervisor`);
        const feature = who.feature ?? a.feature;
        if (!feature) throw new ToolError("name the feature: a new slug for this idea");
        if (!who.feature) {
          if (ctx.stores.features(who.project).includes(feature)) throw new ToolError(`feature ${feature} already exists; pick a new slug`);
          ctx.identities.setFeature(who.tokenHash, feature);
          who.feature = feature;
        }
        const doc = ctx.stores.writeDoc(who.project, feature, "brief", a.markdown);
        appendAs(ctx, who, feature, { kind: "brief", data: { ...doc, title: a.title } });
        const ids = addPremises(ctx, who, feature, a.premises);
        return `Saved brief v${doc.version} (${doc.sha256.slice(0, 12)}) at ${doc.path}. Premises: ${ids.join(", ") || "none"}. Show it to the human and ask for approval.`;
      },
    }),
    defineTool({
      name: "slp_human_decision", description: "Record the human's decision, quoting their exact words. The plugin checks the quote against messages the human actually sent.",
      roles: ["supervisor", "lead"],
      input: z.object({ feature: SLUG.optional(), decides: z.enum(["approve_brief", "approve_spec", "supersede", "keep", "change_goal"]), target: z.string().optional(), quote: z.string(), replacement: Premise.optional(), reason: z.string().optional() }),
      async run(who, a) {
        await syncHumanMessages(ctx, who); // the approval usually arrives in the turn that calls this tool
        const feature = requireFeature(who, a.feature);
        const events = ctx.stores.feature(who.project, feature).all();
        const st = deriveFeature(feature, events);
        let after: string; let target = a.target ?? "";
        if (a.decides === "approve_brief" || a.decides === "approve_spec") {
          const doc = a.decides === "approve_brief" ? st.brief : st.spec;
          if (!doc) throw new ToolError(`no ${a.decides.slice(8)} to approve`);
          after = doc.ts; target = doc.sha256;
        } else {
          if (!target && a.decides !== "change_goal") throw new ToolError("target is required");
          const asked = [...events].reverse().find((e) => e.kind === "challenge" && (a.decides === "change_goal" || e.data.target === target));
          if (!asked) throw new ToolError(`no challenge about ${target || "the goal"} was raised; the human decides premises only on a raised question`);
          after = asked.ts;
        }
        const approval = a.decides === "approve_brief" || a.decides === "approve_spec";
        const q = findHumanQuote(humanMessagesFor(ctx, who), { agentId: who.agentId!, quote: a.quote, after, affirm: approval, extraWords: [feature] });
        if (!q.ok) throw new ToolError(`quote rejected: ${q.reason}`);
        if (messageUsed(events, q.messageId, a.decides, target)) throw new ToolError("quote rejected: that message already backs another decision; ask the human about this item separately");
        appendAs(ctx, who, feature, { kind: "human_decision", data: { decides: a.decides, target, quote: a.quote, reason: a.reason, messageSeq: q.seq, messageId: q.messageId } });
        // The human may decide in the Lead's tab; the Supervisor must not wait for a gate that is already passed (T21).
        if (who.role === "lead") notify(ctx, supervisorAddress(who.project, feature), `The human decided in the Lead's tab: ${a.decides}${target ? ` ${target.slice(0, 12)}` : ""} (quote: "${a.quote}"). It is recorded; do not ask them again.`);
        const resolve = (outcome: "accepted" | "rejected") => {
          for (const c of st.challenges.values()) if (c.open && (a.decides === "change_goal" || c.target === target)) appendAs(ctx, who, feature, { kind: "challenge_resolved", refs: [c.id], data: { outcome, reason: a.reason ?? a.quote } });
        };
        if (a.decides === "supersede") {
          if (!a.replacement) throw new ToolError("supersede needs a replacement premise");
          const old = st.premises.get(target);
          if (!old || old.status === "superseded") throw new ToolError(`${target} is not an active premise`);
          const [newId] = addPremises(ctx, who, feature, [a.replacement]);
          appendAs(ctx, who, feature, { kind: "supersede", supersedes: target, refs: [newId!], data: { quote: a.quote } });
          resolve("accepted");
          if (who.role === "supervisor") notify(ctx, leadAddress(who.project, feature), `Human decision: ${target} superseded by ${newId} (${a.replacement.title}). Update spec/plan; stale tasks must be redone.`);
          return `${target} superseded by ${newId}.`;
        }
        if (a.decides === "keep") { resolve("rejected"); if (who.role === "supervisor") notify(ctx, leadAddress(who.project, feature), `Human decision: keep ${target}. Reason: ${a.reason ?? a.quote}. Unpark dependent tasks.`); return `Kept ${target}.`; }
        if (a.decides === "change_goal") {
          resolve("rejected");
          // Halted: work tools refuse (T18) and Peer reports are no longer committed (T20), so the contracts are safe to hand on (review Codex 2026-10-22).
          for (const i of ctx.identities.active(who.project).filter((x) => x.feature === feature && (x.role === "peer-impl" || x.role === "peer-review"))) {
            ctx.router.enqueue({ role: i.role, project: who.project, feature, task: i.task }, "[SLP plugin] The human changed the goal; this feature is halted. Stop now and end your turn; do not report.", { mode: "interrupt" });
          }
          releaseContracts(ctx, who.project, feature);
          if (who.role === "supervisor") notify(ctx, leadAddress(who.project, feature), "Human decision: the goal changes. The feature is halted: Peers were told to stop, and spawn, accept, merge and ship are refused. Wait.");
          void ctx.router.flush().catch((e) => ctx.log("router flush failed", e));
          return "Feature halted; brainstorm the new goal with the human.";
        }
        if (a.decides === "approve_spec" && who.role === "supervisor") notify(ctx, leadAddress(who.project, feature), `The human approved spec v${st.spec!.version}. Write the plan (slp_plan).`);
        return `Recorded ${a.decides} for ${target.slice(0, 12)}.`;
      },
    }),
    defineTool({
      name: "slp_spec", description: "Save a new spec version (contracts only) with any new premises.",
      roles: ["lead"],
      input: z.object({ markdown: z.string().min(1), premises: z.array(Premise).default([]) }),
      run(who, a) {
        const feature = who.feature!;
        const before = deriveFeature(feature, ctx.stores.feature(who.project, feature).all());
        if (before.halted) throw new ToolError(haltedMessage(feature));
        const doc = ctx.stores.writeDoc(who.project, feature, "spec", a.markdown);
        const ids = addPremises(ctx, who, feature, a.premises, doc.sha256);
        const carried = [...before.premises.values()].filter((p) => p.status === "proposed" && new RegExp(`\\b${p.id}\\b`).test(a.markdown)).map((p) => p.id);
        appendAs(ctx, who, feature, { kind: "spec", data: { ...doc, premises: [...carried, ...ids] } });
        routeFrom(ctx, who, supervisorAddress(who.project, feature), `Spec v${doc.version} for ${feature} is ready at ${doc.path}${ids.length ? ` (new premises ${ids.join(", ")}, active once the human approves)` : ""}. Check it against the brief, then show it to the human.`);
        return `Saved spec v${doc.version}. Wait for the human's approval before planning.`;
      },
    }),
    defineTool({
      name: "slp_plan", description: "Save a new plan version: markdown plus structured tasks. Rejected if structural checks fail.",
      roles: ["lead"],
      input: z.object({ markdown: z.string().min(1), tasks: z.array(Task).min(1) }),
      run(who, a) {
        const feature = who.feature!;
        const st = deriveFeature(feature, ctx.stores.feature(who.project, feature).all());
        if (st.halted) throw new ToolError(haltedMessage(feature));
        if (!st.spec?.approved) throw new ToolError("the spec is not approved by the human yet");
        const tasks = a.tasks as PlanTask[];
        const issues = checkPlan(tasks, { premises: st.premises, others: otherFeatures(ctx, who.project, feature), modelsAllowed: ctx.config.models.allowed, heldBy: heldByOthers(ctx, who.project, feature), feature, waits: waitsOfOthers(ctx, who.project, feature) });
        const errors = issues.filter((i) => i.severity === "error");
        if (errors.length) throw new ToolError(`plan rejected:\n${errors.map((i) => `- ${i.code}: ${i.message}`).join("\n")}`);
        // The approved hash must cover what runs, not only the prose (review Codex 2026-10-22): the tasks go into the file.
        const doc = ctx.stores.writeDoc(who.project, feature, "plan", `${a.markdown.trimEnd()}\n\n## Tasks the plugin runs\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`\n`);
        appendAs(ctx, who, feature, { kind: "plan", data: { ...doc, tasks, issues } });
        const warnings = issues.map((i) => `- ${i.code}: ${i.message}`).join("\n");
        if (!ctx.config.flags.supervisorPlanApproval) {
          ctx.stores.feature(who.project, feature).append({ feature, kind: "plan_approved", by_role: "plugin", by_agent: null, data: { sha256: doc.sha256, auto: true } }, ctx.now());
          claimContracts(ctx, who.project, feature, contractsOf(tasks));
          refreshDigest(ctx, who.project, feature);
          return `Plan v${doc.version} saved and auto-approved.${warnings ? `\nWarnings:\n${warnings}` : ""}`;
        }
        routeFrom(ctx, who, supervisorAddress(who.project, feature), `Plan v${doc.version} for ${feature} (${doc.sha256}) is at ${doc.path}.${warnings ? `\nWarnings:\n${warnings}` : ""}\nApprove with slp_approve_plan or send it back.`);
        return `Plan v${doc.version} saved; waiting for the Supervisor.${warnings ? `\nWarnings:\n${warnings}` : ""}`;
      },
    }),
    defineTool({
      name: "slp_approve_plan", description: "Approve the latest plan of your feature by its sha256. The plugin then queues your feature for the shared contracts it touches.",
      roles: ["supervisor"],
      input: z.object({ feature: SLUG.optional(), sha256: z.string() }),
      run(who, a) {
        const feature = requireFeature(who, a.feature);
        const st = deriveFeature(feature, ctx.stores.feature(who.project, feature).all());
        if (st.halted) throw new ToolError(haltedMessage(feature));
        if (!st.plan || st.plan.sha256 !== a.sha256) throw new ToolError(`sha256 does not match the latest plan (${st.plan?.sha256 ?? "none"})`);
        const tasks = [...st.tasks.values()].map(({ id, title, dependsOn, verifies, touchSet, verify, model, waitsOn }) => ({ id, title, dependsOn, verifies, touchSet, verify, model, waitsOn }));
        const errors = checkPlan(tasks, { premises: st.premises, others: otherFeatures(ctx, who.project, feature), modelsAllowed: ctx.config.models.allowed, heldBy: heldByOthers(ctx, who.project, feature), feature, waits: waitsOfOthers(ctx, who.project, feature) }).filter((i) => i.severity === "error");
        if (errors.length) throw new ToolError(`plan no longer passes checks:\n${errors.map((i) => `- ${i.message}`).join("\n")}`);
        appendAs(ctx, who, feature, { kind: "plan_approved", data: { sha256: a.sha256 } });
        claimContracts(ctx, who.project, feature, contractsOf(tasks));
        routeFrom(ctx, who, leadAddress(who.project, feature), `Plan v${st.plan.version} approved. Start with the first task.`);
        return `Approved plan v${st.plan.version}.`;
      },
    }),
    defineTool({
      name: "slp_rule", description: "Record a plan-level ruling R# (and optionally drop tasks).",
      roles: ["lead"],
      input: z.object({ decision: z.string().min(1), reason: z.string().min(1), cost_if_wrong: z.string().min(1), drop: z.array(z.string()).default([]), about: z.string().optional() }),
      run(who, a) { return `Recorded ${appendAs(ctx, who, who.feature!, { kind: "ruling", idPrefix: "R", data: a }).id}.`; },
    }),
    defineTool({
      name: "slp_confirm", description: "Confirm an open hypothesis with evidence (a command and its result on a named commit).",
      roles: ["lead"],
      input: z.object({ hypothesis: z.string().regex(/^H\d+$/), evidence: z.string().min(10) }),
      run(who, a) {
        const p = deriveFeature(who.feature!, ctx.stores.feature(who.project, who.feature!).all()).premises.get(a.hypothesis);
        if (p?.kind !== "hypothesis" || p.status !== "open") throw new ToolError(`${a.hypothesis} is not an open hypothesis`);
        appendAs(ctx, who, who.feature!, { kind: "confirms", refs: [a.hypothesis], data: { evidence: a.evidence } });
        return `${a.hypothesis} confirmed.`;
      },
    }),
    defineTool({
      name: "slp_challenge", description: "Report, with evidence, that a premise, plan step or contract is wrong. Goes to your parent role.",
      roles: ["peer-impl", "peer-review", "lead", "supervisor"],
      input: z.object({ feature: SLUG.optional(), target: z.string().min(1), level: z.enum(["plan", "spec"]).optional(), claim: z.string().min(1), evidence: z.string().min(10), impact: z.string().min(1), smallest_correction: z.string().min(1), repro_command: z.string().optional() }),
      run(who, a) {
        const feature = requireFeature(who, a.feature);
        const target = a.target.trim().replace(/^contract:\s*/i, "contract:");
        // A premise (D#/H#) or a spec contract is the human's call (spec §6.4): the target sets the level, not the caller (review Codex 2026-10-22).
        const humanCall = /^[DH]\d+$/.test(target) || target.startsWith("contract:");
        const level = humanCall ? "spec" : who.role === "peer-impl" || who.role === "peer-review" ? (a.level ?? "plan") : (a.level ?? "spec");
        const ev = appendAs(ctx, who, feature, { kind: "challenge", idPrefix: "C", refs: [target], data: { ...a, target, level, task: who.task } });
        markCall(who);
        const to = parentAddress(who);
        const escalate = level === "spec" && to?.role === "lead" ? `\nOnly the human decides this. Escalate it to the Supervisor with slp_challenge {target: "${target}", level: "spec"}, adding your own assessment and evidence.` : "";
        if (to) routeFrom(ctx, who, to, `Challenge ${ev.id} on ${target} (${level}): ${a.claim}\nEvidence: ${a.evidence}\nImpact: ${a.impact}\nSmallest correction: ${a.smallest_correction}${escalate}`);
        return who.role === "supervisor" ? `Recorded ${ev.id}. Now ask the human, offering: supersede, keep (with a reason), or change the goal.` : `Recorded ${ev.id}. End your turn; your ${to?.role} decides.`;
      },
    }),
    defineTool({
      name: "slp_resolve", description: "Resolve a plan-level challenge raised by one of your subordinates.",
      roles: ["lead", "supervisor"],
      input: z.object({ feature: SLUG.optional(), challenge: z.string().regex(/^C\d+$/), outcome: z.enum(["accepted", "rejected"]), reason: z.string().min(1) }),
      run(who, a) {
        const feature = requireFeature(who, a.feature);
        const events = ctx.stores.feature(who.project, feature).all();
        const c = deriveFeature(feature, events).challenges.get(a.challenge);
        if (!c?.open) throw new ToolError(`${a.challenge} is not open`);
        if (c.level === "spec") throw new ToolError(`${a.challenge} is spec-level: only the human decides it (slp_human_decision)`);
        // Only the raiser's parent role resolves it, and that is checked before anything is written.
        const ev = events.find((e) => e.kind === "challenge" && e.id === a.challenge)!;
        const raiser = ctx.identities.byAgent(ev.by_agent ?? "");
        const to: Address = { role: (raiser?.role ?? ev.by_role) as Role, project: who.project, feature, task: raiser?.task ?? (typeof ev.data.task === "string" ? ev.data.task : null) };
        if (who.role !== parentRoleOf(to.role)) throw new ToolError(`${a.challenge} was raised by ${to.role}; only its parent role resolves it`);
        appendAs(ctx, who, feature, { kind: "challenge_resolved", refs: [a.challenge], data: { outcome: a.outcome, reason: a.reason } });
        if (raiser) routeFrom(ctx, who, to, `${a.challenge} ${a.outcome}: ${a.reason}`);
        return `${a.challenge} ${a.outcome}.`;
      },
    }),
    defineTool({
      name: "slp_ask", description: "Ask your parent role a question without stopping your work.",
      roles: ctx.config.flags.ask ? ["peer-impl", "peer-review", "lead"] : [],
      input: z.object({ question: z.string().min(1) }),
      run(who, a) {
        const ev = appendAs(ctx, who, who.feature!, { kind: "ask", idPrefix: "Q", data: { question: a.question, task: who.task } });
        markCall(who);
        routeFrom(ctx, who, parentAddress(who)!, `Question ${ev.id}: ${a.question}\nAnswer with slp_answer.`);
        return `Asked ${ev.id}. Keep working on what does not depend on the answer.`;
      },
    }),
    defineTool({
      name: "slp_answer", description: "Answer a question Q# from a subordinate.",
      roles: ["lead", "supervisor"],
      input: z.object({ feature: SLUG.optional(), question: z.string().regex(/^Q\d+$/), answer: z.string().min(1) }),
      run(who, a) {
        const feature = requireFeature(who, a.feature);
        const q = ctx.stores.feature(who.project, feature).all().find((e) => e.kind === "ask" && e.id === a.question);
        if (!q) throw new ToolError(`unknown question ${a.question}`);
        // Only the asker's parent role answers it, and that is checked before anything is written.
        const asker = ctx.identities.byAgent(q.by_agent ?? "");
        const to: Address = { role: (asker?.role ?? q.by_role) as Role, project: who.project, feature, task: asker?.task ?? (typeof q.data.task === "string" ? q.data.task : null) };
        if (who.role !== parentRoleOf(to.role)) throw new ToolError(`${a.question} was raised by ${to.role}; only its parent role answers it`);
        appendAs(ctx, who, feature, { kind: "answer", refs: [a.question], data: { answer: a.answer } });
        if (asker) routeFrom(ctx, who, to, `Answer to ${a.question}: ${a.answer}`);
        return `Answered ${a.question}.`;
      },
    }),
    defineTool({
      name: "slp_send", description: 'Send a message along an allowed edge: to "lead", "supervisor", or a task id (a Peer of your feature). mode "steer" adds it to the recipient\'s running turn, "interrupt" cancels that turn first; both only from a Supervisor to its Lead or from a Lead to its Peers.',
      roles: ["supervisor", "lead"],
      input: z.object({ to: z.string().min(1), feature: SLUG.optional(), text: z.string().min(1), mode: z.enum(["queue", "steer", "interrupt"]).default("queue") }),
      run(who, a) {
        const feature = requireFeature(who, a.feature);
        const to: Address = a.to === "lead" ? leadAddress(who.project, feature)
          : a.to === "supervisor" ? supervisorAddress(who.project, feature)
          : { role: "peer-impl", project: who.project, feature, task: a.to };
        routeFrom(ctx, who, to, a.text, a.mode);
        return a.mode === "queue" ? "Queued; delivered when the recipient is idle." : `Sent with ${a.mode}: it reaches the recipient now if it is running, otherwise when it is idle.`;
      },
    }),
  ];
}
