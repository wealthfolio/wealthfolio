DROP TRIGGER IF EXISTS allocation_targets_type_update;
DROP TRIGGER IF EXISTS allocation_target_weights_type_update;
DROP TRIGGER IF EXISTS allocation_target_weights_type_insert;
DROP TRIGGER IF EXISTS allocation_target_asset_weights_type_update;
DROP TRIGGER IF EXISTS allocation_target_asset_weights_type_insert;
DROP TABLE IF EXISTS allocation_target_asset_weights;

ALTER TABLE allocation_targets DROP COLUMN target_type;
