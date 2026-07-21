import type { CapabilityKind, Device, DeviceId, RoomId } from "@supreme/domain-model";

/**
 * Capability Resolution index (§ Universal Intent & Capability Engine, Phase 2).
 *
 * "Given Intent ToggleLight, discover every compatible device — KNX, Casambi,
 * Matter, MQTT, DALI, Hue, future driver — resolve dynamically, no protocol
 * logic, no linear scans." This is the index that makes that fast: every device
 * is indexed once by EACH capability it exposes, so `devicesWithCapability("onoff")`
 * is a `Map` lookup + a `Set` iteration over just the matching devices, never a
 * scan of every device on the hub. Two thousand devices with ten each supporting
 * `onoff` costs exactly the same as two devices, ten of them — not O(2000).
 *
 * Deliberately protocol-blind: it only ever reads `Device.capabilities`/`roomId`
 * (pure `@supreme/domain-model` data), never a driver, manifest, or `ProtocolKind`.
 * Kept in sync incrementally via `upsert`/`remove` — see
 * `HomeService.onDeviceChanged` for the event source the gateway wires this to;
 * `hydrate()` does the one-time full population at boot.
 */
export class CapabilityIndex {
  /** capability kind → every device id currently exposing it. */
  private readonly byCapability = new Map<CapabilityKind, Set<DeviceId>>();
  /** deviceId → the device itself, so a capability lookup doesn't need a second
   * round-trip to HomeService to read the rest of the device. */
  private readonly devices = new Map<DeviceId, Device>();

  /** Bulk initial population (boot). Replaces whatever was indexed before. */
  hydrate(devices: Device[]): void {
    this.byCapability.clear();
    this.devices.clear();
    for (const device of devices) this.upsert(device);
  }

  /** Index (or re-index) one device — safe to call for a brand-new device, a
   * moved/renamed one, or one whose capability config changed. Removes its prior
   * capability memberships first so a capability a device no longer has doesn't
   * linger as a stale index entry. */
  upsert(device: Device): void {
    this.remove(device.id);
    this.devices.set(device.id, device);
    for (const capability of device.capabilities) {
      let set = this.byCapability.get(capability.kind);
      if (!set) {
        set = new Set();
        this.byCapability.set(capability.kind, set);
      }
      set.add(device.id);
    }
  }

  /** Drop a device (deleted, or no longer relevant) from every index. */
  remove(deviceId: DeviceId): void {
    const existing = this.devices.get(deviceId);
    if (existing) {
      for (const capability of existing.capabilities) {
        this.byCapability.get(capability.kind)?.delete(deviceId);
      }
    }
    this.devices.delete(deviceId);
  }

  /** The indexed device, or `null` if it isn't currently known (never removed
   * from `HomeService` but also never hydrated/upserted — treat as "not found"). */
  get(deviceId: DeviceId): Device | null {
    return this.devices.get(deviceId) ?? null;
  }

  /** Every device exposing a capability, home-wide. */
  devicesWithCapability(kind: CapabilityKind): Device[] {
    const ids = this.byCapability.get(kind);
    if (!ids || ids.size === 0) return [];
    const out: Device[] = [];
    for (const id of ids) {
      const device = this.devices.get(id);
      if (device) out.push(device);
    }
    return out;
  }

  /** Every device exposing a capability, scoped to one room — the "Movie Mode
   * button dims every light in the room" resolution path. Still O(devices with
   * that capability), filtered by room, never O(every device on the hub). */
  devicesWithCapabilityInRoom(kind: CapabilityKind, roomId: RoomId): Device[] {
    return this.devicesWithCapability(kind).filter((d) => d.roomId === roomId);
  }

  /** Total indexed device count (diagnostics/scalability introspection only). */
  size(): number {
    return this.devices.size;
  }
}
