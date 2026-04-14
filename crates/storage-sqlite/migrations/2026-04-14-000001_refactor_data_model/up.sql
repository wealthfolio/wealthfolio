-- ============================================================================
-- Consolidated data-model refactor migration.
--
-- This single migration folds in 8 incremental migrations from the phase
-- branches: create_lots_table, add_alt_value_to_valuation,
-- create_daily_portfolio_valuation, lots_cascade_on_activity_delete,
-- add_account_id_to_assets, clear_positions_json,
-- clear_calculated_positions_json, and create_snapshot_positions.
--
-- Schema only. All data backfills (lots from activities, snapshot_positions
-- from holdings_snapshots.positions JSON, daily_portfolio_valuation from
-- account valuations) are performed by application code on first startup
-- after this migration runs. Running the backfill in code lets it be
-- interruptable, per-account, and resumable.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. lots — materialized tax lots (the new authoritative source of positions)
-- ----------------------------------------------------------------------------

CREATE TABLE lots (
    -- Identity & foreign keys
    id                  TEXT    PRIMARY KEY NOT NULL,
    account_id          TEXT    NOT NULL,
    asset_id            TEXT    NOT NULL,

    -- Open state — who opened the lot, when, and at what basis.
    -- open_activity_id is NULL for lots created from HOLDINGS-mode snapshots.
    open_date           TEXT    NOT NULL,
    open_activity_id    TEXT,
    original_quantity   TEXT    NOT NULL,
    cost_per_unit       TEXT    NOT NULL,
    total_cost_basis    TEXT    NOT NULL,
    fee_allocated       TEXT    NOT NULL DEFAULT '0',

    -- Current state — populated over the life of the lot.
    remaining_quantity  TEXT    NOT NULL,
    is_closed           INTEGER NOT NULL DEFAULT 0,

    -- Close state — populated when the lot is fully disposed.
    close_date          TEXT,
    close_activity_id   TEXT,

    -- Tax-relevant flags (populated during shadow-write / future tax phase).
    disposal_method     TEXT    NOT NULL DEFAULT 'FIFO',
    is_wash_sale        INTEGER NOT NULL DEFAULT 0,
    holding_period      TEXT,   -- SHORT_TERM | LONG_TERM | NULL (still open)

    -- Audit
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CHECK (disposal_method IN ('FIFO', 'LIFO', 'SPECIFIC_ID', 'AVG_COST', 'HIFO')),
    CHECK (is_closed    IN (0, 1)),
    CHECK (is_wash_sale IN (0, 1)),
    CHECK (holding_period IS NULL OR holding_period IN ('SHORT_TERM', 'LONG_TERM')),

    -- open_activity_id is CASCADE (not SET NULL) — deleting the opening
    -- activity removes the lot rather than orphaning it with a NULL ref.
    FOREIGN KEY (account_id)        REFERENCES accounts(id)    ON DELETE CASCADE,
    FOREIGN KEY (asset_id)          REFERENCES assets(id)      ON DELETE CASCADE,
    FOREIGN KEY (open_activity_id)  REFERENCES activities(id)  ON DELETE CASCADE,
    FOREIGN KEY (close_activity_id) REFERENCES activities(id)  ON DELETE SET NULL
);

-- Hot-path query: valuation = lots JOIN quotes WHERE is_closed = 0
CREATE INDEX idx_lots_account_asset ON lots(account_id, asset_id);
-- Query open lots for an asset across all accounts
CREATE INDEX idx_lots_asset_open    ON lots(asset_id, is_closed, open_date);
-- Query all open lots for an account
CREATE INDEX idx_lots_account_open  ON lots(account_id, is_closed);
-- Reverse-lookup: which lot was opened by this activity?
CREATE INDEX idx_lots_open_activity ON lots(open_activity_id)
    WHERE open_activity_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. daily_account_valuation — add alternative_market_value column
-- ----------------------------------------------------------------------------
-- Lets the Investments page filter out precious metals / property
-- consistently in both header and account cards.

ALTER TABLE daily_account_valuation
    ADD COLUMN alternative_market_value TEXT NOT NULL DEFAULT '0';


-- ----------------------------------------------------------------------------
-- 3. daily_portfolio_valuation — portfolio-wide totals table
-- ----------------------------------------------------------------------------
-- Replaces the TOTAL pseudo-account rows in daily_account_valuation.
-- Code will populate this on first startup from per-account valuations.

CREATE TABLE daily_portfolio_valuation (
    id                        TEXT    PRIMARY KEY NOT NULL,
    valuation_date            DATE    NOT NULL,
    base_currency             TEXT    NOT NULL,

    -- Component totals
    cash_balance              TEXT    NOT NULL DEFAULT '0',
    investment_market_value   TEXT    NOT NULL DEFAULT '0',
    alternative_market_value  TEXT    NOT NULL DEFAULT '0',

    -- Aggregates
    total_assets              TEXT    NOT NULL DEFAULT '0',
    total_liabilities         TEXT    NOT NULL DEFAULT '0',
    net_worth                 TEXT    NOT NULL DEFAULT '0',

    -- Provenance
    cost_basis                TEXT    NOT NULL DEFAULT '0',
    net_contribution          TEXT    NOT NULL DEFAULT '0',
    calculated_at             TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_portfolio_valuation_date
    ON daily_portfolio_valuation(valuation_date);


-- ----------------------------------------------------------------------------
-- 4. daily_account_valuation — remove TOTAL pseudo-account rows
-- ----------------------------------------------------------------------------
-- Pure cleanup after daily_portfolio_valuation is available. Safe to run
-- at migration time because application code has been updated to no
-- longer read or write TOTAL rows in daily_account_valuation.

DELETE FROM daily_account_valuation WHERE account_id = 'TOTAL';


-- ----------------------------------------------------------------------------
-- 5. assets — optional account_id FK for liability-style assets
-- ----------------------------------------------------------------------------
-- Links alternative assets (liabilities, property, etc.) to the account
-- they belong to. NULL for unlinked assets (house, gold in a safe) and
-- for investment assets (linked via activities/lots instead).

ALTER TABLE assets
    ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;


-- ----------------------------------------------------------------------------
-- 6. snapshot_positions — relational positions for HOLDINGS-mode accounts
-- ----------------------------------------------------------------------------
-- Replaces the positions JSON blob in holdings_snapshots. Integer
-- autoincrement PK; natural key is (snapshot_id, asset_id). Application
-- code populates this on first startup from the legacy positions JSON
-- for HOLDINGS-mode snapshots, and clears the JSON incrementally as
-- each account is migrated so a crash resumes cleanly.

CREATE TABLE snapshot_positions (
    -- Identity & foreign keys
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id          TEXT    NOT NULL REFERENCES holdings_snapshots(id) ON DELETE CASCADE,
    asset_id             TEXT    NOT NULL REFERENCES assets(id)              ON DELETE CASCADE,

    -- Position state
    quantity             TEXT    NOT NULL,
    average_cost         TEXT    NOT NULL,
    total_cost_basis     TEXT    NOT NULL,
    currency             TEXT    NOT NULL,
    contract_multiplier  TEXT    NOT NULL DEFAULT '1',

    -- Metadata
    inception_date       TEXT    NOT NULL,
    is_alternative       INTEGER NOT NULL DEFAULT 0,

    -- Audit
    created_at           TEXT    NOT NULL,
    last_updated         TEXT    NOT NULL,

    UNIQUE (snapshot_id, asset_id)
);

CREATE INDEX idx_snapshot_positions_snapshot_id ON snapshot_positions(snapshot_id);
CREATE INDEX idx_snapshot_positions_asset_id    ON snapshot_positions(asset_id);

-- Backfill snapshot_positions from existing positions JSON. HOLDINGS-mode
-- snapshots (MANUAL_ENTRY, BROKER_IMPORTED, CSV_IMPORT, SYNTHETIC) carry
-- their position data in the JSON blob on today's schema; the new read
-- path sources from snapshot_positions, so existing rows must be copied
-- over for HOLDINGS accounts to keep working after upgrade. One-shot
-- atomic INSERT — no resume logic needed.
--
-- json_extract on numeric fields can produce scientific notation
-- (e.g. 1e-08). Wrap in printf('%.20f') + rtrim to produce the decimal
-- text format that Decimal::from_str expects.
INSERT INTO snapshot_positions (
    snapshot_id, asset_id, quantity, average_cost, total_cost_basis,
    currency, inception_date, is_alternative, contract_multiplier,
    created_at, last_updated
)
SELECT
    hs.id,
    json_extract(pos.value, '$.assetId'),
    rtrim(rtrim(printf('%.20f', json_extract(pos.value, '$.quantity')), '0'), '.'),
    rtrim(rtrim(printf('%.20f', json_extract(pos.value, '$.averageCost')), '0'), '.'),
    rtrim(rtrim(printf('%.20f', json_extract(pos.value, '$.totalCostBasis')), '0'), '.'),
    json_extract(pos.value, '$.currency'),
    COALESCE(json_extract(pos.value, '$.inceptionDate'), '1970-01-01T00:00:00Z'),
    COALESCE(json_extract(pos.value, '$.isAlternative'), 0),
    rtrim(rtrim(printf('%.20f', COALESCE(json_extract(pos.value, '$.contractMultiplier'), 1)), '0'), '.'),
    COALESCE(json_extract(pos.value, '$.createdAt'), '1970-01-01T00:00:00Z'),
    COALESCE(json_extract(pos.value, '$.lastUpdated'), '1970-01-01T00:00:00Z')
FROM holdings_snapshots hs,
     json_each(hs.positions) pos
WHERE hs.positions IS NOT NULL
  AND hs.positions != '{}'
  AND hs.positions != ''
  AND json_extract(pos.value, '$.assetId') IS NOT NULL;

-- Clear positions JSON after backfill to match the new write-path
-- behavior where positions are always written as '{}'.
UPDATE holdings_snapshots SET positions = '{}' WHERE positions != '{}';
