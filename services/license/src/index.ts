/**
 * @supreme/license-service — the hub's Licensing Service: a single source of truth over pluggable
 * providers (developer / offline / cloud / OEM / testing). Drivers and apps only ever ask
 * hasSku / hasFeature / canInstallDriver; licensing logic lives nowhere else.
 */
export {
  LicenseService,
  mergeGrants,
  issueLicense,
} from "./service.js";

export {
  type LicenseProvider,
  DeveloperProvider,
  StaticGrantProvider,
  CallbackProvider,
  makeGrant,
} from "./providers.js";

export {
  FEATURES,
  KNOWN_SKUS,
  TIER_RANK,
  type Feature,
  type LicenseType,
  type LicenseTier,
  type ProviderGrant,
  type SubscriptionInfo,
  type EffectiveLicense,
  type DriverRequirements,
  type LicenseStatus,
} from "./types.js";
