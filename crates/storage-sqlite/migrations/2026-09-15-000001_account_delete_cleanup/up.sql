-- A missing account can be a sync parent that has not arrived yet. Preserve
-- source snapshots unless the account has a deletion tombstone; calculated
-- snapshots and daily valuations are rebuildable local data.
DELETE FROM holdings_snapshots
WHERE account_id NOT IN (SELECT id FROM accounts)
  AND (
      source = 'CALCULATED'
      OR account_id IN (
          SELECT entity_id FROM sync_entity_metadata
          WHERE entity = 'account' AND last_op = 'delete'
      )
  );

-- Migration connections disable foreign keys, so clean position rows explicitly.
DELETE FROM snapshot_positions
WHERE snapshot_id NOT IN (SELECT id FROM holdings_snapshots);

DELETE FROM daily_account_valuation
WHERE account_id NOT IN (SELECT id FROM accounts);

-- Only remove source configuration for confirmed account deletions.
DELETE FROM import_account_templates
WHERE account_id IN (
    SELECT entity_id FROM sync_entity_metadata
    WHERE entity = 'account' AND last_op = 'delete'
      AND entity_id NOT IN (SELECT id FROM accounts)
);

-- Foreign keys are disabled during migrations; delete children before targets.
DELETE FROM allocation_target_weights
WHERE target_id IN (
    SELECT id FROM allocation_targets
    WHERE scope_type = 'account' AND scope_id IN (
        SELECT entity_id FROM sync_entity_metadata
        WHERE entity = 'account' AND last_op = 'delete'
          AND entity_id NOT IN (SELECT id FROM accounts)
    )
);

DELETE FROM allocation_target_constraints
WHERE target_id IN (
    SELECT id FROM allocation_targets
    WHERE scope_type = 'account' AND scope_id IN (
        SELECT entity_id FROM sync_entity_metadata
        WHERE entity = 'account' AND last_op = 'delete'
          AND entity_id NOT IN (SELECT id FROM accounts)
    )
) OR (subject_type = 'account' AND subject_id IN (
    SELECT entity_id FROM sync_entity_metadata
    WHERE entity = 'account' AND last_op = 'delete'
      AND entity_id NOT IN (SELECT id FROM accounts)
));

DELETE FROM allocation_targets
WHERE scope_type = 'account' AND scope_id IN (
    SELECT entity_id FROM sync_entity_metadata
    WHERE entity = 'account' AND last_op = 'delete'
      AND entity_id NOT IN (SELECT id FROM accounts)
);
