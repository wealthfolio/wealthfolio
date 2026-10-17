-- Add FXMacroData as an FX rate provider (requires an API key)
INSERT OR IGNORE INTO market_data_providers (id, name, description, url, priority, enabled, logo_filename, last_synced_at, last_sync_status, last_sync_error)
VALUES
    ('FXMACRODATA', 'FXMacroData', 'Provides daily FX rates built from official central-bank reference rates.', 'https://fxmacrodata.com/', 14, FALSE, NULL, NULL, NULL, NULL);
