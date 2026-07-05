import type { DriverId, InstalledDriver } from "@supreme/domain-model";

/**
 * Persistence boundary for installed drivers (§5, §9). The Postgres implementation
 * in `@supreme/persistence` satisfies this; an in-memory one serves dev/tests.
 */
export interface IInstalledDriverStore {
  list(): Promise<InstalledDriver[]>;
  get(id: DriverId): Promise<InstalledDriver | null>;
  getByKey(key: string): Promise<InstalledDriver | null>;
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
    return [...this.byId.values()].find((d) => d.key === key) ?? null;
  }
  async put(driver: InstalledDriver) {
    this.byId.set(driver.id, driver);
  }
  async remove(id: DriverId) {
    this.byId.delete(id);
  }
}
