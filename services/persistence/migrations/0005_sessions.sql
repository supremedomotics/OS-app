-- Production hardening: persisted login sessions so refresh-token rotation and
-- revocation survive restarts and work across processes (§12).
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  current_jti TEXT NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
