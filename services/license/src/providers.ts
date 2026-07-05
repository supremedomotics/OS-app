/**
 * License providers — the pluggable sources the {@link LicenseService} merges. Adding a new source
 * (cloud subscription, OEM activation, a testing harness) is a new provider; the service and all
 * callers are unchanged. Each provider returns a grant or null (inactive).
 */
import type { LicenseTier, LicenseType, ProviderGrant } from "./types.js";

export interface LicenseProvider {
  /** Stable id, also used for source precedence. */
  readonly id: string;
  /** Load this provider's current grant (null = not active right now). May be async (cloud/IO). */
  load(now: number): Promise<ProviderGrant | null> | ProviderGrant | null;
}

/**
 * Developer Mode. Active when SUPREME_DEV_MODE=true (or a developer license file is present). Unlocks
 * EVERY SKU + feature and flags the UI watermark. Enabling it never requires touching app code — it's
 * purely env/file driven. Must never be used in a production build (the host guards that).
 */
export class DeveloperProvider implements LicenseProvider {
  readonly id = "developer";
  constructor(private readonly isEnabled: () => boolean) {}
  load(): ProviderGrant | null {
    if (!this.isEnabled()) return null;
    return {
      source: this.id,
      licenseType: "developer",
      tier: "enterprise",
      skus: "all",
      features: "all",
      expiresAt: null,
      devMode: true,
    };
  }
}

/** A provider that always returns a fixed grant — used to inject offline/cloud-cached grants. */
export class StaticGrantProvider implements LicenseProvider {
  constructor(
    readonly id: string,
    private readonly grant: ProviderGrant | null,
  ) {}
  load(): ProviderGrant | null {
    return this.grant;
  }
}

/** A provider whose grant is produced lazily by a callback (e.g. read from a store, decode a file). */
export class CallbackProvider implements LicenseProvider {
  constructor(
    readonly id: string,
    private readonly loader: (now: number) => Promise<ProviderGrant | null> | ProviderGrant | null,
  ) {}
  load(now: number): Promise<ProviderGrant | null> | ProviderGrant | null {
    return this.loader(now);
  }
}

/** Convenience: build a plain grant (handy for offline/cloud providers + tests). */
export function makeGrant(input: {
  source: string;
  licenseType: LicenseType;
  tier: LicenseTier;
  skus?: "all" | string[];
  features?: "all" | string[];
  expiresAt?: string | null;
  hubUuid?: string | null;
  licenseId?: string;
}): ProviderGrant {
  return {
    source: input.source,
    licenseType: input.licenseType,
    tier: input.tier,
    skus: input.skus ?? [],
    features: input.features ?? [],
    expiresAt: input.expiresAt ?? null,
    hubUuid: input.hubUuid ?? null,
    licenseId: input.licenseId,
  };
}
