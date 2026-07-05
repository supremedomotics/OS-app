import {
  DEFAULT_DRIVER_OPERATIONS,
  newId,
  type DriverCategory,
  type DriverChannel,
  type DriverConfigField,
  type DriverId,
  type DriverOperation,
  type HomeId,
  type InstalledDriver,
  type SignedDriverBundle,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";

/** One row of the unified driver registry (catalog metadata + installed state). */
export interface DriverRegistryEntry {
  key: string;
  name: string;
  description: string;
  category: DriverCategory;
  channel: DriverChannel;
  version: string;
  publisher: string;
  capabilities: string[];
  protocols: string[];
  requiresSku: string | null;
  /** Minimum hub (Supreme OS) version this driver is compatible with (§ Extension Center). */
  hubMinVersion: string;
  shipsDisabled: boolean;
  configSchema: DriverConfigField[];
  dependencies: string[];
  operations: DriverOperation[];
  installed: boolean;
  enabled: boolean;
  status: string;
  installedId: string | null;
  config: Record<string, unknown>;
}
import { verifyBundle } from "@supreme/driver-sdk";
import { defaultDriverConfig, validateDriverConfig } from "./config.js";
import type { ICatalog } from "./catalog.js";
import { InMemoryInstalledDriverStore, type IInstalledDriverStore } from "./store.js";

/**
 * Hub Driver Manager (§9). Browses the catalog and installs drivers only after:
 *   1. verifying the bundle's Ed25519 signature against a TRUSTED publisher key, and
 *   2. confirming the home holds any required SKU license.
 * Supports update, rollback, enable/disable (Matter opt-in), and uninstall, with
 * installed drivers persisted as the system of record.
 */
export interface DriverManagerOptions {
  homeId: HomeId;
  catalog: ICatalog;
  /** Trusted publisher signing keys, keyed by signingKeyId (PEM public keys). */
  trustedKeys: Map<string, string>;
  store?: IInstalledDriverStore;
  /** SKUs the home is currently licensed for (refreshed from licensing). */
  licensedSkus?: () => Set<string>;
}

export class DriverManager {
  private readonly homeId: HomeId;
  private readonly catalog: ICatalog;
  private readonly trustedKeys: Map<string, string>;
  private readonly store: IInstalledDriverStore;
  private readonly licensedSkus: () => Set<string>;

  constructor(opts: DriverManagerOptions) {
    this.homeId = opts.homeId;
    this.catalog = opts.catalog;
    this.trustedKeys = opts.trustedKeys;
    this.store = opts.store ?? new InMemoryInstalledDriverStore();
    this.licensedSkus = opts.licensedSkus ?? (() => new Set());
  }

  /** Browse the store catalog (signed bundles). */
  browse(): Promise<SignedDriverBundle[]> {
    return this.catalog.list();
  }

  listInstalled(): Promise<InstalledDriver[]> {
    return this.store.list();
  }

  /**
   * The unified driver registry: every driver in the catalog merged with its installed state, config
   * schema and supported operations. The Driver Manager UI populates entirely from this — so any
   * current or future driver appears automatically with the right controls and a generated config page.
   */
  async registry(): Promise<DriverRegistryEntry[]> {
    const [bundles, installed] = await Promise.all([this.catalog.list(), this.store.list()]);
    const byKey = new Map(installed.map((d) => [d.key, d]));
    return bundles
      .map((b) => {
        const m = b.bundle.manifest;
        const inst = byKey.get(m.key);
        return {
          key: m.key,
          name: m.name,
          description: m.description,
          category: m.category,
          channel: m.channel,
          version: m.version,
          publisher: m.publisher,
          capabilities: m.capabilities,
          protocols: m.protocols,
          requiresSku: m.compat.requiresSku,
          hubMinVersion: m.compat.hubMinVersion,
          shipsDisabled: m.shipsDisabled,
          configSchema: m.configSchema,
          dependencies: m.dependencies,
          operations: m.operations.length > 0 ? m.operations : DEFAULT_DRIVER_OPERATIONS,
          installed: Boolean(inst),
          enabled: inst?.enabled ?? false,
          status: inst?.status ?? "not_installed",
          installedId: inst?.id ?? null,
          config: inst?.config ?? {},
        } satisfies DriverRegistryEntry;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The manifest config schema for an installed driver (empty if none / not found). */
  private async schemaFor(key: string): Promise<import("@supreme/domain-model").DriverConfigField[]> {
    const bundle = await this.catalog.find(key);
    return bundle?.bundle.manifest.configSchema ?? [];
  }

  /** Read an installed driver's config. */
  async getConfig(id: DriverId): Promise<Record<string, unknown>> {
    const inst = await this.store.get(id);
    if (!inst) throw new SupremeError("not_found", "driver not installed");
    return inst.config;
  }

  /** Validate + persist an installed driver's config against its manifest schema. */
  async setConfig(id: DriverId, input: Record<string, unknown>): Promise<InstalledDriver> {
    const inst = await this.store.get(id);
    if (!inst) throw new SupremeError("not_found", "driver not installed");
    const schema = await this.schemaFor(inst.key);
    const { config, errors } = validateDriverConfig(schema, input, inst.config);
    if (errors.length > 0) throw new SupremeError("validation_failed", errors.join("; "));
    const updated: InstalledDriver = { ...inst, config };
    await this.store.put(updated);
    return updated;
  }

  /** Install (or change to) a specific driver version. Verifies signature + license. */
  async install(key: string, version?: string): Promise<InstalledDriver> {
    const entry = await this.catalog.find(key, version);
    if (!entry) throw new SupremeError("not_found", `driver ${key}${version ? "@" + version : ""} not found`);
    this.verify(entry);

    const manifest = entry.bundle.manifest;
    const sku = manifest.compat.requiresSku;
    if (sku && !this.licensedSkus().has(sku)) {
      throw new SupremeError("forbidden", `driver ${key} requires the '${sku}' license`);
    }

    const existing = await this.store.getByKey(key);
    const installed: InstalledDriver = {
      id: existing?.id ?? (newId("driver") as DriverId),
      homeId: this.homeId,
      key,
      version: manifest.version,
      channel: manifest.channel,
      category: manifest.category,
      installedAt: new Date().toISOString(),
      // Matter (and other shipsDisabled drivers) install disabled — opt-in to enable.
      enabled: existing?.enabled ?? !manifest.shipsDisabled,
      status: manifest.shipsDisabled && !existing?.enabled ? "disabled" : "active",
      // Preserve config on reinstall; on a fresh install seed the schema defaults.
      config: existing?.config ?? defaultDriverConfig(manifest.configSchema),
    };
    await this.store.put(installed);
    return installed;
  }

  /** Update to the latest published version (no-op if already latest). */
  async update(key: string): Promise<InstalledDriver> {
    const installed = await this.requireInstalled(key);
    const latest = await this.catalog.find(key);
    if (!latest) throw new SupremeError("not_found", `driver ${key} not in catalog`);
    if (latest.bundle.manifest.version === installed.version) return installed;
    return this.install(key, latest.bundle.manifest.version);
  }

  /** Roll back to a specific earlier version. */
  async rollback(key: string, version: string): Promise<InstalledDriver> {
    await this.requireInstalled(key);
    return this.install(key, version);
  }

  /** Enable/disable an installed driver — this is the Matter opt-in toggle (§9). */
  async setEnabled(id: DriverId, enabled: boolean): Promise<InstalledDriver> {
    const driver = await this.store.get(id);
    if (!driver) throw new SupremeError("not_found", "driver not installed");
    const next: InstalledDriver = {
      ...driver,
      enabled,
      status: enabled ? "active" : "disabled",
    };
    await this.store.put(next);
    return next;
  }

  async uninstall(id: DriverId): Promise<void> {
    const driver = await this.store.get(id);
    if (!driver) throw new SupremeError("not_found", "driver not installed");
    await this.store.remove(id);
  }

  private verify(entry: SignedDriverBundle): void {
    const key = this.trustedKeys.get(entry.signingKeyId);
    if (!key) throw new SupremeError("forbidden", `unknown signing key ${entry.signingKeyId}`);
    if (!verifyBundle(entry, key)) {
      throw new SupremeError("forbidden", "driver bundle signature verification failed");
    }
    if (entry.bundle.status === "yanked") {
      throw new SupremeError("conflict", "driver version has been yanked");
    }
  }

  private async requireInstalled(key: string): Promise<InstalledDriver> {
    const installed = await this.store.getByKey(key);
    if (!installed) throw new SupremeError("not_found", `driver ${key} is not installed`);
    return installed;
  }
}
