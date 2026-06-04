import {
  type DriverId,
  type HomeId,
  type License,
  type ProtocolKind,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import { generateSigningKeyPair, type KeyPairPem } from "@supreme/crypto";
import type { SupremeIntegrationLayer } from "@supreme/integration-layer";
import type { HomeService } from "@supreme/home";
import type { SceneService } from "@supreme/scenes";
import type { IdentityService } from "@supreme/identity";
import {
  DriverManager,
  InMemoryCatalog,
  seedFirstPartyCatalog,
  type IInstalledDriverStore,
} from "@supreme/drivers";
import { CommissioningService, type IProtocolScanner } from "@supreme/commissioning";
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

    // Licensing: use the configured public key in prod; generate a dev pair so the
    // installer can issue + activate a license locally.
    this.licensingKeys = deps.config.licensingPublicKey
      ? { publicKey: deps.config.licensingPublicKey, privateKey: null }
      : generateSigningKeyPair();
  }

  /** Load any persisted active license (call on boot when a DB is configured). */
  async init(): Promise<void> {
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
    if (res.valid) this.license = res.license;
  }

  // ── Licensing ──────────────────────────────────────────────────────────────

  /** The set of SKUs the home is entitled to (tier-expanded). */
  licensedSkus(): Set<string> {
    if (!this.license) return new Set();
    const idx = SKU_TIERS.indexOf(this.license.sku as (typeof SKU_TIERS)[number]);
    const skus = idx >= 0 ? SKU_TIERS.slice(0, idx + 1) : [this.license.sku];
    return new Set(skus);
  }

  licenseStatus() {
    return {
      licensed: this.license !== null,
      skus: [...this.licensedSkus()],
      features: this.license?.features ?? [],
      license: this.license,
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
