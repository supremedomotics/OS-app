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
  "lutron",
  "coolmaster",
  "bacnet",
  "dmx",
  "rti",
  "avr",
  "heos",
  "yamaha",
]);
export type ProtocolKind = z.infer<typeof ProtocolKind>;

/**
 * A declarative field in a driver's configuration schema. The Driver Manager UI GENERATES a config
 * form from these, so any driver — current or future — gets a config page for free; complex drivers
 * can still ship a fully custom page. Kept intentionally small and UI-agnostic.
 */
export const DriverConfigField = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "password", "number", "boolean", "select", "host", "port"]),
  required: z.boolean().default(false),
  /** Conditional required-ness: this field is only required when another field in the same
   * schema currently equals the given value (e.g. Casambi's `connectionType` discriminator).
   * Lets one manifest express mutually-exclusive config modes without the generic validator
   * needing to know anything about a specific driver. A field with neither `required` nor
   * `requiredIf` is always optional. */
  requiredIf: z.object({ key: z.string(), equals: z.string() }).optional(),
  /** Default applied when the driver is first configured. */
  default: z.unknown().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  /** Options for `select`. */
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Secret values are masked in the UI and never returned in plaintext by the API. */
  secret: z.boolean().default(false),
});
export type DriverConfigField = z.infer<typeof DriverConfigField>;

export const DriverConfigSchema = z.array(DriverConfigField);
export type DriverConfigSchema = z.infer<typeof DriverConfigField>[];

/** Lifecycle/management operations a driver supports. The UI shows only the declared ones. */
export const DriverOperation = z.enum([
  "install",
  "uninstall",
  "configure",
  "enable",
  "disable",
  "connect",
  "disconnect",
  "diagnostics",
  "health",
  "logs",
  "update",
]);
export type DriverOperation = z.infer<typeof DriverOperation>;

/** The operations essentially every driver supports; protocol drivers add connect/disconnect. */
export const DEFAULT_DRIVER_OPERATIONS: DriverOperation[] = [
  "install",
  "uninstall",
  "configure",
  "enable",
  "disable",
  "diagnostics",
  "health",
  "logs",
  "update",
];

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
    /** Every driver is a native protocol driver — the only supported backend kind. */
    type: z.enum(["native"]),
    /** Opaque backend hint consumed only by the SIL. */
    ref: z.string().nullable().default(null),
  }),
  /** Matter (and similar) ship disabled and are opt-in (§9). */
  shipsDisabled: z.boolean().default(false),
  /** Declarative config schema → the Driver Manager auto-generates this driver's config page. */
  configSchema: DriverConfigSchema.default([]),
  /** Other driver keys this one depends on (installed first). */
  dependencies: z.array(z.string()).default([]),
  /** Operations this driver supports; empty → the default set is assumed. */
  operations: z.array(DriverOperation).default([]),
  /** Authored marketplace metadata (§ Extension Center). Optional — a driver that doesn't provide a
   * field simply has none, and the UI omits it rather than showing a blank. */
  documentationUrl: z.string().url().nullable().default(null),
  /** Release notes for the current version (short, human-facing). */
  releaseNotes: z.string().default(""),
  /** Per-version changelog, newest first. */
  changelog: z
    .array(z.object({ version: z.string(), date: z.string(), notes: z.string() }))
    .default([]),
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
