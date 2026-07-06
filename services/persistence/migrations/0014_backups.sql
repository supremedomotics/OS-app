-- Backup history (§ Backup): a DB-backed store of signed backups so the hub has a real backup
-- health indicator, a schedule, and re-downloadable history. The `backups` table is EXCLUDED from
-- backup dumps (like schema_migrations) so backups never nest/grow exponentially.
CREATE TABLE IF NOT EXISTS backups (
  id             TEXT PRIMARY KEY,
  home_id        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  table_count    INTEGER NOT NULL,
  row_count      INTEGER NOT NULL,
  source         TEXT NOT NULL,
  document       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS backups_home_created ON backups (home_id, created_at DESC);
