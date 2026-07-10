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
} from "@supreme/integration-layer";
import type { HomeService } from "@supreme/home";
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
import { buildNativeDriver, hasNativeFactory } from "./native-driver-factory.js";
import { knxSearch, type KnxGateway } from "@supreme/protocols";
import {
  CommissioningService,
  groupIntoDevices,
  KnxDecryptError,
  parseKnxGroupExport,
  parseKnxProject,
  unzipKnxproj,
  type ImportedDevice,
  type IProtocolScanner,
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

/** Replace configured secret values with a masked placeholder so plaintext never leaves the hub. */
function maskSecrets(config: Record<string, unknown>, schema: { key: string; secret?: boolean }[]): Record<string, unknown> {
  const out = { ...config };
  for (const field of schema) {
    if (field.secret && out[field.key] !== undefined && out[field.key] !== "") out[field.key] = "••••••••";
  }
  return out;
}

/** Result of a KNX import (group-address export or .knxproj). */
export interface KnxImportResult {
  devices: number;
  roomsCreated: number;
  created: { name: string; room: string | null; capabilities: string[] }[];
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

  /** Boot-time hydration: active license, re-bind persisted protocol bindings, and start the native
   *  stacks of every installed+configured driver (the manifest↔runtime bridge). */
  async init(): Promise<void> {
    await this.loadLicense();
    await this.rebindProtocols();
    await this.reconcileNativeDrivers();
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

  /** Re-bind every persisted protocol binding onto the native engine on boot. */
  private async rebindProtocols(): Promise<void> {
    const store = this.d.protocolBindingStore;
    if (!store || !this.d.sil.migrationEnabled) return;
    for (const b of await store.list()) {
      try {
        await this.d.sil.bindNative(
          { deviceId: b.deviceId, capability: b.capability, address: b.address, config: b.config },
          b.protocol,
        );
      } catch {
        // A driver for this protocol may not be configured on this hub; skip it.
      }
    }
  }

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
    roomId: RoomId;
    capabilities: CapabilityKind[];
    supremeType?: Parameters<CommissioningService["commission"]>[0]["supremeType"];
    manufacturer?: string | null;
    model?: string | null;
    network?: Parameters<CommissioningService["commission"]>[0]["network"];
    protocol?: string;
    address?: string;
    config?: Record<string, unknown>;
  }): Promise<Awaited<ReturnType<CommissioningService["commission"]>>> {
    const { protocol, address, config, ...commissionInput } = input;
    const device = await this.commissioning.commission(commissionInput);
    if (protocol) {
      const busAddress = address ?? input.backendId;
      for (const capability of input.capabilities) {
        await this.bindProtocol({ deviceId: device.id, capability, protocol, address: busAddress, config });
      }
    }
    return device;
  }

  /**
   * Import an ETS group-address export (§4): parse it, group the addresses into devices
   * (capabilities inferred from the DPTs), resolve/create each device's room, then
   * commission the device and bind every capability to its KNX group address. Turns a
   * KNX project into ready-to-use device cards — no per-device manual entry.
   */
  async importKnx(content: string): Promise<KnxImportResult> {
    const existing = await this.d.home.listRooms();
    const addresses = parseKnxGroupExport(content);
    if (addresses.length === 0) {
      throw new SupremeError("validation_failed", "no group addresses found in the import");
    }
    return this.commissionImported(groupIntoDevices(addresses, existing.map((r) => r.name)));
  }

  /**
   * Import a `.knxproj` file directly (base64-encoded). Reads the ETS project's
   * building → room → function → group-address structure, so device cards land in their
   * real ETS rooms. Falls back to name-based grouping when the project has no functions.
   */
  async importKnxProject(base64: string, password?: string): Promise<KnxImportResult> {
    let devices: ImportedDevice[];
    try {
      const { devices: parsed } = parseKnxProject(unzipKnxproj(Buffer.from(base64, "base64"), password));
      devices = parsed;
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
    if (devices.length === 0) {
      throw new SupremeError("validation_failed", "no devices found in the project (is it password-protected?)");
    }
    return this.commissionImported(devices);
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
    const imported: ImportedDevice[] = discovered
      .filter((d) => (typeof d.raw?.protocol === "string" ? d.raw.protocol : "") === protocol)
      .map((d) => ({
        name: d.suggestedName,
        room: typeof d.raw?.room === "string" && d.raw.room.trim() ? d.raw.room : null,
        bindings: d.capabilities.map((capability) => ({ capability, address: d.backendId })),
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

  /** Commission a parsed device list into rooms (creating rooms as needed) + bind each capability. */
  private async commissionImported(imported: ImportedDevice[], protocol = "knx"): Promise<KnxImportResult> {
    const existing = await this.d.home.listRooms();
    const roomByName = new Map(existing.map((r) => [r.name.toLowerCase(), r] as const));
    let roomsCreated = 0;
    const created: { name: string; room: string | null; capabilities: string[] }[] = [];

    for (const dev of imported) {
      const roomName = dev.room ?? "Unassigned";
      let room = roomByName.get(roomName.toLowerCase());
      if (!room) {
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
        room = newRoom;
        roomsCreated++;
      }
      const device = await this.commissioning.commission({
        backendId: dev.bindings[0]!.address,
        name: dev.name,
        roomId: room.id,
        capabilities: dev.bindings.map((b) => b.capability),
      });
      for (const b of dev.bindings) {
        await this.bindProtocol({ deviceId: device.id, capability: b.capability, protocol, address: b.address });
      }
      created.push({ name: dev.name, room: dev.room, capabilities: dev.bindings.map((b) => b.capability) });
    }
    return { devices: created.length, roomsCreated, created };
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

  /** Protocols whose native driver was started FROM AN INSTALLED MANIFEST (vs env-wired at boot). We
   *  only ever tear down protocols we started, so legacy env-configured drivers are never disturbed. */
  private readonly manifestManaged = new Set<string>();

  /**
   * Reconcile installed+enabled+configured drivers with their runtime native protocol stacks — the
   * manifest↔runtime bridge. Starts manifest drivers that should run and aren't; stops manifest
   * drivers that shouldn't. Env-wired drivers (bootstrap.ts) are left untouched.
   */
  async reconcileNativeDrivers(): Promise<void> {
    const reg = await this.drivers.registry();
    const desired = new Map<string, { config: Record<string, unknown>; key: string }>();
    for (const d of reg) {
      if (!d.installed || !d.enabled) continue;
      if (!isConfigComplete(d.configSchema, d.config).complete) continue;
      for (const p of d.protocols) if (hasNativeFactory(p)) desired.set(p, { config: d.config, key: d.key });
    }
    for (const [protocol, { config, key }] of desired) {
      if (this.manifestManaged.has(protocol)) continue; // already ours (config edits go via reregister)
      const driver = buildNativeDriver(protocol, config);
      if (driver && (await this.d.sil.registerNativeDriver(driver))) {
        this.manifestManaged.add(protocol);
        this.appendLog(key, "info", `Native ${protocol} driver started`);
      }
    }
    for (const protocol of [...this.manifestManaged]) {
      if (!desired.has(protocol)) {
        await this.d.sil.unregisterNativeProtocol(protocol);
        this.manifestManaged.delete(protocol);
      }
    }
  }

  /** Force one driver's native stack to match its current install/enable/config state. */
  private async reregisterDriver(key: string): Promise<void> {
    const entry = (await this.drivers.registry()).find((e) => e.key === key);
    if (!entry) return;
    for (const protocol of entry.protocols) {
      if (!hasNativeFactory(protocol)) continue;
      const runnable = entry.installed && entry.enabled && isConfigComplete(entry.configSchema, entry.config).complete;
      const driver = runnable ? buildNativeDriver(protocol, entry.config) : null;
      if (driver) {
        if (await this.d.sil.registerNativeDriver(driver)) this.manifestManaged.add(protocol);
      } else if (this.manifestManaged.has(protocol)) {
        await this.d.sil.unregisterNativeProtocol(protocol);
        this.manifestManaged.delete(protocol);
      }
    }
  }

  /** In-memory per-driver log ring buffer (lifecycle + connection events). */
  private readonly driverLogEntries = new Map<string, Array<{ ts: string; level: string; message: string }>>();
  private appendLog(key: string, level: "info" | "warn" | "error", message: string): void {
    const arr = this.driverLogEntries.get(key) ?? [];
    arr.push({ ts: new Date().toISOString(), level, message });
    if (arr.length > 200) arr.shift();
    this.driverLogEntries.set(key, arr);
  }

  /** Recent log entries for an installed driver. */
  async driverLogs(id: DriverId): Promise<{ key: string; entries: Array<{ ts: string; level: string; message: string }> }> {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    if (!entry) throw new SupremeError("not_found", "driver not installed");
    return { key: entry.key, entries: this.driverLogEntries.get(entry.key) ?? [] };
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

  /** Connect a driver's native protocol stack(s). */
  async connectDriver(id: DriverId): Promise<{ connected: boolean }> {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    if (!entry) throw new SupremeError("not_found", "driver not installed");
    let connected = false;
    for (const p of entry.protocols) if (await this.d.sil.connectNativeProtocol(p)) connected = true;
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

  // ── Device Approval (§ Device Approval) ──────────────────────────────────────

  /**
   * Scan every technology and STAGE the results into the pending-device queue (dedupe by backendId,
   * refreshing last-seen), then return the current queue. Nothing is trusted/commissioned until an
   * installer approves it — the security-conscious counterpart to one-tap discovery.
   */
  async scanForApproval(protocol?: ProtocolKind): Promise<PendingDeviceRecord[]> {
    const found = await this.commissioning.discover(protocol);
    const store = this.d.pendingDeviceStore;
    if (store) {
      const seenAt = new Date().toISOString();
      for (const d of found) {
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
  async approvePendingDevice(id: string, input: { name?: string; roomId: RoomId; capabilities?: CapabilityKind[] }) {
    const rec = await this.requirePending(id);
    const device = await this.commissionDevice({
      backendId: rec.backendId,
      name: input.name?.trim() || rec.suggestedName,
      roomId: input.roomId,
      capabilities: (input.capabilities ?? (rec.capabilities as CapabilityKind[])),
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

  /** Uninstall a driver (logged). */
  async uninstallDriver(id: DriverId) {
    const entry = (await this.drivers.registry()).find((e) => e.installedId === id);
    await this.drivers.uninstall(id);
    if (entry) {
      this.appendLog(entry.key, "info", "Uninstalled");
      for (const p of entry.protocols) {
        if (this.manifestManaged.has(p)) {
          await this.d.sil.unregisterNativeProtocol(p);
          this.manifestManaged.delete(p);
        }
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
