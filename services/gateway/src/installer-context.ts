import {
  newId,
  type CapabilityKind,
  type DeviceId,
  type DriverId,
  type HomeId,
  type License,
  type ProtocolKind,
  type Room,
  type RoomId,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import { generateSigningKeyPair, type KeyPairPem } from "@supreme/crypto";
import type {
  IProtocolBindingStore,
  StoredProtocolBinding,
  SupremeIntegrationLayer,
  INativeProtocolDriver,
} from "@supreme/integration-layer";
import type { HomeService, IConfigStore } from "@supreme/home";
import type { SceneService } from "@supreme/scenes";
import type { IdentityService } from "@supreme/identity";
import {
  DriverManager,
  InMemoryCatalog,
  isConfigComplete,
  seedFirstPartyCatalog,
  type IInstalledDriverStore,
} from "@supreme/drivers";
import { CallbackProvider, DeveloperProvider, LicenseService, makeGrant, type LicenseTier, type ProviderGrant } from "@supreme/license-service";
import { buildNativeDriver, hasNativeFactory, type NativeDriverFactoryContext } from "./native-driver-factory.js";
import {
  knxSearch,
  SupremeKnxDriver,
  scoreConfidence,
  assignRoom,
  checkDuplicate,
  planBindings,
  type KnxGateway,
  type UnifiedDeviceMapperInput,
  type UnifiedKnxDevice,
  type BindingPlanItem,
  type ConfidenceScores,
  type RoomAssignmentResult,
  type DuplicateCheckResult,
  type DuplicateDecision,
  type ExistingInstallationState,
} from "@supreme/protocols";
import {
  CommissioningService,
  ConfigKnxLearningStore,
  generateEntities,
  KnxDecryptError,
  knxSignalsFromModel,
  learnRenames,
  parseKnxSource,
  resolveRoomAssignment,
  runKnxImport,
  UNASSIGNED_ROOM_NAME,
  unzipKnxproj,
  type EntitySource,
  type IProtocolScanner,
  type KnxImportResultV2,
  type LocationHint,
  type RecognizedDevice,
} from "@supreme/commissioning";
import { issueLicense, validateLicense } from "@supreme/licensing";
import {
  createBackup,
  inspectBackup,
  restoreBackup,
  serializeBackup,
  signBackup,
  type BackupInspection,
  type SignedBackup,
} from "@supreme/backup";
import type { SqlDb, IBackupStore, BackupRecordMeta, IPendingDeviceStore, PendingDeviceRecord } from "@supreme/persistence";
import type { GatewayConfig } from "./config.js";

/** SKU tiers, lowest → highest. A higher tier entitles all lower SKUs. */
const SKU_TIERS = ["essential", "pro", "estate"] as const;

/** Universal Room Intelligence — Room Normalization (§ Room matching must be case-
 * insensitive and normalization-aware): strips punctuation and whitespace, never real
 * words, so "R&D"/"r&d"/"R & D" collapse to the same key while "Living"/"Living Room"
 * stay distinct (removing a space never removes a word). Deliberately NOT a fuzzy/
 * similarity match — that would risk merging genuinely different rooms, which the room
 * resolver must never do on its own. */
function normalizeRoomName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Replace configured secret values with a masked placeholder so plaintext never leaves the hub. */
function maskSecrets(config: Record<string, unknown>, schema: { key: string; secret?: boolean }[]): Record<string, unknown> {
  const out = { ...config };
  for (const field of schema) {
    if (field.secret && out[field.key] !== undefined && out[field.key] !== "") out[field.key] = "••••••••";
  }
  return out;
}

/** Result of a KNX import (group-address export or .knxproj), or any other native-bus
 * auto-commission (§4). */
export interface KnxImportResult {
  devices: number;
  roomsCreated: number;
  created: { name: string; room: string | null; capabilities: string[] }[];
}

/** Result of {@link InstallerServices.autoCommissionMedia} — the confidence-based
 * Automatic Room Assignment summary (§ Universal AV Driver SDK). `unassigned` counts
 * how many landed in the fixed "Unassigned Devices" room rather than a real one. */
export interface MediaAutoCommissionResult {
  devices: number;
  roomsCreated: number;
  unassigned: number;
  created: { name: string; room: string | null; capabilities: string[]; confidence: number; autoAssigned: boolean }[];
}

/** Pull the `locationHint` a media driver's `discover()` attached to `raw` (§
 * Automatic Room Assignment) — same shape `commissioning/index.ts`'s `view()` reads,
 * duplicated narrowly here because this method reads raw `sil.discover()` output
 * directly rather than going through `CommissioningService.discover()` (see the
 * method doc for why). */
function extractMediaLocationHint(raw: Record<string, unknown> | undefined): LocationHint | null {
  const h = raw?.locationHint;
  if (!h || typeof h !== "object") return null;
  const rec = h as Record<string, unknown>;
  if (typeof rec.raw !== "string" || typeof rec.source !== "string") return null;
  if (rec.source !== "explicit_attribute" && rec.source !== "persistent_user_zone_name" && rec.source !== "friendly_name_heuristic") return null;
  return { raw: rec.raw, source: rec.source };
}

function extractMediaZones(raw: Record<string, unknown> | undefined): { id: string; label: string }[] {
  if (!Array.isArray(raw?.zones)) return [];
  return (raw.zones as unknown[]).filter(
    (z): z is { id: string; label: string } => !!z && typeof z === "object" && typeof (z as Record<string, unknown>).id === "string" && typeof (z as Record<string, unknown>).label === "string",
  );
}

/** Discover Devices workspace sections (§ Phase 5) — every discovered device lands in
 * exactly one, purely as a function of what the Confidence/Duplicate/Binding engines
 * already decided. Never a manual installer classification. */
export type KnxQueueSection = "ready" | "needs_review" | "duplicates" | "conflicts";

export interface KnxInstallerQueueItem {
  device: UnifiedKnxDevice;
  confidence: ConfidenceScores;
  room: RoomAssignmentResult;
  duplicate: DuplicateCheckResult;
  plans: BindingPlanItem[];
  section: KnxQueueSection;
}

export interface KnxApprovalResult {
  device: Awaited<ReturnType<CommissioningService["commission"]>>;
  status: "ready" | "warning" | "error";
  reason?: string;
}

/** Pure classification — a device lands in exactly one section, decided entirely by the
 * three engines that already ran (§ Phase 4), never a separate ad-hoc rule set. */
function knxQueueSection(decision: DuplicateDecision, confidence: ConfidenceScores, plans: BindingPlanItem[]): KnxQueueSection {
  if (decision === "merge" || decision === "update") return "duplicates";
  if (decision === "ask_installer") return "conflicts";
  if (confidence.overall < 70 || plans.length === 0 || !plans.every((p) => p.bindable)) return "needs_review";
  return "ready";
}

/** Discover Devices Summary (§ Discovery Validation) — aggregates data every engine in
 * the pipeline ALREADY computed (Phase 3 Unified Device Mapper, Phase 4 Confidence/
 * Binding/Duplicate Detection). Nothing here re-derives a number those engines didn't
 * already produce; this is purely a rollup for the installer to see before approval. */
export interface KnxDiscoverySummary {
  totalGroupAddresses: number;
  communicationObjects: number;
  circuitsCreated: number;
  devicesCreated: number;
  duplicateCircuits: number;
  unsupportedObjects: number;
  needsReviewCount: number;
  readyCount: number;
  discoveryDurationMs: number;
  groupAddressSchema: string;
}

function summarizeKnxQueue(queue: KnxInstallerQueueItem[], discoveryMs: number, schemaId: string | undefined): KnxDiscoverySummary {
  const communicationObjects = queue.reduce((n, item) => n + item.device.raw.communicationObjects.length, 0);
  return {
    // A "circuit" and the SupremeOS device it becomes are the same thing in this
    // pipeline (§ Universal Device Grouping — one circuit, one device, by design), so
    // both counts are real, not two different derivations of the same number.
    totalGroupAddresses: communicationObjects,
    communicationObjects,
    circuitsCreated: queue.length,
    devicesCreated: queue.length,
    duplicateCircuits: queue.filter((i) => i.section === "duplicates" || i.section === "conflicts").length,
    unsupportedObjects: queue.filter((i) => i.device.raw.deviceKind === "unknown" || i.device.capabilities.length === 0).length,
    needsReviewCount: queue.filter((i) => i.section === "needs_review").length,
    readyCount: queue.filter((i) => i.section === "ready").length,
    discoveryDurationMs: discoveryMs,
    groupAddressSchema: schemaId ?? "auto",
  };
}

/** What triggered a driver's pass through the Driver Lifecycle pipeline — recorded
 * purely for diagnostics/log clarity, never branched on (§ Driver Lifecycle: every
 * trigger runs the exact same stages). */
export type DriverLifecycleTrigger = "boot" | "install" | "reconnect" | "config_change";

export type DriverLifecycleStage =
  | "registering" | "validating" | "restoring_bindings" | "rebinding_devices"
  | "recalculating_ownership" | "publishing" | "ready" | "failed"
  // § Driver Lifecycle Completion — the teardown half (disable/uninstall/no-longer-
  // desired) previously had no visible transitional stage at all: `runDriverLifecycle`
  // went straight from whatever stage the driver was last in to being deleted from
  // `lifecycleStatus` entirely, so a driver mid-teardown looked identical to one that
  // had never existed. "stopping" is now set immediately before the real
  // unregister/disconnect work runs, giving Driver Diagnostics a real, observable
  // "Stop"/"Unbind"/"Destroy" moment (the underlying `SupremeNativeAdapter.
  // unregisterProtocol()` already releases every owned device's per-driver state
  // synchronously within this one stage — see native-adapter.ts).
  | "stopping";

export interface DriverLifecycleStatus {
  protocol: string;
  key: string;
  stage: DriverLifecycleStage;
  healthy: boolean;
  lastError: string | null;
  bindingCount: number;
  boundCount: number;
  ownedCount: number;
  reconnects: number;
  updatedAt: string;
}

export interface DriverDiagnosticsEntry {
  key: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  protocols: DriverLifecycleStatus[];
  healthy: boolean;
  lastError: string | null;
}

export interface InstallerDeps {
  config: GatewayConfig;
  sil: SupremeIntegrationLayer;
  home: HomeService;
  scenes: SceneService;
  identity: IdentityService;
  homeId: HomeId;
  driverStore?: IInstalledDriverStore;
  db?: SqlDb;
  scanners?: IProtocolScanner[];
  protocolBindingStore?: IProtocolBindingStore;
  /** Backup history store (§ Backup). When absent, backups aren't persisted (dev/in-memory). */
  backupStore?: IBackupStore;
  /** Pending-device queue (§ Device Approval). When absent, staging is a no-op. */
  pendingDeviceStore?: IPendingDeviceStore;
  /** Per-home settings store — backs the KNX import Learning Engine's remembered renames. */
  configStore: IConfigStore;
  /** Env-configured native driver instances (bootstrap.ts), keyed by protocol — fed
   * into the SAME Driver Lifecycle pipeline as manifest-configured drivers (§ Driver
   * Lifecycle: no duplicate registration logic). Not yet connected; the pipeline's
   * Register Driver stage connects them. */
  envDrivers?: Map<string, INativeProtocolDriver>;
}

/**
 * Installer/admin services (§9, §14): Driver Store, discovery + commissioning,
 * diagnostics, signed backup/restore, project export, and licensing. Bundled here
 * to keep the core {@link AppContext} focused. All trust is rooted in Ed25519 keys:
 * production injects the real Supreme store + licensing public keys; in dev these
 * are generated ephemerally so the surfaces are fully exercisable offline.
 */
export class InstallerServices {
  readonly drivers: DriverManager;
  readonly commissioning: CommissioningService;
  /** KNX import Learning Engine — remembers installer renames across re-imports (§ Learning Engine). */
  private readonly knxLearning: ConfigKnxLearningStore;

  private readonly d: InstallerDeps;
  private readonly backupKeys: KeyPairPem;
  /** Licensing private key is present only in dev (enables local issuance). */
  private readonly licensingKeys: { publicKey: string; privateKey: string | null };
  private license: License | null = null;
  /** Single source of truth for SKUs/features/driver licensing (Developer Mode + offline license). */
  readonly licenseService: LicenseService;
  /** Runtime Developer-Mode override (UI toggle), OR-ed with the SUPREME_DEV_MODE env flag. */
  private devModeOverride = false;

  constructor(deps: InstallerDeps) {
    this.d = deps;
    this.backupKeys = generateSigningKeyPair();

    // Driver Store trust: always seed a self-signed dev catalog so the store works
    // offline; also trust a config-provided production store key when present.
    const storeKeys = generateSigningKeyPair();
    const catalog = new InMemoryCatalog(
      seedFirstPartyCatalog(storeKeys.privateKey, "supreme-dev-store"),
    );
    const trustedKeys = new Map<string, string>([["supreme-dev-store", storeKeys.publicKey]]);
    if (deps.config.driverStorePublicKey) {
      trustedKeys.set(deps.config.driverStoreKeyId, deps.config.driverStorePublicKey);
    }
    this.drivers = new DriverManager({
      homeId: deps.homeId,
      catalog,
      trustedKeys,
      store: deps.driverStore,
      licensedSkus: () => this.licensedSkus(),
    });

    this.commissioning = new CommissioningService(deps.sil, deps.home, deps.scanners ?? []);
    this.knxLearning = new ConfigKnxLearningStore(deps.configStore);

    // Licensing Service — the single source of truth. Developer Mode (SUPREME_DEV_MODE) unlocks every
    // SKU + feature; otherwise the offline (signed) license, if any, supplies the grant. Drivers ask
    // this, never embed licensing. Sync providers → the first refresh settles before any install call.
    this.licenseService = new LicenseService([
      new DeveloperProvider(() => deps.config.devMode || this.devModeOverride),
      new CallbackProvider("offline", () => this.grantFromLicense()),
    ]);
    void this.licenseService.refresh();

    // Licensing: use the configured public key in prod; generate a dev pair so the
    // installer can issue + activate a license locally.
    this.licensingKeys = deps.config.licensingPublicKey
      ? { publicKey: deps.config.licensingPublicKey, privateKey: null }
      : generateSigningKeyPair();
  }

  /** Boot-time hydration: active license, then every native driver (env-configured AND
   *  manifest-configured alike) through the one unified {@link runDriverLifecycle}
   *  pipeline (§ Driver Lifecycle) — there is no longer a separate "rebind persisted
   *  bindings" pass that can race a separate "start manifest drivers" pass; both
   *  sources feed the same ordered sequence, per protocol, so a binding can never be
   *  replayed before the driver it needs exists. */
  async init(): Promise<void> {
    await this.loadLicense();
    await this.initializeNativeDrivers("boot");
  }

  private async loadLicense(): Promise<void> {
    if (!this.d.db) return;
    const { rows } = await this.d.db.query<{
      id: string;
      home_id: string;
      sku: string;
      seats: number;
      features: string[];
      issued_at: string;
      expires_at: string | null;
      signature: string;
    }>("SELECT * FROM licenses WHERE home_id=$1 ORDER BY issued_at DESC LIMIT 1", [this.d.homeId]);
    const r = rows[0];
    if (!r) return;
    const candidate = {
      id: r.id,
      homeId: r.home_id,
      sku: r.sku,
      seats: r.seats,
      features: r.features,
      issuedAt: r.issued_at,
      expiresAt: r.expires_at,
      signature: r.signature,
    };
    const res = validateLicense(candidate, this.licensingKeys.publicKey, { homeId: this.d.homeId });
    if (res.valid) {
      this.license = res.license;
      await this.licenseService.refresh();
    }
  }

  // ── Native protocol bindings (§3) ────────────────────────────────────────────

  /**
   * Bind a commissioned device's capability to a real bus address (KNX/Modbus/MQTT):
   * persist it and place it under the native engine so commands/state flow over the
   * bus. The protocol's driver must be configured on this hub (SUPREME_*_HOST/URL).
   */
  async bindProtocol(input: {
    deviceId: DeviceId;
    capability: CapabilityKind;
    protocol: string;
    address: string;
    config?: Record<string, unknown>;
  }): Promise<StoredProtocolBinding> {
    if (!this.d.sil.migrationEnabled) {
      throw new SupremeError("conflict", "native protocol binding is not enabled on this hub");
    }
    const binding: StoredProtocolBinding = {
      deviceId: input.deviceId,
      capability: input.capability,
      protocol: input.protocol,
      address: input.address,
      config: input.config ?? {},
    };
    // Bind first so a bad protocol/driver fails before we persist.
    await this.d.sil.bindNative(
      { deviceId: binding.deviceId, capability: binding.capability, address: binding.address, config: binding.config },
      binding.protocol,
    );
    await this.d.protocolBindingStore?.put(binding);
    // If the driver has a real AudioCapabilityConfig (inputs/sound modes/zones/
    // advancedControls) for this device now that it's bound, persist it onto the
    // device's capability config so the UI has real, capability-driven data to render
    // instead of an empty `{}` — never fabricated: null/undefined drivers leave it be.
    const config = await this.d.sil.getCapabilityConfig(binding.deviceId, binding.capability);
    if (config) await this.d.home.setCapabilityConfig(binding.deviceId, binding.capability, config);
    return binding;
  }

  listProtocolBindings(): Promise<StoredProtocolBinding[]> {
    return this.d.protocolBindingStore?.list() ?? Promise.resolve([]);
  }

  /**
   * Commission a device and, when it was discovered on a native bus, immediately bind
   * every capability to that bus (discover → commission → bind in one step). The bus
   * address defaults to the discovered `backendId`.
   */
  async commissionDevice(input: {
    backendId: string;
    name: string;
    /** Explicit installer choice — priority 1. Omit to let the Room Assignment Engine
     * resolve an existing/new room from `roomNameHint` (§ Universal Room Intelligence —
     * the SAME shared resolver every other commissioning path in this file uses). */
    roomId?: RoomId;
    /** A driver-reported room hint (a Casambi Group name, an ETS Function/Space, a
     * KNX IoT title, …) — `DiscoveredView.roomHint` threads straight through here from
     * whatever the SIL's discover() already found, never fabricated. */
    roomNameHint?: string | null;
    capabilities: CapabilityKind[];
    /** § ADR 0017 Capability Normalization — structural per-capability config a driver already
     * resolved at discovery time (e.g. Casambi's real RGB/CCT distinction from `unit.controls`),
     * threaded straight through to the persisted device — never derived from state here. */
    capabilityConfig?: Parameters<CommissioningService["commission"]>[0]["capabilityConfig"];
    supremeType?: Parameters<CommissioningService["commission"]>[0]["supremeType"];
    manufacturer?: string | null;
    model?: string | null;
    network?: Parameters<CommissioningService["commission"]>[0]["network"];
    protocol?: string;
    address?: string;
    config?: Record<string, unknown>;
    /** § Universal Commissioning Architecture — per-capability bind targets, for a device
     * whose capabilities live at DIFFERENT bus addresses (e.g. a KNX device with onoff at
     * one group address and brightness at another). Every commissioning path (auto-commit,
     * manual pairing, Pending Approval, KNX live-discovery approval, KNX ETS import) now
     * funnels through this ONE binding loop instead of each reimplementing it — pass
     * `bindings` when capabilities need distinct addresses/config; omit it (using the plain
     * `protocol`/`address`/`config` trio above) for the common single-address case. */
    bindings?: { capability: CapabilityKind; address: string; config?: Record<string, unknown> }[];
  }): Promise<Awaited<ReturnType<CommissioningService["commission"]>>> {
    const { protocol, address, config, bindings, roomNameHint, ...commissionInput } = input;
    const roomId = await this.resolveOrCreateRoom(input.roomId, roomNameHint ?? null, input.name);
    const device = await this.commissioning.commission({ ...commissionInput, roomId });
    if (bindings && protocol) {
      for (const b of bindings) {
        await this.bindProtocol({ deviceId: device.id, capability: b.capability, protocol, address: b.address, config: b.config });
      }
    } else if (protocol) {
      const busAddress = address ?? input.backendId;
      for (const capability of input.capabilities) {
        await this.bindProtocol({ deviceId: device.id, capability, protocol, address: busAddress, config });
      }
    }
    return device;
  }

  // ── Supreme KNX Unified Device Intelligence (§ Phase 5 — production installer flow) ──

  /** Builds a throwaway {@link SupremeKnxDriver} for DISCOVERY ONLY, from the same
   * config the live "knx" driver already uses (§ reuse, not redesign) — never used for
   * commands. Live command routing for approved devices still goes through whichever
   * driver is registered for the "knx" protocol via {@link bindProtocol} (unchanged;
   * see the KNX IoT Compatibility Report + each phase's Migration Notes for why the
   * production driver hasn't been cut over yet). */
  private async knxDiscoveryDriver(override?: { host: string; port?: number }): Promise<SupremeKnxDriver | null> {
    if (override) return new SupremeKnxDriver(override);
    // The manifest key is "supreme-knx" (§ manifests.ts) — match by protocol, the same
    // field NATIVE_DRIVER_FACTORIES is keyed by, not the catalog key (§ don't re-derive
    // a mapping that already exists elsewhere under a different name).
    const entry = (await this.drivers.registry()).find((e) => e.protocols.includes("knx") && e.installed);
    const host = entry?.config.host;
    if (typeof host !== "string" || host.length === 0) return null;
    const port = Number(entry?.config.port);
    return new SupremeKnxDriver({ host, port: Number.isFinite(port) ? port : undefined });
  }

  /** The installer's selected Group Address Schema (§ Configurable Group Address Schema
   * Engine — the manifest field added earlier; this is what actually WIRES it into
   * discovery). Returns `undefined` for "auto" (the manifest default) or when unset/not
   * configured — a positional schema is only ever force-applied when the installer
   * explicitly picked one, since the safe default is the schema-less trailing-operation-
   * word grouping every non-positional ETS export actually needs (see
   * `groupWithSchema`/`groupByCircuitName`). */
  private async knxConfiguredSchemaId(): Promise<string | undefined> {
    const entry = (await this.drivers.registry()).find((e) => e.protocols.includes("knx") && e.installed);
    const configured = entry?.config.groupAddressSchema;
    return typeof configured === "string" && configured.length > 0 && configured !== "auto" ? configured : undefined;
  }

  /** The existing installation's state, for {@link checkDuplicate} — read-only, derived
   * from the SAME stores every other diagnostic/listing endpoint already reads (never a
   * separate KNX-specific registry). */
  private async knxExistingState(): Promise<ExistingInstallationState> {
    const [devices, bindings] = await Promise.all([this.d.home.listDevices(), this.listProtocolBindings()]);
    const knxBindings = bindings.filter((b) => b.protocol === "knx");
    return {
      // The Supreme Device entity has no persisted `backendId` field (that mapping lives
      // in the SIL's EntityRegistryMirror, not the domain model) — re-discovery dedup
      // relies on the communicationObject/groupingKey checks below instead, which read
      // real, already-available data rather than guessing at a field that doesn't exist.
      backendIds: new Set(),
      boundAddresses: new Set(knxBindings.map((b) => b.address)),
      groupingKeys: new Set(devices.map((d) => d.name.toLowerCase())),
    };
  }

  /**
   * Production Discovery Pipeline (§ Phase 5): Scan → discoverUnified() → Confidence
   * Engine → Room Assignment → Duplicate Detection → Binding Engine → Installer Queue.
   * Every stage reuses the exact Phase 2-4 engine already built and tested — nothing
   * here re-implements grouping, capability detection, metadata merge, or binding
   * logic. No raw KNX object (group address string aside — see `communicationObjects`,
   * which is intentionally protocol-transparent, not protocol-LEAKING: it's shown to the
   * installer as "why", never used as a control) ever needs to leave this pipeline.
   */
  async knxInstallerQueue(opts: {
    ets?: UnifiedDeviceMapperInput["ets"];
    userOverrides?: UnifiedDeviceMapperInput["userOverrides"];
    /** Overrides the installed driver's configured gateway — e.g. for a hub with no
     * driver installed yet, or a test harness. Falls back to the installed "knx"
     * driver's own config when omitted (the real production path). */
    gateway?: { host: string; port?: number };
    /** Overrides the installed driver's configured Group Address Schema — e.g. for a
     * one-off "try this schema" preview before saving it. Falls back to the driver's
     * saved configuration when omitted (the real production path). */
    schemaId?: string;
    /** ETS Project Import (§ Unify ETS Import & Discovery Pipeline) — an ETS project is
     * just another SIGNAL SOURCE into the exact same Unified Device Mapper live
     * discovery already uses, never a second commissioning path. The parser (real,
     * existing XML/CSV/.esf/.knxproj parsing from @supreme/commissioning) only parses —
     * it never recognizes devices, assigns rooms, or commissions anything itself; every
     * group address it finds becomes a plain (id, name, room?) signal, merged with any
     * `opts.ets`/live KNX IoT signals and handed to the SAME discoverUnified() call
     * below. Room comes from the ETS project's own Function/Space tree when present
     * (real metadata, not guessed) and is still subject to the same "explicit signal
     * beats inference" merge priority every other signal source already follows. */
    etsSource?: { kind: "text"; content: string } | { kind: "knxproj"; base64: string; password?: string };
  } = {}): Promise<{ queue: KnxInstallerQueueItem[]; summary: KnxDiscoverySummary }> {
    const driver = await this.knxDiscoveryDriver(opts.gateway);
    if (!driver) throw new SupremeError("not_found", "the KNX driver is not configured on this hub yet");
    const schemaId = opts.schemaId ?? (await this.knxConfiguredSchemaId());

    let ets = opts.ets;
    if (opts.etsSource) {
      const source = opts.etsSource.kind === "knxproj"
        ? await this.knxProjectSource(opts.etsSource.base64, opts.etsSource.password)
        : { kind: "text" as const, content: opts.etsSource.content };
      const model = parseKnxSource(source);
      const etsSignals = knxSignalsFromModel(model);
      if (etsSignals.length === 0) throw new SupremeError("validation_failed", "no group addresses were found in this project — check that you exported the correct file, or that the ETS project isn't empty.");
      ets = [...(ets ?? []), ...etsSignals];
    }

    const startedAt = Date.now();
    const [devices, existing] = await Promise.all([
      driver.discoverUnified(ets, opts.userOverrides, schemaId),
      this.knxExistingState(),
    ]);
    const discoveryMs = Date.now() - startedAt;

    const queue = devices.map((device) => {
      const confidence = scoreConfidence(device);
      const room = assignRoom({ device });
      const duplicate = checkDuplicate(device, existing);
      const plans = planBindings(device);
      return { device, confidence, room, duplicate, plans, section: knxQueueSection(duplicate.decision, confidence, plans) };
    });

    return { queue, summary: summarizeKnxQueue(queue, discoveryMs, schemaId) };
  }

  /**
   * Approval (§ Phase 5): commission the device and bind every plan-supplied capability
   * to ITS OWN group address (unlike {@link commissionDevice}'s single shared address —
   * a real KNX circuit's write and status objects are genuinely different addresses per
   * capability, so this composes {@link CommissioningService.commission} + repeated
   * {@link bindProtocol} calls directly rather than reusing the single-address
   * convenience wrapper). On any binding failure, rolls back everything already bound
   * and the device itself — no half-registered device is ever left behind.
   */
  async approveKnxDevice(input: {
    device: UnifiedKnxDevice;
    name: string;
    /** Explicit installer choice — priority 1. Omit to let the Room Assignment Engine
     * resolve an existing/new room from `roomNameHint` (§ Automatic Room Creation). */
    roomId?: RoomId;
    /** The Room Assignment Engine's own suggestion (`item.room.room` from the queue) —
     * used to find-or-create a room only when `roomId` is not supplied. */
    roomNameHint?: string | null;
    plans: BindingPlanItem[];
  }): Promise<KnxApprovalResult> {
    const bindablePlans = input.plans.filter((p): p is typeof p & { address: string } => p.bindable && p.address !== null);
    if (bindablePlans.length === 0) {
      throw new SupremeError("validation_failed", "this device has no bindable communication object yet — needs installer review, not approval");
    }

    // § Universal Commissioning Architecture — converges on the SAME commissionDevice()
    // every other onboarding flow uses for room-resolution + Device Registry write; the
    // per-capability bind-with-rollback loop below stays local because it's a genuine,
    // KNX-specific safety behavior (undo everything on a binding failure) that the generic
    // wrapper doesn't (and, for other protocols, shouldn't) impose on every caller.
    const device = await this.commissionDevice({
      backendId: input.device.backendId,
      name: input.name,
      roomId: input.roomId,
      roomNameHint: input.roomNameHint ?? input.device.raw.metadata.room ?? null,
      capabilities: bindablePlans.map((p) => p.capability),
      manufacturer: input.device.raw.metadata.manufacturer ?? undefined,
      model: input.device.raw.metadata.model ?? undefined,
    });

    const bound: CapabilityKind[] = [];
    try {
      for (const plan of bindablePlans) {
        await this.bindProtocol({ deviceId: device.id, capability: plan.capability, protocol: "knx", address: plan.address, config: plan.config });
        bound.push(plan.capability);
      }
    } catch (err) {
      await this.rollbackKnxDevice(device.id, bound);
      return { device, status: "error", reason: `binding failed: ${(err as Error).message}` };
    }

    const validation = await this.validateKnxDevice(device.id);
    if (validation.status === "error") {
      await this.rollbackKnxDevice(device.id, bound);
    }
    return { device, ...validation };
  }

  /**
   * Live Validation (§ Phase 5): confirms the driver that owns this protocol actually
   * connected and actually took ownership of the device. A real read/write/feedback
   * telegram round-trip additionally requires a live bus and is NOT performed here —
   * this hub environment has no way to guarantee one exists at approval time, and
   * fabricating a "verified" result without one would violate the project's core
   * "never fabricate" rule. Diagnostics (§ Unified Diagnostics, Phase 3) remain the
   * place to observe real telegram traffic once the device is live.
   */
  private async validateKnxDevice(deviceId: DeviceId): Promise<{ status: "ready" | "warning" | "error"; reason?: string }> {
    const driver = this.d.sil.getNativeDriver("knx");
    if (!driver) return { status: "warning", reason: "no live KNX driver is currently registered to verify ownership against" };
    if (!driver.isConnected()) return { status: "warning", reason: "the KNX driver is not currently connected — device is bound but unverified" };
    if (!driver.manages(deviceId)) return { status: "error", reason: "the driver does not report owning this device after binding" };
    return { status: "ready" };
  }

  /** Rollback (§ Phase 5): undo every binding + the device registration itself — reuses
   * the exact cleanup primitives {@link uninstallDriver} already established for BUG-012
   * (never a second, parallel cleanup implementation). */
  private async rollbackKnxDevice(deviceId: DeviceId, boundCapabilities: CapabilityKind[]): Promise<void> {
    if (this.d.protocolBindingStore) {
      for (const capability of boundCapabilities) await this.d.protocolBindingStore.remove(deviceId, capability);
    }
    await this.d.home.removeDevices([deviceId]);
  }

  /**
   * Import an ETS group-address export (§4, KNX Import Engine): parse it with the full
   * recognition engine — device recognition, room assignment, entity generation — then
   * commission every recognized device and bind every capability to its KNX group
   * address. Turns a KNX project into ready-to-use device cards with almost zero manual
   * configuration. Kept as a one-shot path for API compatibility; {@link previewKnx} +
   * {@link commitKnxImport} is the installer-facing flow (review before saving).
   */
  async importKnx(content: string): Promise<KnxImportResult> {
    const result = await this.runImport({ kind: "text", content });
    return this.commissionImported(result.devices.map((d) => this.toEntitySource(d)));
  }

  /** `.knxproj` counterpart of {@link importKnx} — one-shot parse + commission. */
  async importKnxProject(base64: string, password?: string): Promise<KnxImportResult> {
    const result = await this.runImport(await this.knxProjectSource(base64, password));
    return this.commissionImported(result.devices.map((d) => this.toEntitySource(d)));
  }

  /**
   * Parse an ETS group-address export, `.esf`, or `.knxproj` WITHOUT committing anything —
   * runs the full KNX Import Engine (device recognition, automatic room assignment,
   * datapoint-driven circuit-type detection, learned-rename recall) and returns every
   * recognized device plus any non-fatal warnings (duplicate/missing/unknown DPTs, orphan
   * addresses, conflicting devices, …) for the installer to review before
   * {@link commitKnxImport} saves anything.
   */
  async previewKnx(content: string): Promise<KnxImportResultV2> {
    return this.runImport({ kind: "text", content });
  }

  /** `.knxproj` counterpart of {@link previewKnx} — same parse-only, no-commit contract;
   * also accepts a flat ETS group-address export or `.esf` inside the archive is NOT
   * expected here (use {@link previewKnx} for those) — this is specifically the binary
   * ETS project file path (base64-encoded, optionally WinZip-AES password-protected). */
  async previewKnxProject(base64: string, password?: string): Promise<KnxImportResultV2> {
    return this.runImport(await this.knxProjectSource(base64, password));
  }

  private async knxProjectSource(base64: string, password?: string): Promise<{ kind: "knxproj"; files: Map<string, Buffer> }> {
    try {
      return { kind: "knxproj", files: unzipKnxproj(Buffer.from(base64, "base64"), password) };
    } catch (err) {
      // A wrong/missing password on an encrypted project is a 401 so the UI can re-prompt.
      if (err instanceof KnxDecryptError) {
        const needsPassword = /password/i.test(err.message);
        throw new SupremeError("unauthorized", needsPassword
          ? "this .knxproj is password-protected — provide the ETS project password"
          : `could not decrypt .knxproj: ${err.message}`);
      }
      throw new SupremeError("validation_failed", `could not read .knxproj: ${(err as Error).message}`);
    }
  }

  /** Runs the KNX Import Engine against an already-resolved source, applying the home's
   * existing rooms + any previously-learned renames. Shared by every preview/import entry
   * point so they all see identical recognition/room-assignment/learning behavior. */
  private async runImport(source: Parameters<typeof runKnxImport>[0]): Promise<KnxImportResultV2> {
    const [existingRooms, learnedNames] = await Promise.all([
      this.d.home.listRooms(),
      this.knxLearning.get(this.d.homeId),
    ]);
    const result = runKnxImport(source, {
      existingRoomNames: existingRooms.map((r) => r.name),
      learnedNames,
    });
    if (result.stats.groupAddressCount === 0) {
      throw new SupremeError("validation_failed", "no group addresses found in the import");
    }
    if (result.devices.length === 0) {
      throw new SupremeError("validation_failed", "no devices could be recognized from this import (see warnings)");
    }
    return result;
  }

  private toEntitySource(d: RecognizedDevice): EntitySource {
    return { name: d.name, room: d.room, bindings: d.bindings };
  }

  /**
   * Save a (possibly installer-edited) KNX preview: commission every device the installer
   * left included, into the room they confirmed. This is the "save" step after
   * {@link previewKnx} / {@link previewKnxProject} — it never re-parses the source file,
   * only what the installer approved. Any name the installer typed that differs from the
   * device's own ETS-derived default is remembered by the Learning Engine so a future
   * re-import of an updated project preserves it.
   */
  async commitKnxImport(devices: (RecognizedDevice & { included?: boolean })[]): Promise<KnxImportResult> {
    const toCommit = devices.filter((d) => d.included !== false);
    if (toCommit.length === 0) {
      throw new SupremeError("validation_failed", "no devices selected to save");
    }
    for (const d of toCommit) {
      if (!d.name?.trim()) throw new SupremeError("validation_failed", "every device needs a name");
      if (!d.bindings || d.bindings.length === 0) throw new SupremeError("validation_failed", `${d.name}: no bindings`);
    }

    const existingLearned = await this.knxLearning.get(this.d.homeId);
    const learned = learnRenames(
      toCommit.map((d) => ({ fingerprint: d.fingerprint, name: d.name, sourceName: d.sourceName ?? d.name })),
      existingLearned,
      new Date().toISOString(),
    );
    if (learned.length !== existingLearned.length || learned.some((l, i) => l.name !== existingLearned[i]?.name)) {
      await this.knxLearning.set(this.d.homeId, learned);
    }

    return this.commissionImported(toCommit.map((d) => this.toEntitySource(d)));
  }

  /**
   * Auto-commission a native protocol's discovered devices into rooms in one step: read the driver's
   * discovery (each device carries its capabilities and, when the bus exposes one, a suggested room —
   * e.g. a Casambi group name), create any missing rooms, then commission + bind every capability to
   * its bus address. This is the "dynamic device → room assignment" path for live buses, mirroring the
   * KNX ETS import for projects. Returns the same summary shape as the KNX import.
   */
  async autoCommission(protocol: string): Promise<KnxImportResult> {
    const discovered = await this.d.sil.discover();
    const imported: EntitySource[] = discovered
      .filter((d) => (typeof d.raw?.protocol === "string" ? d.raw.protocol : "") === protocol)
      .map((d) => ({
        name: d.suggestedName,
        room: typeof d.raw?.room === "string" && d.raw.room.trim() ? d.raw.room : null,
        bindings: d.capabilities.map((capability) => ({ capability, address: d.backendId, statusAddress: null, role: "unknown", dpt: null })),
      }))
      .filter((d) => d.bindings.length > 0);
    if (imported.length === 0) {
      throw new SupremeError("validation_failed", `no ${protocol} devices discovered to commission`);
    }
    return this.commissionImported(imported, protocol);
  }

  /** Discover KNXnet/IP interfaces on the LAN (SEARCH_REQUEST multicast) so the installer can pick the
   * gateway host/port for the KNX driver config. Returns [] when none answer. */
  async discoverKnxInterfaces(): Promise<KnxGateway[]> {
    return knxSearch();
  }

  /**
   * Generic Room Assignment Engine — find-or-create (§ Automatic Room Creation): the ONE
   * place in the codebase that turns a room NAME (from any source — ETS Function/Space
   * metadata, a live-discovery group name, circuit-name inference, or an installer's
   * explicit override) into a real `RoomId`, creating the room only when nothing matching
   * already exists. Every commissioning path in this file (the legacy
   * {@link commissionImported} used by ETS one-shot import and {@link autoCommission}'s
   * live-bus flow, AND the Discovery Queue's {@link approveKnxDevice}) now shares this
   * single implementation instead of three copies of the same find-or-create logic —
   * this is what "lives in the common commissioning pipeline, not inside individual
   * drivers" means in practice: it's a method on the driver-agnostic installer service,
   * not on `SupremeKnxDriver` or any other protocol driver.
   *
   * Priority order:
   *   1. Explicit `roomId` override (installer already picked a real room) — used as-is.
   *   2. Existing SupremeOS room whose name matches `roomNameHint` under
   *      {@link normalizeRoomName} (case/punctuation/whitespace-insensitive — "R&D",
   *      "r&d", and "R & D" all resolve to the same room; "Living" and "Living Room"
   *      deliberately do NOT collapse into each other — normalization only strips
   *      formatting noise, it never drops or merges real words).
   *   3. No hint at all (a real gap seen on hardware where a driver reports no group/
   *      zone, e.g. Casambi luminaires with no Group assigned) — match `deviceName`
   *      against an EXISTING room name as a substring (longest name wins, so "Master
   *      Bedroom" beats "Bedroom"), e.g. "Pantry DL-1" → the existing "Pantry" room.
   *      Deliberately reuse-only: inferring a room from a name is safe when it confirms
   *      a room the installer already created, but fabricating a brand-new room from an
   *      arbitrary name substring (e.g. "Ethernet_Gateway_REV2.5_EVO") is not — that step
   *      needs the device-name vocabulary work, not something to fake here.
   *   4. Create a new room named `roomNameHint` (or "Unassigned" when no hint/match at all).
   */
  private async resolveOrCreateRoom(roomId: RoomId | undefined, roomNameHint: string | null, deviceName?: string): Promise<RoomId> {
    if (roomId) {
      await this.d.home.requireRoom(roomId);
      return roomId;
    }
    const existing = await this.d.home.listRooms();
    if (!roomNameHint?.trim() && deviceName) {
      const dn = deviceName.toLowerCase();
      const byName = existing
        .filter((r) => r.name.trim().length > 0 && dn.includes(r.name.trim().toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (byName) return byName.id;
    }
    const name = (roomNameHint ?? "").trim() || "Unassigned";
    const target = normalizeRoomName(name);
    const match = existing.find((r) => normalizeRoomName(r.name) === target);
    if (match) return match.id;
    const room: Room = {
      id: newId("room") as RoomId,
      homeId: this.d.homeId,
      name,
      building: null,
      floor: 0,
      area: null,
      areaType: "other",
      sortOrder: existing.length,
      icon: "home",
      heroImageUrl: null,
      parentRoomId: null,
    };
    await this.d.home.addRoom(room);
    return room.id;
  }

  /**
   * Auto-commission a media protocol's (AVR/HEOS/Yamaha) discovered devices with ZERO
   * installer interaction — the Universal AV Driver SDK's "Automatic Room Assignment" +
   * "Automatic Zone Generation" behavior. Unlike {@link autoCommission} (which takes
   * whatever bare `raw.room` string a driver supplies, with no confidence check), every
   * device here is resolved through {@link resolveRoomAssignment}: strong signals
   * (a HEOS/MusicCast persistent zone name) auto-create/auto-assign a room; weak or
   * absent signals (classic Denon Telnet, which genuinely has none) land in the fixed
   * "Unassigned Devices" room instead of guessing — never silently dropped, never a
   * fabricated room. A physical unit's extra zones (Yamaha's real, wire-queried
   * zone2/3/4 — see `yamaha-driver.ts`'s `discover()`) are auto-commissioned as their
   * own Supreme devices in the SAME room, sharing the SAME physical connection.
   *
   * Deliberately bypasses `CommissioningService.discover()` (like the older
   * {@link autoCommission}) because that method only queries registered Python
   * `IProtocolScanner`s when a protocol is given — AVR/HEOS/Yamaha are native TS
   * drivers surfaced through `sil.discover()` instead, so this reads from there
   * directly and replicates that method's own dedup (`registry.reverseLookup`) so a
   * repeat run never re-commissions an already-bound device or re-expands its zones.
   */
  async autoCommissionMedia(protocol: "avr" | "heos" | "yamaha"): Promise<MediaAutoCommissionResult> {
    const discovered = (await this.d.sil.discover())
      .filter((d) => (typeof d.raw?.protocol === "string" ? d.raw.protocol : "") === protocol)
      .filter((d) => !this.d.sil.registry.reverseLookup(d.backendId));
    if (discovered.length === 0) {
      throw new SupremeError("validation_failed", `no new ${protocol} devices discovered to commission`);
    }

    const existing = await this.d.home.listRooms();
    const roomByName = new Map(existing.map((r) => [r.name.toLowerCase(), r] as const));
    let roomsCreated = 0;
    let unassigned = 0;
    const created: MediaAutoCommissionResult["created"] = [];

    const resolveRoom = async (roomName: string): Promise<Room> => {
      const found = roomByName.get(roomName.toLowerCase());
      if (found) return found;
      const newRoom: Room = {
        id: newId("room") as RoomId,
        homeId: this.d.homeId,
        name: roomName,
        building: null,
        floor: 0,
        area: null,
        areaType: "other",
        sortOrder: existing.length + roomsCreated,
        icon: "home",
        heroImageUrl: null,
        parentRoomId: null,
      };
      await this.d.home.addRoom(newRoom);
      roomByName.set(roomName.toLowerCase(), newRoom);
      roomsCreated++;
      return newRoom;
    };

    for (const d of discovered) {
      const capabilities = d.capabilities as CapabilityKind[];
      const bindConfig = d.raw?.bindConfig && typeof d.raw.bindConfig === "object" && !Array.isArray(d.raw.bindConfig)
        ? (d.raw.bindConfig as Record<string, unknown>)
        : undefined;
      const locationHint = extractMediaLocationHint(d.raw);
      const decision = resolveRoomAssignment(locationHint, [...roomByName.values()].map((r) => r.name));
      const roomName = decision.kind === "assign" ? decision.roomName : UNASSIGNED_ROOM_NAME;
      const room = await resolveRoom(roomName);
      if (decision.kind === "unassigned") unassigned++;

      const device = await this.commissioning.commission({
        backendId: d.backendId,
        name: d.suggestedName,
        roomId: room.id,
        capabilities,
      });
      for (const capability of capabilities) {
        await this.bindProtocol({ deviceId: device.id, capability, protocol, address: d.backendId, config: bindConfig });
      }
      created.push({
        name: d.suggestedName,
        room: room.name,
        capabilities,
        confidence: decision.confidence,
        autoAssigned: decision.kind === "assign",
      });

      // §Automatic Zone Generation — extra zones this ONE physical unit genuinely has
      // (a real getFeatures query, see yamaha-driver.ts), each its own Supreme device
      // in the SAME room, sharing the SAME physical connection (address), differing
      // only by `config.zone`. Never attempted for a protocol that can't back it
      // honestly (Denon Telnet's Zone 2 stays a deliberate, documented manual step —
      // see avr-codec.ts — because the protocol has no wire-level way to detect it).
      const extraZones = extractMediaZones(d.raw).filter((z) => z.id !== (typeof bindConfig?.zone === "string" ? bindConfig.zone : "main"));
      for (const zone of extraZones) {
        const zoneName = `${d.suggestedName} ${zone.label}`;
        const zoneDevice = await this.commissioning.commission({
          backendId: `${d.backendId}#${zone.id}`,
          name: zoneName,
          roomId: room.id,
          capabilities,
        });
        for (const capability of capabilities) {
          await this.bindProtocol({
            deviceId: zoneDevice.id,
            capability,
            protocol,
            address: d.backendId,
            config: { ...bindConfig, zone: zone.id },
          });
        }
        created.push({ name: zoneName, room: room.name, capabilities, confidence: decision.confidence, autoAssigned: decision.kind === "assign" });
      }
    }

    return { devices: created.length, roomsCreated, unassigned, created };
  }

  /** Commission a parsed device list into rooms (creating rooms as needed via
   * {@link resolveOrCreateRoom}) + bind each capability, threading its recognized
   * `config` (real DPT, a separate status address when the source declared one, sensor
   * measure/unit) through to the native binding. */
  private async commissionImported(imported: EntitySource[], protocol = "knx"): Promise<KnxImportResult> {
    const before = await this.d.home.listRooms();
    const roomIds = new Set(before.map((r) => r.id));
    const created: { name: string; room: string | null; capabilities: string[] }[] = [];

    for (const dev of imported) {
      const entity = generateEntities(dev);
      // § Universal Commissioning Architecture — KNX ETS Import now converges on the SAME
      // commissionDevice() every other onboarding flow uses, instead of reimplementing
      // resolve-room + commission + per-capability-bind itself.
      const device = await this.commissionDevice({
        backendId: entity.bindings[0]!.address,
        name: entity.name,
        roomNameHint: entity.room,
        capabilities: entity.bindings.map((b) => b.capability as CapabilityKind),
        protocol,
        bindings: entity.bindings.map((b) => ({ capability: b.capability as CapabilityKind, address: b.address, config: b.config })),
      });
      created.push({ name: entity.name, room: entity.room, capabilities: entity.bindings.map((b) => b.capability) });
      roomIds.add(device.roomId!); // always assigned immediately after commissioning
    }
    return { devices: created.length, roomsCreated: roomIds.size - before.length, created };
  }

  // ── Licensing ──────────────────────────────────────────────────────────────

  /** The set of SKUs the home is entitled to — delegated to the Licensing Service (Dev Mode aware). */
  licensedSkus(): Set<string> {
    return this.licenseService.licensedSkuSet();
  }

  /** The unified driver registry (catalog + installed state + config schema), secrets masked. */
  async driverRegistry() {
    const entries = await this.drivers.registry();
    return entries.map((e) => ({ ...e, config: maskSecrets(e.config, e.configSchema) }));
  }

  /** An installed driver's config schema + current (masked) values, for its config page. */
  async getDriverConfig(id: DriverId) {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    if (!entry) throw new SupremeError("not_found", "driver not installed");
    return { key: entry.key, name: entry.name, schema: entry.configSchema, config: maskSecrets(entry.config, entry.configSchema) };
  }

  /** Validate + persist a driver's config, returning the masked result. */
  async setDriverConfig(id: DriverId, input: Record<string, unknown>) {
    const updated = await this.drivers.setConfig(id, input);
    this.appendLog(updated.key, "info", "Configuration updated");
    await this.reregisterDriver(updated.key); // apply the new config to the running native stack
    return this.getDriverConfig(id);
  }

  // ── Unified Driver Lifecycle (§ Native Driver Architecture Refactor) ──────────
  //
  // Every driver registration — boot, Extension Center install, driver update,
  // reconnect, gateway restart, config change, protocol migration — funnels through
  // ONE pipeline: Register Driver → Validate Driver → Register Protocol → Restore
  // Protocol Bindings → Rebind Devices → Recalculate Ownership → Publish Ownership
  // Changes → Driver Ready. There is no second, independent registration path
  // anymore (the previous env-array-at-boot vs. manifest-driven-at-init split was
  // the exact root cause of native commands silently executing through Home
  // Assistant — see the Architecture Investigation Report). A failed stage stops the
  // pipeline for that protocol, marks it unhealthy with a structured `lastError`, and
  // is visible via {@link driverDiagnostics} — never a silent catch.

  private readonly lifecycleStatus = new Map<string, DriverLifecycleStatus>();
  /** Protocols currently registered through this pipeline (env- or manifest-sourced
   * alike — the distinction no longer matters once both go through the same path). */
  private readonly desiredProtocols = new Map<string, { key: string; config: Record<string, unknown> }>();

  private setStage(protocol: string, patch: Partial<DriverLifecycleStatus>): void {
    const prev = this.lifecycleStatus.get(protocol) ?? {
      protocol, key: patch.key ?? protocol, stage: "registering" as const, healthy: false,
      lastError: null, boundCount: 0, ownedCount: 0, bindingCount: 0, reconnects: 0, updatedAt: "",
    };
    this.lifecycleStatus.set(protocol, { ...prev, ...patch, updatedAt: new Date().toISOString() });
  }

  /** Boot only: register every env-configured native driver (bootstrap.ts) through
   * this same pipeline, then reconcile the manifest-configured ones. Both sources
   * are now indistinguishable to the pipeline itself — that's the fix. */
  async initializeNativeDrivers(trigger: DriverLifecycleTrigger): Promise<void> {
    for (const [protocol, driver] of this.d.envDrivers ?? []) {
      await this.runDriverLifecycle(protocol, driver, `env:${protocol}`, trigger);
    }
    await this.reconcileManifestDrivers(trigger);
  }

  /** § Universal AVR SDK — the per-driver context every manifest-driven native factory
   * call gets: connection-lifecycle logging (unchanged) plus an artwork-proxy URL
   * builder, same real `publicBaseUrl`-based pattern `bootstrap.ts` already wires for
   * the env-only Apple TV driver — now available to any manifest-driven driver too
   * (AVR is the first to use it). `artworkUrlFor` is omitted entirely when
   * `publicBaseUrl` isn't configured (dev/local) rather than building a broken URL. */
  private nativeDriverContext(key: string): NativeDriverFactoryContext {
    return {
      onLog: (level, message) => this.appendLog(key, level, message),
      ...(this.d.config.publicBaseUrl
        ? { artworkUrlFor: (id: string) => `${this.d.config.publicBaseUrl}/v1/devices/${id}/media/artwork` }
        : {}),
      // § AVR Diagnostic Mode — off by default; see `GatewayConfig.avrDiagnostics`.
      avrDiagnostics: this.d.config.avrDiagnostics,
    };
  }

  /**
   * Reconcile installed+enabled+configured manifest drivers with their runtime native
   * protocol stacks: start what should run and isn't, stop what shouldn't. Runs on
   * boot AND after every install/enable/config-change (§ Driver Lifecycle — same
   * pipeline for every trigger, not a boot-only special case).
   */
  private async reconcileManifestDrivers(trigger: DriverLifecycleTrigger): Promise<void> {
    const reg = await this.drivers.registry();
    const desired = new Map<string, { config: Record<string, unknown>; key: string }>();
    for (const d of reg) {
      if (!d.installed || !d.enabled) continue;
      if (!isConfigComplete(d.configSchema, d.config).complete) continue;
      for (const p of d.protocols) if (hasNativeFactory(p)) desired.set(p, { config: d.config, key: d.key });
    }
    for (const [protocol, { config, key }] of desired) {
      this.desiredProtocols.set(protocol, { key, config });
      const driver = buildNativeDriver(protocol, config, this.nativeDriverContext(key));
      await this.runDriverLifecycle(protocol, driver, key, trigger);
    }
    for (const [protocol, { key }] of [...this.desiredProtocols]) {
      if (protocol.startsWith("env:")) continue;
      if (!desired.has(protocol) && !(this.d.envDrivers?.has(protocol))) {
        this.desiredProtocols.delete(protocol);
        await this.runDriverLifecycle(protocol, null, key, "config_change");
      }
    }
  }

  /** Force one installed driver's native stack to match its current install/enable/
   * config state — Extension Center install/enable/disable/config-edit all call this,
   * which is itself just this protocol's slice of {@link runDriverLifecycle}. */
  private async reregisterDriver(key: string): Promise<void> {
    const entry = (await this.drivers.registry()).find((e) => e.key === key);
    if (!entry) return;
    for (const protocol of entry.protocols) {
      if (!hasNativeFactory(protocol)) continue;
      const runnable = entry.installed && entry.enabled && isConfigComplete(entry.configSchema, entry.config).complete;
      const driver = runnable ? buildNativeDriver(protocol, entry.config, this.nativeDriverContext(key)) : null;
      if (runnable) this.desiredProtocols.set(protocol, { key, config: entry.config });
      else this.desiredProtocols.delete(protocol);
      await this.runDriverLifecycle(protocol, driver, key, "config_change");
    }
  }

  /**
   * The one driver-registration pipeline (§ Registration Pipeline). `driver === null`
   * is the teardown variant (disable/uninstall/no-longer-desired): every device this
   * protocol owned has its ownership explicitly cleared — released back to
   * "unassigned", never silently left pointing at a dead driver and never silently
   * defaulted to Home Assistant.
   */
  private async runDriverLifecycle(
    protocol: string,
    driver: INativeProtocolDriver | null,
    key: string,
    trigger: DriverLifecycleTrigger,
  ): Promise<void> {
    if (!driver) {
      // § Driver Lifecycle Completion — Stop → Unbind → Destroy, made observable
      // (previously the driver just vanished from `lifecycleStatus` with no visible
      // transitional state). `unregisterNativeProtocol` is idempotent (a no-op if
      // already stopped, see `SupremeNativeAdapter.unregisterProtocol`), so repeated
      // teardown calls for the same protocol are always safe.
      this.setStage(protocol, { stage: "stopping" });
      const owned = this.d.sil.ownership.devicesOwnedByProtocol(protocol);
      await this.d.sil.unregisterNativeProtocol(protocol); // Stop + Unbind (every owned device's driver-level state released) + Destroy (driver instance dereferenced)
      for (const deviceId of owned) await this.d.sil.ownership.clear(deviceId);
      this.appendLog(key, "info", `Native ${protocol} driver stopped (${trigger})${owned.length ? ` — ${owned.length} device(s) released to unassigned` : ""}`);
      this.lifecycleStatus.delete(protocol);
      return;
    }

    const isReconnect = this.lifecycleStatus.get(protocol)?.stage === "ready" && trigger === "reconnect";
    this.setStage(protocol, { key, stage: "registering", lastError: null, reconnects: (this.lifecycleStatus.get(protocol)?.reconnects ?? 0) + (isReconnect ? 1 : 0) });
    try {
      await this.d.sil.registerNativeDriver(driver); // Register Driver + Register Protocol (native-adapter connects here)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStage(protocol, { stage: "failed", healthy: false, lastError: message });
      this.appendLog(key, "error", `Failed to register native ${protocol} driver (${trigger}): ${message}`);
      return; // structured failure — visible in diagnostics, never silent
    }

    this.setStage(protocol, { stage: "validating" });
    const connStatus = this.d.sil.nativeProtocolStatus().find((s) => s.protocol === protocol);
    if (connStatus?.error) {
      this.appendLog(key, "warn", `Native ${protocol} driver registered but failed to connect (${trigger}): ${connStatus.error}`);
    } else {
      this.appendLog(key, "info", `Native ${protocol} driver connected (${trigger})`);
    }

    this.setStage(protocol, { stage: "restoring_bindings" });
    const store = this.d.protocolBindingStore;
    const bindings = store ? (await store.list()).filter((b) => b.protocol === protocol) : [];

    this.setStage(protocol, { stage: "rebinding_devices", bindingCount: bindings.length });
    let bound = 0;
    const failures: string[] = [];
    for (const b of bindings) {
      try {
        await this.d.sil.bindNative({ deviceId: b.deviceId, capability: b.capability, address: b.address, config: b.config }, protocol);
        bound++;
      } catch (err) {
        failures.push(`${b.deviceId}/${b.capability}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length) {
      // A failed bind must never be invisible (§ Silent Failures) — structured log +
      // health warning, surfaced per-driver via driverDiagnostics().
      this.appendLog(key, "error", `${failures.length}/${bindings.length} device binding(s) failed to restore for ${protocol}: ${failures.join("; ")}`);
    }

    this.setStage(protocol, { stage: "recalculating_ownership", boundCount: bound });
    const ownedCount = this.d.sil.ownership.devicesOwnedByProtocol(protocol).length;

    this.setStage(protocol, { stage: "publishing", ownedCount });
    this.appendLog(key, failures.length ? "warn" : "info", `${bound}/${bindings.length} device binding(s) restored for ${protocol} (${trigger})`);

    this.setStage(protocol, { stage: "ready", healthy: !connStatus?.error, lastError: connStatus?.error ?? null });
  }

  /** Driver Diagnostics (§ Diagnostics): every driver's full lifecycle picture in one
   * place — no log-reading required to answer "is this driver actually working". */
  async driverDiagnostics(): Promise<DriverDiagnosticsEntry[]> {
    const reg = await this.drivers.registry();
    const out: DriverDiagnosticsEntry[] = [];
    for (const entry of reg) {
      const protocolEntries = entry.protocols.map((p) => this.lifecycleStatus.get(p)).filter((s): s is DriverLifecycleStatus => !!s);
      out.push({
        key: entry.key,
        name: entry.name,
        installed: entry.installed,
        enabled: entry.enabled,
        protocols: protocolEntries,
        lastError: protocolEntries.find((p) => p.lastError)?.lastError ?? null,
        healthy: protocolEntries.length === 0 || protocolEntries.every((p) => p.healthy),
      });
    }
    return out;
  }

  /** In-memory per-driver log ring buffer (lifecycle + connection events). */
  private readonly driverLogEntries = new Map<string, Array<{ ts: string; level: string; message: string }>>();
  private appendLog(key: string, level: "info" | "warn" | "error", message: string): void {
    const arr = this.driverLogEntries.get(key) ?? [];
    arr.push({ ts: new Date().toISOString(), level, message });
    if (arr.length > 200) arr.shift();
    this.driverLogEntries.set(key, arr);
    this.pushSystemLog(key, level, message);
  }

  /** Recent log entries for an installed driver. */
  async driverLogs(id: DriverId): Promise<{ key: string; entries: Array<{ ts: string; level: string; message: string }> }> {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    if (!entry) throw new SupremeError("not_found", "driver not installed");
    return { key: entry.key, entries: this.driverLogEntries.get(entry.key) ?? [] };
  }

  /**
   * The unified system log (§ Settings → Logs): every driver lifecycle event (install/
   * enable/connect/disconnect/native-connection), plus device control operation outcomes —
   * one place to see "what's SupremeOS actually doing", not scattered per-driver panels.
   * In-memory ring buffer; a hub restart clears it, same tradeoff `driverLogEntries` already
   * makes (this is diagnostics, not the tamper-evident audit trail — see @supreme/audit for that).
   */
  private readonly systemLog: Array<{ ts: string; level: "info" | "warn" | "error"; source: string; message: string }> = [];
  private pushSystemLog(source: string, level: "info" | "warn" | "error", message: string): void {
    this.systemLog.push({ ts: new Date().toISOString(), level, source, message });
    if (this.systemLog.length > 1000) this.systemLog.shift();
  }

  /** Log a non-driver-scoped system event (e.g. a device control operation) into the unified log. */
  logEvent(source: string, level: "info" | "warn" | "error", message: string): void {
    this.pushSystemLog(source, level, message);
  }

  /** Recent system log entries, newest first. */
  systemLogs(limit = 300): Array<{ ts: string; level: "info" | "warn" | "error"; source: string; message: string }> {
    return this.systemLog.slice(-limit).reverse();
  }

  /** Per-driver health: install/enable state, config completeness, and native connectivity. */
  async driverHealth(id: DriverId) {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    if (!entry) throw new SupremeError("not_found", "driver not installed");
    const { complete, missing } = isConfigComplete(entry.configSchema, entry.config);
    const protoStatus = this.d.sil.nativeProtocolStatus();
    const status = entry.protocols.map((p) => protoStatus.find((s) => s.protocol === p)).find(Boolean);
    const connected = status ? status.connected : null;
    const connectError = status?.error ?? null;
    const verdict = !entry.enabled ? "disabled" : connectError ? "error" : !complete ? "not_configured" : "healthy";
    return {
      key: entry.key,
      name: entry.name,
      installed: entry.installed,
      enabled: entry.enabled,
      status: entry.status,
      configComplete: complete,
      missing,
      connected,
      connectError,
      verdict,
      logCount: (this.driverLogEntries.get(entry.key) ?? []).length,
    };
  }

  /** Connect a driver's native protocol stack(s) — the "reconnect" trigger (§ Driver
   * Lifecycle). The driver instance itself isn't replaced here (that's the
   * install/config-change path, {@link runDriverLifecycle}'s Register Driver stage),
   * so existing bindings/ownership are untouched; this just re-establishes the bus
   * connection and records the reconnect for diagnostics. */
  async connectDriver(id: DriverId): Promise<{ connected: boolean }> {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    if (!entry) throw new SupremeError("not_found", "driver not installed");
    let connected = false;
    for (const p of entry.protocols) {
      if (await this.d.sil.connectNativeProtocol(p)) {
        connected = true;
        const prev = this.lifecycleStatus.get(p);
        if (prev) this.setStage(p, { stage: "ready", healthy: true, lastError: null, reconnects: prev.reconnects + 1 });
      }
    }
    this.appendLog(entry.key, connected ? "info" : "warn", connected ? "Connected" : "No native driver to connect (managed by backend)");
    return { connected };
  }

  /** Disconnect a driver's native protocol stack(s). */
  async disconnectDriver(id: DriverId): Promise<{ disconnected: boolean }> {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    if (!entry) throw new SupremeError("not_found", "driver not installed");
    let disconnected = false;
    for (const p of entry.protocols) if (await this.d.sil.disconnectNativeProtocol(p)) disconnected = true;
    this.appendLog(entry.key, "info", disconnected ? "Disconnected" : "No native driver to disconnect");
    return { disconnected };
  }

  /** Toggle the runtime Developer-Mode override and re-resolve the license. */
  async setDevMode(enabled: boolean): Promise<void> {
    this.devModeOverride = enabled;
    await this.licenseService.refresh();
  }

  /** Translate a stored signed License into a LicenseService grant (tier-expanded SKUs). */
  private grantFromLicense(): ProviderGrant | null {
    if (!this.license) return null;
    const idx = SKU_TIERS.indexOf(this.license.sku as (typeof SKU_TIERS)[number]);
    const skus = idx >= 0 ? SKU_TIERS.slice(0, idx + 1) : [this.license.sku];
    const tier: LicenseTier = this.license.sku === "estate" ? "enterprise" : this.license.sku === "pro" ? "professional" : "home";
    return makeGrant({
      source: "offline",
      licenseType: this.license.sku === "estate" ? "enterprise" : "professional",
      tier,
      skus: [...skus],
      features: this.license.features ?? [],
      expiresAt: this.license.expiresAt ?? null,
      licenseId: this.license.id,
    });
  }

  licenseStatus() {
    return {
      licensed: this.license !== null,
      skus: [...this.licensedSkus()],
      features: this.license?.features ?? [],
      license: this.license,
      // The richer Licensing Service view (type, tier, devMode, full feature set, sources).
      service: this.licenseService.status(),
    };
  }

  /** Validate + activate a license token (offline), persisting it when a DB exists. */
  async activateLicense(token: License): Promise<void> {
    const res = validateLicense(token, this.licensingKeys.publicKey, { homeId: this.d.homeId });
    if (!res.valid) throw new SupremeError("forbidden", `invalid license: ${res.reason}`);
    this.license = res.license;
    if (this.d.db) {
      await this.d.db.query(
        `INSERT INTO licenses (id, home_id, sku, seats, features, issued_at, expires_at, signature)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET sku=$3, seats=$4, features=$5::jsonb, expires_at=$7, signature=$8`,
        [res.license.id, res.license.homeId, res.license.sku, res.license.seats,
          JSON.stringify(res.license.features), res.license.issuedAt, res.license.expiresAt, res.license.signature],
      );
    }
    await this.licenseService.refresh();
  }

  /** Dev-only: issue a license with the local licensing key (cloud does this in prod). */
  devIssueLicense(input: { sku: string; seats: number; features?: string[]; expiresAt?: string | null }): License {
    if (!this.licensingKeys.privateKey) {
      throw new SupremeError("forbidden", "license issuance requires the cloud licensing key");
    }
    return issueLicense({ homeId: this.d.homeId, ...input }, this.licensingKeys.privateKey);
  }

  // ── Discovery & commissioning ────────────────────────────────────────────────

  discover(protocol?: ProtocolKind) {
    return this.commissioning.discover(protocol);
  }

  /**
   * Installed-driver names visible in the registry (§ Discovery Driver Selector) — the
   * SAME source of truth Extension Center already uses, never a second registry. Only
   * installed drivers that expose a `protocol` are discovery-relevant (the KNX Group
   * Address Schema field, for example, has none).
   */
  async discoverableDrivers(): Promise<{ installedId: string; key: string; name: string; protocols: string[] }[]> {
    const reg = await this.drivers.registry();
    return reg
      .filter((d) => d.installed && d.installedId && d.protocols.length > 0)
      .map((d) => ({ installedId: d.installedId!, key: d.key, name: d.name, protocols: d.protocols }));
  }

  /**
   * Discovery Driver Selector backend (§ Priority 4): `driverIds` (installed-driver ids
   * from {@link discoverableDrivers}) resolve to their protocols, which actually gate
   * which drivers run — `SupremeIntegrationLayer.discoverWithStatus` never scans an
   * excluded driver, this is not a result filter. Every returned device is tagged with
   * its SOURCE DRIVER's user-facing name (never an internal engine/provider name — "KNX
   * Ultimate"/"KNX IoT Provider" stay invisible), and per-driver failures are isolated
   * (§ Driver Failure Isolation) so one bad connection never discards the rest.
   */
  async discoverWithStatus(driverIds?: string[]): Promise<{
    discovered: (Awaited<ReturnType<CommissioningService["discover"]>>[number] & { driverName: string | null })[];
    driverResults: { protocol: string; driverName: string; status: "complete" | "failed"; count: number; error?: string }[];
  }> {
    const drivers = await this.discoverableDrivers();
    const nameByProtocol = new Map<string, string>();
    for (const d of drivers) for (const p of d.protocols) nameByProtocol.set(p, d.name);

    const protocols = driverIds
      ? drivers.filter((d) => driverIds.includes(d.installedId)).flatMap((d) => d.protocols)
      : undefined;
    const { discovered, driverResults } = await this.commissioning.discoverWithStatus(protocols);
    return {
      discovered: discovered.map((d) => ({ ...d, driverName: (d.protocol && nameByProtocol.get(d.protocol)) ?? null })),
      driverResults: driverResults.map((r) => ({ ...r, driverName: nameByProtocol.get(r.protocol) ?? r.protocol })),
    };
  }

  // ── Device Approval (§ Device Approval) ──────────────────────────────────────

  /**
   * A device is "ordinary" (§ Priority 1 — auto-commission, no installer approval needed) when
   * it has a real capability set AND a reliable room signal — either the driver's own roomHint,
   * or its name matching a room that already exists. Genuinely exceptional devices (no usable
   * capability, or no room signal at all — an ambiguous assignment resolveOrCreateRoom would
   * otherwise have to dump into "Unassigned") still go to Pending Approval for an installer
   * decision. Driver-independent: no protocol check anywhere in this method.
   */
  private canAutoCommission(d: { capabilities: readonly string[]; roomHint?: string | null; suggestedName: string }, rooms: Room[]): boolean {
    if (d.capabilities.length === 0) return false;
    if (d.roomHint?.trim()) return true;
    const dn = d.suggestedName.toLowerCase();
    return rooms.some((r) => r.name.trim().length > 0 && dn.includes(r.name.trim().toLowerCase()));
  }

  /**
   * Scan every technology. Ordinary devices (§ Priority 1 — see {@link canAutoCommission}) are
   * committed straight through the SAME shared pipeline direct pairing already uses
   * (commissionDevice -> resolveOrCreateRoom -> Device Registry -> Room -> Category -> Canonical
   * Device Router) with zero installer action — Pending Approval is reserved for genuine
   * exceptions (unsupported capabilities, or a room that can't be reliably resolved). Devices
   * already owned never reach here at all (commissioning's discover() dedupe already excludes
   * them), so repeated scans neither re-stage nor re-commission anything.
   */
  async scanForApproval(protocol?: ProtocolKind, driverIds?: string[]): Promise<PendingDeviceRecord[]> {
    const found = driverIds ? (await this.discoverWithStatus(driverIds)).discovered : await this.commissioning.discover(protocol);
    const store = this.d.pendingDeviceStore;
    const rooms = await this.d.home.listRooms();
    // A device staged as pending BEFORE it became auto-commissionable (a room it now matches
    // was just created, say) must not stay stuck in the queue forever just because nothing
    // ever re-evaluates already-staged rows — key by backendId so the auto-commit branch below
    // can clean up its own stale pending record once it successfully commissions.
    let existingPending = store ? await store.list(this.d.homeId) : [];
    // Self-heal: a pending row whose backendId is already OWNED (commissioned some other way —
    // e.g. auto-committed on a prior scan, or approved directly) is orphaned and would otherwise
    // sit in the queue forever, since discover() correctly excludes owned devices from `found`
    // going forward, so the loop below would never reach it again to clean it up.
    if (store) {
      for (const p of existingPending) {
        if (this.d.sil.registry.reverseLookup(p.backendId)) await store.remove(this.d.homeId, p.id);
      }
      existingPending = existingPending.filter((p) => !this.d.sil.registry.reverseLookup(p.backendId));
    }
    const existingPendingByBackendId = new Map(existingPending.map((p) => [p.backendId, p.id]));
    if (store) {
      const seenAt = new Date().toISOString();
      for (const d of found) {
        if (this.canAutoCommission(d, rooms)) {
          try {
            await this.commissionDevice({
              backendId: d.backendId,
              name: d.suggestedName,
              roomNameHint: d.roomHint,
              capabilities: d.capabilities as CapabilityKind[],
              // § ADR 0017 Capability Normalization — same-tick from discovery, never
              // round-tripped through the pending-device table (that path still falls back to
              // state inference; see the ADR's disclosed gap).
              ...(d.capabilityConfig ? { capabilityConfig: d.capabilityConfig } : {}),
              ...(d.protocol ? { protocol: d.protocol } : {}),
              ...(d.network ? { network: d.network } : {}),
            });
            const stalePendingId = existingPendingByBackendId.get(d.backendId);
            if (stalePendingId) await store.remove(this.d.homeId, stalePendingId);
            continue; // auto-commissioned — never (or no longer) staged as pending
          } catch {
            // Fall through to Pending Approval on any commissioning failure — a device is
            // never silently dropped just because the "ordinary" fast path failed.
          }
        }
        await store.upsert({
          homeId: this.d.homeId,
          backendId: d.backendId,
          suggestedName: d.suggestedName,
          protocol: d.protocol ?? null,
          source: d.source,
          capabilities: d.capabilities as string[],
          network: d.network ?? null,
          seenAt,
          newId: newId("device") as string,
          // Universal Room Intelligence (§ Priority 4): whatever room hint the driver's
          // own discovery reported (a Casambi Group, an ETS Function/Space, …) survives
          // into the pending queue so approval can resolve it the same way the direct-
          // commission path already does — never dropped here either.
          roomHint: d.roomHint ?? null,
          // Capability Normalization Pipeline (§ ADR 0018): a driver-normalized capability
          // config must survive Pending Approval exactly like roomHint does — never lost just
          // because a device needed an installer decision instead of auto-committing.
          capabilityConfig: d.capabilityConfig ?? null,
        });
      }
    }
    return this.listPendingDevices();
  }

  listPendingDevices(): Promise<PendingDeviceRecord[]> {
    return this.d.pendingDeviceStore ? this.d.pendingDeviceStore.list(this.d.homeId) : Promise.resolve([]);
  }

  private async requirePending(id: string): Promise<PendingDeviceRecord> {
    const rec = this.d.pendingDeviceStore ? await this.d.pendingDeviceStore.get(this.d.homeId, id) : null;
    if (!rec) throw new SupremeError("not_found", "pending device not found");
    return rec;
  }

  /**
   * Approve a pending device: commission it into a room (reusing the commissioning service — no
   * duplicate device path), carrying over its captured protocol + network, then drop it from the
   * queue. Optional overrides let the installer rename / pick the room at approval time.
   */
  async approvePendingDevice(id: string, input: { name?: string; roomId?: RoomId; capabilities?: CapabilityKind[] }) {
    const rec = await this.requirePending(id);
    const device = await this.commissionDevice({
      backendId: rec.backendId,
      name: input.name?.trim() || rec.suggestedName,
      // Explicit installer choice (priority 1) — omit to let resolveOrCreateRoom find/
      // create a room from the pending record's own roomHint (§ Universal Room
      // Intelligence), exactly like the direct-commission path.
      roomId: input.roomId,
      roomNameHint: rec.roomHint,
      capabilities: (input.capabilities ?? (rec.capabilities as CapabilityKind[])),
      // § ADR 0018 — the SAME structural capability config discovery resolved, carried through
      // Pending Approval instead of being lost, producing the identical persisted device the
      // auto-commit fast path would have produced for this same device.
      ...(rec.capabilityConfig ? { capabilityConfig: rec.capabilityConfig as Parameters<InstallerServices["commissionDevice"]>[0]["capabilityConfig"] } : {}),
      ...(rec.protocol ? { protocol: rec.protocol } : {}),
      ...(rec.network ? { network: rec.network } : {}),
    });
    await this.d.pendingDeviceStore?.remove(this.d.homeId, id);
    return device;
  }

  /** Reject a pending device — kept as a `rejected` record so a re-scan doesn't resurface it. */
  async rejectPendingDevice(id: string): Promise<void> {
    await this.requirePending(id);
    await this.d.pendingDeviceStore?.setStatus(this.d.homeId, id, "rejected");
  }

  /** Remove a pending device entirely (a future scan may surface it again). */
  async removePendingDevice(id: string): Promise<void> {
    await this.requirePending(id);
    await this.d.pendingDeviceStore?.remove(this.d.homeId, id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────────

  async diagnostics() {
    const [rooms, devices, scenes, drivers, users] = await Promise.all([
      this.d.home.listRooms(),
      this.d.home.listDevices(),
      this.d.scenes.list(),
      this.drivers.listInstalled(),
      this.d.identity.listUsers(),
    ]);
    return {
      hubVersion: this.d.config.hubVersion,
      backend: { kind: this.d.sil.backendKind, healthy: this.d.sil.isHealthy() },
      counts: {
        rooms: rooms.length,
        devices: devices.length,
        scenes: scenes.length,
        drivers: drivers.length,
        users: users.length,
      },
      drivers: drivers.map((d) => ({ key: d.key, version: d.version, enabled: d.enabled, status: d.status })),
      offlineDevices: devices
        .filter((d) => d.status !== "online")
        .map((d) => ({ id: d.id, name: d.name })),
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Project export ───────────────────────────────────────────────────────────

  async projectExport() {
    const [home, rooms, devices, scenes, drivers] = await Promise.all([
      this.d.home.getHome(),
      this.d.home.listRooms(),
      this.d.home.listDevices(),
      this.d.scenes.list(),
      this.drivers.listInstalled(),
    ]);
    const roomName = (id: string | null) => rooms.find((r) => r.id === id)?.name ?? null;
    return {
      exportedAt: new Date().toISOString(),
      hubVersion: this.d.config.hubVersion,
      home: { name: home?.name ?? "", tier: home?.tier ?? "signature" },
      rooms: rooms.map((r) => ({ name: r.name, areaType: r.areaType })),
      devices: devices.map((d) => ({
        name: d.name,
        supremeType: d.supremeType,
        room: roomName(d.roomId),
        capabilities: d.capabilities.map((c) => c.kind),
      })),
      scenes: scenes.map((s) => ({ name: s.name, steps: s.steps.length })),
      drivers: drivers.map((d) => ({ key: d.key, version: d.version, enabled: d.enabled })),
    };
  }

  // ── Backup / restore (§ Backup: history, schedule, dry-run, rollback, health) ──

  /** Create + sign a backup, persist it to the history (pruning to the retention limit), and return
   * its meta + document. `source` distinguishes manual vs scheduled runs. */
  async createBackup(source = "manual") {
    const db = this.requireDb();
    const signed = signBackup(await createBackup(db), this.backupKeys.privateKey);
    const document = serializeBackup(signed);
    const meta = signed.bundle.meta;
    if (this.d.backupStore) {
      await this.d.backupStore.save({
        id: meta.id,
        homeId: this.d.homeId,
        createdAt: meta.createdAt,
        schemaVersion: meta.schemaVersion,
        tableCount: meta.tableCount,
        rowCount: meta.rowCount,
        source,
        document,
      });
      const { retain } = await this.getBackupSchedule();
      await this.d.backupStore.prune(this.d.homeId, retain);
    }
    return { meta, document };
  }

  /** Parse a backup document (throws a clean error on bad JSON). */
  private parseBackup(document: string): SignedBackup {
    try {
      return JSON.parse(document) as SignedBackup;
    } catch {
      throw new SupremeError("validation_failed", "backup document is not valid JSON");
    }
  }

  /** Dry-run: verify + report exactly what a restore would write, without touching the database. */
  inspectRestore(document: string): BackupInspection {
    return inspectBackup(this.parseBackup(document), { publicKeyPem: this.backupKeys.publicKey });
  }

  /**
   * Rollback-safe restore. Takes a safety snapshot of the current state first; if the restore fails
   * partway, the snapshot is re-applied so the hub is never left in a half-restored state.
   */
  async restore(document: string): Promise<{ tables: number; rows: number; rolledBack: boolean }> {
    const db = this.requireDb();
    const signed = this.parseBackup(document);
    // Verify up-front so an invalid backup never triggers the (destructive) restore path.
    const inspection = inspectBackup(signed, { publicKeyPem: this.backupKeys.publicKey });
    if (inspection.signatureValid === false) {
      throw new SupremeError("validation_failed", "backup signature verification failed");
    }
    const safety = signBackup(await createBackup(db), this.backupKeys.privateKey);
    try {
      const result = await restoreBackup(db, signed, { publicKeyPem: this.backupKeys.publicKey });
      await this.setConfigJson("backup_last_restore", { at: new Date().toISOString(), rows: result.rows });
      return { ...result, rolledBack: false };
    } catch (err) {
      // Roll back to the pre-restore snapshot; surface the original failure either way.
      try {
        await restoreBackup(db, safety);
      } catch {
        throw new SupremeError("internal", "restore failed AND rollback failed — data may be inconsistent");
      }
      throw new SupremeError("validation_failed", `restore failed and was rolled back: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  /** Backup history (metadata only — documents are fetched on demand). */
  listBackups(): Promise<BackupRecordMeta[]> {
    return this.d.backupStore ? this.d.backupStore.listMeta(this.d.homeId) : Promise.resolve([]);
  }

  /** Re-download a stored backup's document by id. */
  async getBackupDocument(id: string): Promise<{ meta: BackupRecordMeta; document: string }> {
    const rec = this.d.backupStore ? await this.d.backupStore.get(this.d.homeId, id) : null;
    if (!rec) throw new SupremeError("not_found", "backup not found");
    const { document, ...meta } = rec;
    return { meta, document };
  }

  /** The backup schedule (persisted); defaults to disabled, daily, keep 14. */
  async getBackupSchedule(): Promise<{ enabled: boolean; everyHours: number; retain: number }> {
    const cfg = (await this.getConfigJson<{ enabled?: boolean; everyHours?: number; retain?: number }>("backup_schedule")) ?? {};
    return {
      enabled: cfg.enabled ?? false,
      everyHours: Math.max(1, cfg.everyHours ?? 24),
      retain: Math.max(1, cfg.retain ?? 14),
    };
  }

  async setBackupSchedule(input: { enabled?: boolean; everyHours?: number; retain?: number }): Promise<{ enabled: boolean; everyHours: number; retain: number }> {
    const current = await this.getBackupSchedule();
    const next = {
      enabled: input.enabled ?? current.enabled,
      everyHours: Math.max(1, input.everyHours ?? current.everyHours),
      retain: Math.max(1, input.retain ?? current.retain),
    };
    await this.setConfigJson("backup_schedule", next);
    return next;
  }

  /** Health indicator: last backup, next due, retention + restore marker — all real, from history. */
  async backupStatus() {
    const [latest, schedule, lastRestore, all] = await Promise.all([
      this.d.backupStore ? this.d.backupStore.latest(this.d.homeId) : Promise.resolve(null),
      this.getBackupSchedule(),
      this.getConfigJson<{ at: string; rows: number }>("backup_last_restore"),
      this.listBackups(),
    ]);
    const nextDueAt =
      schedule.enabled && latest
        ? new Date(new Date(latest.createdAt).getTime() + schedule.everyHours * 3_600_000).toISOString()
        : null;
    return {
      lastBackupAt: latest?.createdAt ?? null,
      lastBackupSource: latest?.source ?? null,
      backupCount: all.length,
      schedule,
      nextDueAt,
      lastRestoreAt: lastRestore?.at ?? null,
    };
  }

  /** Runner hook: create a scheduled backup if the schedule is enabled and one is due. */
  async runScheduledBackupIfDue(nowMs: number): Promise<boolean> {
    if (!this.d.backupStore) return false;
    const schedule = await this.getBackupSchedule();
    if (!schedule.enabled) return false;
    const latest = await this.d.backupStore.latest(this.d.homeId);
    const dueMs = latest ? new Date(latest.createdAt).getTime() + schedule.everyHours * 3_600_000 : 0;
    if (nowMs < dueMs) return false;
    await this.createBackup("scheduled");
    return true;
  }

  // Small JSON config helpers over home_config — same TEXT storage + JSON.parse the ConfigRepo uses.
  private async getConfigJson<T>(key: string): Promise<T | null> {
    if (!this.d.db) return null;
    const { rows } = await this.d.db.query<{ value_json: string }>(
      "SELECT value_json FROM home_config WHERE home_id=$1 AND key=$2",
      [this.d.homeId, key],
    );
    return rows[0] ? (JSON.parse(rows[0].value_json) as T) : null;
  }
  private async setConfigJson(key: string, value: unknown): Promise<void> {
    if (!this.d.db) return;
    await this.d.db.query(
      `INSERT INTO home_config (home_id, key, value_json, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (home_id, key) DO UPDATE SET value_json=$3, updated_at=$4`,
      [this.d.homeId, key, JSON.stringify(value ?? null), new Date().toISOString()],
    );
  }

  // ── driver helpers (thin pass-throughs used by routes) ───────────────────────

  async enableDriver(id: DriverId, enabled: boolean) {
    const d = await this.drivers.setEnabled(id, enabled);
    this.appendLog(d.key, "info", enabled ? "Enabled" : "Disabled");
    await this.reregisterDriver(d.key); // start/stop its native stack
    return d;
  }

  /** Install a driver (logged). */
  async installDriver(key: string, version?: string) {
    const d = await this.drivers.install(key, version);
    this.appendLog(d.key, "info", `Installed v${d.version}`);
    await this.reregisterDriver(d.key);
    return d;
  }

  /** Uninstall a driver (logged). Also removes every device it created — a device
   *  whose driver no longer exists has no way to be controlled or rediscovered, so
   *  leaving it behind just orphans a dead entry in the devices list. */
  async uninstallDriver(id: DriverId) {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    await this.drivers.uninstall(id);
    if (entry) {
      this.appendLog(entry.key, "info", "Uninstalled");
      for (const p of entry.protocols) {
        if (this.desiredProtocols.has(p)) {
          this.desiredProtocols.delete(p);
          await this.runDriverLifecycle(p, null, entry.key, "config_change"); // teardown: releases owned devices, never leaves them silently
        }
      }
      const orphaned = (await this.d.home.listDevices()).filter((dv) => dv.driverId === id);
      if (orphaned.length) {
        // Protocol bindings (bus address + config, e.g. IP/credentials for that specific
        // device) live in their own table, keyed by device+capability — removeDevices()
        // only clears the SIL registry/ownership, so these rows would otherwise survive
        // as orphaned data with no device or driver left to reference them.
        if (this.d.protocolBindingStore) {
          for (const dv of orphaned) {
            for (const cap of dv.capabilities) {
              await this.d.protocolBindingStore.remove(dv.id, cap.kind);
            }
          }
        }
        await this.d.home.removeDevices(orphaned.map((dv) => dv.id));
        this.appendLog(entry.key, "info", `Removed ${orphaned.length} device(s) belonging to this driver`);
      }
    }
  }

  private requireDb(): SqlDb {
    if (!this.d.db) {
      throw new SupremeError("conflict", "backup/restore requires the Postgres persistence layer (set DATABASE_URL)");
    }
    return this.d.db;
  }
}
