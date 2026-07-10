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

/**
 * Home service (§4 rooms + devices services, plus favorites). Owns the Supreme
 * topology and binds each device capability to a backend entity in the SIL entity
 * registry — the only place the HA mapping lives. Clients see pure Supreme data.
 */
export class HomeService {
  private readonly store: IHomeStore;

  constructor(
    private readonly sil: SupremeIntegrationLayer,
    store?: IHomeStore,
  ) {
    this.store = store ?? new InMemoryHomeStore();
  }

  /** Rebind every stored device's capabilities into the SIL registry (on boot). */
  async rebindRegistry(): Promise<void> {
    for (const { device, backendIds } of await this.store.listDevices()) {
      this.bind(device, backendIds);
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

  async addDevice(device: Device, backendIds: Record<string, string>): Promise<void> {
    await this.store.putDevice(device, backendIds);
    this.bind(device, backendIds);
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
  async updateDevice(deviceId: DeviceId, patch: { name?: string; roomId?: RoomId }): Promise<Device> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) throw new SupremeError("not_found", "device not found");
    if (patch.roomId !== undefined) await this.requireRoom(patch.roomId);
    const device: Device = {
      ...stored.device,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.roomId !== undefined ? { roomId: patch.roomId } : {}),
    };
    await this.store.putDevice(device, stored.backendIds);
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
    return clone;
  }

  /** Bulk-move devices to a room (§ Device Platform). Returns how many were moved. */
  async moveDevices(ids: DeviceId[], roomId: RoomId): Promise<number> {
    await this.requireRoom(roomId);
    let moved = 0;
    for (const id of ids) {
      const stored = await this.store.getDevice(id);
      if (stored) {
        await this.store.putDevice({ ...stored.device, roomId }, stored.backendIds);
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
        this.sil.unmapDevice(id);
        await this.store.deleteDevice(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Delete a device: drop its backend bindings from the SIL registry, then remove it. */
  async removeDevice(deviceId: DeviceId): Promise<void> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) throw new SupremeError("not_found", "device not found");
    this.sil.unmapDevice(deviceId);
    await this.store.deleteDevice(deviceId);
  }

  /** Merge a metadata patch onto a device (e.g. a camera's stream/snapshot URLs). */
  async setDeviceMetadata(deviceId: DeviceId, patch: Record<string, unknown>): Promise<Device | null> {
    const stored = await this.store.getDevice(deviceId);
    if (!stored) return null;
    const device = { ...stored.device, metadata: { ...stored.device.metadata, ...patch } };
    await this.store.putDevice(device, stored.backendIds);
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

  private bind(device: Device, backendIds: Record<string, string>): void {
    for (const cap of device.capabilities) {
      const backendId = backendIds[cap.kind];
      if (backendId) {
        this.sil.mapEntity(device.id, cap.kind, {
          backendId,
          backendDomain: backendId.split(".")[0] ?? "unknown",
        });
      }
    }
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
      media: {
        kind: "media",
        playback: "idle",
        volume: 30,
        muted: false,
        title: null,
        artist: null,
        album: null,
        source: "NET",
        artworkUrl: null,
        advanced: { soundMode: "PURE DIRECT", sleepMinutes: 0 },
      },
    }),
    { media: "media_player.living_room" },
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
    metadata: {},
  };
}
