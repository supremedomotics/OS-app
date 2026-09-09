-- § Supreme Universal Keypad, Stage 2: persist KeypadMapping (previously in-memory only —
-- `InMemoryKeypadMappingStore` never survived a restart). Mirrors 0004_automations.sql's shape;
-- `behavior`/`target`/`behavior_state` are the Stage 2 additions with no automations equivalent.
CREATE TABLE IF NOT EXISTS keypad_mappings (
  id             TEXT PRIMARY KEY,
  home_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  input          JSONB NOT NULL,
  conditions     JSONB NOT NULL DEFAULT '[]',
  actions        JSONB NOT NULL DEFAULT '[]',
  behavior       TEXT NOT NULL DEFAULT 'direct',
  target         JSONB,
  behavior_state JSONB NOT NULL DEFAULT '{"lastDirection":null,"cycleIndex":0}',
  variables      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS keypad_mappings_home_idx ON keypad_mappings (home_id);
