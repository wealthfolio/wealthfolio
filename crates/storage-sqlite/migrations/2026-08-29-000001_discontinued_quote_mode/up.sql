-- Add DISCONTINUED as a valid quote_mode value.
-- SQLite does not support ALTER TABLE ... DROP CONSTRAINT, so we recreate the table.

PRAGMA legacy_alter_table = ON;
PRAGMA foreign_keys = OFF;

CREATE TABLE assets_new (
    id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || '4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),

    kind TEXT NOT NULL,
    name TEXT,
    display_code TEXT,
    notes TEXT,
    metadata TEXT,

    is_active INTEGER NOT NULL DEFAULT 1,

    quote_mode TEXT NOT NULL,
    quote_ccy TEXT NOT NULL,

    instrument_type TEXT,
    instrument_symbol TEXT,
    instrument_exchange_mic TEXT,

    instrument_key TEXT GENERATED ALWAYS AS (
        CASE
            WHEN instrument_type IS NULL OR instrument_symbol IS NULL THEN NULL
            WHEN instrument_type IN ('FX', 'CRYPTO')
                THEN instrument_type || ':' || instrument_symbol || '/' || quote_ccy
            WHEN instrument_exchange_mic IS NOT NULL
                THEN instrument_type || ':' || instrument_symbol || '@' || instrument_exchange_mic
            ELSE instrument_type || ':' || instrument_symbol
        END
    ) STORED,

    provider_config TEXT,

    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CHECK (kind IN (
        'INVESTMENT',
        'PROPERTY', 'VEHICLE', 'COLLECTIBLE', 'PRECIOUS_METAL',
        'PRIVATE_EQUITY', 'LIABILITY', 'OTHER',
        'FX'
    )),
    CHECK (quote_mode IN ('MARKET', 'MANUAL', 'DISCONTINUED')),
    CHECK (is_active IN (0, 1)),
    CHECK (metadata IS NULL OR json_valid(metadata)),
    CHECK (provider_config IS NULL OR json_valid(provider_config))
);

INSERT INTO assets_new (
    id, kind, name, display_code, notes, metadata,
    is_active, quote_mode, quote_ccy,
    instrument_type, instrument_symbol, instrument_exchange_mic,
    provider_config, created_at, updated_at
)
SELECT
    id, kind, name, display_code, notes, metadata,
    is_active, quote_mode, quote_ccy,
    instrument_type, instrument_symbol, instrument_exchange_mic,
    provider_config, created_at, updated_at
FROM assets;

DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;

CREATE INDEX idx_assets_kind ON assets(kind);
CREATE INDEX idx_assets_is_active ON assets(is_active);
CREATE INDEX idx_assets_display_code ON assets(display_code);

PRAGMA foreign_keys = ON;
