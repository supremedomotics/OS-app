import type { Grant, GrantId, UserId } from "@supreme/domain-model";
import type { IGrantStore } from "@supreme/permissions";
import type { SqlDb } from "../sql-db.js";

interface GrantRow {
  id: string;
  user_id: string;
  resource_type: string;
  resource_id: string | null;
  action: string;
  effect: string;
  valid_from: string | null;
  valid_until: string | null;
  schedule: Grant["schedule"];
}

function rowToGrant(r: GrantRow): Grant {
  return {
    id: r.id as GrantId,
    userId: r.user_id as UserId,
    resourceType: r.resource_type as Grant["resourceType"],
    resourceId: r.resource_id,
    action: r.action as Grant["action"],
    effect: r.effect as Grant["effect"],
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    schedule: r.schedule ?? null,
  };
}

/** Postgres-backed {@link IGrantStore}. */
export class GrantRepo implements IGrantStore {
  constructor(private readonly db: SqlDb) {}

  async listForUser(userId: UserId): Promise<Grant[]> {
    const { rows } = await this.db.query<GrantRow>("SELECT * FROM grants WHERE user_id=$1", [userId]);
    return rows.map(rowToGrant);
  }
  async add(grant: Grant): Promise<void> {
    await this.db.query(
      `INSERT INTO grants (id, user_id, resource_type, resource_id, action, effect, valid_from, valid_until, schedule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        grant.id, grant.userId, grant.resourceType, grant.resourceId, grant.action,
        grant.effect, grant.validFrom, grant.validUntil,
        grant.schedule === null ? null : JSON.stringify(grant.schedule),
      ],
    );
  }
  async remove(id: GrantId): Promise<void> {
    await this.db.query("DELETE FROM grants WHERE id=$1", [id]);
  }
}
