# Allocation Advisor SOTA Target Model Specification

Status: Historical draft. Rebalancing superseded — see below Date: 2026-05-07
Audience: Product, frontend, backend, desktop, web, and addon engineers

> **Rebalancing in this document is superseded.**
>
> [`self-directed-rebalancing-design.md`](./self-directed-rebalancing-design.md)
> is the current direction for everything this document says about rebalancing,
> scenarios, trade generation and the copy that goes with them. This one is kept
> as a record of the earlier target-model thinking, not as a source of truth for
> behaviour the current design leaves unstated.
>
> It predates PR #1486 and the product-boundary rework that followed. §1 still
> frames the feature as an advisor that answers "what exact draft trades would
> move me toward the target?", which is the direction that was withdrawn: the
> app no longer selects, ranks or constructs a course of action.
>
> Superseded specifically: §4.3, §5.5, §5.7, §5.8, §5.9, §6.4, §6.5, §6.6, §7.4,
> §7.5, §11.3, §11.4, §11.5 and Phase 2 of §13. In particular the three scenario
> modes and their labels are replaced by the two modes in §4 of the current
> design, and `ExecutionPolicy` is not the shape the turnover cap and the
> reduction constraints actually shipped in — see PR #1177.
>
> The target model itself (§5.1, §5.2, §5.3, §6.1, §6.2, §6.3) is still a useful
> reference and is broadly what shipped.

## 1. Purpose

This document specifies a greenfield allocation target and rebalancing advisor
for Wealthfolio. It should not be constrained by any existing pull request,
prototype schema, or prototype UI. Existing Wealthfolio allocation and taxonomy
services are treated only as platform capabilities.

The goal is to turn Wealthfolio from a current-allocation viewer into an
allocation advisor that can answer:

- What is my intended portfolio?
- How far am I from it?
- When should I act?
- Should I use new cash, sell overweight positions, or do both?
- What exact draft trades would move me toward the target?
- What tax, account, turnover, and cash constraints shaped the plan?

This is product and engineering design, not investment advice. Wealthfolio
should help users model and execute their own rules without implying that any
asset mix is suitable for every user.

## 2. Current Wealthfolio Context

Wealthfolio already has the core foundation needed for this feature:

- Local-first portfolio data in SQLite.
- Desktop through Tauri IPC.
- Web mode through Axum HTTP handlers.
- React frontend with adapter-based runtime selection.
- A taxonomy engine for grouping assets by dimensions such as asset class,
  sector, region, risk category, instrument type, and custom taxonomies.
- A current-allocation service that computes portfolio allocation by taxonomy.
- Holdings, accounts, quotes, asset classifications, and market values.

The new feature should build on that foundation while keeping target modeling,
rebalancing policy, funding policy, and trade planning as separate domain
concepts.

Expected architecture flow:

```text
Frontend
  -> adapters/tauri or adapters/web
  -> Tauri command or Axum REST route
  -> crates/core allocation-advisor services
  -> crates/storage-sqlite repositories
  -> SQLite
```

## 3. Product Principles

1. Targets are the source of truth. Current allocation is observed state.
   Targets are desired state.

2. Rebalancing is policy-driven. "When to act" must be separate from "how to
   trade".

3. Cash should be first-class. Cash can be a target sleeve, available funding, a
   reserve, and a trade constraint. These are related but not identical.

4. Taxable accounts need restraint. Selling to rebalance may create tax impact.
   Wealthfolio should prefer contribution-based correction when it satisfies the
   policy.

5. Drafts before action. The system proposes plans and trades. Users review,
   exclude, export, or execute through supported workflows.

6. Explain every recommendation. Every trade recommendation needs a plain reason
   and the constraints applied.

7. Multi-dimensional analysis is not automatically multi-dimensional targeting.
   Asset class can be a primary target while geography, sector, risk, and
   account placement act as guardrails unless the optimizer explicitly supports
   simultaneous constraints.

8. The model must support assets not currently owned. A user must be able to
   target a sleeve, category, or model allocation with zero current holdings.

## 4. Industry Standard Baseline

The feature should follow common portfolio-management practices used by major
brokerages, robo-advisors, and advisor tools.

### 4.1 Target Allocation

An investor defines an intended asset mix. Market movement, contributions,
withdrawals, income, and price changes cause the current mix to drift from that
target. Rebalancing restores or moves the portfolio closer to the intended risk
target.

Common target types:

- Strategic asset allocation: long-term target percentages.
- Model portfolio: reusable target mix such as three-fund, 60/40, all-weather,
  income-focused, or custom.
- Glide path: target changes over time, usually age/date based.
- Account-specific model: account has its own target within a larger household
  or portfolio target.

### 4.2 Rebalance Triggers

Industry sources commonly describe three trigger families:

- Calendar: review or rebalance on a schedule, such as quarterly or annually.
- Threshold: rebalance when drift breaches a tolerance band.
- Hybrid: review on a schedule and rebalance only if drift exceeds threshold.

Vanguard describes calendar, threshold, and calendar-plus-threshold methods, and
highlights the tradeoff between tracking error and transaction costs. Fidelity
describes the same three approaches and notes that rebalancing can involve
selling overweight positions and buying underweight ones, while new
contributions may help avoid taxable sells.

### 4.3 Cash-Flow Rebalancing

Before selling, the system should try to use:

- New contributions.
- Dividends and interest.
- Matured fixed income.
- Existing excess cash above reserve.
- Withdrawals directed from overweight sleeves.

This is especially important in taxable accounts because selling winners can
realize gains.

### 4.4 Tax-Aware Rebalancing

State-of-the-art rebalancing tools account for:

- Taxable vs tax-advantaged accounts.
- Short-term vs long-term capital gains.
- Loss harvesting opportunities.
- Wash-sale risk.
- Asset location preferences.
- Minimum trade size.
- Turnover caps.
- Do-not-trade assets.
- Lot-level selection where available.

Schwab's advisor rebalancing tooling describes rule-based rebalancing, tax-aware
household-level rebalancing, tax-loss harvesting, cash management, and order
approval workflows as professional-grade capabilities.

### 4.5 Value Averaging

Value averaging is a funding strategy. It defines a target portfolio value path
over time and calculates the contribution needed to stay on that path. It is not
an allocation target and not a rebalance trigger.

In Wealthfolio it belongs under Funding Policy:

- Fixed top-up amount.
- Percentage-of-plan top-up.
- Target value path.
- Contribution cap.
- Overflow gains handling.
- Fractional vs whole-unit purchase preference.
- Schedule and end condition.

The output of value averaging is an available contribution amount. The
allocation/rebalancing engine then decides where that contribution should go.

## 5. Core Domain Model

The SOTA model has eight independent but connected entities.

```text
AllocationTarget
  -> AllocationTargetWeight[]
  -> TargetGuardrail[]
  -> HoldingTarget[]
  -> RebalancePolicy
  -> FundingPolicy
  -> ExecutionPolicy
  -> RebalanceRun[]
       -> TradeDraft[]
```

### 5.1 AllocationTarget

Defines the desired portfolio model for a scope.

Fields:

| Field             | Type              | Notes                                          |
| ----------------- | ----------------- | ---------------------------------------------- |
| id                | string            | UUID                                           |
| name              | string            | User-visible name                              |
| scope_type        | enum              | portfolio, account, account_group              |
| scope_id          | string nullable   | Null for whole portfolio                       |
| base_currency     | string            | ISO currency code                              |
| objective         | enum nullable     | growth, balanced, income, preservation, custom |
| model_type        | enum              | template, custom, imported                     |
| version           | integer           | Increment on material changes                  |
| effective_from    | date nullable     | For scheduled/glide changes                    |
| rebalance_goal    | enum              | nearest_band, exact_target                     |
| min_trade_amount  | decimal text      | Future planner minimum trade amount            |
| whole_shares_only | boolean           | Future planner execution constraint            |
| created_at        | datetime          | UTC                                            |
| updated_at        | datetime          | UTC                                            |
| archived_at       | datetime nullable | Null for normal targets; set when archived     |

Rules:

- Multiple targets can exist per scope.
- The monitored target is selected outside the target row.
- Selecting a target does not mutate the previous target.
- Scope is explicit. Do not use sentinel account IDs like "TOTAL" or "PORTFOLIO"
  in persisted target records.

### 5.2 AllocationTargetWeight

Defines a target sleeve in a primary taxonomy.

Fields:

| Field               | Type             | Notes                                  |
| ------------------- | ---------------- | -------------------------------------- |
| id                  | string           | UUID                                   |
| target_id           | string           | Parent AllocationTarget                |
| taxonomy_id         | string           | Usually asset_classes for v1           |
| category_id         | string           | References taxonomy category           |
| parent_node_id      | string nullable  | Enables nested sleeve targets          |
| target_bps          | integer          | 0 to 10000                             |
| min_bps             | integer nullable | Lower tolerance bound                  |
| max_bps             | integer nullable | Upper tolerance bound                  |
| drift_threshold_bps | integer nullable | Override policy default                |
| rebalance_priority  | integer          | Lower number acts first                |
| is_required         | boolean          | Required in target even if no holdings |
| is_locked           | boolean          | UI cannot auto-adjust this row         |
| created_at          | datetime         | UTC                                    |
| updated_at          | datetime         | UTC                                    |

Rules:

- Top-level allocation target weights for a target must sum to 10000 bps.
- Child weights under the same parent must sum to 10000 bps of their parent if
  child targeting is enabled.
- A target weight can reference a category with no current holdings.
- If min/max are omitted, the RebalancePolicy default band applies.

### 5.3 TargetGuardrail

Defines secondary constraints that should be monitored or optionally enforced.

Examples:

- US region 40% to 70%.
- Technology sector maximum 25%.
- Single holding maximum 10%.
- Cash reserve minimum $10,000.
- Taxable account maximum bond interest exposure.

Fields:

| Field          | Type             | Notes                                           |
| -------------- | ---------------- | ----------------------------------------------- |
| id             | string           | UUID                                            |
| target_id      | string           | Parent AllocationTarget                         |
| guardrail_type | enum             | taxonomy, holding, account, cash, concentration |
| taxonomy_id    | string nullable  | Required for taxonomy guardrails                |
| category_id    | string nullable  | Category for taxonomy guardrails                |
| asset_id       | string nullable  | Asset for holding guardrails                    |
| account_id     | string nullable  | Account-specific constraint                     |
| min_bps        | integer nullable | Percentage minimum                              |
| max_bps        | integer nullable | Percentage maximum                              |
| min_amount     | decimal nullable | Currency minimum                                |
| max_amount     | decimal nullable | Currency maximum                                |
| severity       | enum             | info, warning, block                            |
| enforcement    | enum             | monitor_only, constrain_plan, block_plan        |

Rules:

- Guardrails do not need to sum to 100%.
- V1 should default guardrails to monitor-only unless the user enables
  constraint enforcement.
- Multi-dimensional optimizer behavior must be explicit. Do not pretend a
  monitor-only guardrail has shaped trades.

### 5.4 HoldingTarget

Defines optional instrument targets inside an allocation sleeve.

Fields:

| Field               | Type             | Notes                         |
| ------------------- | ---------------- | ----------------------------- |
| id                  | string           | UUID                          |
| allocation_node_id  | string           | Parent AllocationTargetWeight |
| asset_id            | string           | Asset/instrument              |
| target_bps          | integer nullable | Target inside the sleeve      |
| min_bps             | integer nullable | Lower band inside sleeve      |
| max_bps             | integer nullable | Upper band inside sleeve      |
| buy_priority        | integer nullable | Lower number buys first       |
| sell_priority       | integer nullable | Lower number sells first      |
| substitute_group_id | string nullable  | For equivalent ETFs/funds     |
| is_locked           | boolean          | Prevent auto-adjust           |
| is_buyable          | boolean          | Can receive buys              |
| is_sellable         | boolean          | Can be sold by plans          |

Rules:

- Holding targets are optional.
- If omitted, the engine allocates within a sleeve by configured default:
  proportional current weight, priority list, cheapest eligible ETF, or user
  selected preferred asset.
- Holding targets inside a sleeve should sum to 10000 bps only when strict
  holding targeting is enabled for that sleeve.

### 5.5 RebalancePolicy

Defines when Wealthfolio should prompt the user to rebalance.

Fields:

| Field                | Type          | Notes                                          |
| -------------------- | ------------- | ---------------------------------------------- |
| id                   | string        | UUID                                           |
| target_id            | string        | Parent AllocationTarget                        |
| trigger_type         | enum          | manual, calendar, threshold, hybrid            |
| review_frequency     | enum nullable | weekly, monthly, quarterly, semiannual, annual |
| next_review_date     | date nullable | Used for calendar/hybrid                       |
| default_band_bps     | integer       | Example: 500 for +/-5%                         |
| band_type            | enum          | absolute, relative                             |
| rebalance_to         | enum          | exact_target, nearest_band                     |
| notify_on_breach     | boolean       | UI/notification trigger                        |
| require_confirmation | boolean       | Always true for v1                             |

Rules:

- Trigger evaluates whether action is recommended.
- Trigger does not determine whether trades use cash or sells.
- V1 default: hybrid, quarterly review, absolute 500 bps band, rebalance to
  nearest band.

### 5.6 FundingPolicy

Defines how new money enters the plan.

Fields:

| Field                  | Type             | Notes                                                           |
| ---------------------- | ---------------- | --------------------------------------------------------------- |
| id                     | string           | UUID                                                            |
| target_id              | string           | Parent AllocationTarget                                         |
| funding_mode           | enum             | none, manual_cash, recurring_contribution, dca, value_averaging |
| cash_source            | enum             | user_input, account_cash, dividends_interest, external          |
| default_cash_amount    | decimal nullable | Optional prefill                                                |
| reserve_amount         | decimal nullable | Cash to keep uninvested                                         |
| contribution_frequency | enum nullable    | weekly, monthly, quarterly, annual                              |
| start_date             | date nullable    | For scheduled funding                                           |
| end_condition          | enum nullable    | none, date, target_value                                        |
| target_value_path      | json nullable    | Value averaging path parameters                                 |
| max_top_up_amount      | decimal nullable | Cap contribution                                                |
| overflow_action        | enum nullable    | hold_cash, next_period, sell_excess                             |
| fractional_units       | boolean          | Whether fractional shares are allowed                           |

Rules:

- Empty manual cash input is zero, not invalid.
- Value averaging calculates contribution amount first. Allocation happens after
  that amount is known.
- Reserve cash is not deployable unless the user explicitly includes it.

### 5.7 ExecutionPolicy

Defines how a rebalance plan is allowed to create trades.

Fields:

| Field               | Type             | Notes                                         |
| ------------------- | ---------------- | --------------------------------------------- |
| id                  | string           | UUID                                          |
| target_id           | string           | Parent AllocationTarget                       |
| scenario_mode       | enum             | cash_flow_only, sell_to_rebalance, hybrid     |
| allow_sells         | boolean          | False for cash-flow-only                      |
| tax_mode            | enum             | ignore, aware, strict                         |
| lot_selection       | enum nullable    | fifo, lifo, hifo, loss_first, long_term_first |
| wash_sale_check     | boolean          | Requires lot/history support                  |
| min_trade_amount    | decimal          | Skip tiny trades                              |
| min_trade_bps       | integer nullable | Skip tiny portfolio changes                   |
| max_turnover_bps    | integer nullable | Cap total trade volume                        |
| max_realized_gain   | decimal nullable | User-defined cap                              |
| whole_shares_only   | boolean          | False if fractional allowed                   |
| asset_location      | enum             | ignore, prefer_tax_efficient, enforce_rules   |
| blocked_asset_ids   | json             | Do-not-trade list                             |
| preferred_asset_ids | json             | Buy candidates by sleeve                      |

Rules:

- ExecutionPolicy produces scenarios and trade drafts.
- Scenario labels must be clear: "Cash-flow only", "Sell to rebalance",
  "Hybrid".
- Do not label execution scenarios as strategies.

### 5.8 RebalanceRun

Immutable snapshot of one calculation.

Fields:

| Field                | Type             | Notes                                      |
| -------------------- | ---------------- | ------------------------------------------ |
| id                   | string           | UUID                                       |
| target_id            | string           | Allocation target used                     |
| target_version       | integer          | Version at calculation time                |
| scope_type           | enum             | Copied from target                         |
| scope_id             | string nullable  | Copied from target                         |
| run_status           | enum             | draft, accepted, exported, canceled, stale |
| scenario_mode        | enum             | Scenario calculated                        |
| base_currency        | string           | Currency                                   |
| portfolio_value      | decimal          | Snapshot value                             |
| available_cash       | decimal          | Deployable input                           |
| max_drift_bps_before | integer          | Before plan                                |
| max_drift_bps_after  | integer          | Estimated after plan                       |
| turnover_bps         | integer          | Estimated turnover                         |
| estimated_tax_impact | decimal nullable | If available                               |
| explanation          | json             | Constraints and summary                    |
| created_at           | datetime         | UTC                                        |

Rules:

- Runs are immutable. Recalculate instead of mutating old run math.
- A run becomes stale when holdings, quotes, targets, or policies change.

### 5.9 TradeDraft

User-reviewable proposed trade.

Fields:

| Field              | Type             | Notes                       |
| ------------------ | ---------------- | --------------------------- |
| id                 | string           | UUID                        |
| run_id             | string           | Parent RebalanceRun         |
| action             | enum             | buy, sell                   |
| account_id         | string           | Account where trade occurs  |
| asset_id           | string           | Asset/instrument            |
| symbol             | string           | Display symbol snapshot     |
| quantity           | decimal          | Shares/units                |
| estimated_price    | decimal          | Quote used                  |
| estimated_amount   | decimal          | Quantity \* price           |
| sleeve_category_id | string           | Target sleeve reason        |
| reason             | string           | Human-readable reason       |
| tax_lot_ids        | json nullable    | If lot-level support exists |
| estimated_gain     | decimal nullable | Tax estimate                |
| wash_sale_warning  | boolean          | Warning flag                |
| is_excluded        | boolean          | User excluded from plan     |
| exclusion_reason   | string nullable  | Optional                    |

Rules:

- Draft trades are not booked transactions.
- Exported drafts should preserve calculation assumptions.
- Excluding a trade recalculates estimated after-state for the run view.

## 6. Calculation Semantics

### 6.1 Allocation Percent

For each target scope:

```text
current_bps = current_value / total_scope_value * 10000
target_bps = target allocation weight
drift_bps = current_bps - target_bps
value_delta = current_value - target_value
target_value = total_scope_value * target_bps / 10000
```

Interpretation:

- Positive drift: current is overweight.
- Negative drift: current is underweight.
- Positive value_delta: dollars above target.
- Negative value_delta: dollars needed to reach target.

### 6.2 Tolerance Bands

For absolute bands:

```text
min_bps = target_bps - band_bps
max_bps = target_bps + band_bps
```

For relative bands:

```text
min_bps = target_bps * (1 - relative_band)
max_bps = target_bps * (1 + relative_band)
```

Rules:

- Clamp min at 0.
- Clamp max at 10000.
- A sleeve is out of band if current_bps < min_bps or current_bps > max_bps.
- Max drift for the header is max(abs(drift_bps)) across required sleeves.

### 6.3 Rebalance Trigger Evaluation

Manual:

- Never prompts automatically.
- User can always run a plan.

Calendar:

- Prompt when current date >= next_review_date.

Threshold:

- Prompt when any required sleeve breaches its configured band.

Hybrid:

- Prompt when current date >= next_review_date and at least one required sleeve
  breaches its band.

Default:

- V1 should use hybrid quarterly reviews with +/-5 percentage point absolute
  bands.

### 6.4 Rebalance-To Behavior

Exact target:

- Generate trades that aim for target_bps.
- Higher trade volume.
- Better tracking.

Nearest band:

- Generate minimum trades needed to move every breached sleeve back inside its
  band.
- Lower turnover.
- Better default for taxable accounts.

Default:

- Nearest band for taxable or mixed scopes.
- Exact target only when user selects it or scope is fully tax-advantaged.

### 6.5 Scenario Generation

The plan screen should support scenario comparison.

Cash-flow only:

- Uses available deployable cash.
- Buys underweight sleeves.
- Does not sell overweight non-cash holdings.
- Best for regular contributions and taxable accounts.

Sell to rebalance:

- Sells overweight sleeves.
- Uses proceeds to buy underweight sleeves.
- Can restore target faster.
- May create tax and transaction costs.

Hybrid:

- Uses available cash first.
- Sells only when cash cannot bring breached sleeves inside band.
- Applies turnover, tax, minimum trade, do-not-trade, and wash-sale constraints.
- Recommended default scenario for advanced users.

### 6.6 Trade Candidate Selection

For each underweight sleeve:

1. Resolve buy candidates:
   - Holding targets if configured.
   - Preferred assets for the sleeve.
   - Existing holdings in the sleeve.
   - User-selected asset from model template.

2. Remove ineligible candidates:
   - blocked assets.
   - non-buyable assets.
   - missing quote.
   - violates guardrail with enforcement enabled.

3. Allocate budget:
   - by holding target shortfall when configured.
   - by priority when configured.
   - proportional to target weights otherwise.

4. Convert amount to quantity:
   - fractional quantity if allowed.
   - whole shares if required.

5. Skip trades below minimum trade amount or minimum trade bps.

For each overweight sleeve:

1. Resolve sell candidates:
   - sellable holdings in overweight sleeve.
   - tax lots if available.
   - holdings that violate guardrails.

2. Sort by execution policy:
   - loss-first for tax-aware harvesting.
   - long-term-first to avoid short-term gains.
   - highest cost basis first where supported.
   - user priority.

3. Respect constraints:
   - max realized gain.
   - wash-sale warning or block.
   - do-not-trade assets.
   - min residual holding.
   - turnover cap.

4. Generate sell drafts and recompute buy budget.

### 6.7 Value Averaging Funding

Value averaging should be a FundingPolicy mode.

Inputs:

- Start date.
- Review cadence.
- Target value path:
  - fixed dollar growth per period, or
  - percentage growth per period.
- Current portfolio value.
- Prior value averaging contributions.
- Max top-up cap.
- Overflow action.
- Fractional/whole-unit preference.

Output:

```text
target_portfolio_value_for_period
required_top_up = target_portfolio_value_for_period - current_portfolio_value
available_cash = clamp(required_top_up, 0, max_top_up_amount)
overflow = max(current_portfolio_value - target_portfolio_value_for_period, 0)
```

The resulting available_cash is passed to the selected execution scenario.

## 7. UX Specification

The feature should have three main surfaces.

```text
Allocation Advisor
  -> Monitor current vs target
  -> Drill into sleeves and holdings
  -> See drift, bands, guardrails, and trigger state

Targets & Policy
  -> Choose scope
  -> Pick or build target model
  -> Tune target sleeves and bands
  -> Configure rebalance trigger
  -> Configure funding policy
  -> Configure execution policy
  -> Save draft or select

Rebalance Plan
  -> Compare scenarios
  -> Explain before/after drift
  -> Show tax/turnover/cash constraints
  -> Review, exclude, save, export, or execute draft trades
```

### 7.1 Navigation

Recommended advisor navigation:

- Allocation
- Targets & Policy
- Rebalance Plan

Avoid:

- Calling execution modes "strategies".
- Hiding target setup inside the allocation monitor.
- Mixing dividend-income analytics into allocation unless income is the selected
  objective.

### 7.2 Allocation Advisor Screen

Purpose:

- Show current allocation against the selected allocation target.
- Make drift and breach state obvious.
- Let users inspect what holdings make up a sleeve.

Primary controls:

- Scope selector.
- Selected target selector.
- Primary dimension tabs:
  - Asset class.
  - Account.
  - Holding.
- Secondary guardrail tabs:
  - Geography.
  - Sector.
  - Risk.
  - Custom taxonomy.

Core content:

- Donut or stacked composition for current allocation.
- Side-by-side target vs current rows.
- Bands displayed as visible ranges.
- Max drift summary.
- Number of sleeves out of band.
- Next review date.
- Trigger status.
- Holdings table filtered by selected sleeve.

Row display:

| Column  | Meaning                   |
| ------- | ------------------------- |
| Sleeve  | Category name and color   |
| Current | Current percent and value |
| Target  | Target percent            |
| Band    | Min/max or threshold      |
| Drift   | Current - target          |
| Action  | Inspect holdings          |

Empty states:

- No selected target: show current allocation and CTA to create allocation
  target.
- No holdings in target sleeve: show target row with 0 current and suggested buy
  candidates if configured.
- Missing classification: show Unknown category and prompt classification.

### 7.3 Targets & Policy Screen

Purpose:

- Create and maintain allocation targets.
- Keep model, target, trigger, funding, and execution policy separate.

Recommended layout:

1. Scope
   - Whole portfolio.
   - Account.
   - Account group.

2. Model
   - Start from current allocation.
   - Three-fund.
   - 60/40.
   - All-weather.
   - Income-focused.
   - Custom.
   - Imported model.

3. Target allocation
   - Table/editor for sleeves.
   - Must support zero-current sleeves.
   - Show current marker on target slider/bar.
   - Show target, min, max, lock, and required flags.
   - Total must equal 100%.

4. Guardrails
   - Optional secondary constraints.
   - Default monitor-only.
   - Clear severity and enforcement state.

5. Rebalance trigger
   - Manual.
   - Calendar.
   - Threshold.
   - Hybrid.
   - Band tolerance and rebalance-to target/nearest-band.

6. Funding policy
   - Manual cash.
   - Recurring contribution.
   - Dollar-cost averaging.
   - Value averaging.
   - Cash reserve.

7. Execution policy
   - Cash-flow only.
   - Sell to rebalance.
   - Hybrid.
   - Tax-aware behavior.
   - Minimum trade size.
   - Whole/fractional units.
   - Turnover cap.
   - Do-not-trade list.

8. Save & select
   - Save draft.
   - Select target.
   - Duplicate target.
   - Archive target.

### 7.4 Rebalance Plan Screen

Purpose:

- Generate an explainable plan from current state, selected target, funding
  input, and execution policy.

Top summary:

- Scope.
- Allocation target and version.
- Trigger reason.
- Available cash.
- Portfolio value.
- Max drift before.
- Max drift after.
- Trade count.
- Turnover.
- Estimated tax impact, if available.

Scenario tabs:

- Cash-flow only.
- Sell to rebalance.
- Hybrid.

Each scenario must show:

- Before/target/after allocation bars.
- Sleeves still out of band.
- Cash used.
- Cash remaining.
- Sells required.
- Buys required.
- Constraints applied.
- Warnings.

Trade table:

| Column   | Meaning                        |
| -------- | ------------------------------ |
| Include  | Checkbox to exclude from draft |
| Action   | Buy or sell                    |
| Account  | Account where trade occurs     |
| Symbol   | Ticker                         |
| Name     | Asset name                     |
| Sleeve   | Target sleeve                  |
| Quantity | Shares/units                   |
| Amount   | Estimated trade amount         |
| Tax      | Gain/loss/warning              |
| Reason   | Why this trade exists          |

Footer actions:

- Save draft.
- Export CSV.
- Recalculate.
- Mark reviewed.
- Execute, only if a supported integration exists.

### 7.5 Copy and Labels

Use precise labels:

| Use               | Avoid                 |
| ----------------- | --------------------- |
| Targets & Policy  | Strategy              |
| Rebalance trigger | Rebalance strategy    |
| Scenario          | Mode                  |
| Cash-flow only    | Buy only              |
| Sell to rebalance | Buy & sell            |
| Hybrid            | Combined              |
| Funding policy    | Contribution strategy |
| Execution policy  | Advanced settings     |
| Drift             | Difference            |
| Out of band       | Bad allocation        |

## 8. Backend Architecture

### 8.1 Crate Organization

Recommended core modules:

```text
crates/core/src/portfolio/allocation_advisor/
  mod.rs
  model.rs
  target_service.rs
  policy_service.rs
  drift_service.rs
  trigger_service.rs
  funding_service.rs
  rebalancing_service.rs
  trade_planner.rs
  validation.rs
  traits.rs
```

Recommended storage modules:

```text
crates/storage-sqlite/src/portfolio/allocation_advisor/
  mod.rs
  model.rs
  repository.rs
```

Thin application layers:

```text
apps/tauri/src/commands/allocation_advisor.rs
apps/server/src/api/allocation_advisor.rs
apps/frontend/src/adapters/shared/allocation-advisor.ts
```

### 8.2 Service Boundaries

TargetService:

- CRUD allocation targets.
- CRUD allocation target weights.
- CRUD guardrails.
- Select/archive/duplicate targets.
- Validate target sums and category references.

PolicyService:

- CRUD rebalance, funding, and execution policies.
- Provide defaults for new targets.
- Validate policy compatibility.

DriftService:

- Load holdings and current allocation.
- Compare current against target weights.
- Evaluate guardrails.
- Return current/target/band/drift rows.

TriggerService:

- Evaluate RebalancePolicy.
- Produce trigger status and reason.
- Update next review date when user completes review.

FundingService:

- Resolve deployable cash.
- Calculate value averaging contribution.
- Apply reserve rules.

RebalancingService:

- Generate scenario-level plans.
- Coordinate drift, funding, execution, and trade planning.
- Return immutable RebalanceRun plus TradeDraft rows.

TradePlanner:

- Select buy/sell candidates.
- Apply tax, turnover, minimum trade, whole-share, and guardrail constraints.
- Explain every trade.

### 8.3 Adapter and API Requirements

Every new command must exist in both runtime paths:

- Tauri adapter export.
- Web adapter export.
- Web command map or explicit route function.
- Tauri command handler.
- Axum route.
- Core service method.

Do not add frontend calls that only work in desktop mode unless the UI clearly
disables them in web mode.

Suggested frontend adapter functions:

```typescript
export async function listAllocationTargets(
  scope?: TargetScope,
): Promise<AllocationTarget[]>;
export async function getAllocationTarget(
  id: string,
): Promise<AllocationTargetDetail>;
export async function saveAllocationTarget(
  input: SaveAllocationTargetInput,
): Promise<AllocationTargetDetail>;
export async function selectAllocationTarget(
  id: string,
): Promise<AllocationTarget>;
export async function archiveAllocationTarget(id: string): Promise<void>;
export async function getAllocationAdvisorState(
  input: AdvisorStateInput,
): Promise<AdvisorState>;
export async function evaluateRebalanceTrigger(
  targetId: string,
): Promise<TriggerEvaluation>;
export async function calculateRebalanceScenarios(
  input: RebalanceScenarioInput,
): Promise<RebalanceScenarioSet>;
export async function saveRebalanceDraft(runId: string): Promise<RebalanceRun>;
export async function exportRebalanceDraft(
  runId: string,
  format: "csv",
): Promise<ExportResult>;
```

## 9. SQLite Schema Plan

Use a new migration set. Names below are logical names; final Diesel table names
can follow repository conventions.

### 9.1 allocation_targets

```sql
CREATE TABLE allocation_targets (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT,
    base_currency TEXT NOT NULL,
    objective TEXT,
    model_type TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    effective_from TEXT,
    rebalance_goal TEXT NOT NULL DEFAULT 'nearest_band'
        CHECK (rebalance_goal IN ('nearest_band', 'exact_target')),
    min_trade_amount TEXT NOT NULL DEFAULT '0',
    whole_shares_only INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);
```

Indexes:

- `(scope_type, scope_id, archived_at)`

### 9.2 allocation_target_weights

```sql
CREATE TABLE allocation_target_weights (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL,
    taxonomy_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    parent_node_id TEXT,
    target_bps INTEGER NOT NULL,
    min_bps INTEGER,
    max_bps INTEGER,
    drift_threshold_bps INTEGER,
    rebalance_priority INTEGER NOT NULL DEFAULT 100,
    is_required INTEGER NOT NULL DEFAULT 1,
    is_locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_node_id) REFERENCES allocation_target_weights(id) ON DELETE CASCADE
);
```

Indexes:

- `(target_id)`
- `(taxonomy_id, category_id)`

### 9.3 target_guardrails

```sql
CREATE TABLE target_guardrails (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL,
    guardrail_type TEXT NOT NULL,
    taxonomy_id TEXT,
    category_id TEXT,
    asset_id TEXT,
    account_id TEXT,
    min_bps INTEGER,
    max_bps INTEGER,
    min_amount TEXT,
    max_amount TEXT,
    severity TEXT NOT NULL,
    enforcement TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE
);
```

### 9.4 holding_targets

```sql
CREATE TABLE holding_targets (
    id TEXT PRIMARY KEY NOT NULL,
    allocation_node_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    target_bps INTEGER,
    min_bps INTEGER,
    max_bps INTEGER,
    buy_priority INTEGER,
    sell_priority INTEGER,
    substitute_group_id TEXT,
    is_locked INTEGER NOT NULL DEFAULT 0,
    is_buyable INTEGER NOT NULL DEFAULT 1,
    is_sellable INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (allocation_node_id) REFERENCES allocation_target_weights(id) ON DELETE CASCADE,
    UNIQUE(allocation_node_id, asset_id)
);
```

### 9.5 rebalance_policies

```sql
CREATE TABLE rebalance_policies (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL UNIQUE,
    trigger_type TEXT NOT NULL,
    review_frequency TEXT,
    next_review_date TEXT,
    default_band_bps INTEGER NOT NULL,
    band_type TEXT NOT NULL,
    rebalance_to TEXT NOT NULL,
    notify_on_breach INTEGER NOT NULL DEFAULT 0,
    require_confirmation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE
);
```

### 9.6 funding_policies

```sql
CREATE TABLE funding_policies (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL UNIQUE,
    funding_mode TEXT NOT NULL,
    cash_source TEXT NOT NULL,
    default_cash_amount TEXT,
    reserve_amount TEXT,
    contribution_frequency TEXT,
    start_date TEXT,
    end_condition TEXT,
    target_value_path_json TEXT,
    max_top_up_amount TEXT,
    overflow_action TEXT,
    fractional_units INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE
);
```

### 9.7 execution_policies

```sql
CREATE TABLE execution_policies (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL UNIQUE,
    scenario_mode TEXT NOT NULL,
    allow_sells INTEGER NOT NULL,
    tax_mode TEXT NOT NULL,
    lot_selection TEXT,
    wash_sale_check INTEGER NOT NULL DEFAULT 0,
    min_trade_amount TEXT NOT NULL,
    min_trade_bps INTEGER,
    max_turnover_bps INTEGER,
    max_realized_gain TEXT,
    whole_shares_only INTEGER NOT NULL DEFAULT 0,
    asset_location TEXT NOT NULL,
    blocked_asset_ids_json TEXT NOT NULL DEFAULT '[]',
    preferred_asset_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE
);
```

### 9.8 rebalance_runs

```sql
CREATE TABLE rebalance_runs (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL,
    target_version INTEGER NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT,
    run_status TEXT NOT NULL,
    scenario_mode TEXT NOT NULL,
    base_currency TEXT NOT NULL,
    portfolio_value TEXT NOT NULL,
    available_cash TEXT NOT NULL,
    max_drift_bps_before INTEGER NOT NULL,
    max_drift_bps_after INTEGER NOT NULL,
    turnover_bps INTEGER NOT NULL,
    estimated_tax_impact TEXT,
    explanation_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id)
);
```

### 9.9 trade_drafts

```sql
CREATE TABLE trade_drafts (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    action TEXT NOT NULL,
    account_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    quantity TEXT NOT NULL,
    estimated_price TEXT NOT NULL,
    estimated_amount TEXT NOT NULL,
    sleeve_category_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    tax_lot_ids_json TEXT,
    estimated_gain TEXT,
    wash_sale_warning INTEGER NOT NULL DEFAULT 0,
    is_excluded INTEGER NOT NULL DEFAULT 0,
    exclusion_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES rebalance_runs(id) ON DELETE CASCADE
);
```

## 10. Frontend Architecture

Recommended page structure:

```text
apps/frontend/src/pages/allocation-advisor/
  allocation-advisor-page.tsx
  targets-policy-page.tsx
  rebalance-plan-page.tsx
  components/
    scope-selector.tsx
    target-selector.tsx
    target-model-picker.tsx
    target-allocation-editor.tsx
    target-band-row.tsx
    guardrail-editor.tsx
    rebalance-trigger-editor.tsx
    funding-policy-editor.tsx
    execution-policy-editor.tsx
    advisor-composition-chart.tsx
    advisor-drift-table.tsx
    rebalance-scenario-tabs.tsx
    before-after-allocation.tsx
    trade-draft-table.tsx
  hooks/
    use-allocation-targets.ts
    use-advisor-state.ts
    use-rebalance-scenarios.ts
    use-policy-mutations.ts
```

UX implementation notes:

- Use existing `@wealthfolio/ui` and shadcn patterns.
- Use `react-hook-form` and `zod` for target/policy forms.
- Use basis point integers in form state where possible; format as percentages
  only at the UI boundary.
- Keep target total validation visible and immediate.
- Disable activation until top-level targets sum to 100%.
- Keep scenario calculation explicit; do not recalculate on every keystroke for
  large portfolios.
- Use stable table layouts and fixed-width numeric columns.
- Render bands as ranges, not only text.
- Always show current marker relative to target band.

## 11. API Data Shapes

Use camelCase DTOs at the frontend boundary and Rust snake_case internally.

### 11.1 AdvisorState

```typescript
interface AdvisorState {
  scope: TargetScope;
  selectedTarget: AllocationTargetSummary | null;
  portfolioValue: Money;
  trigger: TriggerEvaluation | null;
  rows: AllocationAdvisorRow[];
  guardrails: GuardrailEvaluation[];
  missingClassifications: MissingClassificationSummary[];
}
```

### 11.2 AllocationAdvisorRow

```typescript
interface AllocationAdvisorRow {
  taxonomyId: string;
  categoryId: string;
  categoryName: string;
  color: string;
  currentBps: number;
  targetBps: number;
  minBps: number;
  maxBps: number;
  driftBps: number;
  currentValue: Money;
  targetValue: Money;
  valueDelta: Money;
  status: "in_band" | "underweight" | "overweight" | "not_targeted";
  isRequired: boolean;
  isZeroCurrent: boolean;
}
```

### 11.3 RebalanceScenarioInput

```typescript
interface RebalanceScenarioInput {
  targetId: string;
  scenarioModes: Array<"cash_flow_only" | "sell_to_rebalance" | "hybrid">;
  availableCash?: string;
  baseCurrency: string;
  asOfDate?: string;
}
```

### 11.4 RebalanceScenarioSet

```typescript
interface RebalanceScenarioSet {
  targetId: string;
  targetVersion: number;
  generatedAt: string;
  scenarios: RebalanceScenario[];
}
```

### 11.5 RebalanceScenario

```typescript
interface RebalanceScenario {
  runId: string;
  scenarioMode: "cash_flow_only" | "sell_to_rebalance" | "hybrid";
  summary: RebalanceScenarioSummary;
  beforeRows: AllocationAdvisorRow[];
  afterRows: AllocationAdvisorRow[];
  trades: TradeDraft[];
  constraintsApplied: ConstraintExplanation[];
  warnings: PlanWarning[];
}
```

## 12. Validation Rules

Target:

- Name is required.
- Scope type is required.
- Selected target scope must be unique.
- Base currency is required.

Allocation target weights:

- Top-level targets must sum to 10000 bps.
- No negative bps.
- No target above 10000 bps.
- Min <= target <= max when min/max exist.
- Category must exist in taxonomy unless marked as archived legacy.
- Zero-current categories are valid targets.

Guardrails:

- At least one bound must exist.
- Severity and enforcement are required.
- Blocking guardrails must be explainable in plan output.

Funding:

- Empty available cash is parsed as zero.
- Reserve cannot be negative.
- Value averaging requires start date, cadence, and target path.
- Max top-up cap cannot be negative.

Execution:

- Minimum trade amount cannot be negative.
- Sells disabled means no sell drafts.
- Tax strict cannot run lot-sensitive checks without lot data; show blocking
  validation if unavailable.
- Whole-share plans require valid positive quote prices.

Plan:

- Missing quotes produce warnings and exclude affected assets.
- Stale holdings or quotes should mark existing runs stale.
- Excluded trades update after-state display.

## 13. Rollout Plan

### Phase 1: SOTA-lite Foundation

Ship:

- Allocation targets by scope.
- Primary asset-class target weights.
- Tolerance bands.
- Advisor monitor screen.
- Trigger evaluation.
- Cash-flow-only scenario.
- Manual available cash input.
- Minimum trade amount.
- Desktop and web parity.

Do not ship:

- Tax-lot optimization.
- Automated execution.
- Multi-dimensional constrained optimizer.
- Value averaging.

### Phase 2: Rebalance Scenarios

Ship:

- Sell to rebalance scenario.
- Hybrid scenario.
- Rebalance runs.
- Trade drafts.
- Before/after view.
- Export CSV.
- Whole-share and fractional support.
- Turnover cap.
- Do-not-trade list.

### Phase 3: Advanced Policies

Ship:

- Funding policies.
- Recurring contributions.
- Value averaging.
- Guardrail enforcement.
- Account-group targets.
- Account placement preferences.

### Phase 4: Tax-Aware Planning

Ship when required data exists:

- Tax lots.
- Cost basis by lot.
- Short-term/long-term gain estimate.
- Wash-sale warnings.
- Tax-loss harvest suggestions.
- Tax-aware household/account-level rebalancing.

### Phase 5: Model Marketplace and Addons

Ship:

- Import/export target models.
- Addon SDK APIs for allocation targets and advisor state.
- Optional curated templates.
- Addon-provided funding policies such as advanced value averaging.

## 14. Acceptance Criteria

Functional:

- User can create a allocation target from scratch.
- User can target a category with no current holdings.
- User can select one target for a scope.
- Advisor screen shows current, target, band, drift, and value delta.
- Trigger status explains whether rebalancing is recommended.
- Cash-flow scenario generates buy drafts for underweight sleeves.
- Sell scenarios never appear unless execution policy allows sells.
- Empty cash input is treated as zero.
- Every trade has a reason.
- Desktop and web expose equivalent APIs.

UX:

- User can understand "when to act" separately from "how to trade".
- Bands are visible in monitor and target editor.
- Scenario labels are not confused with strategies.
- Guardrails show whether they are monitor-only or enforced.
- Rebalance plan explains constraints and warnings.

Technical:

- Core services own all financial calculations.
- Tauri and Axum handlers are thin.
- Percentages are stored as basis points.
- Rebalance runs are immutable.
- Existing current-allocation features continue to work.

## 15. Test Plan

Rust unit tests:

- Target sum validation.
- Band validation.
- Absolute and relative drift math.
- Trigger evaluation for manual/calendar/threshold/hybrid.
- Cash-flow-only allocation.
- Sell-to-rebalance allocation.
- Hybrid cash-first then sell behavior.
- Whole-share rounding.
- Minimum trade filtering.
- Turnover cap.
- Zero-current target sleeve.
- Missing quote exclusion.
- Value averaging contribution calculation.

Repository tests:

- Create/update/archive/select target.
- Enforce one selected target per scope.
- Persist weights, guardrails, policies, runs, and drafts.
- Cascade deletes for draft targets.
- Preserve immutable runs after target change.

Frontend tests:

- Target editor requires 100%.
- Zero-current sleeves appear and can be targeted.
- Empty cash input submits zero.
- Scenario tabs render correct labels.
- Drift sign displays underweight/overweight correctly.
- Trigger status updates with threshold breach.
- Excluding a trade updates selected total.

Integration tests:

- Tauri command parity.
- Web route parity.
- Advisor state from sample holdings.
- Rebalance scenario from sample allocation target.
- Export CSV contains included trades only.

Manual QA:

- Desktop build.
- Web build.
- New user with no allocation target.
- Portfolio with only stocks targeting bonds.
- Portfolio with missing classifications.
- Taxable plus IRA accounts.
- Whole-share-only account.
- Fractional-share account.

## 16. Security and Privacy

- Keep all advisor data local unless the user explicitly exports it.
- Do not log holdings, trade drafts, account IDs, cost basis, or tax estimates.
- Export files should be explicit user actions.
- No cloud sync assumptions.
- If addon APIs expose advisor data, require explicit permission scopes.

## 17. Open Product Decisions

These decisions can be made during implementation without changing the core
model:

- Exact default model templates.
- Whether income objective appears in v1.
- Whether account groups ship before or after sell scenarios.
- Whether nearest-band or exact-target is the global default for non-taxable
  accounts.
- Which CSV format to use for trade draft export.
- Whether value averaging is core v3/v4 functionality or an addon-backed
  FundingPolicy provider.

## 18. References

- Vanguard, "Rebalancing your portfolio":
  https://investor.vanguard.com/investor-resources-education/portfolio-management/rebalancing-your-portfolio
- Vanguard, "Tuning in to the right frequency for rebalancing":
  https://corporate.vanguard.com/content/corporatesite/us/en/corp/articles/tuning-frequency-for-rebalancing.html
- Fidelity, "Rebalancing your portfolio":
  https://www.fidelity.com/learning-center/trading-investing/rebalance
- Schwab Intelligent Portfolios FAQ and overview:
  https://www.schwab.com/automated-investing/faqs
- Schwab iRebal advisor rebalancing overview:
  https://advisorservices.schwab.com/intelligent-advisor
- Michael E. Edleson, "Value Averaging":
  https://www.oreilly.com/library/view/value-averaging-the/9780470049778/
