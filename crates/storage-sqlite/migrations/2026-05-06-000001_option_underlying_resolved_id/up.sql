-- ----------------------------------------------------------------------------
-- OptionSpec metadata: rename underlyingAssetId → underlyingAssetSymbol,
-- add underlyingResolvedId pointing at the equity asset_id when resolvable.
-- ----------------------------------------------------------------------------
--
-- Pre-migration shape:
--   metadata.option = {
--     underlyingAssetId: "MU",  -- (mis-named; always held the symbol)
--     expiration, right, strike, multiplier, occSymbol
--   }
--
-- Post-migration shape:
--   metadata.option = {
--     underlyingAssetSymbol: "MU",
--     underlyingResolvedId: "<equity asset_id>" | (absent),
--     expiration, right, strike, multiplier, occSymbol
--   }
--
-- The resolved id is back-filled by joining on instrument_symbol against the
-- assets table, preferring exchange-MIC matches against US venues, then a
-- no-MIC fallback. Options whose underlying isn't in the user's DB get no
-- resolvedId — assets_service back-fills them when the underlying is added.
-- ----------------------------------------------------------------------------

-- Step 1: rename the JSON key on every OPTION asset.
UPDATE assets
SET metadata = json_set(
    json_remove(metadata, '$.option.underlyingAssetId'),
    '$.option.underlyingAssetSymbol',
    json_extract(metadata, '$.option.underlyingAssetId')
)
WHERE instrument_type = 'OPTION'
  AND json_extract(metadata, '$.option.underlyingAssetId') IS NOT NULL;

-- Step 2: back-fill underlyingResolvedId where the underlying equity exists.
-- Match priority: equity with the same instrument_symbol on a major US MIC,
-- falling back to no-MIC. Picks the first match per (option, symbol) via MIN().
UPDATE assets
SET metadata = json_set(
    metadata,
    '$.option.underlyingResolvedId',
    (
        SELECT MIN(eq.id)
        FROM assets eq
        WHERE eq.instrument_type = 'EQUITY'
          AND eq.instrument_symbol = json_extract(assets.metadata, '$.option.underlyingAssetSymbol')
          AND (
              eq.instrument_exchange_mic IN ('XNAS', 'XNYS', 'XASE', 'ARCX', 'BATS')
              OR eq.instrument_exchange_mic IS NULL
          )
    )
)
WHERE instrument_type = 'OPTION'
  AND json_extract(metadata, '$.option.underlyingAssetSymbol') IS NOT NULL
  AND (
      SELECT MIN(eq.id)
      FROM assets eq
      WHERE eq.instrument_type = 'EQUITY'
        AND eq.instrument_symbol = json_extract(assets.metadata, '$.option.underlyingAssetSymbol')
        AND eq.is_active = 1
        AND (
            eq.instrument_exchange_mic IN ('XNAS', 'XNYS', 'XASE', 'ARCX', 'BATS')
            OR eq.instrument_exchange_mic IS NULL
        )
  ) IS NOT NULL;
