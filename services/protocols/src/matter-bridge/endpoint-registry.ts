import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceId } from "@supreme/domain-model";

/** Matter Device Type id (0x0100 On/Off Light, 0x0101 Dimmable Light, 0x010c Color Temperature
 * Light, 0x010d Extended Color Light, 0x0202 Window Covering, …) — see `device-types/
 * matter-device-types.ts` for the authoritative registry these ids resolve against.
 *
 * § Matter Bridge Phase 1 foundation — this field used to be the string literal `"onOffLight"`,
 * the exact architectural gap this Phase exists to close: the persistence model had no room for
 * a second device type without a schema change, which is why every colour-temperature light and
 * the curtain motor that triggered this work could never have been represented here even after
 * the resolver/exposure logic learned about them. A real numeric Matter Device Type id is the
 * permanent identity Phase 2's controller-side discovery will read/write against the SAME field.
 */
export type MatterDeviceTypeId = number;

/** One persisted SupremeOS device ↔ Matter bridged-endpoint mapping. */
export interface MatterEndpointMapping {
  deviceId: DeviceId;
  /** Stable Matter endpoint number, assigned once and reused across restarts — never an
   * array index (§ Matter Bridge Phase 1: "endpoint identity must remain stable"). */
  endpointNumber: number;
  deviceTypeId: MatterDeviceTypeId;
  /** § Matter Bridge Phase 1.2 — the device's CURRENT SupremeOS `device.name`, the source for
   * the Matter endpoint's user-facing BridgedDeviceBasicInformation `NodeLabel` (what Apple
   * Home/Google Home/Alexa/SmartThings actually display — see `real-server.ts`'s doc comment
   * for why the driver's OWN `start()` re-expose loop needs this persisted rather than looked
   * up live: it has no access to `home.listDevices()`, only the registry). Kept in sync on
   * every `resolve()` call that passes a current name (§ requirement 3 — renaming a SupremeOS
   * device updates the Matter-visible name; endpoint identity, below, never changes because of
   * a rename). */
  name: string;
  /** § Matter Bridge Phase 1.2 — the device's CURRENT full set of declared SupremeOS capability
   * kinds (e.g. `["onoff","brightness","color"]` for a KNX tunable light, `["brightness","color"]`
   * for a Casambi CCT fixture with no separate onoff entry). Needed so `real-server.ts`'s OnOff/
   * LevelControl cluster routing can target whichever capability the device ACTUALLY declares
   * (mirroring `apps/web-homeowner/src/lighting.tsx`'s own `showBrightness ? "brightness" :
   * "onoff"` fallback) instead of being hard-locked to the device type's single
   * `primaryCapability` — a device type alone can't tell KNX's 3-capability shape apart from
   * Casambi's 2-capability shape. Kept in sync on every `resolve()` call, same as `name`. Defaults
   * to `[]` for a pre-this-fix persisted file (§ `load()` below) — a driver seeing an empty set
   * falls back to the OLD single-capability routing for that one endpoint until the next
   * reconcile pass supplies the real set. */
  capabilityKinds: string[];
}

/** On/Off Light (0x0100) — the id every registry entry persisted before this Phase implicitly
 * meant via the old `deviceType: "onOffLight"` string literal. Used only to normalize an
 * old-format file on load (§ below); never referenced by new code that has a real resolution. */
const LEGACY_ON_OFF_LIGHT_DEVICE_TYPE_ID = 0x0100;

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

  /** § Phase 2 Recovery — a missing file is the normal "nothing bridged yet" case (empty
   * map). A file that EXISTS but fails to parse, or whose contents fail integrity checks
   * (duplicate endpoint numbers, duplicate device ids, a non-positive-integer endpoint
   * number), is NEVER treated as "start clean" — that would silently reissue identities a
   * real ecosystem may still hold cached. It throws a clear, actionable error instead so the
   * operator fixes or restores the file rather than the bridge quietly renumbering everyone. */
  private load(): Map<DeviceId, MatterEndpointMapping> {
    if (!existsSync(this.filePath)) return new Map();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `matter-bridge: endpoint registry at ${this.filePath} is corrupt (invalid JSON) — ` +
          `refusing to start clean, as that would risk reissuing endpoint identity. Restore ` +
          `from backup or delete the file only if you accept every bridged device will be ` +
          `re-added at a NEW endpoint number. Cause: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(raw)) {
      throw new Error(`matter-bridge: endpoint registry at ${this.filePath} is not a JSON array`);
    }
    const map = new Map<DeviceId, MatterEndpointMapping>();
    const usedNumbers = new Set<number>();
    for (const raw_m of raw as (MatterEndpointMapping & { deviceType?: unknown })[]) {
      if (typeof raw_m.deviceId !== "string" || !raw_m.deviceId) {
        throw new Error(`matter-bridge: endpoint registry at ${this.filePath} has an entry with an invalid deviceId`);
      }
      if (!Number.isInteger(raw_m.endpointNumber) || raw_m.endpointNumber < 1) {
        throw new Error(
          `matter-bridge: endpoint registry at ${this.filePath} has an invalid endpoint number ` +
            `(${String(raw_m.endpointNumber)}) for device ${raw_m.deviceId} — must be a positive integer`,
        );
      }
      // § Matter Bridge Phase 1 foundation — a pre-Phase-1 file has `deviceType: "onOffLight"`
      // and no `deviceTypeId` at all; normalize it to the real id it always implicitly meant,
      // so an existing deployment's already-bridged On/Off lights keep their identity untouched.
      const deviceTypeId =
        typeof raw_m.deviceTypeId === "number"
          ? raw_m.deviceTypeId
          : raw_m.deviceType === "onOffLight"
            ? LEGACY_ON_OFF_LIGHT_DEVICE_TYPE_ID
            : undefined;
      if (deviceTypeId === undefined) {
        throw new Error(
          `matter-bridge: endpoint registry at ${this.filePath} has an entry for device ` +
            `${raw_m.deviceId} with no recognizable device type (neither a numeric deviceTypeId ` +
            `nor the legacy "onOffLight" string)`,
        );
      }
      // § Matter Bridge Phase 1.2 — a pre-this-fix file has no `name` at all (the exact bug
      // this Phase closes: the driver's restart re-expose loop had nothing but `deviceId` to
      // fall back to, which is precisely what leaked into Apple Home as the accessory name).
      // Falling back to `deviceId` here too is a deliberate, ONE-TIME degraded state, not a
      // repeat of the bug: the very next `resolve()` call from a live reconcile pass (which
      // always has the real `device.name`) overwrites and persists the correct name — this
      // fallback only governs what a re-expose shows during the single restart that happens to
      // land between an upgrade and the first reconcile.
      const name = typeof raw_m.name === "string" && raw_m.name ? raw_m.name : raw_m.deviceId;
      const capabilityKinds = Array.isArray(raw_m.capabilityKinds) ? raw_m.capabilityKinds.filter((k): k is string => typeof k === "string") : [];
      const m: MatterEndpointMapping = { deviceId: raw_m.deviceId, endpointNumber: raw_m.endpointNumber, deviceTypeId, name, capabilityKinds };
      if (map.has(m.deviceId)) {
        throw new Error(`matter-bridge: endpoint registry at ${this.filePath} has a duplicate deviceId (${m.deviceId})`);
      }
      if (usedNumbers.has(m.endpointNumber)) {
        throw new Error(
          `matter-bridge: endpoint registry at ${this.filePath} maps two devices to the same ` +
            `endpoint number (${m.endpointNumber}) — two ecosystem-visible identities would collide`,
        );
      }
      usedNumbers.add(m.endpointNumber);
      map.set(m.deviceId, m);
    }
    return map;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o750 });
    // 0600: this file only ever holds deviceId/endpointNumber/deviceType (never a secret —
    // see Phase 2 security review), but it lives in the same persistent data directory as
    // real secrets, so it gets the same restrictive permission by default regardless.
    writeFileSync(this.filePath, JSON.stringify([...this.cache.values()], null, 2), { mode: 0o600 });
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

  /** Returns the existing mapping for this device (persisting a fresh `name` if it changed —
   * § Matter Bridge Phase 1.2, requirement 3: renaming a SupremeOS device updates the Matter-
   * visible name), or allocates + persists a new one. An existing mapping's `deviceTypeId` is
   * returned AS PERSISTED even if the caller passes a different one — a device's resolved
   * Matter Device Type can change if its SupremeOS capabilities change (e.g. a driver update
   * adds real color support to a previously onoff-only light), but that is an explicit
   * re-classification decision for the caller to make (§ Phase 1 doesn't yet implement it),
   * never a silent overwrite here. `endpointNumber` — the stable identity — NEVER changes for
   * an existing mapping, regardless of what `name` or `deviceTypeId` the caller passes. */
  resolve(
    deviceId: DeviceId,
    deviceTypeId: MatterDeviceTypeId = 0x0100,
    name: string = deviceId,
    capabilityKinds: string[] = [],
  ): MatterEndpointMapping {
    const existing = this.store.get(deviceId);
    if (existing) {
      const sameKinds =
        existing.capabilityKinds.length === capabilityKinds.length && existing.capabilityKinds.every((k, i) => k === capabilityKinds[i]);
      if (existing.name !== name || !sameKinds) {
        const updated: MatterEndpointMapping = { ...existing, name, capabilityKinds: capabilityKinds.length ? capabilityKinds : existing.capabilityKinds };
        this.store.put(updated);
        return updated;
      }
      return existing;
    }
    const next = this.nextEndpointNumber();
    const mapping: MatterEndpointMapping = { deviceId, endpointNumber: next, deviceTypeId, name, capabilityKinds };
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
