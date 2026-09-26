-- Additive production migration for idempotent accounting imports.
ALTER TABLE import_previews
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready';

ALTER TABLE import_previews
    ADD COLUMN IF NOT EXISTS result_batch_id BIGINT;

ALTER TABLE import_previews
    ADD COLUMN IF NOT EXISTS completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_import_staging_token_id
    ON import_staging(preview_token, id);

CREATE INDEX IF NOT EXISTS idx_import_previews_created
    ON import_previews(created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version BIGINT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

INSERT INTO schema_migrations(version, applied_at)
VALUES (1, to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.US'))
ON CONFLICT (version) DO NOTHING;
