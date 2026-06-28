import type {
  Device,
  DeviceId,
  Favorite,
  Home,
  Room,
  RoomId,
  SceneId,
  UserId,
} from "@supreme/domain-model";
import type { IHomeStore, StoredDevice } from "@supreme/home";
import type { SqlDb } from "../sql-db.js";
import { rowToHome } from "./identity-repo.js";

interface RoomRow {
  id: string;
  home_id: string;
  name: string;
  floor: number;
  area_type: string;
  sort_order: number;
  icon: string | null;
  hero_image_url: string | null;
  parent_room_id: string | null;
}
interface DeviceRow {
  id: string;
  home_id: string;
  room_id: string | null;
  name: string;
  supreme_type: string;
  manufacturer: string | null;
  model: string | null;
  driver_id: string | null;
  status: string;
  capabilities: Device["capabilities"];
  state: Device["state"];
  metadata: Record<string, unknown>;
  backend_ids: Record<string, string>;
}
interface FavRow {
  user_id: string;
  ref_type: string;
  ref_id: string;
  sort_order: number;
}

function rowToRoom(r: RoomRow): Room {
  return {
    id: r.id as RoomId,
    homeId: r.home_id as Home["id"],
    name: r.name,
    floor: r.floor,
    areaType: r.area_type as Room["areaType"],
    sortOrder: r.sort_order,
    icon: r.icon,
    heroImageUrl: r.hero_image_url,
    parentRoomId: (r.parent_room_id as RoomId | null) ?? null,
  };
}

function rowToDevice(r: DeviceRow): StoredDevice {
  return {
    device: {
      id: r.id as DeviceId,
      homeId: r.home_id as Home["id"],
      roomId: (r.room_id as RoomId | null) ?? null,
      name: r.name,
      supremeType: r.supreme_type as Device["supremeType"],
      manufacturer: r.manufacturer,
      model: r.model,
      driverId: (r.driver_id as Device["driverId"]) ?? null,
      status: r.status as Device["status"],
      capabilities: r.capabilities,
      state: r.state,
      metadata: r.metadata,
    },
    backendIds: r.backend_ids,
  };
}

function rowToFavorite(r: FavRow): Favorite {
  const ref: Favorite["ref"] =
    r.ref_type === "device"
      ? { type: "device", deviceId: r.ref_id as DeviceId }
      : { type: "scene", sceneId: r.ref_id as SceneId };
  return { userId: r.user_id as UserId, ref, sortOrder: r.sort_order };
}

const J = (v: unknown) => JSON.stringify(v);

/** Postgres-backed {@link IHomeStore}. */
export class HomeRepo implements IHomeStore {
  constructor(private readonly db: SqlDb) {}

  async getHome(): Promise<Home | null> {
    const { rows } = await this.db.query<Parameters<typeof rowToHome>[0]>("SELECT * FROM homes LIMIT 1");
    return rows[0] ? rowToHome(rows[0]) : null;
  }
  async putHome(home: Home): Promise<void> {
    await this.db.query(
      `INSERT INTO homes (id, name, address, tier, master_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET name=$2, address=$3, tier=$4, master_user_id=$5`,
      [home.id, home.name, home.address, home.tier, home.masterUserId, home.createdAt],
    );
  }

  async listRooms(): Promise<Room[]> {
    const { rows } = await this.db.query<RoomRow>("SELECT * FROM rooms ORDER BY sort_order");
    return rows.map(rowToRoom);
  }
  async getRoom(id: RoomId): Promise<Room | null> {
    const { rows } = await this.db.query<RoomRow>("SELECT * FROM rooms WHERE id=$1", [id]);
    return rows[0] ? rowToRoom(rows[0]) : null;
  }
  async putRoom(room: Room): Promise<void> {
    await this.db.query(
      `INSERT INTO rooms (id, home_id, name, floor, area_type, sort_order, icon, hero_image_url, parent_room_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         name=$3, floor=$4, area_type=$5, sort_order=$6, icon=$7, hero_image_url=$8, parent_room_id=$9`,
      [room.id, room.homeId, room.name, room.floor, room.areaType, room.sortOrder, room.icon, room.heroImageUrl, room.parentRoomId],
    );
  }

  async listDevices(): Promise<StoredDevice[]> {
    const { rows } = await this.db.query<DeviceRow>("SELECT * FROM devices");
    return rows.map(rowToDevice);
  }
  async getDevice(id: DeviceId): Promise<StoredDevice | null> {
    const { rows } = await this.db.query<DeviceRow>("SELECT * FROM devices WHERE id=$1", [id]);
    return rows[0] ? rowToDevice(rows[0]) : null;
  }
  async putDevice(device: Device, backendIds: Record<string, string>): Promise<void> {
    await this.db.query(
      `INSERT INTO devices (id, home_id, room_id, name, supreme_type, manufacturer, model, driver_id, status, capabilities, state, metadata, backend_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         room_id=$3, name=$4, supreme_type=$5, manufacturer=$6, model=$7, driver_id=$8,
         status=$9, capabilities=$10::jsonb, state=$11::jsonb, metadata=$12::jsonb, backend_ids=$13::jsonb`,
      [
        device.id, device.homeId, device.roomId, device.name, device.supremeType,
        device.manufacturer, device.model, device.driverId, device.status,
        J(device.capabilities), J(device.state), J(device.metadata), J(backendIds),
      ],
    );
  }
  async updateDeviceState(id: DeviceId, state: Device["state"]): Promise<void> {
    await this.db.query("UPDATE devices SET state=$2::jsonb WHERE id=$1", [id, J(state)]);
  }
  async deleteDevice(id: DeviceId): Promise<void> {
    await this.db.query("DELETE FROM devices WHERE id=$1", [id]);
  }

  async listFavorites(userId: UserId): Promise<Favorite[]> {
    const { rows } = await this.db.query<FavRow>(
      "SELECT * FROM favorites WHERE user_id=$1 ORDER BY sort_order",
      [userId],
    );
    return rows.map(rowToFavorite);
  }
  async putFavorite(fav: Favorite): Promise<void> {
    const refId = fav.ref.type === "device" ? fav.ref.deviceId : fav.ref.sceneId;
    await this.db.query(
      `INSERT INTO favorites (user_id, ref_type, ref_id, sort_order)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, ref_type, ref_id) DO UPDATE SET sort_order=$4`,
      [fav.userId, fav.ref.type, refId, fav.sortOrder],
    );
  }
  async removeFavorite(userId: UserId, ref: Favorite["ref"]): Promise<void> {
    const refId = ref.type === "device" ? ref.deviceId : ref.sceneId;
    await this.db.query("DELETE FROM favorites WHERE user_id=$1 AND ref_type=$2 AND ref_id=$3", [
      userId,
      ref.type,
      refId,
    ]);
  }
}
