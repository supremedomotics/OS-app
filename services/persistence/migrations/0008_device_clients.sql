-- Push notification device tokens (§13). One row per registered client device; push
-- delivery (via the optional cloud relay) targets these. WSS delivery is independent.
CREATE TABLE IF NOT EXISTS device_clients (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  platform     TEXT NOT NULL,
  push_token   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS device_clients_user_idx ON device_clients (user_id);
