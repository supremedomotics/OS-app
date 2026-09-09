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
  /** § Supreme Universal Keypad — a capability-less input device (a keypad; see the
   * "camera" 0-capability precedent in `Device.capabilities`'s own doc comment) has no
   * `CapabilityKind` to key `forward`/`reverse` by, so it can never go through `map()`.
   * This is the device-level equivalent: ONLY for devices with zero capabilities, kept
   * entirely separate from the capability-keyed maps above so nothing about them changes
   * for every device that DOES have real capabilities. */
  private readonly deviceBackendId = new Map<DeviceId, string>();
  private readonly reverseDevice = new Map<string, DeviceId>();

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

  /** § Supreme Universal Keypad — register a capability-less device's backendId (see
   * `deviceBackendId`'s doc comment). Never used for a device with any real capability —
   * those go through `map()`, once per capability, exactly as before. */
  mapDevice(deviceId: DeviceId, backendId: string): void {
    this.deviceBackendId.set(deviceId, backendId);
    this.reverseDevice.set(backendId, deviceId);
  }

  /** Backend → Supreme, capability-less devices only. `undefined` for anything registered
   * through `map()` instead — use {@link isKnownBackendId} when you only need "is this
   * backendId already owned by ANY device", not which one. */
  reverseLookupDevice(backendId: string): DeviceId | undefined {
    return this.reverseDevice.get(backendId);
  }

  /** Supreme → backend, capability-less devices only — the forward counterpart to
   * {@link reverseLookupDevice} (§ Supreme Universal Keypad, Stage 4A: a driver's
   * `getKeypadCapabilities(deviceId)` needs to resolve its OWN protocol-native identity back
   * from the Supreme `deviceId` it's handed, the mirror image of turning a raw button event's
   * unit id into a `deviceId`). `undefined` for a device registered through `map()` instead. */
  backendIdOfDevice(deviceId: DeviceId): string | undefined {
    return this.deviceBackendId.get(deviceId);
  }

  /** True if `backendId` is already owned by some Supreme device, through either
   * registration path — the dedup check every discovery/pending-approval call site
   * actually needs (it never cared which capability, only "already known or not"). */
  isKnownBackendId(backendId: string): boolean {
    return this.reverse.has(backendId) || this.reverseDevice.has(backendId);
  }

  /** Drop all capability mappings for a device (used when a device is deleted). */
  unmapDevice(deviceId: DeviceId): void {
    for (const [k, ref] of [...this.forward]) {
      if (k.startsWith(`${deviceId}:`)) {
        this.forward.delete(k);
        this.reverse.delete(ref.backendId);
      }
    }
    const backendId = this.deviceBackendId.get(deviceId);
    if (backendId !== undefined) {
      this.deviceBackendId.delete(deviceId);
      this.reverseDevice.delete(backendId);
    }
  }

  clear(): void {
    this.forward.clear();
    this.reverse.clear();
    this.deviceBackendId.clear();
    this.reverseDevice.clear();
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
