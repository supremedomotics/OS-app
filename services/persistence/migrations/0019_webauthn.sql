-- Passkeys / WebAuthn credentials (§ Security Center — passkeys). Stores the credential's public key
-- (never a secret) + a signature counter. FK-cascades when the user is deleted.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  sign_count     INTEGER NOT NULL DEFAULT 0,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT
);
CREATE INDEX IF NOT EXISTS webauthn_user ON webauthn_credentials (user_id);
