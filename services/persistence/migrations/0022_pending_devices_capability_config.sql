-- Capability Normalization Pipeline (§ ADR 0017 / ADR 0018): a driver-normalized capability
-- config (e.g. Casambi's real RGB/CCT distinction from colorConfigFromUnit()) must survive from
-- discovery through Pending Approval to commissioning — the same guarantee the auto-commit path
-- already had. Purely additive and nullable — existing rows are unaffected, no backfill needed
-- (pending_devices is ephemeral, refreshed on every scan anyway).
ALTER TABLE pending_devices ADD COLUMN IF NOT EXISTS capability_config JSONB;
