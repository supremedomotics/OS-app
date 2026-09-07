-- Real username login (§ Authentication — username field). Replaces the old, now-broken
-- "bare username normalizes to <username>@supreme.local" hack (that synthesized address stopped
-- being created once email became mandatory at Setup Wizard time, so it silently matched no one).
-- Nullable: existing accounts and admin-created users with none set log in by email only. Unique
-- among rows that have one — a partial index so multiple NULLs are allowed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (LOWER(username)) WHERE username IS NOT NULL;
