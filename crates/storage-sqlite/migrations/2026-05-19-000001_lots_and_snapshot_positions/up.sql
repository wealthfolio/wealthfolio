-- ============================================================================
-- Materialize lots and snapshot_positions tables (additive groundwork).
--
-- Adds two relational tables that pull derived position state out of JSON
-- blobs and full activity replays:
--
--   * `lots`               - persistent tax-lot inventory (one row per
--                            acquisition, updated in place as shares are
--                            disposed). Replaces in-memory FIFO recomputation
--                            on every recalc.
--   * `snapshot_positions` - per-snapshot positions for HOLDINGS-mode
--                            accounts. Sibling of the legacy
--                            holdings_snapshots.positions JSON column.
--
-- This migration is intentionally additive:
--   * The legacy positions JSON column is NOT cleared - read paths still
--     resolve through it, dual-write keeps both representations populated.
--   * Legacy HOLDINGS snapshots that were defaulted to CALCULATED are normalized
--     to MANUAL_ENTRY before rebuildable calculated snapshots are cleared.
--     HOLDINGS accounts are not replayed from activities, so those snapshots are
--     source data.
--   * No read-path switchover, scoped valuation fields, or pseudo-account
--     cleanups.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. lots - materialized tax lots
-- ----------------------------------------------------------------------------

CREATE TABLE lots (
    -- Identity & foreign keys
    id                  TEXT    PRIMARY KEY NOT NULL,
    account_id          TEXT    NOT NULL,
    asset_id            TEXT    NOT NULL,

    -- Open state - who opened the lot, when, and at what basis.
    -- open_activity_id may be NULL when compiler-generated lot IDs do not
    -- correspond to real activity rows.
    open_date           TEXT    NOT NULL,
    open_activity_id    TEXT,
    original_quantity   TEXT    NOT NULL,
    cost_per_unit       TEXT    NOT NULL,
    -- Immutable: cost basis at lot creation (cost_per_unit * original_quantity
    -- + fee_allocated, in cost_basis_currency).
    original_cost_basis TEXT    NOT NULL,
    -- Mutable: open cost basis still attributable to remaining_quantity.
    -- Reduced proportionally as remaining_quantity is consumed.
    remaining_cost_basis TEXT   NOT NULL,
    fee_allocated       TEXT    NOT NULL DEFAULT '0',

    -- Current state - populated over the life of the lot.
    remaining_quantity  TEXT    NOT NULL,
    -- Cumulative product of post-acquisition SPLIT ratios for the lot's
    -- asset. Default '1' means no splits since the lot was opened. Lot
    -- columns above (original_quantity, cost_per_unit, original_cost_basis,
    -- fee_allocated, remaining_quantity) are stored in as-acquired
    -- (pre-split) units; effective shares held now = remaining_quantity *
    -- split_ratio. Cost basis is split-invariant.
    split_ratio         TEXT    NOT NULL DEFAULT '1',
    is_closed           INTEGER NOT NULL DEFAULT 0,

    -- Close state - populated when the lot is fully disposed.
    close_date          TEXT,
    close_activity_id   TEXT,

    -- Audit
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CHECK (is_closed    IN (0, 1)),

    -- Tax conclusions (disposal_method, is_wash_sale, holding_period) live in
    -- separate tax-overlay tables in a later phase. The neutral lots table
    -- intentionally stores only inventory facts.

    -- open_activity_id is CASCADE (not SET NULL) - deleting the opening
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
-- 2. snapshot_positions - relational positions for HOLDINGS-mode snapshots
-- ----------------------------------------------------------------------------
-- Sibling of the legacy holdings_snapshots.positions JSON blob. Both columns
-- coexist after this migration: dual-write keeps them in sync, reads can
-- prefer the relational table with a JSON fallback for snapshots that
-- predate the table.
--
-- The natural key is (snapshot_id, asset_id); integer PK simplifies cursor
-- iteration. CASCADE from both parents.

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

-- Normalize legacy holdings-mode snapshots before clearing rebuildable derived
-- snapshots. Older rows can have source='CALCULATED' because the source column
-- defaulted there, but for HOLDINGS accounts these rows are source snapshots.
UPDATE holdings_snapshots
SET source = 'MANUAL_ENTRY'
WHERE source = 'CALCULATED'
  AND account_id IN (
      SELECT id
      FROM accounts
      WHERE tracking_mode = 'HOLDINGS'
  );

-- Drop remaining calculated snapshots and valuation rows so the existing
-- portfolio calculation path rebuilds transaction-derived state and lots.
DELETE FROM holdings_snapshots
WHERE source = 'CALCULATED';

DELETE FROM daily_account_valuation;

-- NOTE: positions JSON is intentionally NOT cleared. Read paths still resolve
-- through it; the relational table is a parallel write surface for now. A
-- future PR that switches reads to snapshot_positions can decide whether
-- to keep or drop the JSON column.
