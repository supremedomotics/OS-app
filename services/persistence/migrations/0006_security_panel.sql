-- Persist the security panel (§4) so an armed home stays armed across a hub restart
-- (a reboot must never silently disarm the home). One row per home.
CREATE TABLE IF NOT EXISTS security_panels (
  home_id         TEXT PRIMARY KEY,
  mode            TEXT NOT NULL,
  triggered       BOOLEAN NOT NULL DEFAULT FALSE,
  last_changed_by TEXT,
  last_changed_at TEXT NOT NULL
);
