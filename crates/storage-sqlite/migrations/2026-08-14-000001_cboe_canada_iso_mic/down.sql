-- Restore the pre-ISO spelling, so the data round-trips with a downgraded app
-- whose exchange registry still calls Cboe Canada XNEO. Same collision guard as
-- the up migration, in the other direction.
UPDATE assets
SET instrument_exchange_mic = 'XNEO'
WHERE UPPER(instrument_exchange_mic) = 'NEOE'
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@XNEO'
  );
