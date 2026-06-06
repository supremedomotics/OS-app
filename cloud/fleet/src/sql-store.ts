import type { HomeId } from "@supreme/domain-model";
import type { Hub, IFleetStore } from "./index.js";

/**
 * Postgres-backed {@link IFleetStore} (§4, §5) so the cloud fleet registry survives a
 * restart instead of living only in process memory. Kept decoupled from the hub's
 * `@supreme/persistence` package (fleet is a separate cloud service) by depending only
 * on a minimal SQL executor — the cloud deploy passes a node-postgres adapter, tests
 * pass PGlite. Run {@link FLEET_SCHEMA_SQL} once at startup.
 */
export interface FleetSqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

export const FLEET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fleet_hubs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  home_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_hubs_org_idx ON fleet_hubs (org_id);
`;

interface HubRow {
  id: string;
  org_id: string;
  home_id: string;
  name: string;
  version: string;
  registered_at: string;
  last_seen_at: string;
}

function rowToHub(r: HubRow): Hub {
  return {
    id: r.id,
    orgId: r.org_id,
    homeId: r.home_id as HomeId,
    name: r.name,
    version: r.version,
    registeredAt: r.registered_at,
    lastSeenAt: r.last_seen_at,
  };
}

export class SqlFleetStore implements IFleetStore {
  constructor(private readonly db: FleetSqlExecutor) {}

  /** Create the table if it doesn't exist. Call once before serving. */
  async init(): Promise<void> {
    await this.db.exec(FLEET_SCHEMA_SQL);
  }

  async put(hub: Hub): Promise<void> {
    await this.db.query(
      `INSERT INTO fleet_hubs (id, org_id, home_id, name, version, registered_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id)
       DO UPDATE SET org_id=$2, home_id=$3, name=$4, version=$5, last_seen_at=$7`,
      [hub.id, hub.orgId, hub.homeId, hub.name, hub.version, hub.registeredAt, hub.lastSeenAt],
    );
  }

  async get(id: string): Promise<Hub | null> {
    const { rows } = await this.db.query<HubRow>("SELECT * FROM fleet_hubs WHERE id=$1", [id]);
    return rows[0] ? rowToHub(rows[0]) : null;
  }

  async listByOrg(orgId: string): Promise<Hub[]> {
    const { rows } = await this.db.query<HubRow>(
      "SELECT * FROM fleet_hubs WHERE org_id=$1 ORDER BY registered_at",
      [orgId],
    );
    return rows.map(rowToHub);
  }
}
