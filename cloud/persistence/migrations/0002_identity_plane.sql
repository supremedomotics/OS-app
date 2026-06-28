-- Durable state for the identity plane (Identity / AuthN / Device Registry). Accounts, sessions,
-- and devices MUST survive a cloud restart — otherwise a single deploy logs everyone out and
-- forgets their devices. Timestamps are epoch-ms (BIGINT) to round-trip the stores' numeric
-- fields exactly. Identity uniqueness is case-insensitive via a stored lowercased value.

-- ── Identity service ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,         -- email | phone | username
  value       TEXT NOT NULL,
  value_lc    TEXT NOT NULL,         -- lower(value) — case-insensitive uniqueness/lookup
  verified_at BIGINT,
  UNIQUE (kind, value_lc)
);
CREATE INDEX IF NOT EXISTS idx_identities_account ON identities (account_id);

CREATE TABLE IF NOT EXISTS credentials (
  account_id    TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL        -- argon2id
);

CREATE TABLE IF NOT EXISTS passkeys (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  sign_count    BIGINT NOT NULL DEFAULT 0,
  name          TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passkeys_account ON passkeys (account_id);

CREATE TABLE IF NOT EXISTS federated_identities (
  provider   TEXT NOT NULL,         -- apple | google | microsoft
  subject    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email      TEXT,
  PRIMARY KEY (provider, subject)
);

-- ── Device Registry ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_devices (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL,
  os_version    TEXT,
  model         TEXT,
  push_token    TEXT,
  push_provider TEXT,
  trust         TEXT NOT NULL DEFAULT 'pending',
  last_seen_at  BIGINT,
  last_ip       TEXT,
  last_geo      TEXT,
  created_at    BIGINT NOT NULL,
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_devices_account ON client_devices (account_id, created_at DESC);

-- ── AuthN (rotating refresh tokens + revocation) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  hash       TEXT PRIMARY KEY,      -- sha256 of the opaque secret; the secret is never stored
  session_id TEXT NOT NULL,
  family_id  TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT,
  rotated_to TEXT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_session ON refresh_tokens (session_id);

CREATE TABLE IF NOT EXISTS revoked_families (family_id TEXT PRIMARY KEY, at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS revoked_sessions (session_id TEXT PRIMARY KEY, at BIGINT NOT NULL);
