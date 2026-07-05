/**
 * Thin SQL seam for the cloud control plane — mirrors the hub's `@supreme/persistence`
 * seam so the same repository SQL runs on production Postgres ({@link PgDb}) and on embedded
 * Postgres ({@link PgliteDb}, used by tests). Both speak real Postgres.
 */
export interface SqlDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** node-postgres pool. `pg` is lazily imported so PGlite-only runs need no native bindings. */
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
