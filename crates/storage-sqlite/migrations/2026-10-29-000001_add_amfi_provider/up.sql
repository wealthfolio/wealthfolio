-- AMFI NAVs for Indian mutual funds. Disabled until the user turns it on, and
-- then used only for funds that choose AMFI or have an AMFI symbol mapping.
INSERT OR IGNORE INTO market_data_providers (id, name, description, url, priority, enabled, logo_filename, last_synced_at, last_sync_status, last_sync_error)
VALUES
    ('AMFI', 'AMFI', 'Daily NAVs for Indian mutual funds from AMFI (Association of Mutual Funds in India). Used only for funds that choose AMFI or have an AMFI symbol mapping, identified by ISIN or AMFI scheme code. No API key required.', 'https://www.amfiindia.com/', 15, FALSE, NULL, NULL, NULL, NULL);
