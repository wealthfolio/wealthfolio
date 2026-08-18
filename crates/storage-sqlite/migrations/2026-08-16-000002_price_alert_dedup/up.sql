CREATE TEMP TABLE duplicate_price_alert_ids (id TEXT PRIMARY KEY NOT NULL);

INSERT INTO duplicate_price_alert_ids (id)
SELECT duplicate.id
FROM price_alerts AS duplicate
WHERE EXISTS (
    SELECT 1
    FROM price_alerts AS keeper
    WHERE keeper.asset_id = duplicate.asset_id
      AND keeper.condition = duplicate.condition
      AND keeper.target_price = duplicate.target_price
      AND (
          keeper.created_at < duplicate.created_at
          OR (keeper.created_at = duplicate.created_at AND keeper.id < duplicate.id)
      )
);

DELETE FROM price_alert_events
WHERE alert_id IN (SELECT id FROM duplicate_price_alert_ids);

DELETE FROM price_alerts
WHERE id IN (SELECT id FROM duplicate_price_alert_ids);

DROP TABLE duplicate_price_alert_ids;

CREATE UNIQUE INDEX price_alerts_unique_target_idx
    ON price_alerts(asset_id, condition, target_price);
