/**
 * LicenseService — the SINGLE source of truth for licensing. It merges all provider grants into one
 * {@link EffectiveLicense} and answers the only three questions anyone should ask:
 *   • hasSku(sku)            — is a driver SKU licensed?
 *   • hasFeature(feature)    — is a platform feature licensed?
 *   • canInstallDriver(req)  — may this driver be installed (SKU + feature + tier)?
 *
 * Drivers, the Driver Manager, the Installer Portal, the apps and the REST layer all go through here;
 * none of them embed licensing logic. Local-first: providers resolve offline; cloud is just one more
 * provider. Call refresh() to (re)load providers (on boot, on activation, periodically).
 */
import { issueLicense as _issue } from "@supreme/licensing";
import type { LicenseProvider } from "./providers.js";
import { type DriverRequirements, type EffectiveLicense, type LicenseStatus, type LicenseTier, type ProviderGrant, KNOWN_SKUS, TIER_RANK } from "./types.js";

// Precedence when choosing the "dominant" source/type for display (developer always wins).
const SOURCE_RANK: Record<string, number> = { developer: 100, testing: 80, oem: 60, offline: 40, cloud: 30 };

const COMMUNITY_DEFAULT: EffectiveLicense = {
  active: false,
  devMode: false,
  licenseType: "community",
  tier: "community",
  skus: new Set<string>(),
  features: new Set<string>(),
  expiresAt: null,
  source: "default",
  sources: [],
};

export class LicenseService {
  private effective: EffectiveLicense = COMMUNITY_DEFAULT;
  private readonly now: () => number;

  constructor(
    private providers: LicenseProvider[],
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** (Re)load every provider and recompute the effective license. Returns the new state. */
  async refresh(): Promise<EffectiveLicense> {
    const now = this.now();
    const loaded = await Promise.all(this.providers.map((p) => Promise.resolve(p.load(now)).catch(() => null)));
    const grants = (loaded.filter(Boolean) as ProviderGrant[]).filter((g) => !g.expiresAt || Date.parse(g.expiresAt) > now);
    this.effective = mergeGrants(grants);
    return this.effective;
  }

  /** Replace the provider set (e.g. after importing an offline license) and refresh. */
  async setProviders(providers: LicenseProvider[]): Promise<EffectiveLicense> {
    this.providers = providers;
    return this.refresh();
  }

  current(): EffectiveLicense {
    return this.effective;
  }

  get devMode(): boolean {
    return this.effective.devMode;
  }

  hasSku(sku: string): boolean {
    const s = this.effective.skus;
    return s === "all" || s.has(sku);
  }

  hasFeature(feature: string): boolean {
    const f = this.effective.features;
    return f === "all" || f.has(feature);
  }

  /** The licensed SKU set for the DriverManager; expands "all" into the known SKU list. */
  licensedSkuSet(): Set<string> {
    return this.effective.skus === "all" ? new Set(KNOWN_SKUS) : this.effective.skus;
  }

  /** Whether the current tier meets a minimum. */
  meetsTier(min: LicenseTier): boolean {
    return TIER_RANK[this.effective.tier] >= TIER_RANK[min];
  }

  /** May this driver be installed? Returns an explicit reason when not. */
  canInstallDriver(req: DriverRequirements): { allowed: boolean; reason?: string } {
    if (req.requiresSku && !this.hasSku(req.requiresSku)) {
      return { allowed: false, reason: `requires the '${req.requiresSku}' license` };
    }
    if (req.requiresFeature && !this.hasFeature(req.requiresFeature)) {
      return { allowed: false, reason: `requires the '${req.requiresFeature}' feature` };
    }
    if (req.minTier && !this.meetsTier(req.minTier)) {
      return { allowed: false, reason: `requires the '${req.minTier}' tier or higher` };
    }
    return { allowed: true };
  }

  /** Serializable status for the Licensing UI / REST. */
  status(): LicenseStatus {
    const e = this.effective;
    return {
      active: e.active,
      devMode: e.devMode,
      licenseType: e.licenseType,
      tier: e.tier,
      skus: e.skus === "all" ? "all" : [...e.skus].sort(),
      features: e.features === "all" ? "all" : [...e.features].sort(),
      expiresAt: e.expiresAt,
      source: e.source,
      sources: e.sources,
      licenseId: e.licenseId,
    };
  }
}

/** Merge active grants: "all" wins for skus/features; highest tier; earliest expiry; dominant source. */
export function mergeGrants(grants: ProviderGrant[]): EffectiveLicense {
  if (grants.length === 0) return COMMUNITY_DEFAULT;

  let skus: Set<string> | "all" = new Set<string>();
  let features: Set<string> | "all" = new Set<string>();
  let tierRank = 0;
  let tier: LicenseTier = "community";
  let devMode = false;
  let expiresAt: string | null = null;
  const sources: string[] = [];

  for (const g of grants) {
    sources.push(g.source);
    if (g.devMode) devMode = true;
    if (g.skus === "all") skus = "all";
    else if (skus !== "all") for (const s of g.skus) skus.add(s);
    if (g.features === "all") features = "all";
    else if (features !== "all") for (const f of g.features) features.add(f);
    if (TIER_RANK[g.tier] > tierRank) {
      tierRank = TIER_RANK[g.tier];
      tier = g.tier;
    }
    // The binding expiry is the EARLIEST non-null one (most restrictive).
    if (g.expiresAt && (!expiresAt || Date.parse(g.expiresAt) < Date.parse(expiresAt))) expiresAt = g.expiresAt;
  }

  const dominant = [...grants].sort((a, b) => (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0))[0]!;
  return {
    active: true,
    devMode,
    licenseType: dominant.licenseType,
    tier,
    skus,
    features,
    expiresAt,
    source: dominant.source,
    sources,
    licenseId: dominant.licenseId,
  };
}

/** Re-export the cloud issuer so installer/dealer tooling can mint signed licenses through one import. */
export const issueLicense = _issue;
