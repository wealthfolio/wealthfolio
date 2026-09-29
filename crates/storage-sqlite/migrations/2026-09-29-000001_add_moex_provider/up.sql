-- Moscow Exchange (MISX) quotes via the public ISS API. The quote client only
-- builds providers that have a row here, so the provider needs one to exist.
INSERT OR IGNORE INTO market_data_providers (id, name, description, url, priority, enabled, logo_filename, last_synced_at, last_sync_status, last_sync_error)
VALUES
    ('MOEX', 'Moscow Exchange', 'Moscow Exchange ISS provides delayed and end-of-day prices for shares, depositary receipts and ETFs traded on MOEX. No API key required.', 'https://www.moex.com/', 14, TRUE, NULL, NULL, NULL, NULL);
