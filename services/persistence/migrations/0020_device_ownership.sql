-- Explicit device ownership (§ Native Driver Architecture Refactor). Every device has
-- exactly one owner — never inferred from a backend id, a naming convention, or a
-- fallback default. Ownership is set only by the driver lifecycle (native bind
-- succeeding), by HA-entity commissioning, or by a future integration's own
-- commissioning path, and is the single source of truth the command router consults.
CREATE TABLE IF NOT EXISTS device_ownership (
  device_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL, -- 'native' | 'ha' | 'matter' | 'cloud' | 'unassigned'
  protocol   TEXT,          -- set when kind = 'native': which native protocol owns it
  updated_at TEXT NOT NULL
);
