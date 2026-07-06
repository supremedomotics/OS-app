-- Security Center (§ Security Center): capture where a login came from so the owner can review
-- active sessions / login history and remotely sign a device out. Nullable + no default so existing
-- sessions are unaffected; the UI shows what's present and hides what predates capture.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TEXT;
