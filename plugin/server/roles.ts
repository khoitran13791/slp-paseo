export const ROLES = ["supervisor", "lead", "peer-impl", "peer-review"] as const;
export type Role = (typeof ROLES)[number];
export type Vendor = "claude" | "codex";

export const ROLE_PROVIDER: Record<Role, string> = {
  supervisor: "slp-supervisor",
  lead: "slp-lead",
  "peer-impl": "slp-peer-impl",
  "peer-review": "slp-peer-review",
};

export function roleOfProvider(provider: string): Role | null {
  const id = provider.split("/")[0];
  return ROLES.find((r) => ROLE_PROVIDER[r] === id) ?? null;
}

export interface RoleProfile { model?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> }
export interface RoleSetup { vendor: Record<Role, Vendor>; profile: Partial<Record<Role, RoleProfile>> }

interface ProfileLike { provider?: string; model?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> }
/** `paseo.config.get().config`: providers and agentProfiles are top-level (not `agents.providers`). */
interface DaemonConfigLike {
  providers?: Record<string, { extends?: string } | undefined>;
  agentProfiles?: ProfileLike[];
}

export function resolveRoleSetup(raw: unknown, opts: { crossVendorReview: boolean }): RoleSetup {
  const cfg = (raw ?? {}) as DaemonConfigLike;
  const vendor = {} as Record<Role, Vendor>;
  for (const role of ROLES) {
    const base = cfg.providers?.[ROLE_PROVIDER[role]]?.extends;
    if (base !== "claude" && base !== "codex") {
      throw new Error(`SLP: provider ${ROLE_PROVIDER[role]} must exist in ~/.paseo/config.json and extend "claude" or "codex" (found ${base ?? "nothing"})`);
    }
    vendor[role] = base;
  }
  if (opts.crossVendorReview && vendor["peer-review"] === vendor["peer-impl"]) {
    throw new Error("SLP: slp-peer-review must use a different vendor than slp-peer-impl");
  }
  const profiles = cfg.agentProfiles ?? [];
  const profile: Partial<Record<Role, RoleProfile>> = {};
  for (const role of ROLES) {
    const p = profiles.find((x) => x.provider === ROLE_PROVIDER[role]);
    if (p) profile[role] = { model: p.model, thinkingOptionId: p.thinkingOptionId, featureValues: p.featureValues };
  }
  return { vendor, profile };
}

export function normalizeModel(model: string): string {
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

export function providerString(role: Role, model: string | undefined): string {
  return model ? `${ROLE_PROVIDER[role]}/${normalizeModel(model)}` : ROLE_PROVIDER[role];
}
