CREATE TABLE fund_managers (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    notes       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE private_assets (
    id                  TEXT NOT NULL PRIMARY KEY,
    name                TEXT NOT NULL,
    fund_manager_id     TEXT,
    vehicle_kind        TEXT NOT NULL CHECK (vehicle_kind IN (
        'FUND',
        'CO_INVESTMENT',
        'DIRECT',
        'REAL_ESTATE',
        'OTHER'
    )),
    strategy_type       TEXT NOT NULL CHECK (strategy_type IN (
        'VENTURE',
        'PRIVATE_EQUITY',
        'HEDGE_FUND',
        'PRIVATE_CREDIT',
        'FUND_OF_FUNDS',
        'ENERGY',
        'REAL_ESTATE',
        'OTHER'
    )),
    currency            TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN (
        'ACTIVE',
        'REALIZED',
        'ARCHIVED'
    )),
    commitment_amount   TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    FOREIGN KEY (fund_manager_id) REFERENCES fund_managers(id)
        ON DELETE NO ACTION
        ON UPDATE NO ACTION
);

CREATE TABLE private_sub_assets (
    id                  TEXT NOT NULL PRIMARY KEY,
    private_asset_id    TEXT NOT NULL,
    name                TEXT NOT NULL,
    reporting_basis     TEXT NOT NULL CHECK (reporting_basis IN (
        'UNKNOWN',
        'GROSS',
        'NET'
    )),
    strategy_type       TEXT CHECK (strategy_type IN (
        'VENTURE',
        'PRIVATE_EQUITY',
        'HEDGE_FUND',
        'PRIVATE_CREDIT',
        'FUND_OF_FUNDS',
        'ENERGY',
        'REAL_ESTATE',
        'OTHER'
    )),
    cost_basis          TEXT,
    current_value       TEXT,
    ownership_percent   TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    FOREIGN KEY (private_asset_id) REFERENCES private_assets(id)
        ON DELETE NO ACTION
        ON UPDATE NO ACTION
);

CREATE TABLE private_snapshots (
    id                  TEXT NOT NULL PRIMARY KEY,
    private_asset_id    TEXT NOT NULL,
    contributed_amount  TEXT NOT NULL,
    distributed_amount  TEXT NOT NULL,
    current_value       TEXT NOT NULL,
    as_of_date          DATE NOT NULL,
    value_source_type   TEXT NOT NULL CHECK (value_source_type IN (
        'MANUAL',
        'STATEMENT',
        'ESTIMATED'
    )),
    notes               TEXT,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (private_asset_id) REFERENCES private_assets(id)
        ON DELETE NO ACTION
        ON UPDATE NO ACTION
);
