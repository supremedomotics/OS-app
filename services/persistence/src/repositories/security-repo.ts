import type { HomeId, UserId } from "@supreme/domain-model";
import type { ISecurityStore, SecurityMode, SecurityState } from "@supreme/security";
import type { SqlDb } from "../sql-db.js";

interface PanelRow {
  home_id: string;
  mode: string;
  triggered: boolean;
  last_changed_by: string | null;
  last_changed_at: string;
}

function rowToState(r: PanelRow): SecurityState {
  return {
    homeId: r.home_id as HomeId,
    mode: r.mode as SecurityMode,
    triggered: r.triggered,
    lastChangedBy: (r.last_changed_by as UserId | null) ?? null,
    lastChangedAt: r.last_changed_at,
  };
}

/** Postgres-backed {@link ISecurityStore} — the panel survives a hub restart. */
export class SecurityRepo implements ISecurityStore {
  constructor(private readonly db: SqlDb) {}

  async load(homeId: HomeId): Promise<SecurityState | null> {
    const { rows } = await this.db.query<PanelRow>(
      "SELECT * FROM security_panels WHERE home_id=$1",
      [homeId],
    );
    return rows[0] ? rowToState(rows[0]) : null;
  }

  async save(state: SecurityState): Promise<void> {
    await this.db.query(
      `INSERT INTO security_panels (home_id, mode, triggered, last_changed_by, last_changed_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (home_id)
       DO UPDATE SET mode=$2, triggered=$3, last_changed_by=$4, last_changed_at=$5`,
      [state.homeId, state.mode, state.triggered, state.lastChangedBy, state.lastChangedAt],
    );
  }
}
