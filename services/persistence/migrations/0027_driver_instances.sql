-- Driver instances (§ Multi-network Casambi).
--
-- A driver catalog key could previously be installed exactly once, because `key` carried a UNIQUE
-- constraint. That made one Casambi cloud account / one Lithernet gateway the hard ceiling for a
-- whole deployment. Sites legitimately run several Casambi networks and several gateways, so a
-- catalog key must now support N installed records — one per network/gateway — each with its own
-- config, credentials, discovery and diagnostics.
--
-- Every per-driver API route already addresses drivers by `id` (the per-record id), not by `key`,
-- so dropping the constraint does not change how any existing route resolves a driver.
--
-- `label` is the installer-facing name for one instance ("Network 1", "Gateway 2"). NULL for the
-- single-instance installs that predate this migration, which keep rendering under the catalog
-- name exactly as before.

ALTER TABLE installed_drivers DROP CONSTRAINT IF EXISTS installed_drivers_key_key;

ALTER TABLE installed_drivers ADD COLUMN IF NOT EXISTS label TEXT;

-- Lookups now routinely fetch every instance of a key (the registry lists them, and version
-- operations fan out across them), so the dropped unique index needs a plain one in its place.
CREATE INDEX IF NOT EXISTS installed_drivers_key_idx ON installed_drivers (key);
