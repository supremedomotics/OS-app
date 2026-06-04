-- Phase 2: installed drivers + licenses (blueprint §5, §9).

CREATE TABLE IF NOT EXISTS installed_drivers (
  id           TEXT PRIMARY KEY,
  home_id      TEXT NOT NULL,
  key          TEXT NOT NULL UNIQUE,
  version      TEXT NOT NULL,
  channel      TEXT NOT NULL,
  category     TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  status       TEXT NOT NULL DEFAULT 'active',
  config       JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS licenses (
  id         TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL,
  sku        TEXT NOT NULL,
  seats      INTEGER NOT NULL,
  features   JSONB NOT NULL DEFAULT '[]',
  issued_at  TEXT NOT NULL,
  expires_at TEXT,
  signature  TEXT NOT NULL
);
