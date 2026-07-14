import type { DeviceId } from "@supreme/domain-model";

/**
 * Device ownership (§ Native Driver Architecture Refactor).
 *
 * Every device has exactly one owner, set explicitly by whatever actually took
 * control of it — a native driver's successful bind, an HA-entity commission, or a
 * future integration's own commissioning path. Ownership is NEVER inferred: not from
 * a backend id's shape, not from a naming convention, not from "well nothing else
 * claimed it so it must be HA." The command router (`RoutingBackendAdapter`) treats
 * this as the single source of truth — a device with no recorded owner cannot be
 * commanded, full stop, rather than silently defaulting anywhere.
 */
export type OwnerKind = "native" | "ha" | "matter" | "cloud" | "unassigned";

export interface DeviceOwnership {
  deviceId: DeviceId;
  kind: OwnerKind;
  /** Set only when kind === "native": which native protocol owns this device. */
  protocol?: string;
  updatedAt: string;
}

/** Persistence seam so ownership survives a hub restart, mirroring {@link IProtocolBindingStore}. */
export interface IDeviceOwnershipStore {
  list(): Promise<DeviceOwnership[]>;
  put(ownership: DeviceOwnership): Promise<void>;
  remove(deviceId: DeviceId): Promise<void>;
}

export class InMemoryDeviceOwnershipStore implements IDeviceOwnershipStore {
  private readonly rows = new Map<DeviceId, DeviceOwnership>();
  async list(): Promise<DeviceOwnership[]> {
    return [...this.rows.values()];
  }
  async put(ownership: DeviceOwnership): Promise<void> {
    this.rows.set(ownership.deviceId, ownership);
  }
  async remove(deviceId: DeviceId): Promise<void> {
    this.rows.delete(deviceId);
  }
}

/**
 * In-memory ownership index the command router consults on every command — a plain
 * Map so the routing decision is a synchronous, allocation-free lookup. Persistence
 * (via {@link IDeviceOwnershipStore}) is a side effect of {@link set}, never the
 * router's concern.
 */
export class OwnershipRegistry {
  private readonly byDevice = new Map<DeviceId, DeviceOwnership>();
  private readonly store?: IDeviceOwnershipStore;

  constructor(store?: IDeviceOwnershipStore) {
    this.store = store;
  }

  /** Restore persisted ownership on boot (no-op without a store). */
  async hydrate(): Promise<void> {
    if (!this.store) return;
    for (const o of await this.store.list()) this.byDevice.set(o.deviceId, o);
  }

  get(deviceId: DeviceId): DeviceOwnership | undefined {
    return this.byDevice.get(deviceId);
  }

  /** Explicitly assign an owner. This is the ONLY way a device becomes commandable —
   * there is no fallback path that infers ownership. Persists before it's visible to
   * the router, so a crash mid-write never leaves an in-memory-only owner that a
   * restart would silently lose (§ Ownership changes must be transactional). */
  async set(deviceId: DeviceId, kind: OwnerKind, protocol?: string): Promise<void> {
    const ownership: DeviceOwnership = { deviceId, kind, ...(protocol ? { protocol } : {}), updatedAt: new Date().toISOString() };
    if (this.store) await this.store.put(ownership);
    this.byDevice.set(deviceId, ownership);
  }

  async clear(deviceId: DeviceId): Promise<void> {
    if (this.store) await this.store.remove(deviceId);
    this.byDevice.delete(deviceId);
  }

  /** Every device currently owned by a given native protocol — used when a protocol's
   * driver is torn down, to know exactly which devices need to be reconciled rather
   * than silently left pointing at a dead instance. */
  devicesOwnedByProtocol(protocol: string): DeviceId[] {
    return [...this.byDevice.values()].filter((o) => o.kind === "native" && o.protocol === protocol).map((o) => o.deviceId);
  }

  countsByKind(): Record<OwnerKind, number> {
    const counts: Record<OwnerKind, number> = { native: 0, ha: 0, matter: 0, cloud: 0, unassigned: 0 };
    for (const o of this.byDevice.values()) counts[o.kind]++;
    return counts;
  }
}
