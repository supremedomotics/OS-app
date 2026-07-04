import {
  License,
  LicensePayload,
  newId,
  type HomeId,
  type LicenseId,
} from "@supreme/domain-model";
import { signPayload, verifyPayload } from "@supreme/crypto";

/**
 * @supreme/licensing — signed license tokens (§9, §13).
 *
 * Licenses are issued by Supreme Cloud (or an installer-side issuer) and signed
 * with the Supreme licensing key. The hub stores the token and validates it
 * OFFLINE against the embedded public key, so an air-gapped install stays
 * licensed. Periodic re-validation is optional, never required for in-home use.
 */

export interface IssueLicenseInput {
  homeId: HomeId;
  sku: string;
  seats: number;
  features?: string[];
  /** null = perpetual. */
  expiresAt?: string | null;
}

/** Issue (sign) a new license. Runs on the licensing service / installer issuer. */
export function issueLicense(input: IssueLicenseInput, privateKeyPem: string): License {
  const payload: LicensePayload = {
    id: newId("license") as LicenseId,
    homeId: input.homeId,
    sku: input.sku,
    seats: input.seats,
    features: input.features ?? [],
    issuedAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
  };
  return { ...payload, signature: signPayload(payload, privateKeyPem) };
}

export type LicenseValidation =
  | { valid: true; license: License }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_home" };

/**
 * Validate a license offline against the embedded public key. Optionally bind it
 * to the hub's `homeId` so a token issued for one home can't license another.
 */
export function validateLicense(
  token: unknown,
  publicKeyPem: string,
  opts: { homeId?: HomeId; now?: Date } = {},
): LicenseValidation {
  const parsed = License.safeParse(token);
  if (!parsed.success) return { valid: false, reason: "malformed" };
  const license = parsed.data;

  const { signature, ...payload } = license;
  if (!verifyPayload(payload, signature, publicKeyPem)) {
    return { valid: false, reason: "bad_signature" };
  }
  if (opts.homeId && license.homeId !== opts.homeId) {
    return { valid: false, reason: "wrong_home" };
  }
  const now = opts.now ?? new Date();
  if (license.expiresAt && new Date(license.expiresAt) <= now) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, license };
}

/** Convenience: is a given feature entitled by a validated license? */
export function hasFeature(license: License, feature: string): boolean {
  return license.features.includes(feature);
}

export {
  DealerLicensingService,
  DealerLicensingError,
  InMemoryLicenseRecordStore,
  type ILicenseRecordStore,
  type LicenseRecord,
  type LicenseRecordStatus,
  type IssueForCustomerInput,
} from "./dealer-licensing.js";
export {
  SqlLicenseRecordStore,
  LICENSING_SCHEMA_SQL,
  type LicensingSqlExecutor,
} from "./sql-store.js";
// NOTE: the Fastify server (buildLicensingServer) is intentionally NOT re-exported here — the hub
// imports this package only for OFFLINE token verification and must not pull in fastify. Cloud
// consumers import it directly from "@supreme/licensing/dist/server.js" (see main.ts).
