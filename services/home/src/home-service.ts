import {
  newId,
  type CapabilityKind,
  type CapabilityState,
  type Device,
  type DeviceId,
  type Favorite,
  type Home,
  type Room,
  type RoomId,
  type UserId,
} from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { SupremeIntegrationLayer } from "@supreme/integration-layer";
import { InMemoryHomeStore, type IHomeStore } from "./store.js";

/** A device was created/updated, or removed — fired by {@link HomeService.onDeviceChanged}.
 * Deliberately NOT fired for live-state-only updates (`applyState`) — a state tick changes
 * a device's reported values, never which capabilities/room it belongs to, so a listener
 * that only cares about capability/topology membership (§ Universal Intent & Capability
 * Engine's `CapabilityIndex`) would otherwise be rebuilt on every single state event for no
 * reason. */
export type DeviceChangeEvent = { type: "upsert"; device: Device } | { type: "delete"; deviceId: DeviceId };

/**
 * Home service (§4 rooms + devices services, plus favorites). Owns the Supreme
 * topology and binds each device capability to a backend entity in the SIL entity
 * registry — the only place the HA mapping lives. Clients see pure Supreme data.
 */
export class HomeService {
  private readonly store: IHomeStore;
  private readonly changeListeners = new Set<(event: DeviceChangeEvent) => void>();

  constructor(
    private readonly sil: SupremeIntegrationLayer,
    store?: IHomeStore,
  ) {
    this.store = store ?? new InMemoryHomeStore();
  }

  /** Subscribe to device topology/capability changes (create, update, move, delete —
   * never a bare live-state tick). Mirrors `SupremeIntegrationLayer.subscribe`/
   * `NotificationService.onNotification`'s exact shape. Returns an unsubscribe fn. */
  onDeviceChanged(listener: (event: DeviceChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChanged(event: DeviceChangeEvent): void {
    for (const l of this.changeListeners) l(event);
  }

  /** Restore every stored device's HA binding on boot (ADR-0023 § Driver Binding: a
   * driver instance is per-process, so a persisted `provider="homeassistant"`
   * lifecycle record from before this restart does NOT mean `HomeAssistantProviderDriver`
   * actually has this device in its in-memory `manages()` set this boot — the exact
   * same "protocol bindings must be replayed onto the driver on every boot" principle
   * `InstallerServices`'s driver lifecycle already applies to native protocol
   * bindings, extended here to Home Assistant). Re-binds through the real
   * `bindNative()` path (never fabricates ONLINE) when a "homeassistant" driver is
   * registered this boot; otherwise only restores the entity mapping, exactly like
   * `addDevice()`'s own no-HA-configured fallback — never a special ownership side
   * effect either way. */
  async rebindRegistry(): Promise<void> {
    for (const { device, backendIds } of await this.store.listDevices()) {
      if (Object.keys(backendIds).length === 0) continue;
      if (this.sil.migrationEnabled && this.sil.getNativeDriver("homeassistant")) {
        const existing = this.sil.providers.get(device.id);
        if (!existing || existing.provider === "homeassistant") {
          for (const cap of device.capabilities) {
            const backendId = backendIds[cap.kind];
            if (backendId) await this.sil.bindNative({ deviceId: device.id, capability: cap.kind, address: backendId }, "homeassistant");
          }
          continue;
        }
      }
      this.mapEntities(device, backendIds);
    }
  }

  getHome(): Promise<Home | null> {
    return this.store.getHome();
  }
  setHome(home: Home): Promise<void> {
    return this.store.putHome(home);
  }

  listRooms(): Promise<Room[]> {
    return this.store.listRooms();
  }
  getRoom(id: RoomId): Promise<Room | null> {
    return this.store.getRoom(id);
  }
  addRoom(room: Room): Promise<void> {
    return this.store.putRoom(room);
  }

  /**
   * Delete a room. Any devices left in it are unassigned (roomId → null) rather than deleted —
   * a room disappearing must never take its devices with it; they simply become "unassigned"
   * until moved elsewhere (matches the existing bulk-move device flow).
   */
  async removeRoom(roomId: RoomId): Promise<void> {
    await this.requireRoom(roomId);
    const inRoom = await this.listDevicesInRoom(roomId);
    for (const d of inRoom) {
      const stored = await this.store.getDevice(d.id);
      if (stored) await this.store.putDevice({ ...stored.device, roomId: null }, stored.backendIds);
    }
    await this.store.deleteRoom(roomId);
  }

  async getDevice(id: DeviceId): Promise<Device | null> {
    return (await this.store.getDevice(id))?.device ?? null;
  }
  async listDevices(): Promise<Device[]> {
    return (await this.store.listDevices()).map((d) => d.device);
  }
  async listDevicesInRoom(roomId: RoomId): Promise<Device[]> {
    return (await this.store.listDevices())
      .map((d) => d.device)
      .filter((d) => d.roomId === roomId);
  }

  /**
   * Commission a device (ADR-0023 § Commissioning: Create Device → Assign Provider →
   * Bind Driver). `backendIds` non-empty is the explicit installer decision to map
   * this device onto Home Assistant. When this hub actually has a "homeassistant"
   * provider driver registered, this binds each mapped capability through
   * `bindNative(..., "homeassistant")` — the EXACT same Driver Binding Engine path
   * every other provider uses, never a special ownership side effect. A device
   * already bound to a real native driver is left untouched — `DriverBindingEngine`/
   * `ProviderRegistry` already refuse to silently downgrade a bound device. When no
   * "homeassistant" driver is registered on this hub at all (HA not configured — an
   * explicitly supported topology per ADR-0023 § Native Backend), this only maps
   * entities, exactly as it does on a bare (non-router) adapter — there is no
   * provider to honestly bind against, so nothing pretends there is.
   */
  async addDevice(device: Device, backendIds: Record<string, string>): Promise<void> {
    await this.store.putDevice(device, backendIds);
    if (this.sil.migrationEnabled && this.sil.getNativeDriver("homeassistant")) {
      for (const cap of device.capabilities) {
        const backendId = backendIds[cap.kind];
        if (!backendId) continue;
        const existing = this.sil.providers.get(device.id);
        if (existing && existing.provider !== "homeassistant") continue; // already bound elsewhere — never downgrade
        await this.sil.bindNative({ deviceId: device.id, capability: cap.kind, address: backendId }, "homeassistant");
      }
    } else {
      this.mapEntities(device, backendIds);
    }
    this.emitChanged({ type: "upsert", device });
  }

  /** Apply a normalized state delta from the SIL onto the cached/persisted device. */
  async applyState(deviceId: DeviceId, state: CapabilityState): Promise<Device | null> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) return null;
    const nextState = { ...stored.device.state, [state.kind]: state };
    await this.store.updateDeviceState(deviceId, nextState);
    return { ...stored.device, state: nextState };
  }

  async roomOf(deviceId: DeviceId): Promise<string | null> {
    return (await this.store.getDevice(deviceId))?.device.roomId ?? null;
  }

  /**
   * Move and/or rename a device. Any device can go in any room — the only constraint is that
   * the target room exists. Capability bindings are unaffected (the device keeps its backend
   * mappings), so it stays controllable after the move.
   */
  async updateDevice(deviceId: DeviceId, patch: { name?: string; roomId?: RoomId; metadata?: Record<string, unknown> }): Promise<Device> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) throw new SupremeError("not_found", "device not found");
    if (patch.roomId !== undefined) await this.requireRoom(patch.roomId);
    const device: Device = {
      ...stored.device,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.roomId !== undefined ? { roomId: patch.roomId } : {}),
      // Shallow merge, never replace — other features may already have their own keys
      // in this device's metadata bag (e.g. a driver-populated field elsewhere).
      ...(patch.metadata !== undefined ? { metadata: { ...stored.device.metadata, ...patch.metadata } } : {}),
    };
    await this.store.putDevice(device, stored.backendIds);
    this.emitChanged({ type: "upsert", device });
    return device;
  }

  /**
   * Clone a device's configuration into a new device (§ Device Platform). The copy keeps the type,
   * capabilities, manufacturer/model and room, but gets a fresh id, a "(copy)" name, empty live
   * state and NO backend bindings — it's a configuration duplicate (e.g. to pre-stage identical
   * fixtures), not a second controller for the same physical device.
   */
  async cloneDevice(deviceId: DeviceId): Promise<Device> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) throw new SupremeError("not_found", "device not found");
    const src = stored.device;
    const clone: Device = {
      ...src,
      id: newId("device") as DeviceId,
      name: `${src.name} (copy)`,
      state: {},
      metadata: { ...src.metadata, clonedFrom: src.id },
    };
    await this.store.putDevice(clone, {});
    this.emitChanged({ type: "upsert", device: clone });
    return clone;
  }

  /** Bulk-move devices to a room (§ Device Platform). Returns how many were moved. */
  async moveDevices(ids: DeviceId[], roomId: RoomId): Promise<number> {
    await this.requireRoom(roomId);
    let moved = 0;
    for (const id of ids) {
      const stored = await this.store.getDevice(id);
      if (stored) {
        const device = { ...stored.device, roomId };
        await this.store.putDevice(device, stored.backendIds);
        this.emitChanged({ type: "upsert", device });
        moved += 1;
      }
    }
    return moved;
  }

  /** Bulk-remove devices (§ Device Platform). Returns how many were removed. */
  async removeDevices(ids: DeviceId[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      const stored = await this.store.getDevice(id);
      if (stored) {
        await this.sil.unmapDevice(id);
        await this.store.deleteDevice(id);
        this.emitChanged({ type: "delete", deviceId: id });
        removed += 1;
      }
    }
    return removed;
  }

  /** Delete a device: drop its backend bindings from the SIL registry, then remove it. */
  async removeDevice(deviceId: DeviceId): Promise<void> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) throw new SupremeError("not_found", "device not found");
    await this.sil.unmapDevice(deviceId);
    await this.store.deleteDevice(deviceId);
    this.emitChanged({ type: "delete", deviceId });
  }

  /** Merge a metadata patch onto a device (e.g. a camera's stream/snapshot URLs). */
  async setDeviceMetadata(deviceId: DeviceId, patch: Record<string, unknown>): Promise<Device | null> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) return null;
    const device = { ...stored.device, metadata: { ...stored.device.metadata, ...patch } };
    await this.store.putDevice(device, stored.backendIds);
    this.emitChanged({ type: "upsert", device });
    return device;
  }

  /** Replace one capability's config (e.g. an AVR's real AudioCapabilityConfig, once its
   * driver reports it at bind time) — the same "merge onto the stored device" shape as
   * {@link setDeviceMetadata}, scoped to a single `DeviceCapability.config`. */
  async setCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind, config: Record<string, unknown>): Promise<Device | null> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) return null;
    const capabilities = stored.device.capabilities.map((c) => (c.kind === capability ? { ...c, config } : c));
    const device = { ...stored.device, capabilities };
    await this.store.putDevice(device, stored.backendIds);
    this.emitChanged({ type: "upsert", device });
    return device;
  }

  // ── Favorites ──────────────────────────────────────────────────────────────
  listFavorites(userId: UserId): Promise<Favorite[]> {
    return this.store.listFavorites(userId);
  }
  async setFavorite(userId: UserId, ref: Favorite["ref"], on: boolean): Promise<void> {
    if (on) {
      const count = (await this.store.listFavorites(userId)).length;
      await this.store.putFavorite({ userId, ref, sortOrder: count });
    } else {
      await this.store.removeFavorite(userId, ref);
    }
  }

  /** Resolve a room id, throwing a typed 404 if absent (route convenience). */
  async requireRoom(roomId: RoomId): Promise<Room> {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new SupremeError("not_found", "room not found");
    return room;
  }

  /** Map every backend-id'd capability into the SIL's entity registry — mapping
   * only, never a provider decision (ADR-0023 § Commissioning). Used by the boot-time
   * `rebindRegistry()` restore path and by `addDevice()`'s bare-adapter (no provider
   * concept) fallback. Returns whether anything was actually mapped. */
  private mapEntities(device: Device, backendIds: Record<string, string>): boolean {
    let mapped = false;
    for (const cap of device.capabilities) {
      const backendId = backendIds[cap.kind];
      if (backendId) {
        this.sil.mapEntity(device.id, cap.kind, {
          backendId,
          backendDomain: backendId.split(".")[0] ?? "unknown",
        });
        mapped = true;
      }
    }
    return mapped;
  }
}

/**
 * Seed a demonstration home (dev/demo only) covering the Phase-1 device classes:
 * lighting, climate, media, and covers — so the homeowner MVP has a full surface.
 */
export async function seedDemoHome(home: HomeService, homeRecord: Home): Promise<void> {
  await home.setHome(homeRecord);
  const hid = homeRecord.id;

  const rooms: Room[] = [
    room(hid, "Living Room", "living", 0, "sofa"),
    room(hid, "Kitchen", "kitchen", 1, "kitchen"),
    room(hid, "Bedroom", "bedroom", 2, "bed"),
  ];
  for (const r of rooms) await home.addRoom(r);
  const [living, kitchen, bedroom] = rooms as [Room, Room, Room];

  await home.addDevice(
    device(hid, living.id, "Living Room Lights", "dimmer", [
      { kind: "onoff", config: {} },
      { kind: "brightness", config: {} },
      { kind: "color", config: {} },
    ], {
      brightness: { kind: "brightness", on: false, level: 0 },
      color: { kind: "color", on: false, level: 0, hue: 40, saturation: 60, kelvin: 2700 },
    }),
    { onoff: "light.living_room", brightness: "light.living_room", color: "light.living_room" },
  );
  await home.addDevice(
    device(hid, living.id, "Living Room Blinds", "cover", [{ kind: "position", config: {} }], {
      position: { kind: "position", position: 100, moving: false },
    }),
    { position: "cover.living_room" },
  );
  await home.addDevice(
    device(hid, living.id, "Media", "media_player", [{
      // Real Denon/Yamaha SSDP discovery reports ["onoff", "media"] (see avr-driver.ts /
      // yamaha-driver.ts discover()) — a receiver's power state is a first-class capability,
      // not folded into the media capability. Mirrored here so the demo seed matches what a
      // real commissioned AVR actually exposes.
      kind: "onoff",
      config: {},
    }, {
      kind: "media",
      // A representative AVR-shaped AudioCapabilityConfig (§ Universal AVR Framework) so
      // the seeded demo home exercises the same capability-driven console a real
      // commissioned Denon/Marantz/Yamaha receiver renders — inputs/soundModes/
      // advancedControls, never hardcoded in the UI. Hand-written here (not imported from
      // @supreme/protocols, which this package doesn't otherwise depend on) since it's
      // demo seed data, not the production Denon config builder.
      config: {
        source: "installer_declared",
        inputs: [
          { id: "BD", label: "Blu-ray", type: "hdmi" },
          { id: "SAT/CBL", label: "Apple TV", type: "hdmi" },
          { id: "NET", label: "Spotify", type: "streaming" },
          { id: "SERVER", label: "TIDAL", type: "streaming" },
          { id: "USB/IPOD", label: "Music Server", type: "network" },
        ],
        soundModes: [
          { id: "MOVIE", label: "MOVIE" },
          { id: "MUSIC", label: "MUSIC" },
          { id: "GAME", label: "GAME" },
          { id: "PURE DIRECT", label: "PURE DIRECT" },
          { id: "DOLBY DIGITAL", label: "DOLBY DIGITAL" },
        ],
        toneControl: { bass: { min: -6, max: 6, step: 1 }, treble: { min: -6, max: 6, step: 1 } },
        advancedControls: [{
          key: "sleepMinutes",
          label: "Sleep Timer",
          kind: "select",
          icon: "sleep",
          options: [
            { id: "0", label: "Off" },
            { id: "30", label: "30 min" },
            { id: "60", label: "60 min" },
            { id: "90", label: "90 min" },
            { id: "120", label: "120 min" },
          ],
        }],
      },
    }], {
      onoff: { kind: "onoff", on: true },
      media: {
        kind: "media",
        // A track already "loaded" (paused, mid-way through) rather than a blank idle
        // state — so the console's Now Playing hero, progress bar, and position ticking
        // (§ AVR Detail Page "Live Data") all have something real to render out of the box,
        // the same way a receiver reports whatever was last playing after a reboot.
        playback: "paused",
        volume: 30,
        muted: false,
        title: "Nocturne in Blue",
        artist: "Aureon Session",
        album: "Late Reflections",
        source: "NET",
        artworkUrl: null,
        durationSec: 243,
        positionSec: 86,
        advanced: { soundMode: "PURE DIRECT", sleepMinutes: 0 },
      },
    }),
    { onoff: "media_player.living_room", media: "media_player.living_room" },
  );
  await home.addDevice(
    device(hid, living.id, "Living Room AC", "thermostat", [
      { kind: "onoff", config: {} },
      {
        kind: "temperature",
        // A representative ClimateCapabilityConfig — hand-written to match EXACTLY what
        // CoolMasterProtocolDriver.getCapabilityConfig() really produces for a bound
        // indoor unit (indoorUnitCapabilityConfig() in @supreme/protocols), not imported
        // from it (this package doesn't otherwise depend on @supreme/protocols): source
        // "device_reported", the fixed 4-mode set (no "dry" — Supreme's temperature
        // command has no dry value to send, see coolmaster-parser.ts's mode mapping
        // notes), fan speeds/swing positions/filter/demand/lock/inhibit support exactly
        // as CoolMaster reports them, so the demo home exercises the same capability-
        // driven climate console a real commissioned CoolMasterNet unit renders.
        config: {
          source: "device_reported",
          modes: ["heat", "cool", "auto", "fan_only"],
          fanSpeeds: ["Auto", "Low", "Med", "High", "Top"],
          swingPositions: ["Auto", "Up", "Down", "Left", "Right"],
          filterSupported: true,
          demandSupported: true,
          faultSupported: true,
          lockSupported: true,
          inhibitSupported: true,
          line: "L1",
          manufacturer: null,
          advancedControls: [
            { key: "fanSpeed", label: "Fan Speed", kind: "select", icon: "fan" },
            { key: "swing", label: "Swing", kind: "select", icon: "swing" },
            { key: "locked", label: "Remote Lock", kind: "toggle", icon: "lock" },
            { key: "inhibited", label: "Inhibit", kind: "toggle", icon: "block" },
            { key: "filterReset", label: "Reset Filter Warning", kind: "action", icon: "filter" },
          ],
        },
      },
    ], {
      onoff: { kind: "onoff", on: true },
      temperature: {
        kind: "temperature",
        ambientC: 24.5,
        targetC: 24,
        mode: "cool",
        advanced: { fanSpeed: "Top", swing: "Auto", filterWarning: false, demand: true, faultCode: null, locked: false, inhibited: false },
      },
    }, {
      // Installer-entered fields (§ AC Unit info card) — never driver-reported (CoolMaster's
      // own capability config always leaves `manufacturer` null, see coolmaster-mapper.ts).
      hvac: { brand: "Daikin", unitType: "4-Way Cassette" },
    }),
    { onoff: "coolmaster.living_room_ac", temperature: "coolmaster.living_room_ac" },
  );
  // A set of colour lights so the room's lighting disc shows multiple draggable nodes
  // (the Ovio multi-light colour-field pattern, §11.1).
  for (const [lname, hue, on] of [
    ["Ceiling", 8, true],
    ["Standing", 210, true],
    ["Spot LC", 280, true],
    ["Spot LL", 150, false],
  ] as const) {
    await home.addDevice(
      device(hid, living.id, lname, "light", [
        { kind: "onoff", config: {} },
        { kind: "brightness", config: {} },
        { kind: "color", config: {} },
      ], {
        brightness: { kind: "brightness", on, level: on ? 70 : 0 },
        color: { kind: "color", on, level: on ? 70 : 0, hue, saturation: 85, kelvin: 2700 },
      }),
      { onoff: `light.${lname.toLowerCase().replace(/ /g, "_")}`, color: `light.${lname.toLowerCase().replace(/ /g, "_")}` },
    );
  }
  await home.addDevice(
    device(hid, living.id, "Front Door", "lock", [{ kind: "lock", config: {} }], {
      lock: { kind: "lock", locked: true, jammed: false },
    }),
    { lock: "lock.front_door" },
  );
  await home.addDevice(
    device(hid, living.id, "Charging Station", "switch", [{ kind: "onoff", config: {} }], {
      onoff: { kind: "onoff", on: true },
    }),
    { onoff: "switch.charging_station" },
  );
  await home.addDevice(
    device(hid, living.id, "Ceiling Fan", "fan", [{ kind: "fan", config: {} }], {
      fan: { kind: "fan", on: true, preset: "auto", direction: "forward" },
    }),
    { fan: "fan.living_room" },
  );
  await home.addDevice(
    device(hid, living.id, "Fred", "vacuum", [{ kind: "vacuum", config: {} }], {
      vacuum: { kind: "vacuum", status: "cleaning", fanSpeed: "normal" },
    }),
    { vacuum: "vacuum.fred" },
  );
  await home.addDevice(
    device(hid, kitchen.id, "Kitchen Lights", "light", [{ kind: "onoff", config: {} }], {
      onoff: { kind: "onoff", on: false },
    }),
    { onoff: "light.kitchen" },
  );
  await home.addDevice(
    device(hid, bedroom.id, "Bedroom Climate", "thermostat", [{ kind: "temperature", config: {} }], {
      temperature: { kind: "temperature", ambientC: 21, targetC: 21, mode: "auto" },
    }),
    { temperature: "climate.bedroom" },
  );
}

function room(homeId: Home["id"], name: string, areaType: Room["areaType"], sort: number, icon: string): Room {
  return {
    id: newId("room") as RoomId,
    homeId,
    name,
    building: null,
    floor: 0,
    area: null,
    areaType,
    sortOrder: sort,
    icon,
    heroImageUrl: null,
    parentRoomId: null,
  };
}

function device(
  homeId: Home["id"],
  roomId: RoomId,
  name: string,
  supremeType: Device["supremeType"],
  capabilities: Device["capabilities"],
  state: Device["state"],
  metadata: Record<string, unknown> = {},
): Device {
  return {
    id: newId("device") as DeviceId,
    homeId,
    roomId,
    name,
    supremeType,
    manufacturer: "Supreme",
    model: "Aureon",
    driverId: null,
    status: "online",
    capabilities,
    state,
    metadata,
  };
}
