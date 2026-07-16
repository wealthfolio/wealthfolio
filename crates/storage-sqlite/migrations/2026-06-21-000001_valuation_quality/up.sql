ALTER TABLE daily_account_valuation
ADD COLUMN value_status TEXT NOT NULL DEFAULT 'COMPLETE';

ALTER TABLE daily_account_valuation
ADD COLUMN basis_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';

-- Synthetic holdings snapshots were a chart backfill workaround. They clone real
-- holdings into dates before the account actually held them, so remove them
-- before rebuilding valuation history.
DELETE FROM snapshot_positions
WHERE snapshot_id IN (
    SELECT id FROM holdings_snapshots WHERE source = 'SYNTHETIC'
);

DELETE FROM sync_outbox
WHERE entity = 'snapshot'
  AND entity_id IN (
      SELECT id FROM holdings_snapshots WHERE source = 'SYNTHETIC'
  );

DELETE FROM sync_entity_metadata
WHERE entity = 'snapshot'
  AND entity_id IN (
      SELECT id FROM holdings_snapshots WHERE source = 'SYNTHETIC'
  );

DELETE FROM holdings_snapshots
WHERE source = 'SYNTHETIC';

-- Daily valuations are generated read models. Rebuild them with explicit value
-- and basis coverage instead of relying on implicit zero-valued missing quotes.
DELETE FROM daily_account_valuation;
