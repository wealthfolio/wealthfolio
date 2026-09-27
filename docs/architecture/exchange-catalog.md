# Exchange catalog

Wealthfolio keeps two exchange datasets with separate responsibilities:

- `iso10383.json` is the complete ISO 10383 identity snapshot. Runtime exchange
  pickers expose its `ACTIVE` and `UPDATED` records, while expired records
  remain available for historical identity and provenance.
- `exchanges.json` contains only Wealthfolio metadata and provider routing
  rules. A missing provider rule must not prevent an ISO exchange from being
  selected or stored. It only prevents an automatic provider request until
  search supplies an exact `providerId` and `providerSymbol` override.

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
