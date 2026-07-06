-- MFA recovery codes (§ Security Center — recovery codes): one-time backup codes a user can use
-- instead of TOTP if they lose their authenticator. Stored as hashes (never plaintext). Nullable
-- default so existing credentials are unaffected.
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS recovery_codes JSONB NOT NULL DEFAULT '[]';
