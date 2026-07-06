import type { SqlDb } from "../sql-db.js";

/**
 * A stored backup in the hub's backup history (§ Backup). Declared here (the provider side) rather
 * than in @supreme/backup so persistence doesn't import the backup package — that would form a build
 * cycle, since @supreme/backup's tests depend on persistence.
 */
export interface BackupRecord {
  id: string;
  homeId: string;
  createdAt: string;
  schemaVersion: string;
  tableCount: number;
  rowCount: number;
  /** "manual" | "scheduled" — how the backup was triggered. */
  source: string;
  /** The serialized signed backup (re-downloadable / restorable). */
  document: string;
}

export type BackupRecordMeta = Omit<BackupRecord, "document">;

/** Persistence boundary for the backup history. */
export interface IBackupStore {
  save(rec: BackupRecord): Promise<void>;
  listMeta(homeId: string): Promise<BackupRecordMeta[]>;
  get(homeId: string, id: string): Promise<BackupRecord | null>;
  latest(homeId: string): Promise<BackupRecordMeta | null>;
  /** Keep only the newest `keep` backups; returns how many were pruned. */
  prune(homeId: string, keep: number): Promise<number>;
}

interface BackupRow {
  id: string;
  home_id: string;
  created_at: string;
  schema_version: string;
  table_count: number;
  row_count: number;
  source: string;
  document: string;
}

const META_COLS = "id, home_id, created_at, schema_version, table_count, row_count, source";

function rowToMeta(r: Omit<BackupRow, "document">): BackupRecordMeta {
  return {
    id: r.id,
    homeId: r.home_id,
    createdAt: r.created_at,
    schemaVersion: r.schema_version,
    tableCount: r.table_count,
    rowCount: r.row_count,
    source: r.source,
  };
}

/** Postgres-backed backup history (§ Backup). Metadata queries never load the (large) document. */
export class BackupRepo implements IBackupStore {
  constructor(private readonly db: SqlDb) {}

  async save(rec: BackupRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO backups (id, home_id, created_at, schema_version, table_count, row_count, source, document)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [rec.id, rec.homeId, rec.createdAt, rec.schemaVersion, rec.tableCount, rec.rowCount, rec.source, rec.document],
    );
  }

  async listMeta(homeId: string): Promise<BackupRecordMeta[]> {
    const { rows } = await this.db.query<Omit<BackupRow, "document">>(
      `SELECT ${META_COLS} FROM backups WHERE home_id=$1 ORDER BY created_at DESC`,
      [homeId],
    );
    return rows.map(rowToMeta);
  }

  async get(homeId: string, id: string): Promise<BackupRecord | null> {
    const { rows } = await this.db.query<BackupRow>(
      "SELECT * FROM backups WHERE home_id=$1 AND id=$2",
      [homeId, id],
    );
    const r = rows[0];
    return r ? { ...rowToMeta(r), document: r.document } : null;
  }

  async latest(homeId: string): Promise<BackupRecordMeta | null> {
    const { rows } = await this.db.query<Omit<BackupRow, "document">>(
      `SELECT ${META_COLS} FROM backups WHERE home_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [homeId],
    );
    return rows[0] ? rowToMeta(rows[0]) : null;
  }

  async prune(homeId: string, keep: number): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM backups WHERE home_id=$1 ORDER BY created_at DESC OFFSET $2`,
      [homeId, Math.max(0, keep)],
    );
    for (const r of rows) {
      await this.db.query("DELETE FROM backups WHERE id=$1", [r.id]);
    }
    return rows.length;
  }
}
