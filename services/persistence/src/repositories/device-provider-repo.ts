import type { DeviceId } from "@supreme/domain-model";
import type { DeviceLifecycleState, DeviceProviderRecord, IDeviceProviderStore } from "@supreme/integration-layer";
import type { SqlDb } from "../sql-db.js";

interface ProviderRow {
  device_id: string;
  provider: string;
  state: string;
  updated_at: string;
}

function rowToRecord(r: ProviderRow): DeviceProviderRecord {
  return {
    deviceId: r.device_id as DeviceId,
    provider: r.provider,
    state: r.state as DeviceLifecycleState,
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link IDeviceProviderStore} — provider+lifecycle survives a hub restart. */
export class DeviceProviderRepo implements IDeviceProviderStore {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<DeviceProviderRecord[]> {
    const { rows } = await this.db.query<ProviderRow>("SELECT * FROM device_provider");
    return rows.map(rowToRecord);
  }

  async put(record: DeviceProviderRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO device_provider (device_id, provider, state, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (device_id) DO UPDATE SET provider=$2, state=$3, updated_at=$4`,
      [record.deviceId, record.provider, record.state, record.updatedAt],
    );
  }

  async remove(deviceId: DeviceId): Promise<void> {
    await this.db.query("DELETE FROM device_provider WHERE device_id=$1", [deviceId]);
  }
}
