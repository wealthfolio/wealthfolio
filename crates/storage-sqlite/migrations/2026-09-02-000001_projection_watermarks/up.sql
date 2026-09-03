-- Per-account record of the last kernel projection: which facts it was
-- computed from (fingerprint), for which day, and the resumable checkpoint.
CREATE TABLE projection_watermarks (
    account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    as_of TEXT NOT NULL,
    computed_at TEXT NOT NULL
);

-- Kernel projection state at chunk boundaries (year ends and the last
-- projected day): a resumed run starts from the latest checkpoint before the
-- earliest changed fact instead of from the first activity.
CREATE TABLE projection_checkpoints (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    checkpoint_date TEXT NOT NULL,
    state TEXT NOT NULL,
    transfer_cache TEXT NOT NULL,
    PRIMARY KEY (account_id, checkpoint_date)
);
