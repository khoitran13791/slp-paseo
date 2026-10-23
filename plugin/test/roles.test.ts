import { describe, expect, it } from "vitest";
import { missingProfileError, normalizeModel, providerString, resolveRoleSetup, roleOfProvider } from "../server/roles";

const off = { enabled: false };
const providers = {
  "slp-supervisor": { extends: "claude", paseoTools: off }, "slp-lead": { extends: "claude", paseoTools: off },
  "slp-peer-impl": { extends: "claude", paseoTools: off }, "slp-peer-review": { extends: "codex", paseoTools: off },
};

describe("roles", () => {
  it("maps provider ids, with or without a model suffix", () => {
    expect(roleOfProvider("slp-lead")).toBe("lead");
    expect(roleOfProvider("slp-peer-impl/claude-sonnet-5")).toBe("peer-impl");
    expect(roleOfProvider("claude")).toBeNull();
  });
  // Shape of `paseo.config.get().config` (MutableDaemonConfig): the file's `agents.providers`
  // is exposed as top-level `providers`, and `agentProfiles` is top-level too
  // (paseo 0.12 daemon-config-store.ts:210, protocol messages.ts:174-210).
  it("reads vendors and profiles from the daemon config", () => {
    const s = resolveRoleSetup({ providers, agentProfiles: [{ id: "p", name: "Lead", provider: "slp-lead", model: "claude-opus-5-5", thinkingOptionId: "high" }] }, { crossVendorReview: true });
    expect(s.vendor).toEqual({ supervisor: "claude", lead: "claude", "peer-impl": "claude", "peer-review": "codex" });
    expect(s.profile.lead).toEqual({ model: "claude-opus-5-5", thinkingOptionId: "high", featureValues: undefined });
    expect(s.profile.supervisor).toBeUndefined();
  });
  it("does not read the file-shaped agents.providers key", () => {
    expect(() => resolveRoleSetup({ agents: { providers } }, { crossVendorReview: true })).toThrow(/slp-supervisor/);
  });
  it("rejects a reviewer on the same vendor as the implementer", () => {
    expect(() => resolveRoleSetup({ providers: { ...providers, "slp-peer-review": { extends: "claude", paseoTools: off } } }, { crossVendorReview: true })).toThrow(/different vendor/);
    expect(() => resolveRoleSetup({ providers: { ...providers, "slp-peer-review": { extends: "claude", paseoTools: off } } }, { crossVendorReview: false })).not.toThrow();
  });
  it("rejects a missing provider", () => {
    expect(() => resolveRoleSetup({ providers: { "slp-lead": { extends: "claude" } } }, { crossVendorReview: true })).toThrow(/slp-supervisor/);
  });
  it("refuses a role provider that still exposes Paseo tools (T21 B-3)", () => {
    expect(() => resolveRoleSetup({ providers: { ...providers, "slp-lead": { extends: "claude", paseoTools: { disabledTools: ["create_agent"] } } } }, { crossVendorReview: true }))
      .toThrow(/slp-lead must set paseoTools.enabled to false/);
    expect(() => resolveRoleSetup({ providers: { ...providers, "slp-supervisor": { extends: "claude" } } }, { crossVendorReview: true }))
      .toThrow(/slp-supervisor must set paseoTools.enabled to false/);
  });
  it("names the missing profile instead of sending a provider without a model", () => {
    expect(missingProfileError("lead")).toMatch(/no agent profile for slp-lead/);
  });
  it("builds provider strings and normalizes models", () => {
    expect(providerString("lead", "claude-opus-5-5")).toBe("slp-lead/claude-opus-5-5");
    expect(providerString("lead", undefined)).toBe("slp-lead");
    expect(normalizeModel("claude/claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});
