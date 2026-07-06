-- Device Approval (§ Device Approval): a queue of discovered devices awaiting an installer's
-- approval before they become real, trusted devices. Ephemeral discovery state (refreshed on each
-- scan) — EXCLUDED from backups so a restore never resurrects stale pending entries.
CREATE TABLE IF NOT EXISTS pending_devices (
  id             TEXT PRIMARY KEY,
  home_id        TEXT NOT NULL,
  backend_id     TEXT NOT NULL,
  suggested_name TEXT NOT NULL,
  protocol       TEXT,
  source         TEXT NOT NULL,
  capabilities   JSONB NOT NULL DEFAULT '[]',
  network        JSONB,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (home_id, backend_id)
);
CREATE INDEX IF NOT EXISTS pending_devices_home ON pending_devices (home_id, last_seen DESC);
