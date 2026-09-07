-- Restore the pre-ISO spellings, so the data round-trips with a downgraded app
-- whose exchange registry still uses the invented keys. Same collision guard as
-- the up migration, in the other direction.

UPDATE assets
SET instrument_exchange_mic = 'CXE'
WHERE UPPER(instrument_exchange_mic) = 'BCXE'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@CXE'
  );

UPDATE assets
SET instrument_exchange_mic = 'DXE'
WHERE UPPER(instrument_exchange_mic) = 'CCXE'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@DXE'
  );

UPDATE assets
SET instrument_exchange_mic = 'XTAI_OTC'
WHERE UPPER(instrument_exchange_mic) = 'ROCO'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@XTAI_OTC'
  );
