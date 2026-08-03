import type { DeviceId } from "@supreme/domain-model";
import type { DeviceLifecycleState } from "./device-lifecycle.js";
import { canTransition } from "./device-lifecycle.js";

/**
 * Device provider + lifecycle record (ADR-0023, replaces {@link OwnershipRegistry}).
 *
 * `provider` describes device origin only (which integration it came from) and never
 * gates runtime behavior — the router and state engine key on `state`, not on which
 * provider string is present. Provider is free-form (validated against whatever
 * providers are actually registered), never a closed union, so a future driver never
 * needs a type change here to exist.
 */
export interface DeviceProviderRecord {
  deviceId: DeviceId;
  provider: string;
  state: DeviceLifecycleState;
  updatedAt: string;
}

/** Persistence seam so provider+lifecycle survives a hub restart. */
export interface IDeviceProviderStore {
  list(): Promise<DeviceProviderRecord[]>;
  put(record: DeviceProviderRecord): Promise<void>;
  remove(deviceId: DeviceId): Promise<void>;
}

export class InMemoryDeviceProviderStore implements IDeviceProviderStore {
  private readonly rows = new Map<DeviceId, DeviceProviderRecord>();
  async list(): Promise<DeviceProviderRecord[]> {
    return [...this.rows.values()];
  }
  async put(record: DeviceProviderRecord): Promise<void> {
    this.rows.set(record.deviceId, record);
  }
  async remove(deviceId: DeviceId): Promise<void> {
    this.rows.delete(deviceId);
  }
}

/**
 * In-memory provider+lifecycle index the router consults on every command — a plain
 * Map so routing is a synchronous, allocation-free lookup, mirroring
 * {@link OwnershipRegistry}'s design. Persistence is a side effect of {@link set},
 * never the router's concern.
 */
export class ProviderRegistry {
  private readonly byDevice = new Map<DeviceId, DeviceProviderRecord>();
  private readonly store?: IDeviceProviderStore;

  constructor(store?: IDeviceProviderStore) {
    this.store = store;
  }

  /** Restore persisted provider/lifecycle records on boot (no-op without a store). */
  async hydrate(): Promise<void> {
    if (!this.store) return;
    for (const r of await this.store.list()) this.byDevice.set(r.deviceId, r);
  }

  get(deviceId: DeviceId): DeviceProviderRecord | undefined {
    return this.byDevice.get(deviceId);
  }

  /** Register a device's provider for the first time (DISCOVERED/REGISTERED → UNBOUND).
   * Use {@link transition} for every subsequent lifecycle change — this is only the
   * initial assignment, never a way to jump straight to BOUND/ONLINE. */
  async assign(deviceId: DeviceId, provider: string): Promise<void> {
    const record: DeviceProviderRecord = { deviceId, provider, state: "UNBOUND", updatedAt: new Date().toISOString() };
    if (this.store) await this.store.put(record);
    this.byDevice.set(deviceId, record);
  }

  /** Move a device to a new lifecycle state. Throws on an invalid transition — the
   * registry is the single point that enforces the state machine, so no caller can
   * silently skip a step (e.g. jump UNBOUND → ONLINE without ever BINDING). */
  async transition(deviceId: DeviceId, to: DeviceLifecycleState): Promise<void> {
    const current = this.byDevice.get(deviceId);
    if (!current) throw new Error(`device ${deviceId} has no provider record — call assign() first`);
    if (!canTransition(current.state, to)) {
      throw new Error(`device ${deviceId} cannot transition ${current.state} -> ${to}`);
    }
    const record: DeviceProviderRecord = { ...current, state: to, updatedAt: new Date().toISOString() };
    if (this.store) await this.store.put(record);
    this.byDevice.set(deviceId, record);
  }

  async remove(deviceId: DeviceId): Promise<void> {
    if (this.store) await this.store.remove(deviceId);
    this.byDevice.delete(deviceId);
  }

  /** Every device currently assigned to a given provider — used when a provider is
   * torn down, to know exactly which devices need reconciling. */
  devicesByProvider(provider: string): DeviceId[] {
    return [...this.byDevice.values()].filter((r) => r.provider === provider).map((r) => r.deviceId);
  }

  countsByState(): Record<DeviceLifecycleState, number> {
    const counts: Record<DeviceLifecycleState, number> = {
      DISCOVERED: 0, REGISTERED: 0, UNBOUND: 0, BINDING: 0, BOUND: 0, ONLINE: 0, OFFLINE: 0, ERROR: 0, REMOVED: 0,
    };
    for (const r of this.byDevice.values()) counts[r.state]++;
    return counts;
  }
}
