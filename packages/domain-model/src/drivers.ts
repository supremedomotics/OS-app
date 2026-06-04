import { z } from "zod";
import { CapabilityKind } from "./capabilities.js";
import { DriverId, HomeId, LicenseId } from "./ids.js";

/**
 * Driver & licensing domain (blueprint §9).
 *
 * A driver exposes a Supreme capability manifest. In Phase 1/2 a driver typically
 * wraps an HA integration underneath, but it declares the SIL contract so a future
 * native rewrite is a drop-in replacement. Matter ships disabled and is enabled on
 * demand by the owner/installer.
 */

export const DriverCategory = z.enum([
  "lighting",
  "climate",
  "shades",
  "media",
  "security",
  "energy",
  "protocol",
  "other",
]);
export type DriverCategory = z.infer<typeof DriverCategory>;

/** Distribution channel with an implied trust/certification level (§9). */
export const DriverChannel = z.enum(["official", "certified", "community", "beta"]);
export type DriverChannel = z.infer<typeof DriverChannel>;

export const ProtocolKind = z.enum([
  "knx",
  "dali",
  "casambi",
  "zigbee",
  "matter",
  "mqtt",
  "modbus",
]);
export type ProtocolKind = z.infer<typeof ProtocolKind>;

/**
 * The driver manifest — the heart of the bundle. It declares which Supreme
 * capabilities the driver provides and how it binds to a backend, WITHOUT leaking
 * backend specifics above the SIL.
 */
export const DriverManifest = z.object({
  /** Stable key, e.g. "supreme-knx". */
  key: z.string().regex(/^[a-z][a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(""),
  category: DriverCategory,
  channel: DriverChannel,
  publisher: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Supreme capabilities this driver can surface. */
  capabilities: z.array(CapabilityKind).min(1),
  /** Protocols the driver speaks (for commissioning + diagnostics). */
  protocols: z.array(ProtocolKind).default([]),
  compat: z.object({
    /** Minimum hub version this driver supports. */
    hubMinVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** SKU required to install/run; null = free. */
    requiresSku: z.string().nullable().default(null),
  }),
  backend: z.object({
    /** Phase-1 reality: "ha-integration" wraps an HA integration; "native" later. */
    type: z.enum(["ha-integration", "native"]),
    /** Opaque backend hint consumed only by the SIL (e.g. HA domain). */
    ref: z.string().nullable().default(null),
  }),
  /** Matter (and similar) ship disabled and are opt-in (§9). */
  shipsDisabled: z.boolean().default(false),
});
export type DriverManifest = z.infer<typeof DriverManifest>;

export const DriverVersionStatus = z.enum(["published", "deprecated", "yanked"]);
export type DriverVersionStatus = z.infer<typeof DriverVersionStatus>;

/**
 * A signed, installable bundle as published to the Driver Store. The hub verifies
 * `signature` (Ed25519 over the canonical manifest + contentHash) against the
 * publisher's signing key BEFORE install, and checks any required license (§9).
 */
export const DriverBundle = z.object({
  manifest: DriverManifest,
  /** SHA-256 of the adapter payload (the code/assets); integrity check. */
  contentHash: z.string(),
  /** Download location of the adapter payload (cloud store / CDN, or local). */
  bundleUrl: z.string(),
  status: DriverVersionStatus.default("published"),
  changelog: z.string().default(""),
});
export type DriverBundle = z.infer<typeof DriverBundle>;

export const SignedDriverBundle = z.object({
  bundle: DriverBundle,
  /** Base64 Ed25519 signature over the canonical bundle. */
  signature: z.string(),
  /** Id of the publisher signing key that produced the signature. */
  signingKeyId: z.string(),
});
export type SignedDriverBundle = z.infer<typeof SignedDriverBundle>;

/** An installed driver on a specific hub. */
export const InstalledDriver = z.object({
  id: DriverId,
  homeId: HomeId,
  key: z.string(),
  version: z.string(),
  channel: DriverChannel,
  category: DriverCategory,
  installedAt: z.string().datetime(),
  /** Disabled drivers (e.g. Matter before opt-in) are present but inactive. */
  enabled: z.boolean().default(true),
  status: z.enum(["active", "disabled", "error"]).default("active"),
  config: z.record(z.unknown()).default({}),
});
export type InstalledDriver = z.infer<typeof InstalledDriver>;

// ── Licensing (offline-validating signed tokens, §9, §13) ────────────────────

/** The signed license payload (everything except the signature). */
export const LicensePayload = z.object({
  id: LicenseId,
  homeId: HomeId,
  sku: z.string(),
  seats: z.number().int().positive(),
  features: z.array(z.string()).default([]),
  issuedAt: z.string().datetime(),
  /** null = perpetual. */
  expiresAt: z.string().datetime().nullable(),
});
export type LicensePayload = z.infer<typeof LicensePayload>;

export const License = LicensePayload.extend({
  /** Base64 Ed25519 signature over the canonical payload, verified on the hub. */
  signature: z.string(),
});
export type License = z.infer<typeof License>;
