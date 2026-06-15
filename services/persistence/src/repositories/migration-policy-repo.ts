import type { EngineKind, IMigrationPolicyStore } from "@supreme/integration-layer";
import type { SqlDb } from "../sql-db.js";

/** Postgres-backed {@link IMigrationPolicyStore} — native-migration routing survives restarts. */
export class MigrationPolicyRepo implements IMigrationPolicyStore {
  constructor(private readonly db: SqlDb) {}

  async loadNativeDomains(): Promise<string[]> {
    const { rows } = await this.db.query<{ domain: string }>(
      "SELECT domain FROM migration_policy WHERE engine='native'",
    );
    return rows.map((r) => r.domain);
  }

  async setEngine(domain: string, engine: EngineKind): Promise<void> {
    await this.db.query(
      `INSERT INTO migration_policy (domain, engine) VALUES ($1,$2)
       ON CONFLICT (domain) DO UPDATE SET engine=$2`,
      [domain, engine],
    );
  }
}
