-- ADR 0101 Part 1: Scene Runtime — organizational/provenance fields for imported scenes.
-- Every existing (hand-authored) scene stays imported=false, source*=NULL, unaffected.
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS source_driver_id TEXT;
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS source_scene_id TEXT;
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS imported BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS sync_status TEXT;
CREATE INDEX IF NOT EXISTS scenes_source_idx ON scenes (source_driver_id, source_scene_id);
