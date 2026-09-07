import type { DriverId, InstalledDriver } from "@supreme/domain-model";

/**
 * Persistence boundary for installed drivers (§5, §9). The Postgres implementation
 * in `@supreme/persistence` satisfies this; an in-memory one serves dev/tests.
 */
export interface IInstalledDriverStore {
  list(): Promise<InstalledDriver[]>;
  get(id: DriverId): Promise<InstalledDriver | null>;
  /** The FIRST installed instance of a catalog key (deterministic by install order). A key can
   * hold several instances — one per Casambi network / Lithernet gateway — so callers that mean
   * "every instance" use {@link listByKey}. Optional on the interface so existing third-party
   * stores keep compiling; {@link listByKeyOf} falls back to filtering `list()`. */
  getByKey(key: string): Promise<InstalledDriver | null>;
  listByKey?(key: string): Promise<InstalledDriver[]>;
  put(driver: InstalledDriver): Promise<void>;
  remove(id: DriverId): Promise<void>;
}

export class InMemoryInstalledDriverStore implements IInstalledDriverStore {
  private readonly byId = new Map<DriverId, InstalledDriver>();

  async list() {
    return [...this.byId.values()];
  }
  async get(id: DriverId) {
    return this.byId.get(id) ?? null;
  }
  async getByKey(key: string) {
    return (await this.listByKey(key))[0] ?? null;
  }
  async listByKey(key: string) {
    return [...this.byId.values()]
      .filter((d) => d.key === key)
      .sort((a, b) => a.installedAt.localeCompare(b.installedAt) || a.id.localeCompare(b.id));
  }
  async put(driver: InstalledDriver) {
    this.byId.set(driver.id, driver);
  }
  async remove(id: DriverId) {
    this.byId.delete(id);
  }
}

/** Every installed instance of `key`, using the store's own `listByKey` when it has one and
 * falling back to filtering `list()` for stores that predate driver instances. */
export async function listByKeyOf(store: IInstalledDriverStore, key: string): Promise<InstalledDriver[]> {
  if (store.listByKey) return store.listByKey(key);
  return (await store.list()).filter((d) => d.key === key);
}
