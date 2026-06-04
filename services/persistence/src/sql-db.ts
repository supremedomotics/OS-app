/**
 * Thin SQL seam (§5). Repositories target plain Postgres SQL through this
 * interface, with two implementations behind it:
 *   - {@link PgDb}: node-postgres pool — the hub's production Postgres.
 *   - {@link PgliteDb}: embedded Postgres (PGlite) — used by tests and available
 *     as a zero-dependency local-first option.
 * Because both speak real Postgres, the migrations and repository SQL are shared.
 */
export interface SqlDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run raw, possibly multi-statement SQL (used by the migrator). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** node-postgres-backed implementation. Lazily imports `pg` so PGlite-only test
 * runs don't require native bindings. */
export class PgDb implements SqlDb {
  private constructor(private readonly pool: import("pg").Pool) {}

  static async connect(connectionString: string): Promise<PgDb> {
    const { Pool } = await import("pg");
    return new PgDb(new Pool({ connectionString }));
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[] };
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** PGlite-backed implementation (embedded Postgres in WASM). */
export class PgliteDb implements SqlDb {
  private constructor(private readonly db: { query: Function; exec: Function; close: Function }) {}

  static async create(dataDir?: string): Promise<PgliteDb> {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = dataDir ? new PGlite(dataDir) : new PGlite();
    return new PgliteDb(db as never);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const res = await this.db.query(sql, params);
    return { rows: (res as { rows: T[] }).rows };
  }
  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}
