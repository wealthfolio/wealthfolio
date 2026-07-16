# Performance Semantics Design: Transfers, Holdings Mode, and Dashboard Returns

- Date: 2026-06-17
- Status: target design plus current branch implementation notes
- Primary input: GitHub issue #1119, local reproduction data, v3.5.2 versus
  `origin/main`, and current code. Examples below use synthetic account names
  and rounded fixture values.

## Executive Summary

This is not one isolated calculation bug. It is a semantics gap between the
product model, the stored data model, and the dashboard presentation model.

The current code has two visible tracking modes: transaction-derived holdings
and manually entered/imported holdings. That split is reasonable. The problem is
that the two modes do not have separate enough economics:

- Holdings mode should be current-state plus cost-basis reporting.
- Transaction mode should be cash-flow performance reporting.
- Transfer-only transaction workflows should support in-kind securities without
  forcing users to manage cash.

Today, external security transfers and holdings snapshots reuse fields whose
meanings overlap:

- `unit_price` can mean trade price, transfer cost basis, or fallback quote.
- `amount` can mean cash amount, total market value, broker net amount, or, for
  non-buy/sell activities, authoritative lot cost.
- `net_contribution_base` is used as a performance fallback, but holdings
  snapshots often persist it as zero even when the user supplied
  `quantity * average cost` and cash.
- `external_inflow_base` and `external_outflow_base` exist on valuation rows,
  but their source does not encode whether the amount was a true cash flow, a
  security fair market value, or a degraded fallback.

The result is predictable:

- Holdings accounts can enter portfolio history with real value and zero
  invested-capital basis.
- Transfer-only transaction accounts work structurally, but external in-kind
  transfers use cost basis as performance flow value unless `amount` is present,
  and if `amount` is present it can corrupt lot cost basis.
- Mixed portfolio dashboards can show a dollar P&L and a percent return computed
  from different concepts.
- The health center warning detects residual imbalance but does not identify the
  accounts, dates, or missing semantics that caused it.

The target design is to keep the existing modes, but make their economics
explicit without adding derived source columns:

- Holdings snapshots store source facts: quantity, average cost/cost basis, and
  cash. The compiler derives book basis as `cost_basis + cash`.
- Holdings mode reports current value, cost basis/invested capital, unrealized
  P&L, and gain versus cost. It does not pretend to have audited cash-flow
  performance.
- Transaction mode keeps TWR/IRR when flows are known.
- External security transfers/deliveries separate tax/book cost basis from
  transfer-date market value in the calculation model. Transfer-date market
  value is derived from quotes by default, not normally entered by the user.
- Return method and data quality are displayed instead of inferred by frontend
  helpers.

This also means external `TRANSFER_IN` and `TRANSFER_OUT` should be handled
differently for transaction-mode performance, not as a new transaction type, but
through a richer economics compiler and finalizer.

## Release And Main Status

I compared the released v3.5.2 code path with `origin/main`. `origin/main`
contains backend current-valuation work, but I did not find a fix in the
historical performance, holdings snapshot, transfer, or holdings percentage
semantics paths described here. The relevant main changes for the issue symptoms
are mostly dashboard/current-valuation presentation work, not a historical
performance correction.

Implication: fixing issue #1119 requires domain and data-contract changes, not
just a rebuild or frontend patch.

## Evidence From The Issue And Local Database

The latest user comment on issue #1119 narrows the problem:

- The `+42.49%%` was on the main dashboard and later disappeared.
- The generic "Performance attribution is incomplete" warning also disappeared.
- Calculation issues remain.
- The user's history is transfer-heavy because they do not manage cash.
- The user found negative zero cash snapshots and a cash-only transfer-out case
  where absolute gain and relative return have opposite signs.

Local reproduction data shows the same pattern at larger scale:

- Latest total value is materially higher than latest net contribution.
- Multiple holdings-mode accounts have nonzero market value but zero
  invested-capital basis.
- The first aggregate history point is much smaller than later portfolio value,
  so all-time percent can become thousands of percent when holdings accounts
  enter with value but zero invested-capital basis.

Synthetic example from latest valuations:

| Account               | Mode         | Latest value | Net contribution | Implied P&L |
| --------------------- | ------------ | -----------: | ---------------: | ----------: |
| Holdings Account A    | HOLDINGS     |   100,000.00 |             0.00 |  100,000.00 |
| Holdings Account B    | HOLDINGS     |    85,000.00 |             0.00 |   85,000.00 |
| Holdings Account C    | HOLDINGS     |    75,000.00 |             0.00 |   75,000.00 |
| Transaction Account D | TRANSACTIONS |   140,000.00 |        95,000.00 |   45,000.00 |
| Transaction Account E | TRANSACTIONS |    60,000.00 |        40,000.00 |   20,000.00 |

Synthetic example from each account's first valuation row:

| Account               | Mode         | First date | First value | Net contribution | External inflow | Source           |
| --------------------- | ------------ | ---------- | ----------: | ---------------: | --------------: | ---------------- |
| Holdings Account A    | HOLDINGS     | 2025-01-01 |  100,000.00 |             0.00 |            0.00 | ACTIVITY_DERIVED |
| Holdings Account B    | HOLDINGS     | 2025-03-01 |   85,000.00 |             0.00 |            0.00 | ACTIVITY_DERIVED |
| Holdings Account C    | HOLDINGS     | 2025-06-01 |   75,000.00 |             0.00 |            0.00 | ACTIVITY_DERIVED |
| Transaction Account D | TRANSACTIONS | 2024-01-01 |   50,000.00 |        50,000.00 |            0.00 | ACTIVITY_DERIVED |
| Transaction Account E | TRANSACTIONS | 2024-06-01 |   25,000.00 |        25,000.00 |            0.00 | ACTIVITY_DERIVED |

Those rows are enough to create misleading all-time returns. The current
valuation history treats holdings value as gain versus a zero book basis.

## Evidence From The Code

Key current contracts:

- `crates/core/src/accounts/accounts_model.rs` defines only `Transactions`,
  `Holdings`, and `NotSet`.
- `crates/core/src/activities/activities_model.rs` stores activity economics as
  `quantity`, `unit_price`, `amount`, `fee`, `currency`, `fx_rate`, and
  `metadata`. There is no distinct transfer market value or performance flow
  value field.
- `crates/core/src/portfolio/valuation/valuation_model.rs` has valuation-level
  `external_inflow_base`, `external_outflow_base`, and `external_flow_source`,
  but no granular flow quality or source amount semantics.

Root code paths:

- `crates/core/src/portfolio/snapshot/manual_snapshot_service.rs` creates manual
  snapshots with real positions and cost basis, but `net_contribution`,
  `net_contribution_base`, and cash totals are set to zero.
- `crates/core/src/portfolio/valuation/valuation_service.rs` derives activity
  flow amount as `amount` or `quantity * unit_price`. The first valuation row in
  a history slice is forced to zero inflow/outflow.
- `crates/core/src/portfolio/performance/flow_classifier.rs` treats transfers as
  portfolio-external only when `metadata.flow.is_external` is true, or as
  account-scope external when crossing the selected account boundary. That
  classification is directionally right.
- `crates/core/src/portfolio/snapshot/holdings_calculator.rs` uses `amount` as
  authoritative for non-buy/sell activities when present. For external security
  transfers, this means an imported market value in `amount` can become lot cost
  basis.
- `crates/core/src/portfolio/performance/performance_service.rs` uses TWR for
  transaction-only scopes, value return for holdings-only scopes, and value
  return for mixed scopes. That high-level policy is directionally right, but
  polluted holdings basis makes the output wrong.
- `apps/frontend/src/pages/activity/components/forms/transfer-form.tsx` asks for
  `Cost Basis` on external security transfer-in. It does not ask for
  transfer-date market value separately.
- `apps/frontend/src/pages/activity/import/hooks/use-import-mapping.ts` maps
  `market value` aliases to `amount`, which collides with the backend behavior
  above.
- `packages/ui/src/components/financial/gain-percent.tsx` can render `%%` during
  the animated fallback because the fallback calls `formatPercent(...)` and the
  parent appends another `%`.
- `apps/frontend/src/pages/dashboard/accounts-summary.tsx` renders account-row
  gain amounts with `showSign={false}`, so a red negative amount can appear
  without a minus sign beside a signed percent.
- `crates/core/src/portfolio/holdings/holdings_service.rs` and
  `crates/core/src/portfolio/holdings/holdings_valuation_service.rs` fabricate
  `100%` when a percentage numerator is nonzero and the basis is zero or
  unavailable. That hides missing basis data instead of exposing it.
- Per-holding percentages use several related denominators: unrealized gain over
  open cost basis, total gain over return basis, and total return over return
  basis. Those can be valid distinct metrics, but they need explicit names and
  must not silently switch basis or return hard-coded percentages.

## Industry Benchmark

The market standard is not "one return formula everywhere". Mature portfolio
tools split current holdings reporting from transaction/cash-flow performance.

Snowball Analytics documents this split directly. Its Holdings portfolio lets
users enter current positions and average cost, then provides current balance,
unrealized P&L, allocation, dividends, fundamentals, and analytics. Its
Transactions portfolio is the "best and most powerful" mode for performance
history, portfolio value history, IRR, realized P&L, fees, and transaction-based
benchmarking. See https://help.snowball-analytics.com/holdings-vs-transactions/.

Quicken uses placeholder entries when holdings exist but transaction history is
missing. Its docs say placeholders can track holdings-only information, but full
performance reporting and tax planning require actual historical transactions.
It also supports estimated average cost for limited reporting. See
https://info.quicken.com/win/how-do-i-decide-how-to-resolve-placeholder-entries.

Portfolio Performance does not treat unexplained snapshots as full performance
history. It models securities entering/leaving without a cash account as
explicit Delivery In/Out transactions. At portfolio level, deposit, withdrawal,
delivery in, and delivery out are the external flows for TWR. See:

- https://help.portfolio-performance.info/en/concepts/system-overview/
- https://help.portfolio-performance.info/en/reference/transaction/delivery/
- https://help.portfolio-performance.info/en/reference/transaction/transfer/
- https://help.portfolio-performance.info/en/concepts/performance/time-weighted/

Sharesight supports opening balances with quantity and cost base, then uses its
money-weighted performance methodology for portfolios with cash-flow timing. Its
historical cost reporting separately shows cost base and market value columns.
See:

- https://help.sharesight.com/upload-import-opening-balances/
- https://help.sharesight.com/us/historical_cost_report/

GIPS guidance remains the benchmark for transaction-mode performance:
time-weighted returns adjust for external flows, and external flows can be cash
or investments entering/exiting a portfolio. See
https://www.gipsstandards.org/wp-content/uploads/2021/03/calculation_methodology_gs_2006.pdf.

The common benchmark is:

- Holdings mode: use user-entered quantity, average cost, and cash for
  current-state reporting and gain versus cost.
- Transaction mode: use dated cash flows and dated security deliveries for
  TWR/IRR/performance history.
- In-kind deliveries: use market value for performance boundary flows and
  preserve cost basis for tax/P&L.
- Internal transfers: account-boundary flows, not portfolio-boundary flows.
- Incomplete data: show limited/degraded method labels instead of pretending
  full performance history exists.

## Diagnosis

### 1. Holdings Snapshots Are Missing Invested Capital

Manual and imported holdings snapshots represent current portfolio state. The
user supplies quantity and average cost, and may also supply cash balances. That
should produce a holdings-mode book basis:

```text
invested capital = sum(quantity * average cost) + cash
unrealized P&L = current market value - invested capital
gain versus cost = unrealized P&L / invested capital
```

Today, manual snapshots can preserve position cost basis but still persist
`net_contribution` and `net_contribution_base` as zero. That makes holdings
accounts look like pure gains versus a zero basis.

The fix is not to infer buys, sells, dividends, or transfers from snapshots, and
not to add another persisted source column for book basis. The fix is to derive
holdings book basis from existing stored source facts:

```text
holdings_book_basis = stored position cost basis + stored cash
```

Holdings mode should then be a cost-basis/current-state reporting mode.

### 2. External Security Transfers Conflate Cost Basis And Performance Flow

For users who do not manage cash, external `TRANSFER_IN` is the right mechanism
conceptually. It represents an in-kind delivery into the tracked portfolio.

What is missing is a separate performance flow value:

- Lot cost basis should come from cost basis.
- Performance inflow should come from market value at transfer date.
- The normal product flow should not ask the user for fair market value. Derive
  it from the transfer date's quote times quantity.
- If a provider or CSV explicitly supplies transfer-date market value, do not
  collapse it into generic `amount`; defer preservation until a typed field or
  import contract exists.
- If no quote exists, fall back to cost basis only with a degraded-data warning.

Current code usually uses `quantity * unit_price` when `amount` is absent.
Because the transfer form labels `unit_price` as cost basis, performance
currently uses cost basis as market flow value. If CSV import supplies `amount`
as market value, `holdings_calculator.rs` may instead use that amount as lot
cost basis.

### 3. First-Row Flow Handling Is Too Naive For Mixed Scopes

`valuation_service.rs` forces the first row in a valuation slice to zero
external flow. That is acceptable only when the row already represents the
beginning of the selected performance universe. It is wrong when
transaction-mode accounts first appear later because of a real external flow,
and it is misleading when holdings-mode accounts are folded into a portfolio
headline without method labels.

Late-entering transaction accounts need explicit flows. Late-entering holdings
accounts need book-basis reporting, not transaction-performance inference.

The mixed dashboard must not silently combine transaction TWR semantics with
holdings gain-versus-cost semantics.

### 4. Dashboard Pairs Metrics That Users Read As One Metric

The dashboard amount is computed from attribution P&L, while the percent is
selected from TWR or value return. For flow-heavy periods, a positive TWR and
negative dollar P&L can both be mathematically possible. But when displayed
without labels as a pair, users read it as inconsistent.

Account cards also hide the amount sign while preserving red/green color, which
makes the inconsistency look worse.

### 5. Holdings Percentages Hide Missing Basis

Holdings percentages currently fall back to `100%` when the basis is zero and
the numerator is nonzero. That is not a neutral fallback; it creates a false
return.

The correct behavior is:

- if basis is positive, calculate percentage normally;
- if basis is zero/missing and numerator is zero, show `0%` or `N/A` based on
  context;
- if basis is zero/missing and numerator is nonzero, show `N/A` with a
  missing-basis reason.

The implementation should also test FX consistency. A percentage where average
cost and current price are nearly equal should not become a large gain/loss
solely because cost basis and market value were converted with incompatible FX
dates. This is plausible from the reported `price_return` symptom, but it needs
a targeted fixture before being stated as confirmed root cause.

### 6. The `%%` Screenshot Is A Frontend Formatting Bug

The dashboard uses animated `GainPercent`. While the dynamic number component is
loading, `AnimatedNumber` returns `formatPercent(absValue)`, which already
includes `%`; the parent then appends another `%`.

This explains a transient `+42.49%%` on the dashboard.

### 7. The Residual Warning Is A Symptom, Not A Diagnosis

The residual warning is emitted when attribution components do not reconcile
with total value delta. That can happen when flows, book basis, unrealized P&L,
and snapshot state are not semantically aligned.

The warning should not just say "review Health Center". It should identify the
top dates/accounts/activities causing the residual.

## Target Product Model

Keep two primary modes:

1. Transaction mode
   - User tracks real transactions.
   - Cash can be fully managed or not managed.
   - External in-kind security transfers are supported as "delivery in/out".
   - TWR and IRR are first-class only when external flows have usable market
     values.

2. Holdings mode
   - User tracks current positions/snapshots, average cost, and cash.
   - Show current value, cost basis/invested capital, unrealized P&L, gain
     versus cost, allocation, income estimates, and risk/volatility where
     meaningful.
   - Do not infer buys, sells, dividends, or transfers from changed quantities.
   - Do not present TWR/IRR as first-class. Holdings mode lacks dated cash flows
     by design.
   - Treat each snapshot as replacement state for holdings reporting.

Add product language for user intent:

- "External security transfer" or "Delivery in/out" for in-kind assets
  entering/leaving.
- "Holdings snapshot" for current positions when historical trades are not
  entered.
- "Average cost", "Cost basis", "Invested capital", or "Book value" for
  `quantity * average cost + cash`.
- "Market value at transfer date" for transaction-mode delivery performance.
  This is quote-derived in this branch. Explicit import/provider values are
  deferred until a typed import/storage contract exists.

This avoids adding a third account mode while making transfer-only transaction
accounts legitimate.

## Target Technical Model

Introduce an internal `EconomicEventCompiler` for transaction-mode activities
and transfers. It compiles persisted activities into typed internal economic
events without adding persisted activity types:

- `CashFlow`
- `ExternalSecurityDeliveryIn`
- `ExternalSecurityDeliveryOut`
- `InternalSecurityTransfer`
- `Trade`
- `Income`
- `Fee`
- `Tax`
- `UnknownBoundaryTransfer`

In this branch the compiler is computed from existing activity columns, transfer
pair resolution, transfer-date quotes, lot-engine feedback, and FX only. There
is no source-schema migration and no new metadata contract.

Holdings snapshots should use a separate `HoldingsSnapshotEconomics`
interpretation. They are not activity history and should not be converted into
guessed buys/sells/transfers.

### Storage Versus Calculation Boundary

The first target implementation does not require a new holdings snapshot schema
field or a transfer economics table. The database should store source facts; the
compiler should produce calculated economics.

Existing source facts are enough for holdings book basis:

- `snapshot_positions.quantity`
- `snapshot_positions.average_cost`
- `snapshot_positions.total_cost_basis`
- `holdings_snapshots.cash_balances`
- `holdings_snapshots.cash_total_account_currency`
- `holdings_snapshots.cash_total_base_currency`

Existing source facts are enough for normal listed security transfers:

- `activities.quantity`
- `activities.unit_price` as transfer cost basis per unit
- transfer date
- asset quote on transfer date

The compiler output should be typed even if storage remains unchanged:

```text
CompiledActivityEconomics {
  event_kind,
  lot_cost_basis_value,
  lot_cost_basis_currency,
  performance_flow_value,
  performance_flow_currency,
  performance_flow_source,
  basis_status,
  diagnostics
}
```

Derived values can be materialized later in `daily_account_valuation` or a
debug/audit table if needed, but that is read-model caching, not source schema.

Suggested conceptual fields:

| Concept                   | Meaning                                 | Source today                              | Target source                            |
| ------------------------- | --------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `quantity`                | Units moved/held                        | `activities.quantity`                     | unchanged                                |
| `cost_basis_per_unit`     | Lot/tax/book price                      | `unit_price` for external transfer-in     | explicit form/import field               |
| `cost_basis_total`        | Book basis for lot                      | `quantity * unit_price` or `amount` today | compiler-derived from cost basis         |
| `market_value_total`      | Fair market value on transfer date      | usually absent                            | quote-derived by default                 |
| `performance_flow_value`  | External boundary flow used for returns | `amount` or `quantity * unit_price` today | `market_value_total` with source quality |
| `cash_flow_amount`        | Cash movement                           | `amount` for cash activities              | unchanged                                |
| `performance_flow_source` | Exact producer/degraded fallback source | absent                                    | compiler-owned enum                      |

Suggested holdings snapshot fields:

| Concept                 | Meaning                             | Source today                               | Target source                    |
| ----------------------- | ----------------------------------- | ------------------------------------------ | -------------------------------- |
| `snapshot_quantity`     | Units held on snapshot date         | snapshot positions                         | unchanged                        |
| `average_cost_per_unit` | User-entered average/book cost      | import/form average cost                   | unchanged                        |
| `position_cost_basis`   | `quantity * average cost`           | snapshot position total cost basis         | unchanged source fact            |
| `cash_balance`          | User-entered cash state             | snapshot cash balances                     | unchanged source fact            |
| `invested_capital`      | `sum(position_cost_basis) + cash`   | currently often zero in `net_contribution` | compiler-derived book basis      |
| `market_value`          | `quantity * quote + cash`           | valuation calculation                      | unchanged                        |
| `unrealized_pnl`        | `market_value - invested_capital`   | derived inconsistently when basis is zero  | derived from compiler book basis |
| `gain_vs_cost`          | `unrealized_pnl / invested_capital` | unavailable/misleading when basis is zero  | derived headline metric          |

Compiler-owned flow value sources:

- `CASH_AMOUNT`
- `QUOTE_DERIVED_MARKET_VALUE`
- `COST_BASIS_FALLBACK`
- `REMOVED_LOT_BASIS_FALLBACK`
- `LEGACY_ACTIVITY_AMOUNT_FALLBACK`
- `UNKNOWN_BOUNDARY_TRANSFER`
- `UNKNOWN`

Compatibility values such as `ACTIVITY_DERIVED`, `STORED_GROSS`,
`NET_CONTRIBUTION_FALLBACK`, and aggregate `MIXED` can remain readable for old
rows or aggregate views, but they are not valid new producer sources for
compiled activity economics.

### Event Finalizer And Attribution Ledger

Use a two-stage pipeline:

1. Compiler classifies the activity, transfer boundary, quote-derived market
   flow value, entered cost basis, flow source, basis status, and diagnostics.
2. Lot engine consumes compiled lot basis, creates/removes lots, and returns
   disposal/removed-lot facts by activity.
3. Finalizer attaches cost-dependent fallbacks and emits event effects.

The finalizer should produce a period event-effect ledger:

```text
EconomicEventEffect {
  activity_id,
  account_id,
  asset_id,
  date,
  event_kind,
  external_flow,
  realized_pnl,
  unrealized_movement,
  income,
  fee,
  tax,
  fx_effect,
  diagnostics
}
```

Performance attribution must consume this ledger. Legacy `*_best_effort`
attribution passes can remain only as temporary compatibility code while the
ledger is rolled out.

Required invariant for every performance period:

```text
value_delta = external_flows + event_effects + unreconciled_diagnostic_delta
```

The unreconciled delta is a diagnostic for bugs or incomplete data. It must not
be injected as a normal display P&L component.

### External Security Transfer In

For a security `TRANSFER_IN` marked external:

- Increase quantity.
- Create lot using `cost_basis_per_unit` or transferred lot details.
- Do not create cash.
- External performance inflow equals transfer-date market value:
  - quote on transfer date times quantity by default,
  - else cost basis fallback with warning.
- The standard manual transfer form should keep asking for cost basis, not
  require fair market value.
- Fees should follow the same policy as today, but the performance-flow decision
  must be explicit.

### External Security Transfer Out

For a security `TRANSFER_OUT` marked external:

- Remove quantity using account cost-basis method.
- Do not create cash unless user records cash separately.
- External performance outflow equals transfer-date market value:
  - quote on transfer date times quantity by default,
  - else removed lot cost basis fallback with warning.
- Removed-lot cost basis must come back from the lot engine by `activity_id`. Do
  not reconstruct it from daily `net_contribution_base` deltas.

### Internal Security Transfer

For a paired transfer:

- Preserve lots from source to destination.
- At portfolio scope, no external flow.
- At account scope, source has outflow and destination has inflow.
- Account-scope performance flow should use transfer-date market value, not
  original cost basis.
- Portfolio performance should reconcile regardless of transfer quote, because
  both legs cancel at portfolio scope.

### Holdings Snapshot

For every holdings-mode snapshot:

- Persist position cost basis from the user-entered average cost.
- Persist cash balances and include them in holdings invested capital.
- Compute holdings invested capital as `sum(quantity * average cost) + cash` in
  the compiler/read model.
- Compute market value from quotes plus cash.
- Compute unrealized P&L and gain versus cost from market value and invested
  capital.
- Treat later snapshots as replacement state. If quantity moves from `10` to
  `200`, do not guess whether that was a buy, transfer, dividend reinvestment,
  split, or correction.
- Do not create snapshot-derived external flows by default.
- Mark TWR/IRR unavailable for holdings-only scopes because dated flows are not
  tracked.

### Manual And Custom Assets Without Quotes

Manual/custom assets need an explicit policy so they do not silently become
zero-value positions:

- Market-priced held asset with no quote: Health Center reports missing market
  data.
- Manual/custom asset with a typed manual current value or manual quote: include
  it in net worth. Include it in performance only when basis and value coverage
  are complete for the requested metric.
- Manual/custom asset without a quote and without typed manual valuation:
  exclude or degrade it from performance, preserve basis information for
  holdings reporting, and emit a Health Center diagnostic for missing manual
  valuation.
- Do not use average cost as market value unless it is explicitly stored as a
  manual valuation or manual quote.

## Target Dashboard Semantics

The backend should return a display-ready headline contract, not force frontend
helpers to infer semantics.

Suggested headline fields:

- `amount`
- `percent`
- `method`: `TWR`, `IRR`, `VALUE_RETURN`, `VALUE_CHANGE`, `GAIN_VS_COST`,
  `P_AND_L`, `NOT_APPLICABLE`
- `basis`: `MARKET_VALUE`, `COST_BASIS`, `INVESTED_CAPITAL`, `MIXED`
- `quality`: `COMPLETE`, `ESTIMATED`, `DEGRADED`, `UNAVAILABLE`
- `basis_status`: `COMPLETE`, `PARTIAL_UNKNOWN`, `UNKNOWN`, `NOT_APPLICABLE`
- `component_coverage`: amount/percent completeness plus per-component inclusion
  flags
- `reasons`: display-only explanatory strings

Frontend helpers must consume typed fields. They must not parse `reasons` or
warning text to infer return method, basis, quality, or percent availability.

Display rule:

- If amount and percent are shown side by side, their numerator must match, or
  the labels must make the difference explicit.
- Never hide the negative sign while using red coloring.
- Normalize negative zero before display.
- For holdings-mode all-time scopes, default to `GAIN_VS_COST`:
  `market value - invested capital`, divided by invested capital.
- For holdings-mode bounded periods, default to value change over starting value
  unless a replacement snapshot changes the economic baseline.
- For mixed transaction/holdings scopes, show split component semantics and do
  not label the combined view as TWR.
- A mixed combined percent is available only when its numerator and denominator
  cover the same component set. Otherwise show `N/A`.
- For holdings rows with missing average cost or zero invested capital, show
  `N/A` with a useful reason instead of a huge percent.

### Scope-Specific Headline Behavior

Dashboard and account-summary headlines must branch by scope composition before
calculating returns:

| Scope composition | Headline amount                                         | Headline percent                                        | TWR/IRR                        |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| Transaction-only  | Transaction attribution P&L                             | TWR by default, or selected transaction return          | Available when valid           |
| Holdings-only     | Bounded: value change; all-time: gain versus book basis | Same numerator divided by starting value/book basis     | Not first-class                |
| Mixed             | Sum of account-level transaction P&L and holdings gain  | Only when component coverage is coherent; otherwise N/A | Unavailable for combined scope |

Transaction-only scopes can keep the existing transaction performance path.
Holdings-only scopes can keep the current holdings value-return path. Mixed
scopes need a separate backend aggregator; they must not derive external flows
from aggregate `net_contribution_base` deltas.

Mixed-scope bounded-period algorithm:

```text
for each account in scope:
  if account.tracking_mode == TRANSACTIONS:
    amount_i = transaction attribution P&L for the period
    denominator_i = starting total value, when positive
  if account.tracking_mode == HOLDINGS:
    amount_i = ending total value - starting total value
    denominator_i = starting total value, when positive

headline_amount = sum(amount_i)
headline_percent = headline_amount / sum(denominator_i)
method = MIXED_VALUE_RETURN
quality = DEGRADED if any account-level component is degraded/unavailable
```

Mixed-scope all-time algorithm:

```text
for each account in scope:
  if account.tracking_mode == TRANSACTIONS:
    amount_i = lifetime transaction attribution P&L
    denominator_i = earliest positive total value or explicit transaction basis
  if account.tracking_mode == HOLDINGS:
    amount_i = ending total value - ending book basis
    denominator_i = ending book basis, when positive

headline_amount = sum(amount_i)
headline_percent = headline_amount / sum(denominator_i)
method = MIXED_VALUE_RETURN
```

The denominator contract should be explicit in the backend response. Do not let
the frontend infer it from the displayed amount, account mode, or group shape.

## SOTA Completion Criteria

The architecture is complete only when these criteria are all true:

- Every persisted activity consumed by performance compiles through
  `EconomicEventCompiler` before lots, valuation, performance, diagnostics, or
  UI semantics consume it.
- Lot-engine feedback is first class. Transfer-out removed-lot basis is returned
  by activity and used by the event finalizer; no path reconstructs it from
  `net_contribution_base` deltas.
- New compiled activity flows write only compiler-owned producer sources:
  `CASH_AMOUNT`, `QUOTE_DERIVED_MARKET_VALUE`, `COST_BASIS_FALLBACK`,
  `REMOVED_LOT_BASIS_FALLBACK`, `LEGACY_ACTIVITY_AMOUNT_FALLBACK`,
  `UNKNOWN_BOUNDARY_TRANSFER`, or `UNKNOWN`.
- Legacy source values remain readable and degraded, but they are not normal
  producers for new calculation rows.
- Performance attribution is built from finalized event effects. Residual is a
  diagnostic only and never contributes to displayed P&L.
- Manual/custom holdings without quote or typed manual valuation are not valued
  at zero silently. They degrade performance coverage and create a Health Center
  missing-manual-valuation issue.
- Market-priced holdings with no quote create missing-market-data diagnostics.
- Backend headline responses include typed method, basis, quality, basis status,
  component coverage, amount, and optional percent. Frontend code does not parse
  display reasons to infer math.
- Mixed transaction/holdings scopes show split component semantics. A combined
  percent is returned only when numerator and denominator cover the same
  component set; otherwise the percent is `N/A`.

## Implementation Plan

The plan is split deliberately. Issue #1119 should not wait for a full
performance architecture project. Ship the surgical fix first, then continue
with the compiler/finalizer transfer and delivery semantics work.

### Phase 0: Reproduction And Fixtures

Create minimal test fixtures before changing behavior:

- Transfer-only account with external security transfer-in, no cash, cost basis
  equal market value.
- Transfer-only account with external security transfer-in, no cash, cost basis
  different from transfer-date market value.
- External security transfer-out with no cash leg.
- Internal security transfer between two accounts.
- Holdings-mode account with one snapshot: quantity, average cost, current
  quote, and cash.
- Holdings-mode account with later replacement snapshot where quantity and
  average cost change.
- Holdings-mode account with zero/missing average cost.
- Holdings-mode holding with equal average cost/current price across currencies
  to verify FX-base percentage consistency.
- Mixed portfolio containing transaction and holdings accounts.
- UI fixture for animated percent fallback.

Acceptance:

- Reproduce `%%`.
- Reproduce red/green mismatch.
- Reproduce misleading holdings gain from zero invested-capital basis.
- Reproduce hard `100%` percentage fallback when basis is zero.
- Reproduce attribution residual warning with a known bad basis/flow mismatch.

### Phase 1: Surgical #1119 Fix

This is the short-term PR. It should be small, low-risk, and independent of the
deeper compiler/finalizer and import-contract work.

- Fix `GainPercent` animated fallback so it does not append a second `%`.
- Do not suppress negative signs on account gain amounts.
- Normalize negative zero in financial display helpers.
- Surface return method labels where amount and percent are not the same metric.
- Feed holdings-mode invested capital from existing snapshot cost basis and
  cash, rather than zero, where the user supplied average cost/cash.
- Replace holdings hard `100%` percentage fallbacks with
  unavailable/missing-basis semantics.
- Add tests for holdings gain versus cost, zero basis, and FX-base consistency.

Acceptance:

- No `%%` can render while `@number-flow/react` is loading.
- A negative amount always displays a minus sign when it is color-coded as
  negative.
- `-0`, `-0.00`, and `-0.00%` render as `0`, `0.00`, or `0.00%`.
- A holdings account with `100` shares, `avg_cost = 50`, quote `200`, and no
  cash reports invested capital `5,000`, market value `20,000`, P&L `15,000`,
  gain versus cost `300%`.
- A holdings cash balance contributes to invested capital and market value, not
  fake P&L.
- Missing/zero average cost produces `N/A` for gain versus cost, not hard
  `100%`.
- Average cost and current price that are nearly equal do not produce a large
  percentage due to FX-base inconsistency.

### Current Branch Progress

Branch: `feature/fix-1119-performance-semantics`

Scope: calculation/read-model architecture for #1119 without changing storage
schema or activity metadata. Richer dashboard method labels and typed explicit
CSV market-value preservation remain follow-up phases.

| Item                                                                                                | Status                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Fix animated percent fallback double `%`                                                            | Implemented                                                         |
| Preserve negative sign on dashboard account gain amounts                                            | Implemented                                                         |
| Normalize display-level negative zero for gain amount/percent                                       | Implemented                                                         |
| Feed non-calculated holdings snapshots from existing cost basis plus cash when contribution is zero | Implemented                                                         |
| Replace hard `100%` zero-basis holdings percentage fallbacks with unavailable percentages           | Implemented                                                         |
| Use holdings book basis for all-time gain-vs-cost and value change for bounded periods              | Implemented                                                         |
| Add focused tests for manual holdings basis, zero-basis percentage, and dashboard amount signs      | Implemented                                                         |
| Add FX-base consistency fixture                                                                     | Implemented                                                         |
| Add quote-derived external security transfer flow compiler                                          | Implemented                                                         |
| Prefer transfer cost basis over generic `amount` when quotes are missing                            | Implemented                                                         |
| Prevent legacy transfer `amount` from overriding cost basis when `quantity * unit_price` is present | Implemented                                                         |
| Stop auto-mapping CSV `market value` into generic `amount`                                          | Implemented                                                         |
| Fix mixed-scope dashboard/account-group headline aggregation                                        | Implemented with account-level component aggregation                |
| Suppress mixed-scope combined percent when component coverage is incoherent                         | Implemented with split components and `N/A` combined percent        |
| Enrich mixed-scope transaction component attribution before aggregation                             | Implemented for service path                                        |
| Use first positive transaction value as all-time mixed denominator                                  | Implemented                                                         |
| Avoid showing zero P&L when all-time holdings book basis is unavailable                             | Implemented with explicit P&L unavailable reason                    |
| Treat partial missing holdings book basis as all-time holdings headline unavailable                 | Implemented                                                         |
| Skip invalid negative components in mixed scopes instead of failing the whole scope                 | Implemented with degraded data-quality warnings                     |
| Build mixed bounded return series from account-level component timelines                            | Implemented                                                         |
| Add explicit frontend return method labels                                                          | Deferred until the mixed-scope headline contract is explicit        |
| Persist explicit import/provider transfer market value                                              | Deferred; requires a typed field/contract, not metadata or `amount` |

### Phase 2: Economic Event Compiler And Finalizer

This architecture is implemented for transfer performance in the current branch.
It remains intentionally storage-neutral.

Add a centralized compiler in core, then migrate transaction/transfer callers
onto it:

- Inputs: `Activity`, transfer boundary, transfer-date quote lookup, lot-engine
  feedback, FX service, account currency, base currency, valuation date.
- Outputs: typed event kind, cost basis total, quote-derived market value total,
  performance flow value, cash flow value, basis status, flow source, event
  effects, diagnostics.
- Keep existing DB columns initially. This phase is a calculation-model change,
  not a storage-schema change.
- Do not add metadata as a hidden transfer economics surface.
- Attribute performance from compiler/finalizer event effects. Existing
  best-effort attribution helpers are temporary compatibility paths, not the
  target design.

Critical behavior changes:

- Security transfers with `quantity + unit_price + amount` must not let `amount`
  silently override lot cost basis.
- `amount` on a security transfer must not override `quantity * unit_price` when
  cost basis exists. It is only a legacy fallback when both quote and cost basis
  are missing.
- Existing import rows should be handled through compatibility heuristics during
  recalculation.
- Do not change shared BUY/SELL amount handling without tests. Normal trades may
  legitimately derive price from broker amount when quantity/unit price are
  incomplete.

Acceptance:

- External security transfer-in with cost basis `10`, transfer-date quote `12`,
  current quote `15` reports lot cost basis from `10` and performance inflow
  from `12`.
- External security transfer-out with no transfer-date quote uses removed-lot
  basis returned by the lot engine, not a `net_contribution_base` delta guess.
- Internal portfolio transfer cancels at portfolio scope.
- Account-scope transfer performance uses transfer market value.
- Attribution components reconcile to value delta through event effects; any
  residual remains diagnostic-only and is not displayed as normal P&L.
- New valuation rows from compiled activities use only compiler-owned flow
  sources. Legacy flow-source strings remain readable but degraded.

### Phase 3: Transfer Form And CSV Import

This phase depends on compiler semantics being explicit enough to separate cost
basis from transfer-date market value without burdening the normal form.

Transfer form:

- Keep "External transfer" and cash/securities mode.
- For external security transfer-in, show:
  - `Quantity`.
  - `Cost basis per share/unit`.
- Do not require the user to enter fair market value. Derive transfer-date
  market value from quotes.
- If no quote is available, either use a degraded cost-basis fallback or expose
  an advanced optional override for manual/custom assets.
- For external security transfer-out, derive market value from quote by default;
  optional override belongs in an advanced/import path, not the primary flow.

CSV import:

- Keep `amount` for cash activities and cash transfers.
- Stop mapping `market value` into generic `amount`.
- Keep existing `unitPrice`/cost-basis import behavior for security transfers.
- Defer explicit imported transfer-date market value until there is a typed
  field/contract. Do not preserve it in generic `amount` or metadata.
- Keep backward compatibility: existing templates using `amount` still import,
  but security-transfer performance ignores it when `quantity * unit_price`
  already supplies cost basis.

Bulk holdings / holdings snapshots:

- Treat imported holdings as holdings snapshots, not external deliveries.
- Persist `quantity`, `average_cost`, `cost_basis = quantity * average_cost`,
  and cash.
- Use quotes for current market value, not for user-entered invested capital.
- If average cost is missing or zero, import can still create the holding, but
  gain versus cost is unavailable or marked incomplete.
- If a manual/custom holding has no quote and no typed manual valuation, import
  can still preserve the holding and cost basis, but performance is degraded and
  Health Center reports missing manual valuation.

Acceptance:

- The manual transfer form submits quantity and cost basis without requiring
  market value.
- A CSV with cost basis imports cost basis; a standalone `market value` column
  is left unmapped instead of becoming generic `amount`.
- A CSV with only average cost still imports and produces valid gain versus cost
  once quotes are available.
- Bulk holdings no longer create holdings accounts with zero invested-capital
  basis when the user supplied average cost.
- Manual/custom holdings without quote or typed manual valuation do not silently
  become zero-value performance positions; they produce a diagnostic.

### Phase 4: Holdings Snapshot Book Basis Semantics

Change snapshot-to-valuation semantics:

- Snapshot positions carry cost basis from `quantity * average cost`.
- Snapshot cash balances are persisted and included in holdings invested
  capital.
- Do not add a holdings snapshot `book_basis` source column. Derive holdings
  book basis from existing position cost basis plus cash.
- Avoid treating holdings book basis as transaction `net_contribution` in the
  domain model. If a compatibility API needs a value in that slot temporarily,
  label it as transitional read-model behavior, not storage semantics.
- Prefer a typed API/read-model field such as `book_basis` or `invested_capital`
  for holdings-mode display.
- Holdings-mode all-time headline uses current unrealized P&L over current
  invested capital.
- Later snapshots replace state. Do not infer transaction flows from
  quantity/cash deltas.
- TWR/IRR remain unavailable for holdings-only scopes.

Short-term implementation can compute this in the compiler without changing the
database. Long-term implementation should still prefer typed read-model fields
over mixing holdings book basis with transaction net contribution.

Acceptance:

- A holdings account with `100` shares, `avg_cost = 50`, quote `200`, and no
  cash reports invested capital `5,000`, market value `20,000`, P&L `15,000`,
  gain versus cost `300%`.
- A holdings cash balance of `10,000` contributes to invested capital and market
  value, not to fake P&L.
- A later replacement snapshot with `200` shares recomputes invested capital
  from the new quantity and average cost; it does not create hidden
  buys/transfers.
- Missing/zero average cost produces `N/A` for gain versus cost, not an infinite
  return.

### Phase 5: Mixed Scope Dashboard Headline Aggregator

Fix the dashboard and grouped account summaries before relying on a full
rebuild. The current mixed-scope path aggregates account valuation rows first,
then derives external flows from aggregate `net_contribution_base` deltas. That
is wrong when holdings-mode book basis appears in the history, because the book
basis is not a period contribution.

Implementation:

- Add a scope-composition classifier:
  - `TRANSACTION_ONLY`
  - `HOLDINGS_ONLY`
  - `MIXED`
- Keep transaction-only scopes on the existing transaction performance path.
- Keep holdings-only scopes on the holdings value-return path.
- Replace mixed-scope headline calculation with account-level aggregation:
  - load account histories for each account in the requested scope,
  - compute transaction account P&L through transaction attribution,
  - compute holdings account amount through holdings rules,
  - sum account-level amounts,
  - divide by explicit account-level denominators.
- Do not use aggregate `net_contribution_base` deltas as mixed-scope external
  flows.
- Keep the output mode as value return or introduce `MIXED_VALUE_RETURN` in the
  display contract.
- Add data-quality warnings when any component is unavailable or degraded.

Recommended denominator contract:

| Component type            | Bounded-period denominator      | All-time denominator                                 |
| ------------------------- | ------------------------------- | ---------------------------------------------------- |
| Transaction account       | Starting positive total value   | Earliest positive total value or explicit flow basis |
| Holdings account          | Starting positive total value   | Ending book basis                                    |
| Holdings account no basis | Starting value for bounded only | Unavailable                                          |

Acceptance:

- Business mixed group for the local fixture reports about `+3,972.94` and
  `+1.30%` for 2026-06-12 to 2026-06-19, not `-195,816.22` and `-64.07%`.
- Whole dashboard mixed scope reports about `+28,536.00` and `+2.24%` for the
  same period, not `-516,176.69` and `-40.51%`.
- A holdings book-basis discontinuity inside the selected period does not create
  a fake contribution.
- Transaction-only grouped scopes keep their current TWR/headline behavior.
- Holdings-only grouped scopes keep bounded value change and all-time
  gain-versus-book-basis behavior.
- Mixed-scope TWR and IRR remain unavailable.

### Phase 6: Rebuild

Rebuild historical valuations with the new compiler/finalizer. This is
recalculation from source facts, not a source-data migration.

- For existing external security transfers:
  - derive market flow from quote times quantity by default,
  - use cost basis fallback for transfer-in when quotes are missing,
  - use lot-engine removed basis fallback for transfer-out when quotes are
    missing,
  - use generic `amount` only for legacy security-transfer rows that have no
    quote and no cost basis.
- For transfer-out fallback, feed removed-lot basis from the lot engine by
  activity. Do not infer it from daily net-contribution deltas.
- For existing holdings snapshots:
  - recompute position cost basis from stored snapshot positions,
  - recompute cash totals from stored cash balances,
  - derive holdings invested capital/book basis from cost basis plus cash,
  - do not synthesize historical transaction flows.
- Do not mutate user activities.
- Prefer recalculating valuation rows from source data.
- Reinterpretation of historical `amount` on security transfers must be
  non-destructive and guarded by diagnostics.
- Phase 0 fixtures must land before rebuild logic.

Compatibility warnings:

- Activities that previously used `amount` as both market value and cost basis
  need classification.
- Rows with missing quote and missing cost basis must remain usable but degraded
  if a legacy amount exists.
- Holdings snapshots with missing average cost remain usable for current value,
  but gain versus cost is unavailable.
- Manual/custom holdings with neither quote nor typed valuation remain preserved
  as holdings facts, but performance and net-worth value coverage are degraded
  with a Health Center diagnostic.

Acceptance:

- Rebuilding history fixes holdings accounts with zero invested-capital basis.
- Health Center can report which rows used degraded fallbacks.
- Transfer-out fallback rows identify the source activity and removed-lot basis
  used.
- v3.5.2 data remains readable.
- Rebuild does not silently rewrite user cost basis or realized P&L.

### Phase 7: Health Center Diagnostics

Replace generic residual messages with actionable diagnostics:

- Top dates by attribution residual.
- Holdings accounts/snapshots with nonzero value and zero invested-capital
  basis.
- External security transfers with missing transfer-date quote.
- Transfer-outs that used removed-lot basis fallback.
- Security transfers using the legacy `amount` fallback because cost basis is
  missing.
- Security transfers where `amount` and `quantity * unit_price` differ
  materially.
- Holdings snapshots with missing or zero average cost.
- Holdings percentage calculations that are unavailable because basis is
  missing.
- Market-priced held assets with no quote.
- Manual/custom holdings with no quote and no typed manual valuation.
- Mixed-scope periods where aggregate net contribution changes because holdings
  book basis appears in only part of the history.
- Negative zero rows, normalized by rebuild.

Diagnostics should be structured enough for API/UI consumers and tests:

```text
PerformanceDiagnostic {
  reason_code,
  severity,
  account_id,
  activity_id,
  asset_id,
  date,
  event_kind,
  flow_source
}
```

Required reason codes:

- `UNKNOWN_TRANSFER_BOUNDARY`
- `MISSING_TRANSFER_QUOTE`
- `REMOVED_LOT_BASIS_FALLBACK`
- `LEGACY_ACTIVITY_AMOUNT_FALLBACK`
- `MISSING_BASIS`
- `PARTIAL_BASIS`
- `MISSING_MARKET_QUOTE`
- `MISSING_MANUAL_VALUATION`
- `ATTRIBUTION_UNRECONCILED`

Acceptance:

- A user can open Health Center and see the exact account/date/activity causing
  degraded performance.
- Manual/custom holdings without typed valuation appear as missing manual
  valuation issues, not quote-sync issues.
- The "fix" action can rebuild with the new compiler/finalizer and report
  remaining unfixable rows.

### Phase 8: Tests And Release Criteria

Backend tests:

- `economic_events`: every activity class compiles to the expected event kind,
  flow source, basis status, and diagnostics.
- `flow_classifier`: portfolio versus account boundary behavior, including
  invalid groups, conflicting external metadata, and unknown transfers.
- `holdings_calculator`: transfer amount no longer corrupts cost basis, and
  transfer-out removed-lot basis is available by activity for finalization.
- `valuation_service`: external transfer flow value comes from market value, and
  no-quote transfer-out uses removed-lot fallback without net-delta inference.
- `performance_service`: holdings scopes report gain versus cost and keep
  TWR/IRR unavailable.
- `performance_service`: mixed scopes aggregate account-level headline amounts
  and do not treat holdings book-basis changes as external flows.
- `performance_service`: event effects reconcile to value delta; residual is a
  diagnostic only.
- `holdings_service` and `holdings_valuation_service`: no hard `100%` fallback
  when basis is zero/missing.
- FX consistency fixture for holdings percentages.
- Snapshot fixtures for invested capital, cash balances, zero average cost, and
  replacement snapshots.
- Health fixtures for missing market quote, missing manual valuation, unknown
  transfer boundary, partial basis, and degraded fallback sources.

Frontend tests:

- Transfer form submits quantity and cost basis without requiring market value.
- CSV importer does not map `market value` into generic `amount`.
- `GainPercent` fallback never double-appends `%`.
- Account summary shows negative sign when value is negative.
- Dashboard mixed groups show composite value return instead of aggregate
  net-contribution fallback.

End-to-end checks:

- Reproduce issue #1119 minimal data.
- Run full pipeline fixtures from activity/import through compiler, lot engine,
  valuation, performance API, frontend helpers, and Health Center.
- Rebuild history.
- Dashboard, Performance page, Holdings page, and Health Center all agree on
  method and quality.

## Product Direction

Recommended direction:

- Do not remove transfer-only transaction workflows. They are valid and common.
- Do not require users to manage cash just to get sane performance.
- Treat external security transfers as first-class in-kind deliveries.
- Treat holdings imports/snapshots as current state with average cost, not as
  transaction history.
- Derive holdings invested capital as `quantity * average cost + cash`, not
  zero, from stored source facts.
- Do not require users to enter transfer-date fair market value for listed
  securities. Derive it from quotes by default.
- For manual/custom assets, require a typed manual valuation or manual quote
  before including them as valued performance positions; otherwise degrade and
  surface a Health Center issue.
- Show Holdings mode as gain versus cost/current-state reporting.
- For mixed scopes, aggregate account-level headline amounts; do not compute
  external flows from aggregate net-contribution deltas.
- Make performance method and data quality visible.
- Keep TWR/IRR out of holdings-only mode unless users enter transactions or
  explicit deliveries.

This gives transaction-mode users accurate TWR when they provide or can derive
market-value flows, and gives holdings-mode users honest value/P&L reporting
without pretending incomplete flow history is complete.

## Open Decisions

1. Holdings read model: expose derived `book_basis`/`invested_capital` fields
   directly, or keep transitional API compatibility through existing
   `net_contribution` fields while clearly labelling the metric?
2. Transfer storage: later add typed DB columns only if explicit transfer-date
   market values become first-class persisted user/provider facts?
3. Manual/custom valuation storage: use manual quote records as the typed
   valuation source, or add a dedicated manual valuation field/table for
   non-quoted assets?
4. Backward compatibility: should legacy `amount` on security transfers remain
   only a no-quote/no-cost-basis fallback, or should users get an opt-in repair
   tool for older imported market values?
5. UI wording: use "External security transfer" or adopt the Portfolio
   Performance term "Delivery in/out"?
6. Mixed dashboard wording: label the combined metric as "Mixed value return",
   "Composite return", or show separate transaction and holdings subtotals?
