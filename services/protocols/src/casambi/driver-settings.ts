import type { CasambiConnectionMode } from "./connection-manager.js";

/**
 * Casambi Driver Settings (§ Casambi Driver Refactor — Foundation). The full settings surface the
 * Driver Manager's config page exposes for this driver: which connection mode is active, that
 * mode's own settings, and cross-cutting advanced settings. This module owns the SHAPE only — the
 * Driver Store's config schema (`services/drivers/src/manifests.ts`) is written against the same
 * field keys by convention, since that package intentionally has no dependency on
 * `@supreme/protocols` (manifests are metadata; every other driver's schema/factory pair already
 * follows this same convention, e.g. KNX's `host`/`port` keys).
 */
export interface CasambiCloudSettings {
  apiKey: string;
  email: string;
  password: string;
  networkId?: string;
}

export interface CasambiLocalSettings {
  gatewayIp: string;
  restPort: number;
  udpPort: number;
  gatewayName?: string;
  autoDiscover: boolean;
}

export interface CasambiAdvancedSettings {
  /** Unlocks the Diagnostics page's raw fields. */
  developerMode: boolean;
  /** Verbose lifecycle logging into the Driver Manager's per-driver log. */
  logging: boolean;
  /** § PR-3 placeholder — a real packet capture needs the Local UDP Engine; today this only
   * toggles the same lightweight `onLog` trace every other native driver already has. */
  packetCapture: boolean;
}

export interface CasambiDriverSettings {
  connectionType: CasambiConnectionMode;
  cloud?: CasambiCloudSettings;
  local?: CasambiLocalSettings;
  advanced: CasambiAdvancedSettings;
}

export const DEFAULT_CASAMBI_ADVANCED_SETTINGS: CasambiAdvancedSettings = {
  developerMode: false,
  logging: false,
  packetCapture: false,
};
