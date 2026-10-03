# Exchange catalog

Wealthfolio keeps two exchange datasets with separate responsibilities:

- `iso10383.json` is the complete ISO 10383 identity snapshot. Runtime exchange
  pickers expose its `ACTIVE` and `UPDATED` records, while expired records
  remain available for historical identity and provenance.
- `exchanges.json` contains only Wealthfolio metadata and provider routing
  rules. A missing provider rule must not prevent an ISO exchange from being
  selected or stored. It only prevents an automatic provider request until
  search supplies an exact `providerId` and `providerSymbol` override.

The provider catalog is curated, not exhaustive. Expand it when a provider's
symbol convention is verified; one exchange can have rules for several
providers. Use an exact per-asset provider symbol override when a listing needs
a different symbol. Neither a missing catalog entry nor an unknown suffix
justifies guessing a venue: `ABC.ZZ` without an explicit MIC keeps the key
`EQUITY:ABC.ZZ`.

One guarded data migration corrects known legacy MIC aliases without changing
asset IDs. It skips collisions instead of combining financial histories. Profile
edits preserve the stored identity unless the user changes an identity field. An
explicit exchange correction normalizes the MIC and fails clearly if another
asset already owns the resulting key; it never silently keeps the old exchange.

Refresh the ISO snapshot from a saved release file or the official URL and pin
the source bytes by SHA-256. For the snapshot checked in on 2026-09-24, the
exact command is:

```sh
node scripts/update-iso10383.mjs \
  --source https://www.iso20022.org/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv \
  --expected-sha256 79de0f7704e260bd49b0d2439f3084891cabc93481da8bdbaa716e15a27211ed \
  --publication-date 2026-09-14 \
  --implementation-date 2026-09-28
```

When the official mutable URL advances, download and retain the release CSV
while reviewing the change, then run the same command with
`--source path/to/release.csv` and the checksum of that file. The updater
rejects a checksum mismatch before it writes the generated JSON.
