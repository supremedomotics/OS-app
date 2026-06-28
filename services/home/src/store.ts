import type {
  Device,
  DeviceId,
  Favorite,
  Home,
  Room,
  RoomId,
  UserId,
} from "@supreme/domain-model";

/**
 * Persistence boundary for home topology, devices, and favorites. Phase-1 ships an
 * in-memory implementation; the Postgres implementation in `@supreme/persistence`
 * satisfies the same interface so the hub persists across restarts (§5).
 *
 * The `backendIds` map (capability kind → backend entity id) is stored alongside
 * the device but is consumed ONLY by the SIL; it is never returned to clients.
 */
export interface StoredDevice {
  device: Device;
  backendIds: Record<string, string>;
}

export interface IHomeStore {
  getHome(): Promise<Home | null>;
  putHome(home: Home): Promise<void>;

  listRooms(): Promise<Room[]>;
  getRoom(id: RoomId): Promise<Room | null>;
  putRoom(room: Room): Promise<void>;

  listDevices(): Promise<StoredDevice[]>;
  getDevice(id: DeviceId): Promise<StoredDevice | null>;
  putDevice(device: Device, backendIds: Record<string, string>): Promise<void>;
  updateDeviceState(id: DeviceId, state: Device["state"]): Promise<void>;
  deleteDevice(id: DeviceId): Promise<void>;

  listFavorites(userId: UserId): Promise<Favorite[]>;
  putFavorite(fav: Favorite): Promise<void>;
  removeFavorite(userId: UserId, ref: Favorite["ref"]): Promise<void>;
}

const favKey = (ref: Favorite["ref"]): string =>
  ref.type === "device" ? `device:${ref.deviceId}` : `scene:${ref.sceneId}`;

export class InMemoryHomeStore implements IHomeStore {
  private home: Home | null = null;
  private readonly rooms = new Map<RoomId, Room>();
  private readonly devices = new Map<DeviceId, StoredDevice>();
  private readonly favorites = new Map<UserId, Map<string, Favorite>>();

  async getHome() {
    return this.home;
  }
  async putHome(home: Home) {
    this.home = home;
  }
  async listRooms() {
    return [...this.rooms.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }
  async getRoom(id: RoomId) {
    return this.rooms.get(id) ?? null;
  }
  async putRoom(room: Room) {
    this.rooms.set(room.id, room);
  }
  async listDevices() {
    return [...this.devices.values()];
  }
  async getDevice(id: DeviceId) {
    return this.devices.get(id) ?? null;
  }
  async putDevice(device: Device, backendIds: Record<string, string>) {
    this.devices.set(device.id, { device, backendIds });
  }
  async updateDeviceState(id: DeviceId, state: Device["state"]) {
    const existing = this.devices.get(id);
    if (existing) existing.device = { ...existing.device, state };
  }
  async deleteDevice(id: DeviceId) {
    this.devices.delete(id);
  }
  async listFavorites(userId: UserId) {
    return [...(this.favorites.get(userId)?.values() ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
  }
  async putFavorite(fav: Favorite) {
    const map = this.favorites.get(fav.userId) ?? new Map<string, Favorite>();
    map.set(favKey(fav.ref), fav);
    this.favorites.set(fav.userId, map);
  }
  async removeFavorite(userId: UserId, ref: Favorite["ref"]) {
    this.favorites.get(userId)?.delete(favKey(ref));
  }
}
