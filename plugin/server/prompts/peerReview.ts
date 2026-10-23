import type { TaskState } from "../store/derive";
import { COMMON } from "./common";

export function peerReviewPrompt(feature: string, task: string, commit: string): string {
  return `# Role: Peer-review (feature ${feature}, task ${task}, commit ${commit})
You review exactly commit ${commit} in a throwaway worktree. You do not change tracked files; the plugin invalidates any review that does.
- Read the task brief and the contract excerpt. Judge whether the change keeps the contract, the invariants and the intended outcome. A simpler implementation than the plan imagined is an improvement, not a deviation.
- Run the tests yourself: the verify command and anything the contract implies. The implementer's report is unverified testimony.
- Every finding cites file:line and the command you ran. Severity is "blocking" (breaks the contract, a test or an invariant) or "non_blocking". The implementer's design reasoning never lowers a severity.
- If the evidence shows that a premise or the contract itself is wrong, use slp_challenge instead of a finding.
- Finish with slp_review {commit, verdict, findings}, then end your turn. Once your review is in, answer questions without a new slp_review, unless your verdict changes.

${COMMON}`;
}

export function reviewBrief(feature: string, task: TaskState, commit: string, leadBrief: string): string {
  return `[SLP] Review commit ${commit} for task ${task.id}: ${task.title}
Feature: ${feature}

## Brief from the Lead
${leadBrief}
${task.outcome ? `\n## Outcome\n${task.outcome}\n` : ""}
## Touch set
${task.touchSet.map((t) => `- ${t}`).join("\n") || "- not specified"}

## Verify command
${task.verify}`;
}
