-- Three exchange-registry keys were never ISO 10383 MICs. The registry invented
-- them, so rows stored under them match no registry entry once the catalog is
-- keyed correctly: no exchange name, no trading currency, no provider suffix for
-- quote lookups. Worse, the next broker sync resolves the same instrument to the
-- real MIC and files a second asset row beside the stale one.
--
--   CXE      -> BCXE  Cboe Europe Equities (GB)
--   DXE      -> CCXE  Cboe Europe Equities - European Equities (NL)
--   XTAI_OTC -> ROCO  Taipei Exchange (TW)
--
-- All three confirmed ACTIVE operating MICs in the published ISO 10383 list.
--
-- `instrument_key` embeds the MIC (`EQUITY:VWRP@CXE`) but is a STORED generated
-- column, so SQLite recomputes it from the MIC written here.
--
-- Each statement carries the same collision guard as the NEOE migration: a row
-- whose correctly-spelled twin already exists is left alone, because the
-- recomputed key would collide with `idx_assets_instrument_key` and fail the
-- migration. Merging two asset rows is not something a migration can do safely
-- - activities, quotes, lots and snapshots reference the ids separately - so the
-- stale row simply stops being resolved once syncing continues under the real
-- MIC. Only the `@MIC` key form can collide; FX and CRYPTO keys carry the quote
-- currency instead, and a NULL instrument type or symbol makes the comparison
-- NULL and matches nothing.

UPDATE assets
SET instrument_exchange_mic = 'BCXE'
WHERE UPPER(instrument_exchange_mic) = 'CXE'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@BCXE'
  );

UPDATE assets
SET instrument_exchange_mic = 'CCXE'
WHERE UPPER(instrument_exchange_mic) = 'DXE'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@CCXE'
  );

UPDATE assets
SET instrument_exchange_mic = 'ROCO'
WHERE UPPER(instrument_exchange_mic) = 'XTAI_OTC'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@ROCO'
  );
