-- Phase 3: automations (the visual Builder's DSL, stored Supreme-owned, §10).
CREATE TABLE IF NOT EXISTS automations (
  id           TEXT PRIMARY KEY,
  home_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  triggers     JSONB NOT NULL DEFAULT '[]',
  conditions   JSONB NOT NULL DEFAULT '[]',
  actions      JSONB NOT NULL DEFAULT '[]',
  engine       TEXT NOT NULL DEFAULT 'supreme',
  external_ref TEXT,
  ai_generated BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS automations_home_idx ON automations (home_id);
