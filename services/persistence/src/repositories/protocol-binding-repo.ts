import type { CapabilityKind, DeviceId } from "@supreme/domain-model";
import type { IProtocolBindingStore, StoredProtocolBinding } from "@supreme/integration-layer";
import type { SqlDb } from "../sql-db.js";

interface BindingRow {
  device_id: string;
  capability: string;
  protocol: string;
  address: string;
  config: string;
}

function rowToBinding(r: BindingRow): StoredProtocolBinding {
  return {
    deviceId: r.device_id as DeviceId,
    capability: r.capability as CapabilityKind,
    protocol: r.protocol,
    address: r.address,
    config: parseConfig(r.config),
  };
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Postgres-backed {@link IProtocolBindingStore} — bus bindings survive a restart. */
export class ProtocolBindingRepo implements IProtocolBindingStore {
  constructor(private readonly db: SqlDb) {}

  async list(): Promise<StoredProtocolBinding[]> {
    const { rows } = await this.db.query<BindingRow>(
      "SELECT * FROM protocol_bindings ORDER BY device_id, capability",
    );
    return rows.map(rowToBinding);
  }

  async put(binding: StoredProtocolBinding): Promise<void> {
    await this.db.query(
      `INSERT INTO protocol_bindings (device_id, capability, protocol, address, config)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (device_id, capability)
       DO UPDATE SET protocol=$3, address=$4, config=$5`,
      [binding.deviceId, binding.capability, binding.protocol, binding.address, JSON.stringify(binding.config ?? {})],
    );
  }

  async remove(deviceId: DeviceId, capability: CapabilityKind): Promise<void> {
    await this.db.query("DELETE FROM protocol_bindings WHERE device_id=$1 AND capability=$2", [
      deviceId,
      capability,
    ]);
  }
}
