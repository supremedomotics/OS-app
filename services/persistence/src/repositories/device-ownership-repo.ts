import type { DeviceId } from "@supreme/domain-model";
import type { DeviceOwnership, IDeviceOwnershipStore, OwnerKind } from "@supreme/integration-layer";
import type { SqlDb } from "../sql-db.js";

interface OwnershipRow {
  device_id: string;
  kind: string;
  protocol: string | null;
  updated_at: string;
}

function rowToOwnership(r: OwnershipRow): DeviceOwnership {
  return {
    deviceId: r.device_id as DeviceId,
    kind: r.kind as OwnerKind,
    ...(r.protocol ? { protocol: r.protocol } : {}),
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link IDeviceOwnershipStore} — ownership survives a hub restart. */
export class DeviceOwnershipRepo implements IDeviceOwnershipStore {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<DeviceOwnership[]> {
    const { rows } = await this.db.query<OwnershipRow>("SELECT * FROM device_ownership");
    return rows.map(rowToOwnership);
  }

  async put(ownership: DeviceOwnership): Promise<void> {
    await this.db.query(
      `INSERT INTO device_ownership (device_id, kind, protocol, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (device_id) DO UPDATE SET kind=$2, protocol=$3, updated_at=$4`,
      [ownership.deviceId, ownership.kind, ownership.protocol ?? null, ownership.updatedAt],
    );
  }

  async remove(deviceId: DeviceId): Promise<void> {
    await this.db.query("DELETE FROM device_ownership WHERE device_id=$1", [deviceId]);
  }
}
