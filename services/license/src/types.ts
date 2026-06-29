/**
 * Licensing domain types — the vocabulary the whole platform shares. Licensing is NEVER hardcoded in
 * drivers or app code: everything resolves to an {@link EffectiveLicense} produced by the
 * LicenseService from its providers, and callers only ask hasSku/hasFeature/canInstallDriver.
 */

/** Commercial license models Supreme OS supports. */
export type LicenseType =
  | "developer"
  | "community"
  | "home"
  | "professional"
  | "enterprise"
  | "commercial_building"
  | "hotel"
  | "oem"
  | "trial"
  | "beta"
  | "internal_testing"
  | "lifetime"
  | "subscription";

/** Capability tiers, ordered. A driver/feature can require a minimum tier. */
export type LicenseTier = "community" | "home" | "professional" | "enterprise";
export const TIER_RANK: Record<LicenseTier, number> = { community: 0, home: 1, professional: 2, enterprise: 3 };

/** Licensable platform features (not drivers). Drivers are gated by SKU; these by feature. */
export const FEATURES = [
  "cloud",
  "ai",
  "auto_pilot",
  "energy_intelligence",
  "analytics",
  "voice",
  "remote_access",
  "installer_portal",
  "dealer_portal",
  "camera_ai",
  "predictive_intelligence",
  "reports",
  "api_access",
] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * SKUs referenced by driver manifests + the tiers that imply them. Kept as a concrete list so that a
 * grant of "all" (e.g. Developer Mode) can be expanded into a real Set for the DriverManager, whose
 * check is `licensedSkus().has(sku)`.
 */
export const KNOWN_SKUS = ["pro", "professional", "enterprise", "commercial_building", "hotel", "oem"] as const;

/** Subscription metadata attached to a grant (when the license is subscription-based). */
export interface SubscriptionInfo {
  period: "monthly" | "yearly" | "lifetime";
  /** When the subscription next renews (null = perpetual/lifetime). */
  renewsAt?: string | null;
  /** Within grace, an expired subscription still grants access. */
  graceUntil?: string | null;
}

/** What a single provider contributes. The service merges all active grants. */
export interface ProviderGrant {
  /** Provider id that produced this grant (e.g. "developer", "offline", "cloud"). */
  source: string;
  licenseType: LicenseType;
  tier: LicenseTier;
  /** "all" unlocks every SKU (e.g. Developer Mode); otherwise the explicit set. */
  skus: "all" | string[];
  /** "all" unlocks every feature; otherwise the explicit set. */
  features: "all" | string[];
  /** ISO expiry; null = perpetual. An expired grant is ignored by the service. */
  expiresAt: string | null;
  /** Developer-mode grant — drives the UI watermark; must never be a production license. */
  devMode?: boolean;
  /** The hub this license is bound to (UUID); null/undefined = unbound. */
  hubUuid?: string | null;
  licenseId?: string;
  subscription?: SubscriptionInfo;
}

/** The resolved, merged license the service exposes to everyone. */
export interface EffectiveLicense {
  /** True when at least one active (non-expired) grant exists. */
  active: boolean;
  devMode: boolean;
  licenseType: LicenseType;
  tier: LicenseTier;
  /** Licensed SKUs, or "all". */
  skus: Set<string> | "all";
  /** Licensed features, or "all". */
  features: Set<string> | "all";
  /** Earliest non-null expiry across contributing grants (the binding one). */
  expiresAt: string | null;
  /** The dominant source (developer > offline > cloud > oem > testing > default). */
  source: string;
  /** All contributing provider sources. */
  sources: string[];
  licenseId?: string;
}

/** What a driver needs, lifted from its manifest — drivers contain NO licensing logic themselves. */
export interface DriverRequirements {
  key: string;
  requiresSku?: string | null;
  requiresFeature?: string | null;
  minTier?: LicenseTier | null;
}

/** Public, serializable status for the Licensing UI + REST. */
export interface LicenseStatus {
  active: boolean;
  devMode: boolean;
  licenseType: LicenseType;
  tier: LicenseTier;
  skus: string[] | "all";
  features: string[] | "all";
  expiresAt: string | null;
  source: string;
  sources: string[];
  licenseId?: string;
}
