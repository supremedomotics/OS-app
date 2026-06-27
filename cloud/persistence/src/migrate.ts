import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDb } from "./sql-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../migrations");

/** Ordered migration files. Append new ones; never edit a shipped migration. */
const MIGRATIONS = ["0001_hub_registry.sql"] as const;

/** Apply pending migrations idempotently (a `schema_migrations` table records what ran). */
export async function migrateCloud(db: SqlDb): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;
    await db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    await db.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [
      name,
      new Date().toISOString(),
    ]);
  }
}
