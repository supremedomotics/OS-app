-- Location hierarchy (§ Unified Onboarding): Building › Floor › Room › Area.
-- `floor` already exists on rooms; add optional Building + Area labels. Nullable + no default so
-- existing rooms are unaffected; the UI groups by them when present.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS building TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS area TEXT;
