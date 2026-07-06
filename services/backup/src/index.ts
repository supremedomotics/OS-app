import { newId, type BackupId } from "@supreme/domain-model";
import { canonicalJson, signPayload, verifyPayload } from "@supreme/crypto";

/**
 * Minimal SQL surface the backup engine needs — structurally compatible with @supreme/persistence's
 * `SqlDb`, but declared here so the backup package doesn't depend on persistence (which in turn
 * depends on this package for its {@link IBackupStore}). Breaking that import cycle keeps the build
 * acyclic; any `SqlDb` is assignable to `BackupDb`.
 */
export interface BackupDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Backup & restore of the Supreme system of record (§14). A backup is a JSON dump
 * of every Supreme table, signed with the hub's backup key so a restore can verify
 * authenticity/integrity offline (e.g. before importing an off-site backup). This
 * powers installer Backup/Restore and optional off-site backup.
 */
export interface BackupMeta {
  id: string;
  createdAt: string;
  /** Hub/schema version the backup was taken at. */
  schemaVersion: string;
  tableCount: number;
  rowCount: number;
}

export interface BackupBundle {
  meta: BackupMeta;
  /** table name → rows. */
  tables: Record<string, Record<string, unknown>[]>;
}

export interface SignedBackup {
  bundle: BackupBundle;
  signature: string;
}

/** Tables never included in a backup (transient/derived). `backups` is excluded so backups never
 * nest inside one another (which would grow exponentially). */
const EXCLUDED = new Set(["schema_migrations", "backups"]);

async function listTables(db: BackupDb): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name).filter((t) => !EXCLUDED.has(t));
}

/**
 * Order tables so a parent table is restored before any table that references it
 * (FK-safe insert order). Computed by topologically sorting the foreign-key graph.
 */
async function insertionOrder(db: BackupDb, tables: string[]): Promise<string[]> {
  const { rows } = await db.query<{ child: string; parent: string }>(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  );
  const present = new Set(tables);
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of rows) {
    if (child !== parent && present.has(child) && present.has(parent)) {
      deps.get(child)!.add(parent);
    }
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  const visit = (t: string, stack: Set<string>): void => {
    if (done.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const p of deps.get(t) ?? []) visit(p, stack);
    stack.delete(t);
    done.add(t);
    ordered.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return ordered;
}

/** Dump the whole Supreme database into an in-memory backup bundle. */
export async function createBackup(db: BackupDb, schemaVersion = "0001"): Promise<BackupBundle> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  let rowCount = 0;
  for (const table of await listTables(db)) {
    const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM ${ident(table)}`);
    tables[table] = rows;
    rowCount += rows.length;
  }
  return {
    meta: {
      id: newId("backup") as BackupId,
      createdAt: new Date().toISOString(),
      schemaVersion,
      tableCount: Object.keys(tables).length,
      rowCount,
    },
    tables,
  };
}

export function signBackup(bundle: BackupBundle, privateKeyPem: string): SignedBackup {
  return { bundle, signature: signPayload(bundle, privateKeyPem) };
}

export function verifyBackup(signed: SignedBackup, publicKeyPem: string): boolean {
  return verifyPayload(signed.bundle, signed.signature, publicKeyPem);
}

export interface BackupInspection {
  /** Whether the signature verifies against the given key (null when no key was supplied). */
  signatureValid: boolean | null;
  schemaVersion: string;
  createdAt: string;
  tableCount: number;
  rowCount: number;
  /** Per-table row counts that WOULD be restored — the dry-run preview. */
  tables: { name: string; rows: number }[];
}

/**
 * Inspect a signed backup WITHOUT touching any database (§ restore dry-run). Verifies the signature
 * (when a key is provided) and reports exactly what a restore would write, so an operator can preview
 * a restore safely before committing to it.
 */
export function inspectBackup(signed: SignedBackup, opts: { publicKeyPem?: string } = {}): BackupInspection {
  const tables = Object.entries(signed.bundle.tables)
    .map(([name, rows]) => ({ name, rows: rows.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    signatureValid: opts.publicKeyPem ? verifyBackup(signed, opts.publicKeyPem) : null,
    schemaVersion: signed.bundle.meta.schemaVersion,
    createdAt: signed.bundle.meta.createdAt,
    tableCount: tables.length,
    rowCount: tables.reduce((n, t) => n + t.rows, 0),
    tables,
  };
}

/**
 * Restore a backup into a database (which must already be migrated). Existing rows
 * in the affected tables are cleared first. If `publicKeyPem` is given, the
 * signature is verified before any data is touched.
 */
export async function restoreBackup(
  db: BackupDb,
  signed: SignedBackup,
  opts: { publicKeyPem?: string } = {},
): Promise<{ tables: number; rows: number }> {
  if (opts.publicKeyPem && !verifyBackup(signed, opts.publicKeyPem)) {
    throw new Error("backup signature verification failed");
  }
  const { tables } = signed.bundle;
  const order = await insertionOrder(db, Object.keys(tables));

  // Clear children before parents (reverse insert order), then insert parents
  // before children, so foreign keys are never violated mid-restore.
  for (const table of [...order].reverse()) {
    await db.query(`DELETE FROM ${ident(table)}`);
  }

  let restored = 0;
  for (const table of order) {
    const rows = tables[table] ?? [];
    for (const row of rows) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const placeholders = cols.map((c, i) => placeholder(row[c], i + 1));
      const values = cols.map((c) => serialize(row[c]));
      await db.query(
        `INSERT INTO ${ident(table)} (${cols.map(ident).join(",")}) VALUES (${placeholders.join(",")})`,
        values,
      );
      restored++;
    }
  }
  return { tables: Object.keys(tables).length, rows: restored };
}

/** Serialize a JSON document bundle to a string (for download/storage). */
export function serializeBackup(signed: SignedBackup): string {
  return canonicalJson(signed);
}


// ── helpers ────────────────────────────────────────────────────────────────

/** Object/array values map to jsonb columns and need a cast + stringification. */
function isJson(value: unknown): boolean {
  return value !== null && typeof value === "object";
}
function placeholder(value: unknown, i: number): string {
  return isJson(value) ? `$${i}::jsonb` : `$${i}`;
}
function serialize(value: unknown): unknown {
  return isJson(value) ? JSON.stringify(value) : value;
}
/** Quote an identifier defensively (table/column names come from our own schema). */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
