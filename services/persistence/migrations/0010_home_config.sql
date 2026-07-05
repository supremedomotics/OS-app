-- Per-home key/value configuration (durable settings: energy tariff, schedules, preferences).
CREATE TABLE IF NOT EXISTS home_config (
  home_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (home_id, key)
);
