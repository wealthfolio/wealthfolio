-- Restore the legacy value on rollback. The collision guard avoids rewriting a
-- canonical row when an XAQE twin already exists.
UPDATE assets
SET instrument_exchange_mic = 'XAQE'
WHERE UPPER(instrument_exchange_mic) = 'AQSE'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@XAQE'
  );
