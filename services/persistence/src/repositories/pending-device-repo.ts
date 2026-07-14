import type { SqlDb } from "../sql-db.js";

/**
 * A device discovered but not yet approved into the home (§ Device Approval). Declared here (the
 * provider side) so persistence doesn't import commissioning. Ephemeral — refreshed on each scan.
 */
export interface PendingDeviceRecord {
  id: string;
  homeId: string;
  backendId: string;
  suggestedName: string;
  protocol: string | null;
  source: string;
  capabilities: string[];
  network: { ip?: string; mac?: string; host?: string } | null;
  firstSeen: string;
  lastSeen: string;
  status: string;
}

/** Input for staging a freshly-discovered device (id/firstSeen are assigned on first insert). */
export interface StagePendingInput {
  homeId: string;
  backendId: string;
  suggestedName: string;
  protocol: string | null;
  source: string;
  capabilities: string[];
  network: { ip?: string; mac?: string; host?: string } | null;
  seenAt: string;
  newId: string;
}

export interface IPendingDeviceStore {
  /** Insert a newly-seen device or refresh an existing one's lastSeen/metadata (dedupe by backendId). */
  upsert(input: StagePendingInput): Promise<void>;
  list(homeId: string): Promise<PendingDeviceRecord[]>;
  get(homeId: string, id: string): Promise<PendingDeviceRecord | null>;
  setStatus(homeId: string, id: string, status: string): Promise<void>;
  remove(homeId: string, id: string): Promise<void>;
}

interface PendingRow {
  id: string;
  home_id: string;
  backend_id: string;
  suggested_name: string;
  protocol: string | null;
  source: string;
  capabilities: string[];
  network: { ip?: string; mac?: string; host?: string } | null;
  first_seen: string;
  last_seen: string;
  status: string;
}

function rowTo(r: PendingRow): PendingDeviceRecord {
  return {
    id: r.id,
    homeId: r.home_id,
    backendId: r.backend_id,
    suggestedName: r.suggested_name,
    protocol: r.protocol ?? null,
    source: r.source,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
    network: r.network ?? null,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    status: r.status,
  };
}

/** Postgres-backed pending-device queue (§ Device Approval). */
export class PendingDeviceRepo implements IPendingDeviceStore {
  constructor(private readonly db: SqlDb) {}

  async upsert(i: StagePendingInput): Promise<void> {
    // Dedupe by (home_id, backend_id): a re-scan refreshes last_seen + metadata and keeps the
    // original id/first_seen. Status is revived to 'pending' on every hit — safe because the
    // caller (CommissioningService.discover) only ever passes backendIds that are NOT currently
    // owned by a live Supreme device (see its own reverseLookup filter), so a still-commissioned
    // device can never reach here. A backendId that previously got 'rejected' — or was 'approved'
    // and the resulting device was later deleted — genuinely is available again; keeping it stuck
    // at a terminal status forever left no way to reconsider it (§ BUG-005).
    await this.db.query(
      `INSERT INTO pending_devices
         (id, home_id, backend_id, suggested_name, protocol, source, capabilities, network, first_seen, last_seen, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$9,'pending')
       ON CONFLICT (home_id, backend_id) DO UPDATE SET
         suggested_name=$4, protocol=$5, source=$6, capabilities=$7::jsonb, network=$8::jsonb, last_seen=$9, status='pending'`,
      [
        i.newId,
        i.homeId,
        i.backendId,
        i.suggestedName,
        i.protocol,
        i.source,
        JSON.stringify(i.capabilities),
        i.network ? JSON.stringify(i.network) : null,
        i.seenAt,
      ],
    );
  }

  async list(homeId: string): Promise<PendingDeviceRecord[]> {
    const { rows } = await this.db.query<PendingRow>(
      "SELECT * FROM pending_devices WHERE home_id=$1 AND status='pending' ORDER BY last_seen DESC",
      [homeId],
    );
    return rows.map(rowTo);
  }

  async get(homeId: string, id: string): Promise<PendingDeviceRecord | null> {
    const { rows } = await this.db.query<PendingRow>(
      "SELECT * FROM pending_devices WHERE home_id=$1 AND id=$2",
      [homeId, id],
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async setStatus(homeId: string, id: string, status: string): Promise<void> {
    await this.db.query("UPDATE pending_devices SET status=$3 WHERE home_id=$1 AND id=$2", [homeId, id, status]);
  }

  async remove(homeId: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM pending_devices WHERE home_id=$1 AND id=$2", [homeId, id]);
  }
}
