-- Supreme Intelligence Engine — local learning + action history (ADR 0013).
-- Every decision the engine surfaces or takes is appended here, on the hub, with its full confidence
-- breakdown and estimated savings. This is the single source for the learning engine (adaptive Auto
-- Pilot) and for the daily/weekly/monthly/yearly/lifetime reports. No cloud — purely local.
CREATE TABLE IF NOT EXISTS sie_history (
  id                      TEXT PRIMARY KEY,
  home_id                 TEXT NOT NULL,
  ts                      TEXT NOT NULL,             -- ISO-8601, sortable
  module                  TEXT NOT NULL,             -- "energy" | "presence" | ...
  device_id               TEXT,
  room_id                 TEXT,
  zone_id                 TEXT,
  owner_user_id           TEXT,
  action                  TEXT NOT NULL,             -- notified|approval_requested|auto_off|user_off|keep_on|ignored_today|always_ignore
  reason                  TEXT,
  automatic               BOOLEAN NOT NULL DEFAULT FALSE,
  user_response           TEXT,                      -- the action the user picked, when applicable
  decision_confidence     DOUBLE PRECISION,
  presence_confidence     DOUBLE PRECISION,
  room_vacancy_confidence DOUBLE PRECISION,
  ownership_confidence    DOUBLE PRECISION,
  energy_confidence       DOUBLE PRECISION,
  estimated_watts         DOUBLE PRECISION,
  estimated_kwh_saved     DOUBLE PRECISION,
  estimated_cost_saved    DOUBLE PRECISION,
  currency                TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sie_history_home_ts_idx ON sie_history (home_id, ts);
CREATE INDEX IF NOT EXISTS sie_history_home_device_ts_idx ON sie_history (home_id, device_id, ts);
CREATE INDEX IF NOT EXISTS sie_history_home_action_ts_idx ON sie_history (home_id, action, ts);
