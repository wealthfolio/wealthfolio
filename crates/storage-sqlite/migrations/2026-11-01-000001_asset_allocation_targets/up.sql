ALTER TABLE allocation_targets
  ADD COLUMN target_type TEXT NOT NULL DEFAULT 'category'
      CHECK (target_type IN ('category', 'asset'));

CREATE TABLE allocation_target_asset_weights (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    target_bps INTEGER NOT NULL CHECK (target_bps >= 0 AND target_bps <= 10000),
    is_locked INTEGER NOT NULL DEFAULT 0,
    is_required INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
    UNIQUE(target_id, asset_id)
);

CREATE INDEX idx_allocation_target_asset_weights_target
ON allocation_target_asset_weights(target_id);

-- A weight can arrive before its target during sync replay. The trigger only
-- enforces the type when the target is already present, so out-of-order
-- delivery stays possible; the service validates the same rule on save.
CREATE TRIGGER allocation_target_asset_weights_type_insert
BEFORE INSERT ON allocation_target_asset_weights
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM allocation_targets
    WHERE id = NEW.target_id AND target_type <> 'asset'
)
BEGIN
    SELECT RAISE(ABORT, 'allocation_target_asset_weights require an asset target');
END;

CREATE TRIGGER allocation_target_asset_weights_type_update
BEFORE UPDATE OF target_id ON allocation_target_asset_weights
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM allocation_targets
    WHERE id = NEW.target_id AND target_type <> 'asset'
)
BEGIN
    SELECT RAISE(ABORT, 'allocation_target_asset_weights require an asset target');
END;

CREATE TRIGGER allocation_target_weights_type_insert
BEFORE INSERT ON allocation_target_weights
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM allocation_targets
    WHERE id = NEW.target_id AND target_type <> 'category'
)
BEGIN
    SELECT RAISE(ABORT, 'allocation_target_weights require a category target');
END;

CREATE TRIGGER allocation_target_weights_type_update
BEFORE UPDATE OF target_id ON allocation_target_weights
FOR EACH ROW
WHEN EXISTS (
    SELECT 1 FROM allocation_targets
    WHERE id = NEW.target_id AND target_type <> 'category'
)
BEGIN
    SELECT RAISE(ABORT, 'allocation_target_weights require a category target');
END;

CREATE TRIGGER allocation_targets_type_update
BEFORE UPDATE OF target_type ON allocation_targets
FOR EACH ROW
WHEN OLD.target_type <> NEW.target_type
    AND (
        EXISTS (
            SELECT 1 FROM allocation_target_weights
            WHERE target_id = OLD.id
        )
        OR EXISTS (
            SELECT 1 FROM allocation_target_asset_weights
            WHERE target_id = OLD.id
        )
    )
BEGIN
    SELECT RAISE(ABORT, 'allocation_targets.target_type cannot change while weights exist');
END;
