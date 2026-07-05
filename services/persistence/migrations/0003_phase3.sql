-- Phase 3: energy/analytics time-series + tamper-evident audit log (§5, §8).

-- Energy & telemetry samples. On a real hub this is a TimescaleDB hypertable; the
-- schema is plain SQL so it runs identically on Postgres and the PGlite test engine.
CREATE TABLE IF NOT EXISTS energy_samples (
  id        TEXT PRIMARY KEY,
  home_id   TEXT NOT NULL,
  device_id TEXT NOT NULL,
  room_id   TEXT,
  measure   TEXT NOT NULL,          -- 'power' | 'energy' | 'temperature' | ...
  value     DOUBLE PRECISION NOT NULL,
  unit      TEXT NOT NULL,
  ts        TEXT NOT NULL           -- ISO-8601, sortable
);
CREATE INDEX IF NOT EXISTS energy_home_measure_ts_idx ON energy_samples (home_id, measure, ts);
CREATE INDEX IF NOT EXISTS energy_device_ts_idx ON energy_samples (device_id, ts);

-- Append-only, hash-chained audit log: each row's `entry_hash` = H(prev_hash || row),
-- so any tampering breaks the chain (tamper-evident, §8/§12). `seq` orders the chain.
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  home_id       TEXT NOT NULL,
  seq           BIGINT NOT NULL,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  ip            TEXT,
  created_at    TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  entry_hash    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_home_seq_idx ON audit_log (home_id, seq);
