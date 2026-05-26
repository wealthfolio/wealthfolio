# Wealthfolio SOTA Valuation & Performance Migration Plan

## Summary

Move Wealthfolio from precomputed aggregate rows and account-local valuation
math to scoped, base-currency, flow-aware valuation and performance.

Primary outcomes:

- `AccountScope::All`, saved portfolios, single accounts, and ad-hoc account
  groups use the same scoped engine.
- No new code depends on persisted aggregate-account rows.
- Multi-currency account aggregation is done from per-account base-currency
  valuation rows.
- Internal transfers do not distort portfolio/group net contribution or returns.
- Accounting realized P&L and income are tracked separately from future tax
  reporting.

## Key Decisions

- Use existing `AccountScope` as the public scope type.
- Remove `ResolvedAccountScope::TotalSnapshot`; resolved scopes always contain
  real account IDs.
- Do not add calculation-version columns. Migrations that change derived math
  clear affected derived rows and enqueue recompute.
- Account currency is immutable after creation.
- Accounting uses fixed FIFO. Tax reporting may later add its own
  disposal-method settings and overlays.
- `daily_account_valuation` remains unsynced. `holdings_snapshots` sync must
  drop legacy aggregate snapshots after the rollout.
- Saved portfolio historical charts use current portfolio membership at query
  time because `portfolio_accounts` has no historical membership dates.

## Public Interfaces

- Replace resolved enum behavior with:

```rust
pub struct ResolvedAccountScope {
    pub scope_id: String,
    pub account_ids: Vec<String>,
    pub base_currency: String,
}
```

- Canonical `scope_id` rules:
  - `all`
  - `account:<account_id>`
  - `portfolio:<portfolio_id>`
  - `accounts:<sha16>` from lex-sorted, deduped account IDs

- Add explicit Modified Dietz fields and keep old aliases temporarily:
  - `cumulative_modified_dietz`
  - `annualized_modified_dietz`
  - deprecated aliases: `cumulative_mwr`, `annualized_mwr`

- Later add XIRR fields:
  - `period_xirr`
  - `annualized_xirr`

## Phase 1: Scope Engine And Aggregate Retirement

Goal:

- Make every read path resolve scopes to real account IDs and stop treating
  legacy aggregate rows as live accounts.

Implementation:

- Change `AccountScope::All` resolution to active, non-archived real accounts.
- Remove `ResolvedAccountScope::TotalSnapshot`.
- Remove all recalculation code that appends aggregate account rows.
- Move holdings, allocations, income, valuation, dashboard, and performance
  reads to scoped aggregation.
- Frontend keeps `AccountScope` union, removes string shortcut hooks like
  `useHoldings(string)`, and uses scope object query keys.
- Migration deletes existing aggregate account rows from `holdings_snapshots`
  and `daily_account_valuation`.
- Sync apply ignores inbound aggregate `holdings_snapshots`.

Checks:

- `AccountScope::All` resolves to real accounts only.
- No new snapshot or valuation write creates aggregate account rows.
- Existing dashboard, holdings, allocation, income, and performance views work
  for all/account/portfolio/accounts scopes.
- Incremental sync and snapshot restore tests prove inbound aggregate snapshots
  are dropped.
- Empty saved portfolio returns deterministic empty data, not an error or panic.

## Phase 2: Base-Currency Valuation Foundation

Goal:

- Persist enough per-account base-currency valuation data to aggregate
  portfolios without recomputing FX on read.

Implementation:

- Add base fields to `daily_account_valuation`:
  - `cash_balance_base`
  - `investment_market_value_base`
  - `total_value_base`
  - `cost_basis_base`
  - `net_contribution_base`
  - `external_inflow_base`
  - `external_outflow_base`
  - `performance_eligible_value_base`
- Introduce semantic FX intent:

```rust
pub enum FxContext {
    ValuationDate,
    AcquisitionDate,
    FlowDate,
}
```

- Use valuation-date FX for market value and cash.
- Use acquisition-date FX for lot cost basis, using materialized lots from PR
  #1002.
- Use flow-date FX for contributions, withdrawals, and transfer boundary flows.
- Performance-eligible value includes cash and quoted transaction-mode market
  positions; excludes HOLDINGS-mode snapshot positions and alternative/manual
  assets.

Checks:

- `daily_account_valuation(account_id, valuation_date)` index exists and
  supports range replacement.
- Base cash reconciles:

```text
holdings_snapshots.cash_total_base_currency
== daily_account_valuation.cash_balance_base
```

- Multi-currency accounts aggregate correctly into the user base currency.
- Cost basis for foreign assets uses acquisition-date FX, not current-date FX.
- Missing FX produces a clear stale/incomplete valuation status, not silent
  zeroes.

## Phase 3: Recompute Orchestration And Migration UX

Goal:

- Make derived-data rebuilds predictable, atomic, and visible to the user.

Implementation:

- On migration, clear affected derived rows and enqueue a full historical
  recompute.
- UI shows valuation/performance updating state while required rows are missing
  or stale.
- Recompute windows:
  - activity edit: earliest affected activity date forward
  - quote or FX backfill: earliest affected date forward
  - base currency change: full history
  - portfolio membership change: no per-account recompute
- Write valuation rows transactionally per account/date range: delete old rows
  and insert replacements in one transaction.
- If inputs change while a job is running, supersede the job before commit.

Checks:

- Migration from an existing DB starts recompute automatically.
- App remains usable during recompute and shows stale/updating status.
- Editing an old activity only rebuilds the affected forward range.
- FX backfill triggers the correct forward valuation rebuild.
- No partial valuation range is visible after a failed recompute transaction.

## Phase 4: Scoped Flow Engine

Goal:

- Compute net contribution and return cash flows at any scope boundary without
  fragile `source_group_id` corrections.

Implementation:

- Evolve `flow_classifier.rs` from account/portfolio-only classification to
  scope-aware classification.
- Inputs are resolved account IDs, compiled activities, account currencies, base
  currency, and transfer metadata.
- Persist daily external inflow/outflow base values into valuation rows.
- Transfer rules:
  - both accounts inside scope: internal
  - one account outside scope: external
  - missing or unpaired transfer: external with warning
  - `metadata.flow.is_external = true` forces external
- Opposite-leg inference requires unique match on user-local date, opposite
  transfer type, same asset for securities, same currency for cash, and same
  quantity/amount within Decimal tolerance.

Checks:

- Cash transfer inside same scope does not change scoped net contribution.
- Security transfer inside same scope does not change scoped net contribution.
- Transfer crossing scope boundary changes scoped net contribution.
- Unpaired transfer defaults external and emits warning.
- Holdings-mode accounts are excluded from transaction-flow performance and use
  snapshot/simple-return behavior.

## Phase 5: TWR And Modified Dietz

Goal:

- Use scoped external flows to compute correctly labeled daily returns.

Implementation:

- Keep current Modified Dietz logic but rename it explicitly.
- Compute daily TWR approximation with locked convention:

```text
r_D = (V_D + outflow_D - V_{D-1} - inflow_D) / (V_{D-1} + inflow_D)
```

- Treat valuation rows as end-of-day.
- Treat inflows as start-of-day capital.
- Treat outflows as end-of-day withdrawals.
- If denominator is `<= 0` or crosses through zero, exclude the period from
  compounding and surface a warning.

Checks:

- Numeric fixture proves deposit-on-up-day does not become investment gain.
- Numeric fixture proves withdrawal-on-up-day is handled consistently.
- Negative or zero denominator period is excluded with warning.
- Existing frontend uses new Modified Dietz fields while old MWR aliases remain
  during compatibility window.

## Phase 6: Scoped Aggregation And Portfolio Views

Goal:

- Make saved portfolios first-class valuation/performance scopes.

Implementation:

- Aggregate scoped histories from per-account base valuation rows.
- Cache scoped aggregate reads by:

```text
(instance_id or db_path, scope_id, base_currency, max(calculated_at), membership_hash)
```

- Membership hash uses sorted, deduped account IDs.
- Server cache is instance/database scoped; if true multi-user DB support is
  added later, include `user_id`.
- Frontend portfolio views, dashboard widgets, charts, holdings, allocation,
  income, and performance use `AccountScope`.

Checks:

- Saved portfolio with accounts in different currencies produces correct base
  history.
- Saved portfolio membership change uses current membership at query time.
- `All` scope and a saved portfolio containing all active accounts match.
- Cache invalidates when underlying valuation rows change.
- Cache invalidates when portfolio membership changes.

## Phase 7: Period XIRR

Goal:

- Add a true money-weighted return metric without overloading Modified Dietz.

Implementation:

- Implement Brent solver only.
- Name the metric “Period XIRR”.
- Cash-flow convention:
  - starting market value is negative anchor flow
  - external inflows are negative flows
  - external outflows are positive flows
  - ending market value is positive terminal flow
- Expose XIRR alongside TWR and Modified Dietz.

Checks:

- Solver handles normal deposit/invest/gain cases.
- Solver handles withdrawals.
- Solver returns no value with a clear reason when no valid sign change exists.
- Account-scope XIRR works before relying on saved portfolio UI.

## Phase 8: Accounting Realized P&L And Income

Goal:

- Surface total return from unrealized gain, realized P&L, and income without
  mixing in tax-reporting policy.

Implementation:

- Add `lot_disposals` accounting read model generated from FIFO lot reductions.
- Add `income_events` read model for dividends, interest, withholding tax, and
  received/source currency.
- `lot_disposals` stores proceeds, fees, sold cost basis, realized P&L,
  currencies, FX rate to base, and `basis_source = accounting_fifo`.
- No user disposal-method setting in this feature.
- Holding total return exposes:
  - unrealized gain
  - realized gain
  - income
  - simple basis return percent
- Do not call this tax gain/loss.

Checks:

- Buy then partial sell records realized P&L and sold cost basis.
- Full sell keeps realized P&L available even when open position is gone.
- Dividend/interest events attach to asset/account where available.
- Fees reduce realized P&L correctly.
- Total return equals unrealized + realized + income.
- Tax reporting can be added later without changing accounting FIFO records.

## Phase 9: Advanced Metrics And Deferred Corporate Actions

Goal:

- Add SOTA analytics after the valuation/flow foundation is stable.

Implementation:

- Add volatility, downside deviation, Sharpe, Sortino, max drawdown duration,
  recovery time, and dividend yield metrics.
- Reverse split is supported through existing `split_ratio < 1`.
- Defer spin-off, merger, rights issue, and return of capital.
- Unsupported corporate actions should be marked review-needed, not silently
  mapped to transfers.

Checks:

- Reverse split preserves quantity/value consistency.
- Risk metrics match fixture return series.
- Dividend yield uses income events and documented denominator.
- Unsupported corporate action fixtures fail clearly with review-needed status.

## Global Acceptance Checks

- Full recompute on a realistic fixture is measured before enforcing hard
  budgets.
- After Phase 6, scoped aggregation must be at least as fast as current
  dashboard reads on baseline fixtures or have a documented cache path.
- Desktop and web compile for every phase touching shared DTOs.
- Device sync tests cover legacy aggregate snapshots.
- No phase requires a tax setting, disposal-method selection, or historical
  portfolio-membership model.
