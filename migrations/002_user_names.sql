-- Add a display name without changing existing accounts or permissions.
BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';

INSERT INTO schema_migrations(version, applied_at)
VALUES (2, to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.US'))
ON CONFLICT (version) DO NOTHING;

COMMIT;
