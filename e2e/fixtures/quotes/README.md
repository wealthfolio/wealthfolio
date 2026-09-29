# E2e Market Data Fixtures

The e2e fixture provider reads `instruments.json` and generates deterministic
synthetic OHLCV quotes at runtime. No real market-data rows are stored here.

- `instruments.json`: synthetic provider metadata for search, profile, quote
  currency, and quote generation, including a corporate bond with an ISIN and
  fraction-of-par prices through `BOERSE_FRANKFURT`. Börse profiles do not
  supply bond terms; unknown coupon and maturity fields stay unknown.
- `treasury-securities.json`: synthetic TreasuryDirect-shaped responses for a
  bill, note, bond, TIPS, and FRN. Identifiers match the live spec, but these
  terms are deliberately synthetic and must not be treated as real security
  data.
- `treasury-yield-curves.xml`: synthetic Treasury.gov-shaped responses for May
  11–12, 2026. A flat 4% yield curve makes the 4% note price at par; the bill
  and 5% bond have independently specified expected prices.
- `WEALTHFOLIO_FIXTURE_AS_OF`: optional latest-quote date and Treasury history
  cutoff. Defaults to `2026-05-12`; set to `today` for local exploratory runs.

Search results, profiles, latest quotes, historical quotes, and splits all use
the same instrument metadata, so currencies and symbols stay consistent.

## Provider Contract

The e2e runner sets `WEALTHFOLIO_E2E=1` and `WEALTHFOLIO_FIXTURE_DIR` before
starting `dev:web`. In that mode:

- `YAHOO` is replaced by the fixture provider backed by `instruments.json`.
- `BOERSE_FRANKFURT` is replaced by the same fixture provider, reporting itself
  as `BOERSE_FRANKFURT`.
- `US_TREASURY_CALC` uses the production provider with the local security and
  yield responses. Its parsing, nominal-term validation, and pricing remain
  real. Missing fixture securities or years fail without an HTTP fallback.
  Latest quotes default to the last fixture curve date, with the same
  `WEALTHFOLIO_FIXTURE_AS_OF` override as the other fixture providers.
- Other built-in market-data providers are disabled instead of being allowed to
  hit the network.
- Extra/custom providers are skipped for the same reason.

If a spec needs another provider, add explicit fixture support first. E2e runs
should fail closed instead of silently reaching real market-data services.

The regular bond spec uses activities dated May 11, 2026, so Treasury history
comes from the fixed curves. TIPS and FRNs receive profiles but no nominal
Treasury quote. Corporate quotes retain the existing deterministic OHLCV
generator and are never attributed to `US_TREASURY_CALC`.

FX pairs found in e2e runs are explicitly listed for the CAD, USD, EUR, and GBP
lanes. The provider also generates deterministic FX quotes for missing
Yahoo-shaped or slash-shaped pairs such as `CADUSD=X` or `CAD/USD`.

Custom/manual symbols and expected invalid mappings are intentionally not
listed: `MYASSET`, `MYCOIN`, `TESTASSET01`, `INVALID_TICKER_XYZ_E2E`, and
`INVALID_BF_XYZ_E2E`.
