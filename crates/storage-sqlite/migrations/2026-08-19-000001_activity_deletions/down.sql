DROP INDEX IF EXISTS ix_activity_deletions_account_id;
DROP INDEX IF EXISTS ix_activity_deletions_idempotency_key;
DROP INDEX IF EXISTS ix_activity_deletions_source_identity;
DROP TABLE IF EXISTS activity_deletions;
