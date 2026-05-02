-- Schema-only reversal. Does NOT restore data — any code-performed
-- backfills (lots, snapshot_positions population, positions JSON
-- clearing) will not come back. The down migration is provided for
-- development iteration on the up migration, not for production rollback.

DROP INDEX IF EXISTS idx_snapshot_positions_asset_id;
DROP INDEX IF EXISTS idx_snapshot_positions_snapshot_id;
DROP TABLE IF EXISTS snapshot_positions;

ALTER TABLE assets DROP COLUMN account_id;

ALTER TABLE daily_account_valuation DROP COLUMN alternative_market_value;

DROP INDEX IF EXISTS idx_lots_open_activity;
DROP INDEX IF EXISTS idx_lots_account_open;
DROP INDEX IF EXISTS idx_lots_asset_open;
DROP INDEX IF EXISTS idx_lots_account_asset;
DROP TABLE IF EXISTS lots;
