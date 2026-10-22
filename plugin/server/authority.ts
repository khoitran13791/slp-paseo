import type { Actor, EventKind } from "./store/events";

const WRITERS: Record<EventKind, readonly Actor[]> = {
  brief: ["supervisor"],
  premise: ["supervisor", "lead"],
  human_decision: ["supervisor", "lead"],
  supersede: ["supervisor", "lead"],
  spec: ["lead"],
  plan: ["lead"],
  plan_approved: ["supervisor", "plugin"],
  assign: ["supervisor", "lead"],
  release: ["lead"],
  report: ["peer-impl"],
  commit: ["plugin"],
  merge: ["plugin"],
  evidence: ["plugin"],
  review: ["peer-review"],
  challenge: ["peer-impl", "peer-review", "lead", "supervisor"],
  challenge_resolved: ["lead", "supervisor"],
  ask: ["peer-impl", "peer-review", "lead"],
  answer: ["lead", "supervisor"],
  ruling: ["lead"],
  confirms: ["lead"],
  human_message: ["plugin"],
  ops: ["plugin"],
  ship_package: ["supervisor"],
  shipped: ["plugin"],
  checkpoint: ["supervisor", "lead"],
  feature_record: ["supervisor"],
  watch_result: ["supervisor"],
  contract_claim: ["plugin"],
  contract_release: ["plugin"],
};

export class AuthorityError extends Error {}

export function canWrite(actor: Actor, kind: EventKind): boolean {
  return WRITERS[kind].includes(actor);
}

export function assertCanWrite(actor: Actor, kind: EventKind): void {
  if (!canWrite(actor, kind)) throw new AuthorityError(`role ${actor} may not write ${kind}`);
}
