-- Durable state for the Hub Registry (ADR 0008). The hub↔account ownership graph must survive
-- restarts. Timestamps are epoch-ms (BIGINT) to round-trip the store's numeric fields exactly.
-- Claim codes are deliberately NOT persisted here — they are short-lived ephemeral state (Redis
-- in production), so the Postgres store keeps them in memory.

CREATE TABLE IF NOT EXISTS hubs (
  hub_uuid              TEXT PRIMARY KEY,
  status                TEXT NOT NULL DEFAULT 'provisioned',
  public_key            TEXT NOT NULL,
  model                 TEXT NOT NULL,
  fw_version            TEXT NOT NULL,
  cert_serial           TEXT,
  claimed_by_account_id TEXT,
  dealer_org_id         TEXT,
  created_at            BIGINT NOT NULL,
  last_seen_at          BIGINT
);
CREATE INDEX IF NOT EXISTS idx_hubs_claimed ON hubs (claimed_by_account_id);

CREATE TABLE IF NOT EXISTS homes (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  hub_uuid         TEXT NOT NULL,
  created_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_homes_hub ON homes (hub_uuid);

CREATE TABLE IF NOT EXISTS memberships (
  id         TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memberships_home ON memberships (home_id);

-- Single-use enrollment nonces (anti-replay). A unique PK makes recordNonce atomic.
CREATE TABLE IF NOT EXISTS enroll_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);

-- Revoked device-cert serials (CRL).
CREATE TABLE IF NOT EXISTS revoked_certs (
  serial     TEXT PRIMARY KEY,
  revoked_at BIGINT NOT NULL
);
