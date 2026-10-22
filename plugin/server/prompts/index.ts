import type { Identity } from "../identity";
import type { TaskState } from "../store/derive";
import { leadPrompt } from "./lead";
import { peerImplPrompt } from "./peerImpl";
import { peerReviewPrompt } from "./peerReview";
import { supervisorPrompt } from "./supervisor";

export { leadKickoff } from "./lead";
export { taskBrief } from "./peerImpl";
export { reviewBrief } from "./peerReview";

export function promptFor(ident: Identity, info: { task?: TaskState | null }): string {
  switch (ident.role) {
    case "supervisor": return supervisorPrompt(ident.project, ident.feature);
    case "lead": return leadPrompt(ident.feature ?? "?");
    case "peer-impl": return peerImplPrompt(ident.feature ?? "?", ident.task ?? "?", ident.worktree ?? "?", info.task?.verify ?? "(see task brief)");
    case "peer-review": return peerReviewPrompt(ident.feature ?? "?", ident.task ?? "?", ident.reviewCommit ?? "?");
  }
}
