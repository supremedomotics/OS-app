import type { HomeId } from "@supreme/domain-model";
import type { IConfigStore } from "@supreme/home";
import type { SqlDb } from "../sql-db.js";

/** Postgres-backed {@link IConfigStore} — per-home settings survive a hub restart. */
export class ConfigRepo implements IConfigStore {
  constructor(private readonly db: SqlDb) {}

  async get(homeId: HomeId, key: string): Promise<unknown | undefined> {
    const { rows } = await this.db.query<{ value_json: string }>(
      "SELECT value_json FROM home_config WHERE home_id=$1 AND key=$2",
      [homeId, key],
    );
    return rows[0] ? (JSON.parse(rows[0].value_json) as unknown) : undefined;
  }

  async set(homeId: HomeId, key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO home_config (home_id, key, value_json, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (home_id, key) DO UPDATE SET value_json=$3, updated_at=$4`,
      [homeId, key, JSON.stringify(value ?? null), new Date().toISOString()],
    );
  }

  async delete(homeId: HomeId, key: string): Promise<void> {
    await this.db.query("DELETE FROM home_config WHERE home_id=$1 AND key=$2", [homeId, key]);
  }

  async getAll(homeId: HomeId): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM home_config WHERE home_id=$1",
      [homeId],
    );
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
  }
}
