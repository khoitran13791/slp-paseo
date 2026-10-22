import { describe, expect, it } from "vitest";
import { assertCanWrite, canWrite } from "../server/authority";

describe("authority matrix (spec §5.2)", () => {
  it.each([
    ["supervisor", "brief"], ["supervisor", "premise"], ["lead", "premise"], ["supervisor", "human_decision"], ["lead", "human_decision"],
    ["lead", "spec"], ["lead", "plan"], ["supervisor", "plan_approved"], ["plugin", "plan_approved"], ["lead", "release"],
    ["peer-impl", "report"], ["plugin", "commit"], ["plugin", "merge"], ["plugin", "evidence"], ["peer-review", "review"],
    ["peer-impl", "challenge"], ["peer-review", "challenge"], ["lead", "challenge"], ["supervisor", "challenge"],
    ["lead", "challenge_resolved"], ["supervisor", "challenge_resolved"], ["peer-impl", "ask"], ["lead", "ask"],
    ["lead", "answer"], ["supervisor", "answer"], ["lead", "ruling"], ["lead", "confirms"], ["plugin", "human_message"],
    ["plugin", "ops"], ["supervisor", "ship_package"], ["plugin", "shipped"], ["lead", "checkpoint"], ["supervisor", "feature_record"],
    ["supervisor", "watch_result"], ["plugin", "contract_claim"], ["plugin", "contract_release"],
  ] as const)("%s may write %s", (actor, kind) => expect(canWrite(actor, kind)).toBe(true));

  it.each([
    ["peer-impl", "premise"], ["peer-impl", "ruling"], ["peer-impl", "human_decision"], ["peer-impl", "plan"], ["peer-impl", "commit"],
    ["peer-review", "report"], ["supervisor", "report"], ["supervisor", "commit"], ["lead", "review"], ["lead", "brief"],
    ["lead", "ship_package"], ["supervisor", "spec"], ["lead", "evidence"], ["peer-impl", "release"], ["lead", "human_message"],
    ["lead", "watch_result"], ["supervisor", "contract_claim"], ["lead", "contract_release"],
  ] as const)("%s may NOT write %s", (actor, kind) => {
    expect(canWrite(actor, kind)).toBe(false);
    expect(() => assertCanWrite(actor, kind)).toThrow(`role ${actor} may not write ${kind}`);
  });
});
