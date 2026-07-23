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

/**
 * Real network coordinates for a discovered/commissioned device, when the discovery source resolved
 * them (mDNS addresses, Shelly/Matter TXT, etc.). Every field is optional and only ever present when
 * genuinely known — a device on a non-IP bus (KNX/Zigbee) simply has none. Never fabricated.
 */
export const NetworkInfo = z.object({
  ip: z.string().optional(),
  mac: z.string().optional(),
  host: z.string().optional(),
});
export type NetworkInfo = z.infer<typeof NetworkInfo>;

/** Per-driver outcome of one discovery run (§ Driver Failure Isolation) — returned
 * ONLY after each driver's scan completes; true live progress would need a streaming
 * transport this API doesn't have (a documented limitation, not fabricated progress). */
export const DriverDiscoveryResult = z.object({
  protocol: z.string(),
  driverName: z.string(),
  status: z.enum(["complete", "failed"]),
  count: z.number(),
  error: z.string().optional(),
});
export type DriverDiscoveryResult = z.infer<typeof DriverDiscoveryResult>;

export const DiscoveredDeviceView = z.object({
  backendId: z.string(),
  suggestedName: z.string(),
  capabilities: z.array(CapabilityKind),
  source: z.string(),
  /** Native bus protocol this device was discovered on (e.g. "mqtt"), if any. */
  protocol: z.string().optional(),
  /** Resolved network coordinates (IP/MAC/host), when the discovery source knows them. */
  network: NetworkInfo.optional(),
  /**
   * Protocol-specific binding config the discovery source already resolved (e.g. a
   * HEOS player's `pid`, an AVR/Yamaha zone) — pass straight through as `config` on a
   * `CommissionRequest` to bind correctly without the installer typing it in by hand.
   * Absent when the protocol needs no config (KNX group address, Modbus register, …).
   */
  bindConfig: z.record(z.unknown()).optional(),
  /**
   * Room-name hint the driver's own discovery already resolved (a Casambi Group name,
   * an ETS Function/Space, …) — never a guess invented by commissioning, only ever what
   * the driver genuinely reported. Pass straight through as `roomNameHint` on a
   * `CommissionRequest` so the shared Room Assignment Engine can find-or-create the
   * matching Supreme room without the installer having to pick one by hand.
   */
  roomHint: z.string().nullable().optional(),
  /** The installed driver's user-facing name (e.g. "Supreme KNX") — NEVER an internal
   * engine/provider name ("KNX Ultimate", "KNX IoT Provider" stay invisible). Null when
   * the device came from a source with no installed-driver mapping. */
  driverName: z.string().nullable().optional(),
  /** Driver-normalized per-capability config (§ ADR 0017/0018 — Capability Normalization
   * Pipeline), e.g. `{ color: { colorModes: { rgb, cct } } }` — known from the driver's own
   * protocol model at discovery time, never a guess. Pass straight through as
   * `capabilityConfig` on a `CommissionRequest` so manual pairing preserves the exact same
   * structural signal the auto-commit path already does. */
  capabilityConfig: z.record(z.record(z.unknown())).optional(),
  /** §Automatic Zone Generation — extra logical zones this ONE physical unit exposes,
   * discovered via a genuine wire query (e.g. Yamaha's `getFeatures`). Absent for
   * single-zone devices/protocols — never fabricated for one that can't report it. */
  zones: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  /** A real, wire-reported brand string (§ Discover Devices enrichment) — e.g. fetched from
   * a unit's UPnP description XML. Absent for sources that report no such field. */
  manufacturer: z.string().optional(),
});
export type DiscoveredDeviceView = z.infer<typeof DiscoveredDeviceView>;

export const DiscoveryList = z.object({
  discovered: z.array(DiscoveredDeviceView),
  /** Per-driver outcome (§ Driver Failure Isolation) — empty when the backend adapter
   * doesn't support per-driver breakdown (defensive default, never fabricated). */
  driverResults: z.array(DriverDiscoveryResult).optional(),
});
export type DiscoveryList = z.infer<typeof DiscoveryList>;

/** A device discovered but awaiting installer approval (§ Device Approval). */
export const PendingDeviceView = z.object({
  id: z.string(),
  backendId: z.string(),
  suggestedName: z.string(),
  protocol: z.string().nullable(),
  source: z.string(),
  capabilities: z.array(z.string()),
  network: NetworkInfo.nullable(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  /** The driver's own room hint, carried from discovery (§ Universal Room Intelligence)
   * — shown to the installer as the pre-filled/suggested room, never silently applied
   * without their final approval. */
  roomHint: z.string().nullable().optional(),
  /** The installed driver's user-facing name, resolved from `protocol` at read time
   * (never persisted — always reflects the CURRENT registry, e.g. after a rename). */
  driverName: z.string().nullable().optional(),
});
export type PendingDeviceView = z.infer<typeof PendingDeviceView>;

export const PendingDeviceList = z.object({ pending: z.array(PendingDeviceView) });
export type PendingDeviceList = z.infer<typeof PendingDeviceList>;

export const ApproveDeviceRequest = z.object({
  name: z.string().optional(),
  /** Explicit installer choice — omit to let the Room Assignment Engine resolve one from
   * the pending record's own roomHint (§ Universal Room Intelligence). */
  roomId: z.string().optional(),
  capabilities: z.array(CapabilityKind).optional(),
});
export type ApproveDeviceRequest = z.infer<typeof ApproveDeviceRequest>;

export const DiscoverRequest = z.object({
  protocol: ProtocolKind.optional(),
  /** Discovery Driver Selector (§ Priority 4) — installed-driver ids (from `/v1/drivers/
   * registry`'s `installedId`) to scan. Omit to scan every installed, discovery-capable
   * driver (the previous default behavior — fully backward compatible). An empty array
   * intentionally scans nothing (a "Deselect All" state), not "scan everything". */
  driverIds: z.array(z.string()).optional(),
});
export type DiscoverRequest = z.infer<typeof DiscoverRequest>;

/**
 * A targeted, single-address reachability probe (§ AVR Intelligent Manual Add) — distinct
 * from {@link DiscoverRequest}'s broadcast scan. For protocols with no broadcast presence
 * (or a scan that hasn't reached a device yet), the installer types in an address and this
 * opens a real connection to confirm it before committing to commission anything.
 */
export const ProbeRequest = z.object({ protocol: ProtocolKind, address: z.string().min(1) });
export type ProbeRequest = z.infer<typeof ProbeRequest>;

/** One zone/endpoint found (or not) during a probe — honestly labeled as detected, not guaranteed. */
export const ProbeZone = z.object({
  id: z.string(),
  label: z.string(),
  detected: z.boolean(),
});
export type ProbeZone = z.infer<typeof ProbeZone>;

export const ProbeResult = z.object({
  reachable: z.boolean(),
  error: z.string().nullable(),
  mac: z.string().nullable(),
  /** Empty for protocols/errors where zone detection doesn't apply. */
  zones: z.array(ProbeZone),
  /** § Universal AVR SDK — real renamed/hidden inputs fetched over HTTP AppCommand
   * during the probe (AVR only; every other protocol simply omits these, same
   * optional-field convention as `mac`/zone detection being protocol-specific). */
  renamedInputs: z.record(z.string()).optional(),
  hiddenInputs: z.array(z.string()).optional(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export const CommissionRequest = z.object({
  backendId: z.string(),
  name: z.string().min(1),
  /** Explicit installer choice — omit to let the Room Assignment Engine resolve one from
   * `roomNameHint` (§ Universal Room Intelligence). */
  roomId: z.string().optional(),
  /** A driver-reported room hint (e.g. `DiscoveredDeviceView.roomHint`) — used to find-or-
   * create a room only when `roomId` is not supplied. */
  roomNameHint: z.string().nullable().optional(),
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
  /** Network coordinates carried over from discovery, persisted onto the device (§ Device Manager). */
  network: NetworkInfo.optional(),
  /** § ADR 0017/0018 — pass `DiscoveredDeviceView.capabilityConfig` straight through so manual
   * pairing preserves the same driver-normalized structural signal the auto-commit path does. */
  capabilityConfig: z.record(z.record(z.unknown())).optional(),
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

// ── System log (§ Settings → Logs) ────────────────────────────────────────────

/** One entry in the unified system log: driver lifecycle events (install/enable/connect/
 * native-connection) and device control operation outcomes, all in one stream. */
export const SystemLogEntry = z.object({
  ts: z.string().datetime(),
  level: z.enum(["info", "warn", "error"]),
  /** A driver key (e.g. "supreme-avr") or a human-readable device label (e.g. "Device: Living Room AC"). */
  source: z.string(),
  message: z.string(),
});
export type SystemLogEntry = z.infer<typeof SystemLogEntry>;

export const SystemLogList = z.object({ entries: z.array(SystemLogEntry) });
export type SystemLogList = z.infer<typeof SystemLogList>;

/**
 * Real host telemetry (§ Installer Dashboard). Every field is measured from the OS the hub runs on;
 * the optional fields (`utilizationPct`, `storage`, `temperatureC`) are ABSENT when the platform
 * can't measure them — clients hide what isn't present rather than showing a fabricated zero.
 */
export const SystemHealth = z.object({
  uptimeSeconds: z.number(),
  hostUptimeSeconds: z.number(),
  cpu: z.object({
    cores: z.number().int(),
    model: z.string(),
    loadAvg1: z.number(),
    loadAvg5: z.number(),
    loadAvg15: z.number(),
    utilizationPct: z.number().optional(),
  }),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    usedPct: z.number(),
  }),
  process: z.object({ rssBytes: z.number(), heapUsedBytes: z.number() }),
  storage: z
    .object({ totalBytes: z.number(), usedBytes: z.number(), freeBytes: z.number(), usedPct: z.number() })
    .optional(),
  temperatureC: z.number().optional(),
});
export type SystemHealth = z.infer<typeof SystemHealth>;

/**
 * Hub software-update status for the Update Center (§ Update Center). `channelConfigured` is false
 * when no signed OTA channel is set up on this hub (the honest common case for a LAN dev/demo hub) —
 * the UI then simply shows the current version. `latest` (with signed release notes) appears only
 * when a genuinely newer, signature-verified release exists.
 */
export const SystemUpdate = z.object({
  current: z.string(),
  channelConfigured: z.boolean(),
  updateAvailable: z.boolean(),
  latest: z
    .object({ version: z.string(), notes: z.string().optional(), releasedAt: z.string() })
    .optional(),
  checkedAt: z.string(),
  /** Present when a configured channel could not be reached/verified — surfaced, not hidden. */
  error: z.string().optional(),
});
export type SystemUpdate = z.infer<typeof SystemUpdate>;

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

export const RestoreRequest = z.object({
  document: z.string(),
  /** Preview only — verify + report what would be restored, without touching data (§ dry-run). */
  dryRun: z.boolean().optional(),
});
export type RestoreRequest = z.infer<typeof RestoreRequest>;

export const RestoreResponse = z.object({
  tables: z.number().int(),
  rows: z.number().int(),
  /** True when the restore failed and the pre-restore snapshot was re-applied. */
  rolledBack: z.boolean(),
});
export type RestoreResponse = z.infer<typeof RestoreResponse>;

/** Dry-run inspection of a backup — what a restore WOULD write, plus signature validity. */
export const BackupInspectionResponse = z.object({
  inspection: z.object({
    signatureValid: z.boolean().nullable(),
    schemaVersion: z.string(),
    createdAt: z.string(),
    tableCount: z.number().int(),
    rowCount: z.number().int(),
    tables: z.array(z.object({ name: z.string(), rows: z.number().int() })),
  }),
});
export type BackupInspectionResponse = z.infer<typeof BackupInspectionResponse>;

/** One backup in the history (metadata only). */
export const BackupHistoryEntry = z.object({
  id: z.string(),
  createdAt: z.string(),
  schemaVersion: z.string(),
  tableCount: z.number().int(),
  rowCount: z.number().int(),
  source: z.string(),
});
export type BackupHistoryEntry = z.infer<typeof BackupHistoryEntry>;

export const BackupList = z.object({ backups: z.array(BackupHistoryEntry) });
export type BackupList = z.infer<typeof BackupList>;

export const BackupSchedule = z.object({
  enabled: z.boolean(),
  everyHours: z.number().int().positive(),
  retain: z.number().int().positive(),
});
export type BackupSchedule = z.infer<typeof BackupSchedule>;

/** Accepts a partial schedule patch. */
export const BackupScheduleInput = z.object({
  enabled: z.boolean().optional(),
  everyHours: z.number().int().positive().optional(),
  retain: z.number().int().positive().optional(),
});
export type BackupScheduleInput = z.infer<typeof BackupScheduleInput>;

export const BackupScheduleResponse = z.object({ schedule: BackupSchedule });
export type BackupScheduleResponse = z.infer<typeof BackupScheduleResponse>;

/** Backup health indicator (§ Backup). */
export const BackupStatus = z.object({
  lastBackupAt: z.string().nullable(),
  lastBackupSource: z.string().nullable(),
  backupCount: z.number().int(),
  schedule: BackupSchedule,
  nextDueAt: z.string().nullable(),
  lastRestoreAt: z.string().nullable(),
});
export type BackupStatus = z.infer<typeof BackupStatus>;

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
