DO $migration$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3) THEN
        ALTER TABLE users
            DROP CONSTRAINT IF EXISTS users_role_check,
            DROP CONSTRAINT IF EXISTS users_check,
            ADD CONSTRAINT users_role_check
                CHECK (role IN ('treasurer', 'department', 'leadership')),
            ADD CONSTRAINT users_check CHECK (
                (role IN ('treasurer', 'leadership') AND department_name IS NULL) OR
                (role = 'department' AND department_name IS NOT NULL)
            );
        ALTER TABLE audit_log
            ADD COLUMN IF NOT EXISTS actor_user_id BIGINT,
            ADD COLUMN IF NOT EXISTS actor_email TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS actor_name TEXT NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS actor_department TEXT NOT NULL DEFAULT '';
        INSERT INTO schema_migrations (version, applied_at)
            VALUES (3, CURRENT_TIMESTAMP::text);
    END IF;
END;
$migration$;
