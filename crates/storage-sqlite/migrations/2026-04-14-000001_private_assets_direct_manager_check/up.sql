PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE private_assets RENAME TO private_assets_old;

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
    CHECK (
        (vehicle_kind = 'DIRECT' AND fund_manager_id IS NULL) OR
        (vehicle_kind <> 'DIRECT' AND fund_manager_id IS NOT NULL)
    ),
    FOREIGN KEY (fund_manager_id) REFERENCES fund_managers(id)
        ON DELETE NO ACTION
        ON UPDATE NO ACTION
);

INSERT INTO private_assets (
    id,
    name,
    fund_manager_id,
    vehicle_kind,
    strategy_type,
    currency,
    status,
    commitment_amount,
    notes,
    created_at,
    updated_at
)
SELECT
    id,
    name,
    fund_manager_id,
    vehicle_kind,
    strategy_type,
    currency,
    status,
    commitment_amount,
    notes,
    created_at,
    updated_at
FROM private_assets_old;

DROP TABLE private_assets_old;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
