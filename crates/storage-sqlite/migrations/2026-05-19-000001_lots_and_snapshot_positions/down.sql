-- Schema-only reversal. The legacy positions JSON column is untouched by this
-- migration (and by its reversal), so HOLDINGS-mode read paths keep working
-- through the JSON either way.

DROP INDEX IF EXISTS idx_snapshot_positions_asset_id;
DROP INDEX IF EXISTS idx_snapshot_positions_snapshot_id;
DROP TABLE IF EXISTS snapshot_positions;

DROP INDEX IF EXISTS idx_lots_open_activity;
DROP INDEX IF EXISTS idx_lots_account_open;
DROP INDEX IF EXISTS idx_lots_asset_open;
DROP INDEX IF EXISTS idx_lots_account_asset;
DROP TABLE IF EXISTS lots;
