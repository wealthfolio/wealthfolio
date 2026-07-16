# Generic Signed-Lot Foundation And Option Shorts Design

- Date: 2026-06-26
- Status: target design
- Scope: generic signed-lot foundation with short options enabled first. Stock
  short selling remains product-gated and out of first-release UI scope.
- Primary inputs: initial signed option shorts implementation plan, current
  Wealthfolio code, and public SnapTrade broker documentation.

## Executive Summary

Wealthfolio should support short exposure through a generic signed-lot model:

- positive lot quantity means long exposure;
- negative lot quantity means short exposure;
- negative position quantity, cost basis, and market value are valid only when
  the instrument/account policy allows short exposure;
- user-entered quantities, prices, fees, and amounts remain stored as positive
  activity facts;
- `ActivityType` remains `BUY` and `SELL`;
- position effect is persisted as `POSITION_OPEN` or `POSITION_CLOSE`; UI labels
  and broker imports may use option aliases such as `BTO`, `STO`, `BTC`, `STC`,
  `BUY_TO_OPEN`, `SELL_TO_OPEN`, `BUY_TO_CLOSE`, or `SELL_TO_CLOSE`, and stock
  aliases such as `SELL_SHORT`, `SHORT_SELL`, `BUY_COVER`, or `BUY_TO_COVER`;
- the calculator derives the actual open/close behavior from current signed
  lots.

The current code has positive-only assumptions across position aggregation, FIFO
reduction, realized P&L recording, cost-basis aggregation, valuation, broker
sync, import, and UI. This feature must therefore be implemented as a
cross-cutting domain invariant change, not as a narrow broker or UI patch.

The target model keeps first-release stock behavior conservative. The signed-lot
helpers should be generic, but a shortability policy controls where negative
lots are allowed:

- options: enabled in this feature;
- stocks/ETFs: disabled by default until a later stock-short UX and product
  policy is implemented.

A stock oversell must not create a negative stock lot while the stock/ETF
shortability gate is disabled.

## Review-Driven Simplifications

The implementation should avoid persisting option identity on `Position` or
`snapshot_positions`. The current code already has authoritative option
classification on `Asset::is_option()`, and services that need option behavior
already load asset metadata for multiplier, expiry, pricing, or display. Keeping
option identity derived removes:

- a `snapshot_positions.is_option` migration;
- JSON snapshot shape changes;
- app-sync field changes;
- backfill logic for older snapshots;
- drift risk between asset classification and duplicated position flags.

The remaining required migration is a rebuild migration for generated read
models whose rows were calculated under positive-only option semantics.

## External Broker Reference

SnapTrade's current public documentation is the closest public reference for
Wealthfolio Connect behavior:

- SnapTrade marks the old option holdings endpoint as deprecated and points to
  the unified `positions/all` endpoint for option positions:
  https://docs.snaptrade.com/reference/Options/Options_listOptionHoldings
- SnapTrade's `positions/all` endpoint documents signed position `units`, where
  long positions are positive and short positions are negative, and documents
  option `cost_basis` as per contract:
  https://docs.snaptrade.com/reference/Account%20Information/AccountInformation_getAllAccountPositions
- SnapTrade's account activity endpoint documents option transaction `price` as
  price per share of the option contract:
  https://docs.snaptrade.com/reference/Account%20Information/AccountInformation_getAccountActivities

Implementation implication:

- broker holdings sync should treat signed `units` as authoritative; no separate
  provider side field is part of the current implementation scope;
- current Connect option holdings mirror SnapTrade option holdings:
  `average_purchase_price` is per contract and must not be multiplied by the
  option multiplier when computing holdings cost basis;
- option market `price` and transaction `price` are per share and must use the
  option multiplier when converting to economic value;
- if Connect migrates holdings sync to `positions/all`, map its option
  `cost_basis` field to the same per-contract average-cost path.

## Goals

- Build generic signed-lot internals so future stock/ETF shorts do not require a
  second lot model.
- Support signed short option positions in transaction-derived snapshots.
- Support signed short option positions in broker holdings-mode snapshots.
- Support CSV/manual workflows for option shorts without accepting negative
  user-entered activity values.
- Preserve existing long option behavior.
- Preserve existing stock behavior by keeping stock/ETF shortability disabled in
  first-release product flows.
- Preserve option identity through asset metadata, and ensure snapshot, lot,
  sync, import, and UI paths derive option behavior from that metadata.
- Produce intentional realized P&L for option open/close and crossing trades.
- Produce sensible current valuation and percentages for short options.
- Keep implementation surgical and aligned with current model boundaries.

## Non Goals

- Enabling stock/ETF short selling in the first-release UI or imports.
- Margin balance, borrow fee, hard-to-borrow fee, locate, or interest modeling.
- Short-stock dividend owed / payment-in-lieu automation.
- Option assignment and exercise automation.
- Multi-leg option strategy modeling.
- Tax-lot method changes beyond existing FIFO behavior.
- Changing activity storage to signed quantity or signed price.
- Rewriting performance methodology.

## GitHub Issue 339 Coverage

This design covers the option-specific parts of
https://github.com/wealthfolio/wealthfolio/issues/339:

- short put and short call positions;
- covered-call entry as a separate long stock position plus short call option
  position;
- broker-style `Sell to Open` and `Buy to Close` option workflow;
- option contract multiplier handling for standard and mini contracts;
- negative option quantities, signed cost basis, holdings display, valuation,
  import, and broker sync.

This design also prepares the internal model for the issue's broader stock-short
proposal by using generic signed lots and generic open/close intent. It does not
enable stock shorts in first-release product flows:

- no negative stock/ETF share quantities in first-release product flows;
- no top-level `SHORT_SELL`, `SELL_SHORT`, or `BUY_COVER` activity types;
- stock aliases such as `SELL_SHORT` and `BUY_COVER` map to generic
  `SELL + POSITION_OPEN` and `BUY + POSITION_CLOSE` only after stock/ETF
  shortability is enabled;
- no borrow fee, locate, margin, buying power, or stock-short allocation model.

## Terminology

### Activity Type

The existing high-level activity discriminator:

- `BUY`
- `SELL`
- `ADJUSTMENT`
- other existing activity types

`BUY` and `SELL` stay unchanged.

### Option Contract Type

The option contract type is part of the option asset identity:

- `CALL`: contract gives the holder the right to buy the underlying at the
  strike price;
- `PUT`: contract gives the holder the right to sell the underlying at the
  strike price.

`CALL`/`PUT` is not trade intent. A call can be bought to open, sold to open,
bought to close, or sold to close. The existing option form already captures
this through `OptionContractFields`.

### Position Effect Subtype

Optional subtype used for UX, imports, and broker audit:

- `POSITION_OPEN`: open/increase exposure on the side implied by `BUY` or
  `SELL`;
- `POSITION_CLOSE`: close/reduce exposure on the opposite side.

Broker-style labels are derived from `instrument + activity_type + subtype`:

| Instrument | Activity type | Canonical subtype | UI/broker label |
| ---------- | ------------- | ----------------- | --------------- |
| option     | `BUY`         | `POSITION_OPEN`   | Buy to Open     |
| option     | `SELL`        | `POSITION_OPEN`   | Sell to Open    |
| option     | `BUY`         | `POSITION_CLOSE`  | Buy to Close    |
| option     | `SELL`        | `POSITION_CLOSE`  | Sell to Close   |
| stock/ETF  | `SELL`        | `POSITION_OPEN`   | Sell Short      |
| stock/ETF  | `BUY`         | `POSITION_CLOSE`  | Buy to Cover    |

Accepted import/broker aliases:

- `BTO`, `BUY_TO_OPEN`, `BUY OPEN` -> `POSITION_OPEN` on `BUY`
- `STO`, `SELL_TO_OPEN`, `SELL OPEN` -> `POSITION_OPEN` on `SELL`
- `BTC`, `BUY_TO_CLOSE`, `BUY CLOSE` -> `POSITION_CLOSE` on `BUY`
- `STC`, `SELL_TO_CLOSE`, `SELL CLOSE` -> `POSITION_CLOSE` on `SELL`
- `SELL_SHORT`, `SHORT_SELL`, `SELL SHORT` -> `POSITION_OPEN` on `SELL`
- `BUY_COVER`, `BUY_TO_COVER`, `BUY COVER` -> `POSITION_CLOSE` on `BUY`

Subtypes do not override calculator reality. The calculator still uses current
lots to decide whether a trade opens or closes exposure. If subtype intent
contradicts current position state, keep processing by signed lots and surface a
warning or `needs_review` flag.

The existing `Activity.subtype` field is single-valued and already carries
semantic labels such as `DRIP`, `STAKING_REWARD`, `BONUS`, `REBATE`, `REFUND`,
and `OPTION_EXPIRY`. `POSITION_OPEN` and `POSITION_CLOSE` are valid only for
`BUY` and `SELL` rows. Do not attach position-effect subtypes to income, credit,
transfer, or adjustment rows, and add tests proving existing subtype
canonicalization and activity compilation behavior is unchanged for those
subtypes.

### Shortability Policy

Shortability is a policy decision, not a separate activity type.

Initial policy:

| Instrument | Negative lots | Product behavior        |
| ---------- | ------------- | ----------------------- |
| option     | allowed       | enabled by this feature |
| stock/ETF  | blocked       | future feature gate     |
| other      | blocked       | explicit future review  |

The signed-lot helper code should be generic, but every path that can open a
negative lot must receive an `allows_negative_lots` decision derived from asset,
account, import source, and product policy. In the first release this decision
is true for options and false for stocks/ETFs.

Concrete first-release definition:

```rust
pub struct ShortabilityPolicy;

impl ShortabilityPolicy {
    pub fn allows_negative_lots(asset: &Asset, _account_id: Option<&str>) -> bool {
        asset.is_option()
    }
}
```

Ownership:

- define the policy in core near the snapshot calculator, for example
  `crates/core/src/portfolio/snapshot/shortability_policy.rs`;
- expose only the boolean decision through `AssetPositionInfo`;
- do not let callers independently infer shortability from raw instrument type
  once the policy exists;
- keep the account parameter even if unused in the first release so a later
  stock short phase can account for margin-capable accounts without changing
  every call site.

All openers must treat this policy as a hard gate. UI/import validation should
block or mark unsupported stock short requests before calculation, and the core
signed-lot opener must still reject negative lots when the gate is false.

### Signed Lot

A signed lot:

- `quantity > 0`: long exposure
- `quantity < 0`: short exposure
- `cost_basis > 0`: long debit basis
- `cost_basis < 0`: short credit basis, net of opening fees

### Contract Multiplier

Multiplier used to convert option premium into economic value.

- standard equity option: `100`
- mini option: `10`
- fallback: `1`, only when option metadata is unavailable

## Current State Evidence

The current implementation supports long options through contract multipliers,
but assumes lots and positions are positive in many places.

### Position Model

Path: `crates/core/src/portfolio/snapshot/positions_model.rs`

Current issues:

- `Position` has `is_alternative` and `contract_multiplier`. Option identity is
  already available from the related `Asset`, but position methods currently do
  not receive that context.
- `recalculate_aggregates` zeroes negative aggregate quantity and cost basis.
- `add_lot_values` skips non-positive quantities.
- `reduce_lots_fifo` rejects non-positive reduction input and skips negative
  lots.
- `Lot::basis_status` requires positive quantity and positive cost basis.
- `Position::basis_status` ignores lots with non-positive quantity.

### Holdings Calculator

Path: `crates/core/src/portfolio/snapshot/holdings_calculator.rs`

Current issues:

- `AssetPositionInfo` has `contract_multiplier` and `is_bond`, but no
  `is_option`.
- `handle_buy` always opens a positive lot because `Activity::qty()` returns an
  absolute value.
- `handle_sell` only reduces existing positive lots. If there is no position, it
  applies cash and records no lot.
- stock oversells are clamped to available quantity.
- position cost basis aggregation filters `lot.quantity > 0`.
- option expiry uses the positive-only FIFO reducer.
- `record_lot_disposals` can support signed P&L only if close proceeds and
  removed short lots are passed with intentional signs.

### Activity Model

Path: `crates/core/src/activities/activities_model.rs`

Current facts:

- `Activity::qty()`, `Activity::price()`, `Activity::amt()`, and
  `Activity::fee_amt()` return absolute values.
- This matches the target user-facing convention.
- subtype canonicalization currently does not canonicalize position effect
  aliases such as `BTO`, `STO`, `BTC`, `STC`, `BUY_TO_OPEN`, `SELL_TO_OPEN`,
  `BUY_TO_CLOSE`, `SELL_TO_CLOSE`, `SELL_SHORT`, or `BUY_COVER`.

### Snapshot Persistence

Paths:

- `crates/core/src/portfolio/snapshot/snapshot_model.rs`
- `crates/storage-sqlite/src/portfolio/snapshot/model.rs`
- `crates/storage-sqlite/src/schema.rs`

Current issues:

- snapshot content equality compares position quantity, average cost, total cost
  basis, and currency, but does not compare `contract_multiplier` or
  `is_alternative`.
- snapshot read paths return standalone `Position` values. Any code that needs
  option-specific behavior must derive option identity from the related asset at
  the service/calculator boundary.

### Broker Holdings Sync

Paths:

- `crates/connect/src/broker/service.rs`
- `crates/connect/src/broker/models.rs`
- `crates/connect/src/broker/mapping.rs`

Current issues:

- option holdings preserve signed `units` if the provider sends them, but the
  created snapshot does not explicitly normalize option short economics.
- holdings cost basis is currently computed as `quantity * avg_cost`, which is
  correct for SnapTrade option holdings because `average_purchase_price` is per
  contract. The implementation needs fixtures so this path is not later changed
  to incorrectly multiply holdings cost basis by the option multiplier.
- option DTOs mostly accept snake_case field names. Connect or broker payloads
  may send camelCase names such as `optionSymbol`, `optionPositions`,
  `isMiniOption`, and `averagePurchasePrice`.
- broker transaction mapping passes type/subtype through, but does not
  canonicalize position effect aliases into `POSITION_OPEN` / `POSITION_CLOSE`.

### Valuation

Paths:

- `crates/core/src/portfolio/holdings/holdings_valuation_service.rs`
- `crates/core/src/portfolio/valuation/current_account_valuation.rs`

Current issues:

- gain percentage returns `None` when basis is negative.
- expired options are treated as a long option loss with `-100%`, which is wrong
  for expired short options.
- expired options are skipped from current valuation.
- day-change percentage on negative market value can have an unintuitive sign if
  the denominator is not absolute.

### Frontend And Imports

Paths:

- `apps/frontend/src/lib/constants.ts`
- `apps/frontend/src/pages/activity/components/forms/buy-form.tsx`
- `apps/frontend/src/pages/activity/components/forms/sell-form.tsx`
- `apps/frontend/src/pages/activity/components/forms/fields/advanced-options-section.tsx`
- `apps/frontend/src/pages/activity/import/utils/validation-utils.ts`
- `apps/frontend/src/pages/asset/asset-profile-page.tsx`
- `apps/frontend/src/pages/asset/asset-lots-table.tsx`

Current issues:

- no generic position effect subtype constants exist.
- buy/sell option forms hide intent controls.
- sell form warns that an oversell may create a short position even for stocks,
  but backend does not support stock shorts.
- import grids use global subtype choices rather than row-aware choices.
- CSV import normalizes numeric fields to absolute values, which is correct, but
  option amount derivation needs multiplier awareness.
- option expiry action only includes `quantity > 0` holdings.
- lot table fallback percentages divide by signed cost basis.

## Target Invariants

### Activity Storage Invariants

Activity numeric fields remain positive:

- `quantity >= 0`
- `unit_price >= 0`
- `fee >= 0`
- `amount >= 0`

Direction is represented by:

- `activity_type`: `BUY` or `SELL`
- asset identity and shortability policy
- current signed lots
- optional subtype for UX/audit

No negative user-entered activity value should be required for short exposure.

### Position Invariants

Do not add or persist `Position.is_option` or `Position.allows_short`. The
authoritative instrument identity comes from `Asset`, and the permission to open
negative lots comes from runtime shortability policy. This avoids duplicating
asset classification into every snapshot row, avoids a snapshot sync migration,
and prevents drift if asset metadata or shortability policy changes later.

Any service that can apply signed-lot logic must load or receive asset metadata
and an `allows_negative_lots` decision before opening a negative lot.

Rules:

- positions with `allows_negative_lots = false` must have `quantity >= 0` after
  recalculation;
- positions with `allows_negative_lots = true` may have positive, zero, or
  negative quantity;
- signed positions may have positive or negative total cost basis;
- average cost for signed positions must be stable and display-safe:
  - if quantity is positive, `average_cost = total_cost_basis / quantity`;
  - if quantity is negative,
    `average_cost = abs(total_cost_basis) / abs(quantity)` for display, or keep
    signed average only if all downstream callers are audited;
  - recommendation: store `average_cost` as positive per-contract cost/credit
    for signed positions, and store sign in `quantity` and `total_cost_basis`.

Rationale:

- asset metadata is already required for multiplier, expiry, pricing, and
  display;
- signed quantity and signed total cost basis are enough for economics;
- positive average cost avoids UI and broker diff surprises;
- realized P&L should use lot cost basis, not displayed average cost.

### Lot Invariants

No `Lot.is_option` or `Lot.allows_short` field is required. The lot belongs to
exactly one asset through its position, and instrument identity plus
shortability policy are resolved by the caller.

Rules:

- long lot:
  - `quantity > 0`
  - `original_quantity > 0`
  - `cost_basis > 0`
  - `acquisition_price > 0`
- short lot:
  - `quantity < 0`
  - `original_quantity < 0`
  - `cost_basis < 0`
  - `acquisition_price > 0`
- closed lots preserve the original sign in closure records.

Opening fee handling:

```text
long buy-to-open cost_basis = gross_debit + opening_fee
short sell-to-open cost_basis = -gross_credit + opening_fee
```

The short opening fee reduces the net credit because it makes the negative cost
basis less negative.

### Cash Invariants

For signed trade accounting:

```text
gross = quantity_abs * unit_price * instrument_multiplier
```

`instrument_multiplier` is the option contract multiplier for options and `1`
for stocks/ETFs and ordinary securities.

Cash effects:

```text
Buy to Open cash = -(gross + fee)
Sell to Close cash = +(gross - fee)
Sell to Open cash = +(gross - fee)
Buy to Close cash = -(gross + fee)
```

Because activity storage uses only `BUY` and `SELL`:

- all `BUY` activities are cash outflows;
- all `SELL` activities are cash inflows;
- when crossing through zero, the single activity cash effect stays unchanged,
  but lot accounting splits the close and open portions internally.

### Realized P&L Invariants

For disposal records:

```text
realized_pnl = proceeds - removed_cost_basis
```

Long close example:

```text
open long cost_basis = +100
sell close proceeds = +120
realized_pnl = +120 - +100 = +20
```

Short close example:

```text
open short cost_basis = -100
buy close proceeds = -80
realized_pnl = -80 - -100 = +20
```

Therefore buy-to-close lots must pass negative disposal proceeds into
`record_lot_disposals`.

Crossing trades allocate fees and proceeds by absolute contract quantity:

```text
close_qty_abs / total_activity_qty_abs
open_qty_abs / total_activity_qty_abs
```

The allocated close fee is part of close proceeds. The allocated open fee is
part of new lot cost basis.

### Valuation Invariants

Market value remains signed:

```text
market_value = quantity * quote_price * contract_multiplier
```

Unrealized gain remains:

```text
unrealized_gain = market_value - cost_basis
```

Examples:

```text
short option opened for 100 credit:
quantity = -1
cost_basis = -100
market_value at 80 debit = -80
unrealized_gain = -80 - -100 = +20

short option opened for 100 credit:
quantity = -1
cost_basis = -100
market_value at 130 debit = -130
unrealized_gain = -130 - -100 = -30
```

Percentage denominators:

- option-short holding and lot gain percentages use `abs(cost_basis)`;
- long holdings use positive cost basis as today;
- day-change percentages for signed market value should use
  `abs(previous_market_value)` when previous value is nonzero;
- portfolio-level allocation percentages should not blindly use absolute math.
  If net portfolio value is zero or negative, return `None`, omit percent, or
  surface a data-quality warning depending on the API contract.

Expired options:

- expired long option:
  - market value becomes zero;
  - unrealized gain is `-cost_basis`;
  - gain percent is `-100%`.
- expired short option:
  - market value becomes zero;
  - unrealized gain is `-cost_basis`, which is positive when cost basis is
    negative;
  - gain percent is `+100%` when measured against `abs(cost_basis)`.

## Data Model Changes

### Position

File: `crates/core/src/portfolio/snapshot/positions_model.rs`

Do not add fields to `Position`.

Instead, add generic signed-lot methods whose callers must have already
established asset identity and shortability:

- keep existing `add_lot_values` and `reduce_lots_fifo` positive-only;
- add a signed lot opener;
- add a negative-lot FIFO closer;
- add an internal aggregate recalculation helper that accepts a policy such as
  `allows_negative_lots`.

This keeps the snapshot schema stable and keeps stock behavior unchanged while
stock/ETF shortability remains disabled.

### AssetPositionInfo And Shortability

File: `crates/core/src/portfolio/snapshot/holdings_calculator.rs`

Add:

```rust
is_option: bool,
allows_negative_lots: bool,
```

Populate from asset metadata and product policy:

```rust
let is_option = asset.is_option();
let allows_negative_lots = shortability_policy.allows_negative_lots(asset, account);
```

`Asset::is_option()` already exists and checks
`instrument_type == Some(InstrumentType::Option)`. For the first release, the
policy should return `true` for options and `false` for stocks/ETFs.

### Snapshot Positions Table

No `snapshot_positions` schema change is required for option identity.

The existing `asset_id` foreign key already points at the authoritative asset
record, and `contract_multiplier` is already persisted for historical valuation
semantics. Read paths that need option behavior should load asset metadata
beside snapshot positions, as current holdings and current valuation paths
already do for pricing, expiry, and display.

Generated read models must be cleared:

```sql
DELETE FROM lot_disposals;
DELETE FROM lots;
DELETE FROM daily_account_valuation;
DELETE FROM holdings_snapshots
WHERE source = 'CALCULATED';
```

Notes:

- deleting calculated `holdings_snapshots` should cascade to their
  `snapshot_positions` rows if the FK cascade is active;
- surviving manual or broker holdings snapshots do not need option-identity
  backfill; option identity should be derived from their assets when those
  snapshots are read.

### Snapshot JSON

Do not add `isOption` to snapshot JSON. Old and new JSON snapshots should keep
the same shape for this feature. The runtime code that needs option behavior
must derive it from asset metadata.

### Snapshot Equality And Diff

File: `crates/core/src/portfolio/snapshot/snapshot_model.rs`

Update `positions_equal` to compare:

- `asset_id`
- `quantity`
- `average_cost`
- `total_cost_basis`
- `currency`
- `is_alternative`
- `contract_multiplier`

Rationale:

- broker holdings diff must detect multiplier changes;
- option identity changes belong to asset metadata. A corrected asset instrument
  type should not require rewriting every snapshot position row.

### App Sync

Files to audit:

- `crates/core/src/sync/app_sync_model.rs`
- storage sync table serializers and deserializers
- any sync migration/version handling

Requirements:

- no new sync field is required for option identity;
- ensure existing asset sync preserves `instrument_type = OPTION` and option
  metadata before snapshot positions that reference those assets are rebuilt;
- keep existing snapshot position sync and JSON fallback behavior unchanged.

## Core Algorithm Design

### Generic Signed-Lot Helpers

Keep the current positive-only FIFO API intact for existing callers. Add generic
signed-lot helpers for the buy/sell calculator and broker/import snapshot paths.
Do not relax `reduce_lots_fifo` globally.

Recommended helper surface:

```rust
impl Position {
    pub fn open_lot_signed(
        &mut self,
        lot_id: String,
        signed_quantity: Decimal,
        unit_price: Decimal,
        fee: Decimal,
        acquisition_date: DateTime<Utc>,
        fx_rate_used: Option<Decimal>,
        source_activity_id: Option<String>,
        book_basis: LotBookBasis,
        allows_negative_lots: bool,
    ) -> Result<Decimal>;

    pub fn recalculate_aggregates_with_policy(
        &mut self,
        allows_negative_lots: bool,
    );

    pub fn reduce_positive_lots_fifo(
        &mut self,
        quantity_abs: Decimal,
    ) -> Result<FifoReductionResult>;

    pub fn reduce_negative_lots_fifo(
        &mut self,
        quantity_abs: Decimal,
    ) -> Result<FifoReductionResult>;
}
```

Rules:

- `handle_buy`, `handle_sell`, option expiry, broker holdings sync, and manual
  holdings import must call signed helpers only after passing an
  `allows_negative_lots` decision.
- `open_lot_signed` must reject negative signed quantities when
  `allows_negative_lots = false`.
- `open_lot_signed` should be the only path that can append a negative lot.
- aggregate recalculation must be policy-aware: if
  `allows_negative_lots = false` and signed aggregation would produce negative
  quantity or cost basis, return an error or clamp with an explicit warning. Do
  not silently persist a negative stock/ETF position while the gate is disabled.
- signed helpers do not need a persisted `Position.is_option` or
  `Position.allows_short` guard.
- existing `add_lot_values` and `reduce_lots_fifo` keep current positive stock
  behavior.
- `FifoReductionResult.quantity_reduced` should be absolute quantity for both
  positive and negative reducers.
- removed short lots keep negative `quantity` and negative `cost_basis`.

### Recalculate Aggregates

For positions with `allows_negative_lots = false`:

- preserve current behavior;
- if aggregate quantity is negative, zero or warn as today.

For positions with `allows_negative_lots = true`:

- sum signed effective quantity;
- sum signed cost basis;
- preserve negative quantity and negative cost basis;
- if signed quantity is insignificant, clear quantity and cost basis only when
  all lots are closed or insignificant;
- compute average cost with absolute denominator for display:

```rust
if quantity_abs_is_significant {
    average_cost = total_cost_basis.abs() / quantity.abs();
} else {
    average_cost = Decimal::ZERO;
}
```

### BUY Processing

File: `crates/core/src/portfolio/snapshot/holdings_calculator.rs`

Current `handle_buy` always opens a positive lot. Change behavior:

1. Load `AssetPositionInfo`.
2. Use `asset_info.allows_negative_lots`, not `asset_info.is_option`, to decide
   whether the trade may cross through zero.
3. If negative lots are allowed:
   - ensure position is created with the asset's `contract_multiplier`;
   - book cash outflow for the full activity as today;
   - reduce negative lots first using absolute activity quantity;
   - pass negative close proceeds to `record_lot_disposals`;
   - if activity quantity exceeds closed short quantity, open a positive lot for
     the excess.
4. If negative lots are not allowed, keep current positive-only BUY behavior.

Pseudo-code:

```rust
fn handle_signed_buy(...) -> Result<()> {
    let qty_abs = activity.qty();
    let gross = gross_trade_amount(activity, asset_info);
    let fee = activity.fee_amt();
    let unit_price = effective_unit_price(activity, asset_info);

    if !asset_info.allows_negative_lots {
        return handle_positive_only_buy(...);
    }

    book_cash_outflow(gross + fee);

    let close_qty = min(qty_abs, abs(position.negative_open_quantity()));
    let open_qty = qty_abs - close_qty;

    let close_fee = allocate_by_qty(fee, close_qty, qty_abs);
    let open_fee = fee - close_fee;

    if close_qty > 0 {
        let close_gross = unit_price * close_qty;
        let close_proceeds = -(close_gross + close_fee);
        let reduction = position.reduce_negative_lots_fifo(close_qty)?;
        record_lot_disposals(..., close_proceeds, reduction.quantity_reduced, ...);
        record_lot_closures(...);
    }

    if open_qty > 0 {
        position.open_lot_signed(
            ..., +open_qty, unit_price, open_fee, ..., asset_info.allows_negative_lots,
        )?;
    }
}
```

### SELL Processing

Current `handle_sell` only closes positive lots. Change behavior:

1. Load `AssetPositionInfo`.
2. Use `asset_info.allows_negative_lots`, not `asset_info.is_option`, to decide
   whether the trade may cross through zero.
3. If negative lots are allowed and the trade has explicit or default-open
   intent:
   - ensure position is created with the asset's `contract_multiplier`;
   - book cash inflow for the full activity as today;
   - reduce positive lots first;
   - pass positive close proceeds to `record_lot_disposals`;
   - if activity quantity exceeds closed long quantity, open a negative lot for
     the excess.
4. If negative lots are not allowed, keep current positive-only SELL behavior
   and never open a negative lot.

Pseudo-code:

```rust
fn handle_signed_sell(...) -> Result<()> {
    let qty_abs = activity.qty();
    let gross = gross_trade_amount(activity, asset_info);
    let fee = activity.fee_amt();
    let unit_price = effective_unit_price(activity, asset_info);

    if !asset_info.allows_negative_lots {
        return handle_positive_only_sell(...);
    }

    book_cash_inflow(gross - fee);

    let close_qty = min(qty_abs, position.positive_open_quantity());
    let open_qty = qty_abs - close_qty;

    let close_fee = allocate_by_qty(fee, close_qty, qty_abs);
    let open_fee = fee - close_fee;

    if close_qty > 0 {
        let close_gross = unit_price * close_qty;
        let close_proceeds = close_gross - close_fee;
        let reduction = position.reduce_positive_lots_fifo(close_qty)?;
        record_lot_disposals(..., close_proceeds, reduction.quantity_reduced, ...);
        record_lot_closures(...);
    }

    if open_qty > 0 {
        if should_open_short(activity, asset_info, position) {
            position.open_lot_signed(
                ..., -open_qty, unit_price, open_fee, ..., asset_info.allows_negative_lots,
            )?;
        } else {
            handle_oversell_without_short_intent(...)?;
        }
    }
}
```

### Crossing Trade IDs

A single activity may both close and open exposure. The open lot ID must not
collide with disposal IDs or existing activity-based lot IDs.

Recommended IDs:

```text
{activity.id}:open
{activity.id}:close:{lot.id}:{index}
```

If existing lot records require `open_activity_id` to match an activity row for
cascade deletes, keep `source_activity_id = Some(activity.id.clone())` and use a
stable synthetic lot `id`.

### Disposal Allocation For Short Lots

`record_lot_disposals` currently allocates proceeds by:

```rust
total_proceeds * effective_quantity / total_quantity_reduced
```

For short lots, `effective_quantity` may be negative. That would invert the
allocation. Update disposal allocation to use absolute quantities:

```rust
let effective_quantity_abs = lot.effective_quantity().abs();
let proceeds =
    total_proceeds * effective_quantity_abs / total_quantity_reduced_abs;
```

Persist disposal quantity as the absolute closed quantity unless downstream tax
reporting explicitly needs the signed quantity. If signed quantity is persisted,
all reports must be audited.

### Cost Basis Aggregation

Update account snapshot cost basis aggregation:

- positions with `allows_negative_lots = false`: existing positive-lot behavior;
- positions with `allows_negative_lots = true`: include signed lots;
- if position has no lots, use signed `position.total_cost_basis`.

Files:

- `crates/core/src/portfolio/snapshot/holdings_calculator.rs`
- `crates/core/src/lots/mod.rs`
- storage lot read model queries

Quote sync should not rely on net quantity alone when long and short positions
in different accounts net to zero. Use "any open lot by asset" or sum of
absolute quantities where quote planning needs exposure existence.

### Option Expiry

Current `OPTION_EXPIRY` reduces positive lots only.

New behavior:

- if option position quantity is positive, close positive lots with zero
  proceeds;
- if option position quantity is negative, close negative lots with zero
  proceeds;
- record realized P&L through the same disposal path:
  - long expiry: `0 - positive_cost_basis = loss`;
  - short expiry: `0 - negative_cost_basis = gain`.

Use activity quantity as absolute contracts to expire.

Frontend expiry creation must submit `abs(quantity)` for negative holdings.

### Subtype Validation And Warnings

Subtype should not determine accounting, but it is useful for review.

Validation rules:

- `BUY` and `SELL` may have `POSITION_OPEN` or `POSITION_CLOSE`;
- options may open negative lots because option shortability is enabled in this
  feature;
- stock/ETF rows should not show short-open or buy-cover controls while
  stock/ETF shortability is disabled;
- stock/ETF imports that contain `SELL_SHORT`, `SHORT_SELL`, `BUY_COVER`, or
  `BUY_TO_COVER` should canonicalize for audit but remain blocked or
  `needs_review` until stock/ETF shortability is enabled;
- imports and broker sync may accept aliases but must canonicalize them to
  `POSITION_OPEN` or `POSITION_CLOSE`.

Warning examples:

- subtype `POSITION_CLOSE` on a `BUY` but no short option lots exist, so the
  trade opened a long lot;
- subtype `POSITION_CLOSE` on a `SELL` but no long option lots exist, so the
  trade opened a short lot;
- stock activity requests `POSITION_OPEN` short exposure while the stock/ETF
  shortability gate is disabled.

Warnings can initially be logs or `needs_review` flags. Do not block broker
imports unless the data is structurally invalid.

### Explicit Short Intent Versus Oversell

Do not treat every oversell as an intentional short.

Rules:

- option `SELL` may default to `POSITION_OPEN` when there is no open long
  quantity, matching broker "sell to open" behavior and the first-release option
  UX;
- stock/ETF `SELL` without an explicit `POSITION_OPEN`, `SELL_SHORT`, or
  `SHORT_SELL` label is an ordinary sell. While stock/ETF shortability is
  disabled, preserve current positive-only behavior and do not create a negative
  lot;
- stock/ETF `SELL` with explicit short intent while stock/ETF shortability is
  disabled must be blocked in manual UI and marked `needs_review` or rejected in
  imports/broker sync before it reaches the calculator;
- when stock/ETF shortability is enabled in a later phase, stock/ETF short
  opening should still require explicit short intent. A plain stock oversell
  should remain a data-quality issue, missing-history issue, or positive-only
  clamp rather than silently becoming a short sale.

Enforcement points:

- manual UI validation: hide disabled stock short controls and reject submitted
  stock/ETF `POSITION_OPEN` short intent while disabled;
- CSV/import review validation:
  `apps/frontend/src/pages/activity/import/utils/validation-utils.ts` should
  flag disabled stock/ETF short intent before import submission;
- core import and sync preparation:
  `crates/core/src/activities/activities_service.rs` should canonicalize the
  subtype, preserve the raw alias in metadata when useful, and keep disabled
  stock/ETF short rows out of normal calculated activity flow by returning
  review/rejection;
- broker mapping: `crates/connect/src/broker/mapping.rs` may canonicalize broker
  aliases, but broker service preparation must not let disabled stock/ETF short
  intent create a calculated negative stock lot;
- calculator: `open_lot_signed(..., allows_negative_lots = false)` is the final
  backstop and must reject negative openings even if validation missed a path.

## Broker Sync Design

### DTO Alias Coverage

Files:

- `crates/connect/src/broker/models.rs`
- `crates/connect/src/broker/mapping.rs`

Add serde aliases for option-related DTO fields where Connect may send camelCase
or snake_case.

Examples:

```rust
#[serde(alias = "optionSymbol")]
pub option_symbol: Option<HoldingsOptionSymbol>,

#[serde(alias = "optionPositions")]
pub option_positions: Option<Vec<HoldingsOptionPosition>>,

#[serde(alias = "isMiniOption")]
pub is_mini_option: Option<bool>,

#[serde(alias = "averagePurchasePrice")]
pub average_purchase_price: Option<f64>,
```

Also audit:

- `expirationDate`
- `strikePrice`
- `underlyingSymbol`
- `rawSymbol`
- `symbolType`
- `micCode`
- activity option fields such as `optionType`

### Transaction Sync

Requirements:

- preserve option asset identity;
- preserve and canonicalize position effect subtype;
- normalize option multiplier before calculator use;
- store positive quantity and unit price;
- normalize amount so calculator does not understate or overstate option
  economics.

Subtype canonicalization:

```text
BTO, BUY_TO_OPEN, BUY OPEN, OPEN -> POSITION_OPEN when activity_type = BUY
STO, SELL_TO_OPEN, SELL OPEN, OPEN -> POSITION_OPEN when activity_type = SELL
BTC, BUY_TO_CLOSE, BUY CLOSE, CLOSE -> POSITION_CLOSE when activity_type = BUY
STC, SELL_TO_CLOSE, SELL CLOSE, CLOSE -> POSITION_CLOSE when activity_type = SELL
SELL_SHORT, SHORT_SELL, SELL SHORT -> POSITION_OPEN when activity_type = SELL
BUY_COVER, BUY_TO_COVER, BUY COVER -> POSITION_CLOSE when activity_type = BUY
```

Preserve the raw provider subtype in metadata when broker audit needs the exact
source value. The canonical `Activity.subtype` should be `POSITION_OPEN` or
`POSITION_CLOSE`.

If a stock/ETF broker transaction maps to `POSITION_OPEN` short exposure while
stock/ETF shortability is disabled, do not silently create a negative stock lot.
Mark the row `needs_review` or block it according to the import path.

Amount normalization policy:

SnapTrade documents option activity `price` as premium per share. The existing
calculator path derives multiplier-inclusive economics as:

```text
gross_trade_amount = qty * price * contract_multiplier
```

For current SnapTrade/Connect option transactions, keep `quantity` as contracts,
keep `price` as premium per share, and do not make `amount` authoritative for
normal option BUY/SELL rows.

Still add provider fixtures that lock down option `price`, `amount`, and
currency signs before enabling signed broker option transactions.

Use this policy:

1. For SnapTrade/Connect option activity payloads, store unit price and let the
   calculator derive `qty * price * multiplier`.
2. If fixture proves amount is total premium and multiplier-inclusive while unit
   price is absent or unreliable for a future provider, store `amount` and
   metadata that makes `should_use_activity_amount` treat it as authoritative.
3. If fixture proves price is per contract for a future provider, convert to
   per-share price before persistence or store total `amount` with the
   authoritative metadata above.
4. If a payload is ambiguous, do not compute trusted broker option basis from
   it. Mark the activity or holdings row `needs_review` and keep source metadata
   for inspection.

The calculator currently ignores `amount` for normal buy/sell rows when both
quantity and unit price are present. That is acceptable for SnapTrade/Connect
option transactions because unit price is premium per share and multiplier is
available. If broker amount should override price for options in another
provider, update `should_use_activity_amount` with an explicit broker metadata
signal instead of making all options amount-authoritative.

### Holdings-Mode Sync

Files:

- `crates/connect/src/broker/service.rs`
- `crates/connect/src/broker/models.rs`

Requirements:

- signed option `units` become signed `Position.quantity`;
- `contract_multiplier` comes from option metadata;
- mini options use multiplier 10;
- standard options use multiplier 100;
- `average_cost` is positive display cost or credit per contract;
- `total_cost_basis` is signed:
  - long: positive;
  - short: negative.

Cost basis normalization:

```text
if provider_average_purchase_price_is_per_contract:
    avg_cost_per_contract = average_purchase_price
else if provider_cost_basis_is_per_contract:
    avg_cost_per_contract = cost_basis
else if provider_average_purchase_price_is_per_share:
    avg_cost_per_contract = average_purchase_price * contract_multiplier
else if provider_total_cost_basis_is_available:
    avg_cost_per_contract = abs(total_cost_basis) / abs(units)
```

Then:

```text
total_cost_basis =
    sign(units) * abs(units) * avg_cost_per_contract
average_cost = avg_cost_per_contract
```

For current SnapTrade/Connect option holdings:

```text
avg_cost_per_contract = average_purchase_price
total_cost_basis = units * average_purchase_price
market_value = units * price * contract_multiplier
```

Do not multiply `average_purchase_price` by `contract_multiplier` in holdings
mode. The multiplier is already baked into SnapTrade option holdings basis. Only
apply the multiplier to per-share option `price` when deriving market value or
transaction gross amount.

If Connect migrates to SnapTrade `positions/all`, map option `cost_basis` to
`avg_cost_per_contract` and keep the same no-extra-multiplier basis rule.

Do not compute option holdings basis from ambiguous price fields without a test
fixture.

### Broker Snapshot Diff

Snapshot diff/content equality must include:

- signed quantity;
- total cost basis;
- `contract_multiplier`.

Asset option identity is compared through the asset record, not duplicated on
the snapshot position.

## CSV And Manual Import Design

### Activity CSV Import

Current import normalizes numeric values to absolute values. Keep that behavior.

Add row-aware position effect subtype support:

- allow `POSITION_OPEN` / `POSITION_CLOSE` only when the row's instrument and
  shortability policy support the requested effect;
- canonicalize aliases to `POSITION_OPEN` or `POSITION_CLOSE`;
- preserve raw provider subtype in metadata for audit when needed.

Option amount derivation:

- if quantity and unit price exist, leave `amount` empty where possible and let
  backend derive with multiplier;
- if import UI derives amount, multiply by contract multiplier;
- if multiplier is unknown at import-review time, mark row needs review or defer
  amount derivation to backend.

### Holdings CSV Import

Manual holdings snapshot rows must set:

- `contract_multiplier` from option metadata;
- signed quantity only when the row's instrument allows negative lots;
- positive average cost per contract;
- signed total cost basis.

Do not allow negative quantity for stocks in holdings import while stock/ETF
shortability is disabled.

### Manual UI

Manual activity forms:

- keep quantity and price inputs positive;
- option buy form should expose intent segmented control:
  - `Buy to Open` -> `POSITION_OPEN`
  - `Buy to Close` -> `POSITION_CLOSE`
- option sell form should expose intent segmented control:
  - `Sell to Close` -> `POSITION_CLOSE`
  - `Sell to Open` -> `POSITION_OPEN`
- default can be inferred from holdings:
  - BUY defaults to `POSITION_CLOSE` if there is an open short quantity,
    otherwise `POSITION_OPEN`;
  - SELL defaults to `POSITION_CLOSE` if there is open long quantity, otherwise
    `POSITION_OPEN`.
- stock/ETF buy/sell forms should not expose `Sell Short` or `Buy to Cover`
  until stock/ETF shortability is enabled.

Important:

- intent is a hint and persisted subtype;
- calculator still splits crossing trades by lots.

Sell warning:

- for options: "This may open a short option position."
- for stocks: "Selling more than available holdings is unsupported and will not
  create a short stock position."

### Target Option Activity Form

The current buy/sell forms already have the right base structure:

- asset type selector;
- account and date;
- option contract fields through `OptionContractFields`;
- contracts, premium/share, fee, contract multiplier, and total debit/credit;
- currency/FX advanced options;
- notes.

Target change: add a position-effect segmented control immediately after the
option contract fields and before trade details. In the first release this
control is visible only for option trades; future stock/ETF shortability can use
the same `positionEffect` field with stock labels.

Buy option form:

```text
Account
Date
Option Contract
  Underlying | Expiration | Call/Put | Strike
Intent
  [Buy to Open] [Buy to Close]
Trade Details
  Contracts | Premium/Share | Fee
  Multiplier: 100x
  Total Debit
Advanced Options
Notes
```

Sell option form:

```text
Account
Date
Option Contract
  Underlying | Expiration | Call/Put | Strike
Intent
  [Sell to Close] [Sell to Open]
Current Position
  Long N contracts or Short N contracts when available
Trade Details
  Contracts | Premium/Share | Fee
  Multiplier: 100x
  Total Credit
Warnings
Advanced Options
Notes
```

Implementation details:

- add `positionEffect` or `subtype` to `buyFormSchema` and `sellFormSchema`;
- map buy/sell position effect to payload `subtype`;
- keep `CALL`/`PUT` inside `OptionContractFields`;
- do not show stock/ETF short controls while stock/ETF shortability is disabled;
- do not use `AdvancedOptionsSection` for position effect, because intent is a
  primary trade field, not an advanced field;
- update `activity-form-config.ts` so BUY/SELL defaults read `activity.subtype`
  and `toPayload` writes it for supported activities;
- button text should reflect selected intent for options:
  - `Buy to Open`
  - `Buy to Close`
  - `Sell to Close`
  - `Sell to Open`

## Frontend Reporting Design

### Holdings And Asset Profile

Requirements:

- display signed quantity for option holdings;
- label short options clearly where existing UI supports status text;
- use backend-provided gain percentages when available;
- if frontend fallback is needed, use `abs(costBasis)` for short option
  percentages;
- do not render `-100%` for expired short options.

### Lots Table

File: `apps/frontend/src/pages/asset/asset-lots-table.tsx`

Fallback math:

```text
market_value = quantity * market_price * contract_multiplier
gain_loss = market_value - cost_basis
gain_loss_percent =
    cost_basis != 0 ? gain_loss / abs(cost_basis) : null
```

When long and short lots are shown together, totals should avoid misleading
average unit cost if signed quantities net near zero. Show `N/A` or use separate
long and short summaries.

### Expiry Action

File: `apps/frontend/src/pages/asset/asset-profile-page.tsx`

Change:

```ts
const nonZeroHoldings = accountHoldings.filter((h) => h.quantity !== 0);
quantity: String(Math.abs(h.quantity));
```

Guard:

- only for option assets;
- keep current long option behavior.

### Import Review Grid

Subtype options must be row-aware:

- BUY option: `Buy to Open` and `Buy to Close`
- SELL option: `Sell to Close` and `Sell to Open`
- stock/ETF BUY/SELL while shortability is disabled: no `Sell Short` or
  `Buy to Cover` choices
- future stock/ETF shortability enabled:
  - SELL stock/ETF: `Sell Short`
  - BUY stock/ETF: `Buy to Cover`

Avoid adding global BUY/SELL subtype options that appear for all securities.

## Valuation And Performance Design

### Current Valuation

Market value stays signed:

```text
quantity * quote_price * contract_multiplier
```

Current account totals may be reduced by short liabilities. This is correct.

Guardrails:

- if total portfolio value is zero or negative, percentage allocations should be
  omitted or returned as `None`;
- if API models cannot represent `None`, return zero and include a warning. A
  model change is preferable if the affected field is user-facing.

### Holding Gain Percent

Use:

```text
denominator = abs(cost_basis)
```

for signed positions when cost basis is negative.

### Day Change Percent

Use:

```text
day_change_pct = day_change / abs(previous_market_value)
```

for signed positions.

This makes a short option liability that becomes more negative show a negative
day change percentage.

### Performance

No performance methodology change is required for the first implementation.

Explicit requirements:

- signed market value flows through daily valuation rows;
- external flows are not created for option open/close trades beyond normal
  trade cash;
- TWR does not treat short liability changes as external flows. Current flow
  classification already treats `BUY` and `SELL` as internal flows, so add
  regression tests rather than a new flow type;
- portfolio value-return fallback does not divide by zero or negative net
  denominator.

## Migration And Rebuild Plan

### Migration Steps

No schema column is required for option identity. Add a rebuild migration that
clears generated read models affected by old positive-only option semantics:

1. Clear generated read models:
   - `lot_disposals`
   - `lots`
   - `daily_account_valuation`
   - calculated `holdings_snapshots`
2. Leave manual and broker holdings snapshots in place. Derive option identity
   from their assets when reading or recalculating them.
3. Rebuild generated snapshots and valuations through existing calculation
   flows.

### Why Read Models Must Be Cleared

Existing generated rows were calculated with positive-only lot semantics. They
cannot be patched safely because:

- short SELL rows may have applied cash without creating short lots;
- oversold option quantities may have been clamped;
- lot disposal P&L may be missing or wrong;
- valuation percentages and market values may have been calculated with old
  denominator rules.

### Rollback Considerations

This migration is not data-destructive for user source facts:

- activities remain;
- assets remain;
- accounts remain;
- manual/broker source snapshots remain unless explicitly generated;
- generated read models are rebuilt.

Because this design does not add a snapshot schema column, rollback risk is
limited to generated read models being recalculated by the older positive-only
logic. Treat app downgrade after recalculation as unsupported unless verified.

## Implementation Order

### Phase 1: Asset-Derived Shortability Context And Rebuild Migration

Files:

- `crates/core/src/portfolio/snapshot/positions_model.rs`
- new migration under `crates/storage-sqlite/migrations`
- snapshot equality tests

Tasks:

- do not add persisted option identity to `Position`, snapshot JSON, or
  `snapshot_positions`;
- add `ShortabilityPolicy` in core with first-release behavior
  `asset.is_option()`;
- add `AssetPositionInfo.is_option` and `AssetPositionInfo.allows_negative_lots`
  in calculator context;
- ensure services that can apply signed logic load asset metadata and
  shortability policy before opening negative lots;
- add a migration that clears generated read models;
- update snapshot equality/diff to include `contract_multiplier` and
  `is_alternative`.

Verification:

- no snapshot schema change is required;
- old snapshot JSON continues to deserialize;
- generated read models are cleared by migration;
- first-release shortability is derived from `Asset::is_option()` where signed
  logic runs, with stock/ETF shortability disabled.

### Phase 2: Generic Signed Lot Operations

Files:

- `crates/core/src/portfolio/snapshot/positions_model.rs`
- `crates/core/src/portfolio/snapshot/holdings_calculator.rs`
- `crates/core/src/lots/mod.rs`
- storage lot repository queries

Tasks:

- add generic signed lot opening gated by `allows_negative_lots`;
- add negative-lot FIFO close;
- update aggregate recalculation to accept/enforce `allows_negative_lots`;
- update basis status to include negative lots when signed lots are allowed;
- update lot extraction and disposal persistence for negative lots;
- update cost-basis aggregation to include signed short lots.

Verification:

- sell-to-open creates negative quantity and negative cost basis;
- buy-to-close partial close leaves negative remaining quantity and correct
  basis;
- buy-to-close full close closes lot and records positive/negative P&L
  correctly;
- stock oversell behavior is unchanged while stock/ETF shortability is disabled.
- policy-aware aggregate recalculation rejects or clamps leaked negative stock
  quantity when `allows_negative_lots = false`.

### Phase 3: Buy/Sell Calculator Split Logic

Files:

- `crates/core/src/portfolio/snapshot/holdings_calculator.rs`
- activity ordering code used by the snapshot calculation flow
- existing calculator tests

Tasks:

- use `AssetPositionInfo.allows_negative_lots` to decide whether buy/sell may
  cross through zero;
- branch `handle_buy` and `handle_sell` into signed-lot behavior only when
  negative lots are allowed;
- require explicit `POSITION_OPEN` intent for future stock/ETF short opening;
- keep plain stock/ETF oversells as positive-only/missing-history behavior while
  stock/ETF shortability is disabled;
- allocate fees across close/open legs;
- pass signed disposal proceeds intentionally;
- record closures for fully consumed negative lots;
- add subtype mismatch warnings;
- make same-timestamp activity ordering deterministic before signed lots are
  calculated.

Verification:

- sell long then open short excess;
- buy short then open long excess;
- fee allocation across crossing trades;
- FX conversion on close and open legs;
- same timestamp option trades use a stable secondary ordering key;
- no stock short creation.
- explicit disabled stock short intent is blocked/reviewed before calculation.

### Phase 4: Broker Sync

Files:

- `crates/core/src/activities/activities_constants.rs`
- `crates/core/src/activities/activities_model.rs`
- `crates/connect/src/broker/models.rs`
- `crates/connect/src/broker/mapping.rs`
- `crates/connect/src/broker/service.rs`

Tasks:

- add canonical activity subtype constants:
  - `POSITION_OPEN`
  - `POSITION_CLOSE`
- canonicalize position effect aliases in `NewActivity::canonicalize_subtype`;
- validate position effect aliases against `BUY` / `SELL` when activity type is
  known, including option aliases and stock-short aliases;
- ensure `POSITION_OPEN` / `POSITION_CLOSE` do not collide with existing
  single-valued subtypes such as `DRIP`, `STAKING_REWARD`, and `OPTION_EXPIRY`;
- add serde aliases;
- canonicalize broker subtype aliases;
- normalize option transaction price as per share and holdings basis as per
  contract;
- compute signed holdings cost basis correctly;
- add fixtures for snake_case and camelCase payloads.

Verification:

- broker transaction option open/close imports with subtype and correct
  economics;
- broker short option holdings produce signed snapshot;
- option holdings basis uses `units * average_purchase_price` without an extra
  multiplier;
- option holdings market value uses `units * price * contract_multiplier`;
- mini option multiplier 10 works in transaction and holdings modes;
- malformed or ambiguous broker amount marks review rather than silently
  corrupting economics.

### Phase 5: Valuation And Reporting

Files:

- `crates/core/src/portfolio/holdings/holdings_valuation_service.rs`
- `crates/core/src/portfolio/valuation/current_account_valuation.rs`
- allocation and holdings aggregation services

Tasks:

- use absolute denominator for option-short holding percentages;
- fix expired short option gain percentage;
- audit day-change percentages for signed market value;
- guard portfolio percentages when net denominator is zero or negative;
- ensure quote planning uses exposure existence, not only net quantity.

Verification:

- short option price down shows positive unrealized gain;
- short option price up shows negative unrealized gain;
- expired short option shows positive gain and `+100%` where applicable;
- zero or negative portfolio denominator does not produce misleading percent.

### Phase 6: Frontend And Imports

Files:

- `apps/frontend/src/lib/constants.ts`
- activity buy/sell forms
- advanced options section
- import review grid and validation utilities
- asset profile expiry action
- asset lots table

Tasks:

- add generic position effect constants and instrument-specific display names;
- add row-aware position effect controls;
- keep stock short controls hidden while stock/ETF shortability is disabled;
- update oversell warning by asset type;
- update CSV amount derivation for options;
- update expiry to include negative option holdings;
- update frontend fallback percentages.

Verification:

- option BUY can persist `POSITION_OPEN` / `POSITION_CLOSE`;
- option SELL can persist `POSITION_OPEN` / `POSITION_CLOSE`;
- stock BUY/SELL does not show `Sell Short` / `Buy to Cover` while stock/ETF
  shortability is disabled;
- import review subtype choices are row-aware;
- expiry works for long and short option holdings.

## Test Plan

### Core Position Tests

Add tests for:

- option position aggregate preserves negative quantity and cost basis;
- stock position aggregate does not preserve negative quantity;
- policy-aware aggregate recalculation rejects/clamps leaked stock negative
  quantity when `allows_negative_lots = false`;
- stock BUY/SELL paths pass `allows_negative_lots = false`;
- stock oversells do not create negative lots;
- negative option lot basis status is complete when cost basis is known;
- average cost remains positive for short option positions;
- split-adjusted effective quantity preserves sign for signed lots;
- split-on-short-stock fixture remains blocked while stock/ETF shortability is
  disabled and is listed as required before enabling stock shorts.

### Core Calculator Tests

Add tests for:

- buy-to-open long option with multiplier 100 remains unchanged;
- sell-to-open creates:
  - cash inflow net of fee;
  - negative position quantity;
  - negative total cost basis;
  - negative lot quantity;
  - no realized P&L on open;
- partial buy-to-close creates:
  - cash outflow;
  - less negative remaining quantity;
  - realized P&L using signed close proceeds;
  - no positive long lot when close quantity is less than short quantity;
- full buy-to-close closes the short lot;
- buy-to-close larger than short quantity closes short and opens long excess;
- sell-to-close larger than long quantity closes long and opens short excess;
- crossing trade fees are allocated by absolute quantity;
- FX conversion preserves signs for close proceeds and cost basis;
- stock oversell does not create negative lot;
- enabling `allows_negative_lots` in a focused unit test lets the same generic
  signed-lot helper represent non-option short exposure without option-specific
  code;
- plain stock oversell without explicit short intent follows existing
  positive-only behavior and does not become a short;
- explicit stock `POSITION_OPEN` / `SELL_SHORT` intent is blocked or marked
  review while stock/ETF shortability is disabled;
- option expiry:
  - long expiry realizes loss;
  - short expiry realizes gain.

### Persistence And Migration Tests

Add tests for:

- old and new snapshot JSON deserialize without an `isOption` field;
- `snapshot_positions` insert/read round trip remains unchanged;
- services that need option behavior derive it from asset metadata;
- `ShortabilityPolicy` returns true for options and false for stock/ETF in the
  first release;
- migration clears generated read models without adding a schema column;
- app sync rebuild of `snapshot_positions` remains unchanged and still depends
  on asset rows being restored before snapshot position rows.

### Broker Tests

Add fixtures for:

- broker transaction aliases `BTO` / `BUY_TO_OPEN`;
- broker transaction aliases `STO` / `SELL_TO_OPEN`;
- broker transaction aliases `BTC` / `BUY_TO_CLOSE`;
- broker transaction aliases `STC` / `SELL_TO_CLOSE`;
- broker transaction aliases `SELL_SHORT` / `SHORT_SELL` canonicalize to
  `POSITION_OPEN` but are blocked or marked `needs_review` while stock/ETF
  shortability is disabled;
- broker transaction aliases `BUY_COVER` / `BUY_TO_COVER` canonicalize to
  `POSITION_CLOSE` but are blocked or marked `needs_review` while stock/ETF
  shortability is disabled;
- snake_case option holdings payload;
- camelCase option holdings payload;
- short option holdings with negative units;
- option holdings cost basis uses `units * average_purchase_price` with no extra
  multiplier;
- option holdings quote/market value uses `units * price * contract_multiplier`;
- mini option holdings with multiplier 10;
- future-provider ambiguous amount payload marked for review;
- disabled stock/ETF short broker rows are review/rejected before calculation,
  even though aliases canonicalize.

### Import And UI Tests

Add tests for:

- option CSV missing amount derives multiplier-inclusive economics;
- option CSV with BTO/STO/BTC/STC aliases canonicalizes to `POSITION_OPEN` or
  `POSITION_CLOSE`;
- stock CSV row cannot select `Sell Short` / `Buy to Cover` while stock/ETF
  shortability is disabled;
- manual option holding can represent negative quantity;
- manual stock holding rejects negative quantity;
- stock short aliases are hidden/rejected while stock/ETF shortability is
  disabled;
- expiry action submits absolute quantity for negative option holding;
- lot table fallback percent uses absolute short basis.

### Subtype Compatibility Tests

Add tests for:

- `DRIP`, `DIVIDEND_IN_KIND`, `STAKING_REWARD`, `BONUS`, `REBATE`, `REFUND`, and
  `OPTION_EXPIRY` canonicalization remains unchanged;
- `POSITION_OPEN` and `POSITION_CLOSE` are accepted only for `BUY` / `SELL`;
- activity compiler expansion for DRIP, dividend-in-kind, and staking rewards is
  unchanged after adding position-effect subtypes.

### Stock-Short Gate Tests

Add tests before enabling stock/ETF shortability:

- short-stock dividend activity is blocked/reviewed or modeled as a cash
  outflow;
- split-on-negative-stock lot preserves sign and signed aggregate quantity;
- portfolio and account return series handle zero or negative denominator
  periods.

### Valuation Tests

Add tests for:

- short option liability market value is negative;
- short option price decrease produces positive gain;
- short option price increase produces negative gain;
- gain percent uses absolute cost basis;
- expired short option gain percent is positive;
- day-change percent uses absolute previous signed value;
- portfolio percentage guard for zero or negative total value.

## Edge Cases And Decisions

### Mixed Long And Short Lots In One Option

The calculator should normally close the opposite side before opening a new
side, so one account should not have simultaneous long and short lots for the
same option after a single ordered activity stream.

Still audit for:

- imported holdings snapshots;
- manual snapshots;
- deleted activities followed by recalculation;
- same timestamp ordering.

If simultaneous signs exist, aggregate quantity can net to zero while exposure
still exists. Reporting should prefer separate lot display over a misleading net
average cost.

### Same-Day Ordering

Current activity ordering should be preserved. If same timestamp ordering is
unstable, add deterministic secondary ordering by activity creation time or ID.
This matters for buy-to-open then sell-to-close versus sell-to-open then
buy-to-close on the same date.

### Deleting Or Editing Activities

Generated snapshots and lot read models should rebuild from source activities.
Do not try to patch signed lots in place after activity edits.

### Assignment And Exercise

Out of scope for this feature.

Recommended behavior for now:

- keep imported assignment/exercise transactions as `needs_review`;
- do not convert them into stock trades automatically;
- add a future design for assignment/exercise once signed option shorts are
  stable.

### Covered Calls And Spreads

Covered calls and spreads are naturally represented as separate signed option
and stock positions. There is no strategy-level grouping in this design.

### Margin And Buying Power

Out of scope. A short position may create a liability, but this design does not
model margin requirements or buying power.

### Stock Shorts: Required Before Enablement

The first release must keep stock/ETF shortability disabled. Before changing
`ShortabilityPolicy` to allow stock/ETF negative lots, add a separate
stock-short implementation plan and cover at least these items:

- short-stock dividends: current income handling books `DIVIDEND` as a cash
  inflow from `activity.amount`. Short equity holders owe dividends, so dividend
  events against short stock exposure must become cash outflows or explicit
  payment-in-lieu activities. Do not enable stock shorts until this is modeled
  or blocked with review.
- explicit short intent: stock/ETF short opening must require `POSITION_OPEN`,
  `SELL_SHORT`, or `SHORT_SELL`. Plain stock oversells without explicit short
  intent remain data-quality or missing-history issues and must not silently
  open shorts.
- stock splits on negative lots: split application preserves lot sign when
  multiplying by a positive split ratio, but signed aggregate recalculation and
  basis status must include negative lots. Add split-on-short-stock tests before
  enabling stock/ETF shortability.
- borrow fees, hard-to-borrow fees, locate, margin, buying power, and dividends
  owed are not automatic in this feature. Decide whether they are manual
  expenses, broker-imported activities, or first-class calculations before
  claiming stock short support.
- portfolio allocation and exposure: stock shorts can make net account or
  portfolio value zero or negative and can create gross exposure much larger
  than net value. Add explicit allocation/exposure UI rules before enabling
  stock shorts.
- performance series: large stock shorts can push value-return denominators near
  zero or negative more often than option shorts. Add tests and API behavior for
  zero/negative denominator periods before enabling stock shorts.
- tax and compliance: stock shorts may need different tax-lot treatment, wash
  sale handling, dividends-in-lieu, and borrow-fee reporting. Keep these outside
  this option-short release.

### Currency

Lot cost basis should stay anchored to acquisition-date FX as today. Short close
proceeds must preserve sign through FX conversion.

### Rounding

Use existing decimal precision rules. Avoid rounding before splitting close and
open legs except where existing storage boundaries require it.

### Negative Zero

Normalize insignificant signed quantities and cost basis to zero after
recalculation. Avoid displaying `-0`.

## Acceptance Criteria

The feature is complete when:

- signed-lot helper code is generic and gated by `allows_negative_lots`;
- `ShortabilityPolicy` is implemented in core and returns true only for options
  in the first release;
- a manual option SELL with no existing long position creates a signed short
  option lot;
- a manual option BUY against that short position closes it and records realized
  P&L correctly;
- long option behavior still passes existing tests;
- stock oversells and stock `SELL_SHORT` aliases do not create short stock lots
  while stock/ETF shortability is disabled;
- disabled stock/ETF short intent is blocked or marked `needs_review` before
  calculation, not silently handled as a calculated short;
- broker holdings-mode short option snapshots preserve signed quantity and
  signed cost basis;
- broker transaction-mode option open/close imports produce signed lots after
  recalculation;
- mini option multiplier 10 is respected;
- generated read models rebuild after migration;
- option identity is derived from asset metadata; no duplicated snapshot option
  flag is required;
- valuation displays short option liabilities and gains with correct signs;
- expired short options show gain, not `-100%` loss;
- existing non-trade subtypes such as `DRIP`, `STAKING_REWARD`, and
  `OPTION_EXPIRY` keep their current behavior;
- UI import/manual activity flows expose option open/close labels for options
  and hide stock short labels until stock/ETF shortability is enabled.

## Open Questions

- Should `average_cost` for short signed positions be stored positive for
  display or signed for strict accounting? This design recommends positive
  average cost with signed total cost basis.
- Should subtype mismatch warnings become blocking validation in manual UI, or
  only `needs_review` in imports?
- Should portfolio-level percentage API models be changed from decimal to
  nullable decimal where net denominator can be zero or negative?
