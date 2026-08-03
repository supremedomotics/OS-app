import type { DeviceId } from "@supreme/domain-model";
import type { SqlDb } from "../sql-db.js";

/** Legacy ownership row shape — read-only (ADR-0023 § Compatibility migrations may
 * remain only for database upgrades). Nothing in the runtime writes this table
 * anymore; it exists purely as the migration source for `device_provider`. */
export interface LegacyDeviceOwnershipRow {
  deviceId: DeviceId;
  kind: string; // 'native' | 'ha' | 'matter' | 'cloud' | 'unassigned'
  protocol: string | null;
  updatedAt: string;
}

interface OwnershipRow {
  device_id: string;
  kind: string;
  protocol: string | null;
  updated_at: string;
}

/** Read-only accessor for the legacy `device_ownership` table — used ONLY by the
 * one-time ownership→provider migration (`migrateOwnershipToProvider`). */
export class DeviceOwnershipRepo {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<LegacyDeviceOwnershipRow[]> {
    const { rows } = await this.db.query<OwnershipRow>("SELECT * FROM device_ownership");
    return rows.map((r) => ({ deviceId: r.device_id as DeviceId, kind: r.kind, protocol: r.protocol, updatedAt: r.updated_at }));
  }
}
