import type { CapabilityKind, DeviceId } from "@supreme/domain-model";

/**
 * Entity Registry Mirror (§5, §7).
 *
 * The single component that maps Supreme device + capability ↔ a backend-native
 * entity. This is the `ha_entity_map` of the blueprint, kept in-memory here for
 * Phase 0 and persisted to Postgres later. It is intentionally the ONLY place
 * backend ids live; remove the backend and you replace this mapping, nothing else.
 */
export interface BackendEntityRef {
  backendId: string;
  /** e.g. HA domain: "light" | "climate" | "cover" … (backend-private). */
  backendDomain: string;
  /** Optional backend attribute the capability reads/writes. */
  backendAttr?: string;
}

type Key = `${string}:${CapabilityKind}`;

const key = (deviceId: DeviceId, capability: CapabilityKind): Key =>
  `${deviceId}:${capability}`;

export class EntityRegistryMirror {
  private readonly forward = new Map<Key, BackendEntityRef>();
  private readonly reverse = new Map<string, { deviceId: DeviceId; capability: CapabilityKind }>();

  map(deviceId: DeviceId, capability: CapabilityKind, ref: BackendEntityRef): void {
    this.forward.set(key(deviceId, capability), ref);
    this.reverse.set(ref.backendId, { deviceId, capability });
  }

  /** Supreme → backend. Used when issuing a command. */
  resolve(deviceId: DeviceId, capability: CapabilityKind): BackendEntityRef | undefined {
    return this.forward.get(key(deviceId, capability));
  }

  /** Backend → Supreme. Used when normalizing an inbound state event. */
  reverseLookup(
    backendId: string,
  ): { deviceId: DeviceId; capability: CapabilityKind } | undefined {
    return this.reverse.get(backendId);
  }

  clear(): void {
    this.forward.clear();
    this.reverse.clear();
  }

  get size(): number {
    return this.forward.size;
  }

  /** Distinct backend domains currently mapped (used by the migration router/UI). */
  domains(): string[] {
    return [...new Set([...this.forward.values()].map((r) => r.backendDomain))].sort();
  }

  /** Resolve the backend domain for a device capability, if mapped. */
  domainOf(deviceId: DeviceId, capability: CapabilityKind): string | undefined {
    return this.forward.get(key(deviceId, capability))?.backendDomain;
  }

  /** Distinct device ids that have at least one capability in a domain. */
  devicesInDomain(domain: string): DeviceId[] {
    const set = new Set<DeviceId>();
    for (const [k, ref] of this.forward) {
      if (ref.backendDomain === domain) set.add(k.split(":")[0] as DeviceId);
    }
    return [...set];
  }

  /** Capabilities of a device that map to a given domain. */
  capabilitiesOf(deviceId: DeviceId, domain: string): CapabilityKind[] {
    const out: CapabilityKind[] = [];
    for (const [k, ref] of this.forward) {
      const [dev, cap] = k.split(":");
      if (dev === deviceId && ref.backendDomain === domain) out.push(cap as CapabilityKind);
    }
    return out;
  }
}
