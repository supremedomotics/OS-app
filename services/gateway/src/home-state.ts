import {
  newId,
  type Device,
  type DeviceId,
  type Home,
  type HomeId,
  type Room,
  type RoomId,
} from "@supreme/domain-model";
import type { SupremeIntegrationLayer } from "@supreme/integration-layer";

/**
 * Home topology + device registry (the Room/Device services of §4, collapsed into
 * a single in-memory module for the Phase-0 vertical slice). It owns the Supreme
 * model and registers each device's capabilities with the SIL entity registry,
 * which is the only place the backend (HA entity id) mapping lives.
 *
 * In Phase 1 this is split into the dedicated `rooms` and `devices` services
 * backed by Postgres; callers (the gateway routes) keep the same shape.
 */
export class HomeState {
  private home: Home | null = null;
  private readonly rooms = new Map<RoomId, Room>();
  private readonly devices = new Map<DeviceId, Device>();

  constructor(private readonly sil: SupremeIntegrationLayer) {}

  setHome(home: Home): void {
    this.home = home;
  }
  getHome(): Home | null {
    return this.home;
  }

  addRoom(room: Room): void {
    this.rooms.set(room.id, room);
  }
  listRooms(): Room[] {
    return [...this.rooms.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  getRoom(id: RoomId): Room | null {
    return this.rooms.get(id) ?? null;
  }

  /**
   * Register a device and bind each of its capabilities to a backend entity in the
   * SIL. `backendIds` maps a capability kind to its backend-native entity id.
   */
  addDevice(device: Device, backendIds: Partial<Record<string, string>>): void {
    this.devices.set(device.id, device);
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

  getDevice(id: DeviceId): Device | null {
    return this.devices.get(id) ?? null;
  }
  listDevicesInRoom(roomId: RoomId): Device[] {
    return [...this.devices.values()].filter((d) => d.roomId === roomId);
  }
  listDevices(): Device[] {
    return [...this.devices.values()];
  }

  /** Apply a normalized state delta from the SIL onto the cached device. */
  applyState(deviceId: DeviceId, state: Device["state"][string]): Device | null {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    device.state = { ...device.state, [state.kind]: state };
    return device;
  }
}

/**
 * Seed a demonstration home so the Phase-0 stack has something to control. This is
 * dev/demo data only; real topology is created via commissioning + the device
 * manager in later phases.
 */
export function seedDemoHome(state: HomeState, home: Home): void {
  state.setHome(home);

  const living: Room = {
    id: newId("room") as RoomId,
    homeId: home.id,
    name: "Living Room",
    floor: 0,
    areaType: "living",
    sortOrder: 0,
    icon: "sofa",
    heroImageUrl: null,
    parentRoomId: null,
  };
  const kitchen: Room = {
    id: newId("room") as RoomId,
    homeId: home.id,
    name: "Kitchen",
    floor: 0,
    areaType: "kitchen",
    sortOrder: 1,
    icon: "kitchen",
    heroImageUrl: null,
    parentRoomId: null,
  };
  state.addRoom(living);
  state.addRoom(kitchen);

  const livingLights: Device = {
    id: newId("device") as DeviceId,
    homeId: home.id,
    roomId: living.id,
    name: "Living Room Lights",
    supremeType: "dimmer",
    manufacturer: "Supreme",
    model: "Aureon Dimmer",
    driverId: null,
    status: "online",
    capabilities: [
      { kind: "onoff", config: {} },
      { kind: "brightness", config: {} },
    ],
    state: {
      brightness: { kind: "brightness", on: false, level: 0 },
    },
    metadata: {},
  };
  state.addDevice(livingLights, { onoff: "light.living_room", brightness: "light.living_room" });

  const kitchenLights: Device = {
    id: newId("device") as DeviceId,
    homeId: home.id,
    roomId: kitchen.id,
    name: "Kitchen Lights",
    supremeType: "light",
    manufacturer: "Supreme",
    model: "Aureon Light",
    driverId: null,
    status: "online",
    capabilities: [{ kind: "onoff", config: {} }],
    state: { onoff: { kind: "onoff", on: false } },
    metadata: {},
  };
  state.addDevice(kitchenLights, { onoff: "light.kitchen" });
}
