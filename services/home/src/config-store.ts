import type { HomeId } from "@supreme/domain-model";

/**
 * Per-home key/value configuration (§13) — durable settings the homeowner/installer set that aren't
 * part of the device/scene model: the energy tariff, scene schedules, vacation preferences, etc.
 * Values are arbitrary JSON. In-memory by default; Postgres-backed in production so settings survive
 * a hub restart.
 */
export interface IConfigStore {
  get(homeId: HomeId, key: string): Promise<unknown | undefined>;
  set(homeId: HomeId, key: string, value: unknown): Promise<void>;
  delete(homeId: HomeId, key: string): Promise<void>;
  getAll(homeId: HomeId): Promise<Record<string, unknown>>;
}

export class InMemoryConfigStore implements IConfigStore {
  private readonly byHome = new Map<string, Map<string, unknown>>();
  private home(homeId: HomeId) {
    let m = this.byHome.get(homeId);
    if (!m) {
      m = new Map();
      this.byHome.set(homeId, m);
    }
    return m;
  }
  async get(homeId: HomeId, key: string) {
    return this.home(homeId).get(key);
  }
  async set(homeId: HomeId, key: string, value: unknown) {
    this.home(homeId).set(key, value);
  }
  async delete(homeId: HomeId, key: string) {
    this.home(homeId).delete(key);
  }
  async getAll(homeId: HomeId) {
    return Object.fromEntries(this.home(homeId).entries());
  }
}
