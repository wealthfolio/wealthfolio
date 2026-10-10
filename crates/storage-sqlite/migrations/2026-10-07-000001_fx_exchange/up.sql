-- The migration runner disables FKs outside the transaction. Keep activity IDs,
-- dependent rows, indexes and projection triggers intact while widening the type CHECK.
CREATE TABLE activities_new (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    asset_id TEXT,

    activity_type TEXT NOT NULL CHECK (activity_type IN (
        'BUY', 'SELL', 'SPLIT',
        'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL',
        'TRANSFER_IN', 'TRANSFER_OUT', 'FEE', 'TAX',
        'CREDIT', 'ADJUSTMENT', 'UNKNOWN', 'FX_EXCHANGE'
    )),
    activity_type_override TEXT,
    source_type TEXT,
    subtype TEXT,
    status TEXT NOT NULL DEFAULT 'POSTED',

    activity_date TEXT NOT NULL,
    settlement_date TEXT,

    quantity TEXT,
    unit_price TEXT,
    amount TEXT,
    fee TEXT,
    currency TEXT NOT NULL,
    fx_rate TEXT,

    notes TEXT,
    metadata TEXT,

    source_system TEXT,
    source_record_id TEXT,
    source_group_id TEXT,
    idempotency_key TEXT,
    import_run_id TEXT,

    is_user_modified INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    tax TEXT,

    destination_amount TEXT,
    destination_currency TEXT,
    CHECK (activity_type <> 'FX_EXCHANGE' OR (
        amount IS NOT NULL AND destination_amount IS NOT NULL
        AND CAST(amount AS NUMERIC) > 0 AND CAST(destination_amount AS NUMERIC) > 0
        AND length(trim(currency)) = 3 AND length(trim(destination_currency)) = 3
        AND fx_rate IS NULL
        AND COALESCE(CAST(fee AS NUMERIC), 0) = 0 AND COALESCE(CAST(tax AS NUMERIC), 0) = 0
        AND COALESCE(CAST(quantity AS NUMERIC), 0) = 0 AND COALESCE(CAST(unit_price AS NUMERIC), 0) = 0
        AND destination_currency IS NOT NULL AND trim(destination_currency) <> ''
        AND upper(trim(currency)) <> upper(trim(destination_currency))
        AND asset_id IS NULL
    )),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (import_run_id) REFERENCES import_runs(id) ON DELETE SET NULL
);

INSERT INTO activities_new (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, fx_rate, notes, metadata, source_system, source_record_id, source_group_id, idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at, tax)
SELECT id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, fx_rate, notes, metadata, source_system, source_record_id, source_group_id, idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at, tax FROM activities;
DROP TABLE activities;
ALTER TABLE activities_new RENAME TO activities;

CREATE INDEX ix_activities_account_id ON activities(account_id);

CREATE INDEX ix_activities_asset_id ON activities(asset_id);

CREATE INDEX ix_activities_activity_date ON activities(activity_date);

CREATE INDEX ix_activities_status ON activities(status);

CREATE UNIQUE INDEX ux_activities_idempotency_key ON activities(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX ix_activities_source_identity
ON activities(source_system, account_id, source_record_id)
WHERE source_system IS NOT NULL AND source_record_id IS NOT NULL;

CREATE INDEX ix_activities_source_group_id
    ON activities(source_group_id)
    WHERE source_group_id IS NOT NULL;

CREATE INDEX ix_activities_transfer_scope
    ON activities(account_id, activity_date, status)
    WHERE COALESCE(activity_type_override, activity_type) IN ('TRANSFER_IN', 'TRANSFER_OUT');

CREATE INDEX idx_activities_account_date ON activities(account_id, activity_date);

CREATE TRIGGER projection_activity_insert AFTER INSERT ON activities
BEGIN
    INSERT INTO projection_state (scope, dirty_from, version)
    VALUES (NEW.account_id, coalesce(date(NEW.activity_date, '-1 day'), '0001-01-01'), 1)
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    SELECT DISTINCT p.account_id, coalesce(date(p.activity_date, '-1 day'), '0001-01-01'), 1
    FROM activities p
    WHERE NEW.source_group_id IS NOT NULL AND p.source_group_id = NEW.source_group_id
      AND p.account_id <> NEW.account_id
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    SELECT 'a:' || NEW.asset_id, '0001-01-01', 1
    WHERE coalesce(nullif(trim(NEW.activity_type_override, char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)), ''), NEW.activity_type) = 'SPLIT' AND NEW.asset_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = '0001-01-01',
        version = projection_state.version + 1;
END;

CREATE TRIGGER projection_activity_update AFTER UPDATE ON activities
BEGIN
    INSERT INTO projection_state (scope, dirty_from, version)
    VALUES (OLD.account_id, coalesce(date(OLD.activity_date, '-1 day'), '0001-01-01'), 1)
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    VALUES (NEW.account_id, coalesce(date(NEW.activity_date, '-1 day'), '0001-01-01'), 1)
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    SELECT DISTINCT p.account_id, coalesce(date(p.activity_date, '-1 day'), '0001-01-01'), 1
    FROM activities p
    WHERE p.source_group_id IS NOT NULL
      AND p.source_group_id IN (OLD.source_group_id, NEW.source_group_id)
      AND p.id <> NEW.id
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    SELECT 'a:' || OLD.asset_id, '0001-01-01', 1
    WHERE coalesce(nullif(trim(OLD.activity_type_override, char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)), ''), OLD.activity_type) = 'SPLIT' AND OLD.asset_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = '0001-01-01',
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    SELECT 'a:' || NEW.asset_id, '0001-01-01', 1
    WHERE coalesce(nullif(trim(NEW.activity_type_override, char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)), ''), NEW.activity_type) = 'SPLIT' AND NEW.asset_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = '0001-01-01',
        version = projection_state.version + 1;
END;

CREATE TRIGGER projection_activity_delete AFTER DELETE ON activities
BEGIN
    INSERT INTO projection_state (scope, dirty_from, version)
    VALUES (OLD.account_id, coalesce(date(OLD.activity_date, '-1 day'), '0001-01-01'), 1)
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    SELECT DISTINCT p.account_id, coalesce(date(p.activity_date, '-1 day'), '0001-01-01'), 1
    FROM activities p
    WHERE OLD.source_group_id IS NOT NULL AND p.source_group_id = OLD.source_group_id
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = min(coalesce(projection_state.dirty_from, excluded.dirty_from), excluded.dirty_from),
        version = projection_state.version + 1;
    INSERT INTO projection_state (scope, dirty_from, version)
    SELECT 'a:' || OLD.asset_id, '0001-01-01', 1
    WHERE coalesce(nullif(trim(OLD.activity_type_override, char(9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)), ''), OLD.activity_type) = 'SPLIT' AND OLD.asset_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET
        dirty_from = '0001-01-01',
        version = projection_state.version + 1;
END;
