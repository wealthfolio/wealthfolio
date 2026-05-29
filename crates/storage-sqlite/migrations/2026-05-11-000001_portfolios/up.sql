CREATE TABLE portfolios (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX idx_portfolios_name_unique
ON portfolios(lower(trim(name)));

CREATE TABLE portfolio_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    portfolio_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (portfolio_id)
        REFERENCES portfolios(id)
        ON DELETE CASCADE,
    FOREIGN KEY (account_id)
        REFERENCES accounts(id)
        ON DELETE CASCADE,
    UNIQUE(portfolio_id, account_id)
);

CREATE INDEX idx_portfolio_accounts_portfolio
ON portfolio_accounts(portfolio_id, sort_order);

CREATE INDEX idx_portfolio_accounts_account
ON portfolio_accounts(account_id);
