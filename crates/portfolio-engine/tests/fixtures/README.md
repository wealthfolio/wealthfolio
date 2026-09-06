# Portfolio engine fixtures

One scenario = one YAML file of **facts** under `scenarios/<family>/<ID>.yaml`.
Outputs are goldens: `goldens/kernel/<ID>.snap`, reviewed insta snapshots of
the engine. The legacy oracle goldens, the parity harness and the divergence
ledger that proved the kernel against the previous pipeline were retired after
sign-off (architecture §4.5); this repository's history keeps them.

## Running

```bash
# kernel goldens (regenerate with INSTA_UPDATE=always after reviewing the diff)
cargo test -p wealthfolio-portfolio-engine --test goldens
# property laws
cargo test -p wealthfolio-portfolio-engine --test properties
# freshness detection, and the lifecycle (LIFE) runner
cargo test -p wealthfolio-core coordinator
# one family or id-prefix list only (engine harnesses)
SCENARIO_FILTER=NOM-,EDGE-CCY cargo test -p wealthfolio-portfolio-engine
```

## Schema

```yaml
id: NOM-TRADE-01            # stable catalog id
title: one line
intent: >                   # what the scenario proves
markers: [L]                # optional: L differed from the previous engine (architecture §4.5), K kernel-only, S shell-level
policy:
  base_currency: USD
  timezone: UTC             # IANA name; default UTC
  as_of: 2025-03-05         # "today": clock is frozen here, valuations end here
accounts:
  - id: acc-1
    name: Brokerage         # default: id
    currency: USD
    account_type: SECURITIES   # SECURITIES | CASH | CREDIT_CARD | CRYPTOCURRENCY
    tracking_mode: TRANSACTIONS # TRANSACTIONS | HOLDINGS | NOT_SET
    is_archived: false
assets:
  - id: aapl
    symbol: AAPL            # default: id
    quote_ccy: USD
    kind: INVESTMENT        # INVESTMENT | PROPERTY | VEHICLE | COLLECTIBLE | PRECIOUS_METAL | OTHER | FX
    instrument_type: EQUITY # EQUITY | CRYPTO | OPTION | BOND | METAL | FX | NONE (untyped)
    contract_multiplier: 100 # optional; stored as asset metadata
    quote_mode: MARKET      # MARKET | MANUAL
activities:
  - id: buy-1
    account: acc-1
    type: BUY               # one of the 14 canonical types
    date: 2025-01-02T10:00:00Z  # RFC 3339; bare YYYY-MM-DD means 12:00 UTC.
    created_at: 2025-01-02T10:00:00Z  # optional row-creation instant (default: date).
                                # Same-instant rows fold by created_at, then id (legacy
                                # folded them in insertion order); parity scenarios keep
                                # timestamps unique because the oracle had no tiebreaker.
    asset: aapl             # optional
    quantity: 10
    unit_price: 100
    amount: 1005            # stored FINAL cash (writer output). Runtime never derives it.
    fee: 5
    tax: 0
    currency: USD           # default: account currency; may be "" for EDGE-CUR scenarios
    fx_rate: 1.35           # optional activity→account rate
    subtype: DRIP           # optional (DRIP, STAKING_REWARD, DIVIDEND_IN_KIND, BONUS, ...)
    status: POSTED          # POSTED | PENDING | DRAFT | VOID
    override: DIVIDEND      # activity_type_override
    source_group_id: g1     # transfer pairing key
    metadata: { flow: { is_external: true } }
    source_system: MANUAL
    is_user_modified: false
    updated_at: 2025-01-02T10:00:00Z  # default: date
quotes:
  - { asset: aapl, day: 2025-01-02, close: 100, currency: USD, source: MANUAL }
                            # same day, several sources: MANUAL wins, then providers, then BROKER
fx_rates:
  - { from: USD, to: CAD, day: 2025-01-02, rate: 1.35 }
observed_snapshots:         # holdings-mode facts (never rebuilt)
  - account: acc-h
    date: 2025-01-31
    source: MANUAL_ENTRY    # MANUAL_ENTRY | CSV_IMPORT | BROKER_IMPORTED
    positions: [{ asset: aapl, quantity: 10, average_cost: 90 }]
    cash: { USD: 500 }
performance_windows:        # optional dated windows; all_time is implicit
  - { label: q1, accounts: [acc-1], start: 2025-01-01, end: 2025-03-31 }
lifecycle:                  # LIFE family: mutate facts, rerun legacy recalc modes,
  - label: backdated_edit   # each step is compared with a full rebuild of the same facts
    as_of: 2025-02-01       # optional new "today"
    add_activities: []      # ActivitySpec list
    update_activities: []   # ActivitySpec list, replaces by id
    remove_activities: []   # ids
    add_quotes: []
    add_fx_rates: []
    recalc: { snapshots: SINCE_DATE, valuations: SINCE_DATE, since: 2025-01-15 }
                            # legacy recalculation modes, kept as documentation of the
                            # oracle's run; the coordinator runner applies the step's
                            # facts and runs the consistency pass (every run rebuilds
                            # from genesis), then compares with a fresh full run.
expected_notes: >
  Human-readable economics the golden must show. Reviewed, not machine-checked.
```

Numbers may be written as YAML numbers or strings; they are parsed as exact
decimals, never through `f64`.

## Golden format

Per account: keyframes (sparse), lots (open + closed), disposals, dense daily
valuations, stamped external flows, and performance per window. Portfolio:
performance per window and stamped flows. `diagnostics` (prose warnings,
not-applicable reasons, failures) is never parity-gated. Decimals are strings at
8 places, trailing zeros trimmed.

## Harnesses over these fixtures

| Harness | Where | What it checks |
| --- | --- | --- |
| Kernel goldens | `cargo test -p wealthfolio-portfolio-engine --test goldens` | Kernel output for every non-shell scenario, under `goldens/kernel/`. |
| Properties | `cargo test -p wealthfolio-portfolio-engine --test properties` | Determinism, chunk/replay equivalence, cash and lot conservation, split neutrality, transfer cancellation, an independent re-derivation of complete days from keyframes and surfaces, exact scope aggregation with ledger-classified transfer days, degradation reporting, override transparency, no panics under mutation. |
| Coordinator | `cargo test -p wealthfolio-core coordinator` | Every parity scenario through the real fact loading, row mapping and persistence, compared field by field with the kernel golden; freshness (facts, market data by content, partner legs, a new day); per-account failures (invalid snapshot dates, unsupported cost basis); the LIFE lifecycle runner (each step's incremental projection, taken through the resume and revalue paths with a two-day checkpoint cadence, equals a fresh rebuild); the plan chosen for quote changes, new days, backdated edits, deletions, forced rebuilds and retried failures. |
| SCALE-01 | `cargo bench -p wealthfolio-portfolio-engine --bench scale` | Five stages over a generated 20k-activity portfolio. |

## Verifying a fixture independently

`expected_notes` states the economics in prose; the kernel golden must show
them. For a complete day, `p_recon_complete_days_rederive_from_keyframes_and_surfaces`
recomputes the account's investment and cash values from the keyframe
positions, the latest quotes and the FX surface, so a wrong valuation cannot
hide behind the valuer's own identities. Same-instant activities fold by
`created_at`, then id; `EDGE-ORD-04` pins it.
