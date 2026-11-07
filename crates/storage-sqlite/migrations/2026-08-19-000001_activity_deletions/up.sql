-- Tombstones for broker-sourced activities the user deleted.
--
-- A broker re-sync walks the same window and upserts on the same keys, so a
-- hard delete is undone by the next sync. This table remembers the delete so
-- the upsert can suppress the row instead of resurrecting it.
--
-- Keyed the same way the upsert matches: provider identity
-- (source_system, account_id, source_record_id) first, semantic idempotency
-- key as the fallback for feeds that carry no record id.
--
-- Local-only, like the broker sync cursor and broker import-run history:
-- broker-sourced activities are never sent to other devices (each device
-- re-syncs from the broker), so their tombstones are not either.
CREATE TABLE activity_deletions (
    id TEXT NOT NULL PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_system TEXT NOT NULL,
    source_record_id TEXT,
    idempotency_key TEXT,
    -- The deleted row, serialized, so the suppression list can describe what it
    -- is suppressing and a restore can put back exactly what was removed.
    activity_snapshot TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX ix_activity_deletions_source_identity
    ON activity_deletions(account_id, source_system, source_record_id)
    WHERE source_record_id IS NOT NULL;

CREATE UNIQUE INDEX ix_activity_deletions_idempotency_key
    ON activity_deletions(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX ix_activity_deletions_account_id ON activity_deletions(account_id);
