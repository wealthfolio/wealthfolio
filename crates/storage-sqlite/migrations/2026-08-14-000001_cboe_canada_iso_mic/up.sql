-- Cboe Canada's ISO 10383 MIC is NEOE. `XNEO` was never an ISO code — the
-- exchange registry invented it — so the registry now spells the `.NE` venue
-- NEOE, and rows left under XNEO would match no registry entry: no exchange
-- name, no trading currency, no provider suffix for quote lookups. Worse, the
-- next broker sync resolves the same instrument to NEOE and files a second asset
-- row beside the stale one.
--
-- `instrument_key` embeds the MIC (`EQUITY:VBU@XNEO`) but is a STORED generated
-- column, so SQLite recomputes it from the MIC written here.
UPDATE assets
SET instrument_exchange_mic = 'NEOE'
WHERE UPPER(instrument_exchange_mic) = 'XNEO'
  -- Rows whose NEOE twin already exists are left alone. An account synced before
  -- this fix could hold both — activities resolved the broker's own `NEOE` while
  -- positions derived XNEO from the `.NE` suffix — and the recomputed key would
  -- collide with `idx_assets_instrument_key`, failing the migration. Merging two
  -- asset rows is not something this migration can do safely: activities,
  -- quotes, lots and snapshots reference the ids separately. The XNEO row simply
  -- stops being resolved once syncing continues under the real MIC.
  --
  -- Only the `@MIC` key form can collide. FX and CRYPTO keys carry the quote
  -- currency instead of a MIC, so their key does not change here, and a NULL
  -- instrument type or symbol makes the comparison NULL and matches nothing.
  AND NOT EXISTS (
    SELECT 1
    FROM assets twin
    WHERE twin.instrument_key =
        assets.instrument_type || ':' || assets.instrument_symbol || '@NEOE'
  );
