-- Reverse: drop underlyingResolvedId and rename underlyingAssetSymbol back to underlyingAssetId.
UPDATE assets
SET metadata = json_remove(metadata, '$.option.underlyingResolvedId')
WHERE instrument_type = 'OPTION'
  AND json_extract(metadata, '$.option.underlyingResolvedId') IS NOT NULL;

UPDATE assets
SET metadata = json_set(
    json_remove(metadata, '$.option.underlyingAssetSymbol'),
    '$.option.underlyingAssetId',
    json_extract(metadata, '$.option.underlyingAssetSymbol')
)
WHERE instrument_type = 'OPTION'
  AND json_extract(metadata, '$.option.underlyingAssetSymbol') IS NOT NULL;
