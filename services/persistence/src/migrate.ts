import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDb } from "./sql-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../migrations");

/** Ordered migration files. Append new ones; never edit a shipped migration. */
const MIGRATIONS = [
  "0001_init.sql",
  "0002_drivers_licenses.sql",
  "0003_phase3.sql",
  "0004_automations.sql",
  "0005_sessions.sql",
  "0006_security_panel.sql",
  "0007_protocol_bindings.sql",
  "0008_device_clients.sql",
  "0009_migration_policy.sql",
] as const;

/**
 * Apply pending migrations idempotently. A `schema_migrations` table records which
 * files have run, so re-running on an existing hub DB is a no-op (§14 OTA updates).
 */
export async function migrate(db: SqlDb): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    await db.exec(sql);
    await db.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [
      name,
      new Date().toISOString(),
    ]);
  }
}
