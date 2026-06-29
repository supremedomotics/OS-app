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
  seedFirstPartyCatalog,
  type IInstalledDriverStore,
} from "@supreme/drivers";
import { CallbackProvider, DeveloperProvider, LicenseService, makeGrant, type LicenseTier, type ProviderGrant } from "@supreme/license-service";
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
  restoreBackup,
  serializeBackup,
  signBackup,
  type SignedBackup,
} from "@supreme/backup";
import type { SqlDb } from "@supreme/persistence";
import type { GatewayConfig } from "./config.js";

/** SKU tiers, lowest → highest. A higher tier entitles all lower SKUs. */
const SKU_TIERS = ["essential", "pro", "estate"] as const;

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
      new DeveloperProvider(() => deps.config.devMode),
      new CallbackProvider("offline", () => this.grantFromLicense()),
    ]);
    void this.licenseService.refresh();

    // Licensing: use the configured public key in prod; generate a dev pair so the
    // installer can issue + activate a license locally.
    this.licensingKeys = deps.config.licensingPublicKey
      ? { publicKey: deps.config.licensingPublicKey, privateKey: null }
      : generateSigningKeyPair();
  }

  /** Boot-time hydration: active license + re-bind persisted protocol bindings. */
  async init(): Promise<void> {
    await this.loadLicense();
    await this.rebindProtocols();
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

  /** Commission a parsed device list into rooms (creating rooms as needed) + bind GAs. */
  private async commissionImported(imported: ImportedDevice[]): Promise<KnxImportResult> {
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
          floor: 0,
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
        await this.bindProtocol({ deviceId: device.id, capability: b.capability, protocol: "knx", address: b.address });
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

  // ── Backup / restore ─────────────────────────────────────────────────────────

  async createBackup() {
    const db = this.requireDb();
    const signed = signBackup(await createBackup(db), this.backupKeys.privateKey);
    return { meta: signed.bundle.meta, document: serializeBackup(signed) };
  }

  async restore(document: string): Promise<{ tables: number; rows: number }> {
    const db = this.requireDb();
    let signed: SignedBackup;
    try {
      signed = JSON.parse(document) as SignedBackup;
    } catch {
      throw new SupremeError("validation_failed", "backup document is not valid JSON");
    }
    try {
      return await restoreBackup(db, signed, { publicKeyPem: this.backupKeys.publicKey });
    } catch (err) {
      throw new SupremeError("validation_failed", err instanceof Error ? err.message : "restore failed");
    }
  }

  // ── driver helpers (thin pass-throughs used by routes) ───────────────────────

  enableDriver(id: DriverId, enabled: boolean) {
    return this.drivers.setEnabled(id, enabled);
  }

  private requireDb(): SqlDb {
    if (!this.d.db) {
      throw new SupremeError("conflict", "backup/restore requires the Postgres persistence layer (set DATABASE_URL)");
    }
    return this.d.db;
  }
}
