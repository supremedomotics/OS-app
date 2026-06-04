-- Supreme system of record — initial schema (blueprint §5).
-- All data is Supreme-owned; HA's recorder DB is treated as ephemeral/internal.
-- Timestamps are stored as ISO-8601 text so the domain (ISO strings) round-trips
-- identically across Postgres and the embedded PGlite test engine.

CREATE TABLE IF NOT EXISTS homes (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  address         TEXT,
  tier            TEXT NOT NULL DEFAULT 'signature',
  master_user_id  TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  home_id      TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  display_name TEXT NOT NULL,
  user_type    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS auth_credentials (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  mfa_secret    TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id             TEXT PRIMARY KEY,
  home_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  floor          INTEGER NOT NULL DEFAULT 0,
  area_type      TEXT NOT NULL DEFAULT 'other',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  icon           TEXT,
  hero_image_url TEXT,
  parent_room_id TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  home_id      TEXT NOT NULL,
  room_id      TEXT,
  name         TEXT NOT NULL,
  supreme_type TEXT NOT NULL,
  manufacturer TEXT,
  model        TEXT,
  driver_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'online',
  capabilities JSONB NOT NULL DEFAULT '[]',
  state        JSONB NOT NULL DEFAULT '{}',
  metadata     JSONB NOT NULL DEFAULT '{}',
  -- backend_ids maps capability kind -> backend entity id; consumed ONLY by the
  -- SIL (this is the `ha_entity_map` of §5). Never returned to clients.
  backend_ids  JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS devices_room_idx ON devices (room_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    TEXT NOT NULL,
  ref_type   TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ref_type, ref_id)
);

CREATE TABLE IF NOT EXISTS scenes (
  id            TEXT PRIMARY KEY,
  home_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'room',
  room_id       TEXT,
  owner_user_id TEXT,
  icon          TEXT,
  ai_generated  BOOLEAN NOT NULL DEFAULT FALSE,
  steps         JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS grants (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  action        TEXT NOT NULL,
  effect        TEXT NOT NULL DEFAULT 'allow',
  valid_from    TEXT,
  valid_until   TEXT,
  schedule      JSONB
);
CREATE INDEX IF NOT EXISTS grants_user_idx ON grants (user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL,
  user_id    TEXT,
  level      TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  context    JSONB NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id);
