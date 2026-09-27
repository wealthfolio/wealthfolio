-- XAQE was a Wealthfolio-specific identifier for Aquis Stock Exchange. ISO
-- 10383 assigns that operating market the active MIC AQSE. Keep a legacy row
-- only when its canonical twin already owns the generated instrument key; the
-- application continues resolving that guarded row through the XAQE -> AQSE
-- runtime alias until the user explicitly reconciles their histories.
UPDATE assets
SET instrument_exchange_mic = 'AQSE'
WHERE UPPER(instrument_exchange_mic) = 'XAQE'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@AQSE'
  );
