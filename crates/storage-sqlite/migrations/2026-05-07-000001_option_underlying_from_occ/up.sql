-- ----------------------------------------------------------------------------
-- Backfill OptionSpec.underlyingAssetSymbol from the OCC symbol when missing.
-- ----------------------------------------------------------------------------
--
-- The previous migration (2026-05-06-000001) renamed underlyingAssetId →
-- underlyingAssetSymbol but only ran on rows where underlyingAssetId existed.
-- Some upstream code paths created OPTION assets with the new field name
-- already present but blank (`underlyingAssetSymbol = ""`), so neither the
-- rename nor the resolved-id backfill ever fired for them.
--
-- This migration:
--   1. Populates underlyingAssetSymbol from the OCC symbol when empty/null.
--      The OCC format is `{underlying}{YYMMDD}{C|P}{strike8}` — the trailing
--      15 characters are fixed, so the underlying ticker is the prefix
--      before that. Whitespace-padded OCC (e.g. "MU    270115C00560000") is
--      handled by TRIMing the result.
--   2. Re-runs the underlyingResolvedId backfill so newly-populated symbols
--      now match against existing equity records.
-- ----------------------------------------------------------------------------

UPDATE assets
SET metadata = json_set(
    metadata,
    '$.option.underlyingAssetSymbol',
    TRIM(SUBSTR(instrument_symbol, 1, LENGTH(instrument_symbol) - 15))
)
WHERE instrument_type = 'OPTION'
  AND instrument_symbol IS NOT NULL
  AND LENGTH(instrument_symbol) > 15
  AND COALESCE(json_extract(metadata, '$.option.underlyingAssetSymbol'), '') = '';

-- Some upstream code paths created OPTION assets with the space-padded
-- 21-char OCC form (e.g. "MU    270115C00560000") in addition to the
-- compact form. The normalized compact rows carry all activities, lots,
-- and positions; the padded rows are pure orphans. Delete them.
DELETE FROM assets
WHERE instrument_type = 'OPTION'
  AND instrument_symbol LIKE '%  %'  -- two consecutive spaces (OCC padding)
  AND id NOT IN (SELECT DISTINCT asset_id FROM activities WHERE asset_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT asset_id FROM lots WHERE asset_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT asset_id FROM snapshot_positions WHERE asset_id IS NOT NULL);

-- Re-run the resolved-id backfill for any options that still lack one.
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
  AND COALESCE(json_extract(metadata, '$.option.underlyingAssetSymbol'), '') != ''
  AND COALESCE(json_extract(metadata, '$.option.underlyingResolvedId'), '') = ''
  AND (
      SELECT MIN(eq.id)
      FROM assets eq
      WHERE eq.instrument_type = 'EQUITY'
        AND eq.instrument_symbol = json_extract(assets.metadata, '$.option.underlyingAssetSymbol')
        AND (
            eq.instrument_exchange_mic IN ('XNAS', 'XNYS', 'XASE', 'ARCX', 'BATS')
            OR eq.instrument_exchange_mic IS NULL
        )
  ) IS NOT NULL;
