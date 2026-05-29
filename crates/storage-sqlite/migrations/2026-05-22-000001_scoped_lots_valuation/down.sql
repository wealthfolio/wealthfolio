DROP INDEX IF EXISTS idx_daily_account_valuation_account_date;

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
    calculated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_account_valuation_account_date
    ON daily_account_valuation(account_id, valuation_date);
