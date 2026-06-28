import type { ClientDevice, IDeviceStore, Platform } from "@supreme/device-registry";
import type { SqlDb } from "./sql-db.js";

interface DeviceRow {
  id: string;
  account_id: string;
  name: string;
  platform: string;
  os_version: string | null;
  model: string | null;
  push_token: string | null;
  push_provider: string | null;
  trust: string;
  last_seen_at: string | number | null;
  last_ip: string | null;
  last_geo: string | null;
  created_at: string | number;
  session_id: string | null;
}

function rowToDevice(r: DeviceRow): ClientDevice {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    platform: r.platform as Platform,
    osVersion: r.os_version,
    model: r.model,
    pushToken: r.push_token,
    pushProvider: r.push_provider as ClientDevice["pushProvider"],
    trust: r.trust as ClientDevice["trust"],
    lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
    lastIp: r.last_ip,
    lastGeo: r.last_geo,
    createdAt: Number(r.created_at),
    sessionId: r.session_id,
  };
}

/** Postgres-backed {@link IDeviceStore} — durable client devices, push tokens, trust state. */
export class PgDeviceStore implements IDeviceStore {
  constructor(private readonly db: SqlDb) {}

  async get(id: string): Promise<ClientDevice | undefined> {
    const { rows } = await this.db.query<DeviceRow>("SELECT * FROM client_devices WHERE id=$1", [id]);
    return rows[0] ? rowToDevice(rows[0]) : undefined;
  }

  async put(device: ClientDevice): Promise<void> {
    await this.db.query(
      `INSERT INTO client_devices (id, account_id, name, platform, os_version, model, push_token,
                                   push_provider, trust, last_seen_at, last_ip, last_geo, created_at, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         name=$3, platform=$4, os_version=$5, model=$6, push_token=$7, push_provider=$8,
         trust=$9, last_seen_at=$10, last_ip=$11, last_geo=$12, session_id=$14`,
      [
        device.id, device.accountId, device.name, device.platform, device.osVersion, device.model,
        device.pushToken, device.pushProvider, device.trust, device.lastSeenAt, device.lastIp,
        device.lastGeo, device.createdAt, device.sessionId,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM client_devices WHERE id=$1", [id]);
  }

  async listForAccount(accountId: string): Promise<ClientDevice[]> {
    const { rows } = await this.db.query<DeviceRow>(
      "SELECT * FROM client_devices WHERE account_id=$1 ORDER BY created_at DESC",
      [accountId],
    );
    return rows.map(rowToDevice);
  }
}
