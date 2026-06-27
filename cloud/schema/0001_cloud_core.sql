-- Supreme Cloud — core control-plane schema (blueprint §6, §23).
-- Schema-per-service in a shared Citus/Postgres cluster; home-scoped tables shard by
-- home_id, identity tables by account_id, memberships co-located as a reference table.
-- The cloud stores the IDENTITY + OWNERSHIP graph only — never device state (invariant I2).
-- All ids UUIDv7 unless a natural key; all timestamps UTC (timestamptz).

-- ── Identity plane (account_id sharded) ────────────────────────────────────────────────
CREATE TABLE accounts (
  id                  uuid PRIMARY KEY,
  status              text NOT NULL DEFAULT 'active',          -- active|suspended|closed
  primary_identity_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL,                                   -- email|phone|username
  value       text NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

CREATE TABLE federated_identities (
  id         uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider   text NOT NULL,                                    -- apple|google|microsoft
  subject    text NOT NULL,
  email      text,
  linked_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE credentials (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash text NOT NULL,                                 -- argon2id, KMS-peppered
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkeys (
  id            uuid PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,                         -- WebAuthn credential id
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  aaguid        uuid,
  transports    text[],
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE TABLE mfa_methods (
  id           uuid PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type         text NOT NULL,                                  -- totp|webauthn|push
  secret_ref   text,                                           -- KMS reference, never plaintext
  confirmed_at timestamptz
);

CREATE TABLE auth_sessions (
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id       uuid,
  amr             text[],                                      -- auth methods used
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  absolute_expiry timestamptz NOT NULL,
  revoked_at      timestamptz
);

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  family_id  uuid NOT NULL,                                    -- rotation family (reuse ⇒ revoke family)
  hash       text NOT NULL,
  rotated_to uuid,
  used_at    timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL
);

CREATE TABLE client_devices (
  id            uuid PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          text NOT NULL,                                 -- "Mujeeb's iPhone"
  platform      text NOT NULL,                                 -- ios|android|web|wearos|watchos|panel|macos
  os_version    text,
  model         text,
  push_token    text,
  push_provider text,                                          -- apns|fcm|webpush
  cert_serial   text,
  trust         text NOT NULL DEFAULT 'pending',               -- approved|pending|revoked
  last_seen_at  timestamptz,
  last_ip       inet,
  last_geo      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Hub plane (hub registry) ───────────────────────────────────────────────────────────
CREATE TABLE hubs (
  id                   uuid PRIMARY KEY,                       -- hub_uuid (UUIDv7)
  status               text NOT NULL DEFAULT 'provisioned',    -- provisioned|claimed|suspended|decommissioned
  model                text,
  fw_version           text,
  public_key           text NOT NULL,                          -- Ed25519 device public key (SPKI PEM)
  hub_ca_serial        text,                                   -- active device-cert serial
  claimed_by_account_id uuid REFERENCES accounts(id),
  dealer_org_id        uuid,
  last_seen_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hub_certs (
  id                uuid PRIMARY KEY,
  hub_id            uuid NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  serial            text NOT NULL UNIQUE,
  pubkey_fingerprint text NOT NULL,
  not_before        timestamptz NOT NULL,
  not_after         timestamptz NOT NULL,
  revoked_at        timestamptz
);

CREATE TABLE hub_attestations (
  id          uuid PRIMARY KEY,
  hub_id      uuid NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
  kind        text NOT NULL,                                   -- factory|installer|tpm
  evidence_ref text,
  verified_at timestamptz
);

CREATE TABLE hub_claim_codes (
  hub_id     uuid PRIMARY KEY REFERENCES hubs(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,                                    -- never store the code in plaintext
  expires_at timestamptz NOT NULL
);

-- ── Home / membership plane (home_id sharded; memberships co-located reference) ─────────
CREATE TABLE homes (
  id               uuid PRIMARY KEY,
  name             text NOT NULL,
  address          text,
  timezone         text NOT NULL DEFAULT 'UTC',
  owner_account_id uuid NOT NULL REFERENCES accounts(id),
  hub_id           uuid REFERENCES hubs(id),                   -- one home ≈ one hub (hub-less allowed)
  tier             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id            uuid PRIMARY KEY,
  home_id       uuid NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role          text NOT NULL,                                 -- owner|admin|installer|homeowner|family|guest|service
  invited_by    uuid REFERENCES accounts(id),
  status        text NOT NULL DEFAULT 'active',
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_until   timestamptz,                                   -- time-boxed guest/service access
  schedule_json jsonb,
  UNIQUE (home_id, account_id)
);

CREATE TABLE member_grants (
  id            uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  resource_type text NOT NULL,                                 -- room|device|scene|camera|...
  resource_id   uuid,
  action        text NOT NULL,
  effect        text NOT NULL DEFAULT 'allow',                 -- allow|deny
  valid_until   timestamptz
);

-- ── Ecosystem / commercial planes ──────────────────────────────────────────────────────
CREATE TABLE voice_links (
  id                uuid PRIMARY KEY,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  home_id           uuid NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  assistant         text NOT NULL,                             -- alexa|google|siri|matter
  external_user_ref text,
  scopes            text[],
  status            text NOT NULL DEFAULT 'linked',
  linked_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE matter_fabrics (
  id          uuid PRIMARY KEY,
  home_id     uuid NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  fabric_id   text NOT NULL,
  root_ref    text,
  admin_refs_json jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY,
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan               text NOT NULL,
  status             text NOT NULL,
  entitlements_json  jsonb,
  current_period_end timestamptz,
  provider_ref       text
);

CREATE TABLE licenses (
  id          uuid PRIMARY KEY,
  home_id     uuid REFERENCES homes(id) ON DELETE CASCADE,
  hub_id      uuid REFERENCES hubs(id) ON DELETE CASCADE,
  sku         text NOT NULL,
  features_json jsonb,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  signature   text NOT NULL                                    -- Ed25519, offline-validatable on the hub
);

CREATE TABLE audit_log (
  id               uuid PRIMARY KEY,
  scope            text NOT NULL,                              -- cloud|home
  home_id          uuid,
  actor_account_id uuid,
  actor_kind       text NOT NULL,                              -- user|hub|dealer|system
  action           text NOT NULL,
  resource_type    text,
  resource_id      uuid,
  metadata_json    jsonb,
  prev_hash        text,                                       -- hash-chained (tamper-evident)
  entry_hash       text NOT NULL,
  ip               inet,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_identities_account     ON identities(account_id);
CREATE INDEX idx_devices_account        ON client_devices(account_id);
CREATE INDEX idx_hubs_claimed_account   ON hubs(claimed_by_account_id);
CREATE INDEX idx_homes_owner            ON homes(owner_account_id);
CREATE INDEX idx_memberships_account    ON memberships(account_id);
CREATE INDEX idx_memberships_home       ON memberships(home_id);
CREATE INDEX idx_refresh_family         ON refresh_tokens(family_id);
CREATE INDEX idx_audit_home_time        ON audit_log(home_id, created_at);
