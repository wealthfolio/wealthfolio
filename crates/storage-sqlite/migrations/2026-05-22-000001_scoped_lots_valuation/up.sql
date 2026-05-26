-- Scoped valuation rollout:
-- - normalize legacy holdings-mode calculated snapshots to user-managed snapshots
-- - remove orphaned derived snapshot rows
-- - recreate the unsynced derived valuation table with base-currency fields

UPDATE holdings_snapshots
SET source = 'MANUAL_ENTRY'
WHERE source = 'CALCULATED'
  AND account_id IN (
      SELECT id
      FROM accounts
      WHERE tracking_mode = 'HOLDINGS'
  );

DELETE FROM snapshot_positions
WHERE snapshot_id IN (
    SELECT id
    FROM holdings_snapshots
    WHERE account_id NOT IN (SELECT id FROM accounts)
);

DELETE FROM holdings_snapshots
WHERE account_id NOT IN (SELECT id FROM accounts);

DROP TABLE IF EXISTS daily_account_valuation;

CREATE TABLE daily_account_valuation (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    valuation_date DATE NOT NULL,
    account_currency TEXT NOT NULL,
    base_currency TEXT NOT NULL,
    fx_rate_to_base TEXT NOT NULL,
    cash_balance TEXT NOT NULL,
    investment_market_value TEXT NOT NULL,
    total_value TEXT NOT NULL,
    cost_basis TEXT NOT NULL,
    net_contribution TEXT NOT NULL,
    cash_balance_base TEXT NOT NULL DEFAULT '0',
    investment_market_value_base TEXT NOT NULL DEFAULT '0',
    total_value_base TEXT NOT NULL DEFAULT '0',
    cost_basis_base TEXT NOT NULL DEFAULT '0',
    net_contribution_base TEXT NOT NULL DEFAULT '0',
    external_inflow_base TEXT NOT NULL DEFAULT '0',
    external_outflow_base TEXT NOT NULL DEFAULT '0',
    performance_eligible_value_base TEXT NOT NULL DEFAULT '0',
    calculated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_account_valuation_account_date
    ON daily_account_valuation(account_id, valuation_date);
