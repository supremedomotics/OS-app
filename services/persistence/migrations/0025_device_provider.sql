-- Device provider + lifecycle state (ADR-0023: Native Device Lifecycle Architecture).
-- Replaces device_ownership's kind/protocol split with a single free-form `provider`
-- (device origin only, never gates runtime behavior) plus an explicit lifecycle state
-- machine (DISCOVERED..REMOVED) so "no driver bound" is a real, honest state
-- (UNBOUND) instead of an implicit simulated fallback. device_ownership is kept
-- read-only for one release as a migration source and rollback fallback — never
-- written to after this migration runs.
CREATE TABLE IF NOT EXISTS device_provider (
  device_id  TEXT PRIMARY KEY,
  provider   TEXT NOT NULL, -- e.g. 'casambi' | 'knx' | 'matter' | 'mqtt' | 'dali' | 'modbus' | 'homeassistant'
  state      TEXT NOT NULL, -- DeviceLifecycleState
  updated_at TEXT NOT NULL
);
