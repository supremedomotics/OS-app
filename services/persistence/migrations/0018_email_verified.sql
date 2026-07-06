-- Email verification (§ Authentication — email verification): track whether a user's email address
-- has been verified. Existing users default to unverified; the app marks the master verified.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
