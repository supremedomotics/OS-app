-- Phase 3: Experience choreography and an authored description.
-- Existing scenes stay description=NULL, phases=[] (everything at once), unaffected.
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS phases JSONB NOT NULL DEFAULT '[]'::jsonb;
