import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceId } from "@supreme/domain-model";

/** One persisted SupremeOS device ↔ Matter bridged-endpoint mapping. */
export interface MatterEndpointMapping {
  deviceId: DeviceId;
  /** Stable Matter endpoint number, assigned once and reused across restarts — never an
   * array index (§ Matter Bridge Phase 1: "endpoint identity must remain stable"). */
  endpointNumber: number;
  deviceType: "onOffLight";
}

/** Persistence seam for the deviceId↔endpoint mapping (§ Persistence). This is deliberately
 * NOT `@matter/main`'s own storage — that owns fabric/commissioning/attribute state, which
 * this never duplicates. This is the one genuinely new piece of state SupremeOS itself must
 * own: "which endpoint number did we already hand out for this device." */
export interface IMatterEndpointStore {
  list(): MatterEndpointMapping[];
  get(deviceId: DeviceId): MatterEndpointMapping | null;
  put(mapping: MatterEndpointMapping): void;
  remove(deviceId: DeviceId): void;
}

export class InMemoryMatterEndpointStore implements IMatterEndpointStore {
  private readonly map = new Map<DeviceId, MatterEndpointMapping>();
  list(): MatterEndpointMapping[] {
    return [...this.map.values()];
  }
  get(deviceId: DeviceId): MatterEndpointMapping | null {
    return this.map.get(deviceId) ?? null;
  }
  put(mapping: MatterEndpointMapping): void {
    this.map.set(mapping.deviceId, mapping);
  }
  remove(deviceId: DeviceId): void {
    this.map.delete(deviceId);
  }
}

/** File-backed store (single JSON file, atomic-enough for a rare, low-frequency write —
 * one write per newly-bridged device, never per command/state event). Production default;
 * a Postgres-backed store can replace this later the same way `IProtocolBindingStore` grew
 * one without changing any caller — deliberately not built speculatively now (ponytail: YAGNI
 * until a second real consumer needs it). */
export class FileMatterEndpointStore implements IMatterEndpointStore {
  private cache: Map<DeviceId, MatterEndpointMapping>;

  constructor(private readonly filePath: string) {
    this.cache = this.load();
  }

  private load(): Map<DeviceId, MatterEndpointMapping> {
    if (!existsSync(this.filePath)) return new Map();
    const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as MatterEndpointMapping[];
    return new Map(raw.map((m) => [m.deviceId, m]));
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.cache.values()], null, 2), "utf8");
  }

  list(): MatterEndpointMapping[] {
    return [...this.cache.values()];
  }
  get(deviceId: DeviceId): MatterEndpointMapping | null {
    return this.cache.get(deviceId) ?? null;
  }
  put(mapping: MatterEndpointMapping): void {
    this.cache.set(mapping.deviceId, mapping);
    this.persist();
  }
  remove(deviceId: DeviceId): void {
    this.cache.delete(deviceId);
    this.persist();
  }
}

/** Allocates + persists a stable endpoint number per device (§ Endpoint architecture — "Do
 * not use array indexes as persistent endpoint identity"). Endpoint numbers start at 1
 * (0 is the Matter root endpoint) and are never reused once assigned, even if the device is
 * later removed — reissuing a freed number to a different device would let a stale
 * ecosystem-side cache address the wrong entity. */
export class MatterEndpointRegistry {
  constructor(private readonly store: IMatterEndpointStore) {}

  /** Returns the existing mapping for this device, or allocates + persists a new one. */
  resolve(deviceId: DeviceId, deviceType: MatterEndpointMapping["deviceType"] = "onOffLight"): MatterEndpointMapping {
    const existing = this.store.get(deviceId);
    if (existing) return existing;
    const next = this.nextEndpointNumber();
    const mapping: MatterEndpointMapping = { deviceId, endpointNumber: next, deviceType };
    this.store.put(mapping);
    return mapping;
  }

  byEndpointNumber(endpointNumber: number): MatterEndpointMapping | null {
    return this.store.list().find((m) => m.endpointNumber === endpointNumber) ?? null;
  }

  all(): MatterEndpointMapping[] {
    return this.store.list();
  }

  remove(deviceId: DeviceId): void {
    this.store.remove(deviceId);
  }

  private nextEndpointNumber(): number {
    const used = this.store.list().map((m) => m.endpointNumber);
    return used.length === 0 ? 1 : Math.max(...used) + 1;
  }
}
