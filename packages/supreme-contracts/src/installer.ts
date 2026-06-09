import {
  CapabilityKind,
  DriverManifest,
  InstalledDriver,
  License,
  ProtocolKind,
  SupremeDeviceType,
} from "@supreme/domain-model";
import { z } from "zod";

/**
 * Installer & admin contracts (§9, §14): Driver Store, discovery + commissioning,
 * diagnostics, backup/restore, project export, and licensing status. All Supreme —
 * the installer never sees Home Assistant.
 */

// ── Driver Store ─────────────────────────────────────────────────────────────

/** A catalog entry as shown to the installer (manifest + lifecycle, no signature). */
export const CatalogEntry = z.object({
  manifest: DriverManifest,
  status: z.enum(["published", "deprecated", "yanked"]),
  signingKeyId: z.string(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const CatalogList = z.object({ catalog: z.array(CatalogEntry) });
export type CatalogList = z.infer<typeof CatalogList>;

export const InstallDriverRequest = z.object({
  key: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
});
export type InstallDriverRequest = z.infer<typeof InstallDriverRequest>;

export const RollbackDriverRequest = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });
export type RollbackDriverRequest = z.infer<typeof RollbackDriverRequest>;

export const InstalledDriverList = z.object({ drivers: z.array(InstalledDriver) });
export type InstalledDriverList = z.infer<typeof InstalledDriverList>;

export const InstalledDriverResponse = z.object({ driver: InstalledDriver });
export type InstalledDriverResponse = z.infer<typeof InstalledDriverResponse>;

export const SetDriverEnabledRequest = z.object({ enabled: z.boolean() });
export type SetDriverEnabledRequest = z.infer<typeof SetDriverEnabledRequest>;

// ── Discovery & commissioning ────────────────────────────────────────────────

export const DiscoveredDeviceView = z.object({
  backendId: z.string(),
  suggestedName: z.string(),
  capabilities: z.array(CapabilityKind),
  source: z.string(),
  /** Native bus protocol this device was discovered on (e.g. "mqtt"), if any. */
  protocol: z.string().optional(),
});
export type DiscoveredDeviceView = z.infer<typeof DiscoveredDeviceView>;

export const DiscoveryList = z.object({ discovered: z.array(DiscoveredDeviceView) });
export type DiscoveryList = z.infer<typeof DiscoveryList>;

export const DiscoverRequest = z.object({ protocol: ProtocolKind.optional() });
export type DiscoverRequest = z.infer<typeof DiscoverRequest>;

export const CommissionRequest = z.object({
  backendId: z.string(),
  name: z.string().min(1),
  roomId: z.string(),
  capabilities: z.array(CapabilityKind).min(1),
  supremeType: SupremeDeviceType.optional(),
  manufacturer: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  /**
   * When set, the new device is immediately bound to this native bus on every
   * capability (the discovered device's protocol + bus address) — discover → commission
   * → bind in one step. The bus address defaults to `backendId`.
   */
  protocol: z.string().optional(),
  address: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});
export type CommissionRequest = z.infer<typeof CommissionRequest>;

/** Bind a commissioned device's capability to a real bus address (KNX/Modbus/MQTT). */
export const ProtocolBindingView = z.object({
  deviceId: z.string(),
  capability: CapabilityKind,
  protocol: z.string(),
  /** Protocol-native address (KNX group address, Modbus register, MQTT base topic). */
  address: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});
export type ProtocolBindingView = z.infer<typeof ProtocolBindingView>;

export const BindProtocolRequest = ProtocolBindingView;
export type BindProtocolRequest = z.infer<typeof BindProtocolRequest>;

export const ProtocolBindingList = z.object({ bindings: z.array(ProtocolBindingView) });
export type ProtocolBindingList = z.infer<typeof ProtocolBindingList>;

// ── Diagnostics ──────────────────────────────────────────────────────────────

export const DiagnosticsReport = z.object({
  hubVersion: z.string(),
  backend: z.object({ kind: z.string(), healthy: z.boolean() }),
  counts: z.object({
    rooms: z.number().int(),
    devices: z.number().int(),
    scenes: z.number().int(),
    drivers: z.number().int(),
    users: z.number().int(),
  }),
  drivers: z.array(
    z.object({ key: z.string(), version: z.string(), enabled: z.boolean(), status: z.string() }),
  ),
  /** Devices currently reporting offline/unavailable. */
  offlineDevices: z.array(z.object({ id: z.string(), name: z.string() })),
  generatedAt: z.string().datetime(),
});
export type DiagnosticsReport = z.infer<typeof DiagnosticsReport>;

// ── Backup / restore ─────────────────────────────────────────────────────────

export const BackupMetaResponse = z.object({
  meta: z.object({
    id: z.string(),
    createdAt: z.string().datetime(),
    schemaVersion: z.string(),
    tableCount: z.number().int(),
    rowCount: z.number().int(),
  }),
  /** The signed backup document, serialized — the installer downloads/stores this. */
  document: z.string(),
});
export type BackupMetaResponse = z.infer<typeof BackupMetaResponse>;

export const RestoreRequest = z.object({ document: z.string() });
export type RestoreRequest = z.infer<typeof RestoreRequest>;

export const RestoreResponse = z.object({ tables: z.number().int(), rows: z.number().int() });
export type RestoreResponse = z.infer<typeof RestoreResponse>;

// ── Project export ───────────────────────────────────────────────────────────

/** A portable project document an installer can export and re-import (§16). */
export const ProjectExport = z.object({
  exportedAt: z.string().datetime(),
  hubVersion: z.string(),
  home: z.object({ name: z.string(), tier: z.string() }),
  rooms: z.array(z.object({ name: z.string(), areaType: z.string() })),
  devices: z.array(
    z.object({
      name: z.string(),
      supremeType: z.string(),
      room: z.string().nullable(),
      capabilities: z.array(z.string()),
    }),
  ),
  scenes: z.array(z.object({ name: z.string(), steps: z.number().int() })),
  drivers: z.array(z.object({ key: z.string(), version: z.string(), enabled: z.boolean() })),
});
export type ProjectExport = z.infer<typeof ProjectExport>;

// ── Licensing ────────────────────────────────────────────────────────────────

export const LicenseStatus = z.object({
  licensed: z.boolean(),
  skus: z.array(z.string()),
  features: z.array(z.string()),
  license: License.nullable(),
});
export type LicenseStatus = z.infer<typeof LicenseStatus>;

export const ActivateLicenseRequest = z.object({ token: License });
export type ActivateLicenseRequest = z.infer<typeof ActivateLicenseRequest>;
