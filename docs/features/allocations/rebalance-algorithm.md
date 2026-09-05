# Rebalance Algorithm — Design Notes

Status: Current (M3 + proportional top-up) Date: 2026-06-07 Audience:
Contributors, reviewers, curious users

---

## 1. What problem are we solving?

A user has a target allocation (e.g. 60 % equities, 30 % bonds, 10 % cash) and
optionally a pool of available cash or existing holdings to rebalance against.
Given the current portfolio, which trades bring the portfolio as close to target
as possible?

Constraints:

- **Three scenario modes** — `cash_flow_only` (buys only), `sell_to_rebalance`
  (sells overweight then buys underweight), and `hybrid` (sells only when cash
  alone cannot bring every sleeve within band). The `allow_sells` flag on the
  target profile gates the sell scenarios.
- **Exposure-aware** — an asset may span multiple taxonomy categories (e.g. a
  global ETF classified 60 % US equity / 40 % international). One trade must
  update all affected category exposures simultaneously.
- **Whole-share mode** — when enabled, only round-lot quantities are suggested.
- **Minimum trade size** — asset trades below `min_trade_amount` are dropped
  from the final output; no-ticker manual sleeve suggestions can still use
  remaining cash.

---

## 2. Why not a mathematical optimiser?

Professional rebalancing tools (Tamarac, Orion iRebal) use LP/MILP solvers to
find the globally optimal trade set in one pass. Real costs:

- Heavy dependency (solver library or external service).
- Opaque results — users cannot follow the reasoning.
- Overkill for single-portfolio individual use where "close enough" in
  milliseconds beats "optimal" in seconds.

The greedy algorithm below achieves near-optimal results for typical inputs and
is easy to audit step by step. The `RebalanceOptimizer` trait is
solver-compatible: a future `MilpOptimizer` can replace `DriftPriorityOptimizer`
behind a feature flag without changing `RebalanceService`.

---

## 3. Algorithm overview

```
Input: scenario_mode, available_cash, target_profile, current_holdings, drift_report

Build exposure vectors (buy candidates)
  For each non-cash holding with taxonomy assignments:
    exposure_per_share[category] = contribution.value / quantity
    Skip if all categories are __UNKNOWN__ (warn UnclassifiedAsset)
    Include with partial exposure if some are __UNKNOWN__ (warn PartialClassification)

Sell phase  (SellToRebalance only — runs before buy phase)
  while overweight drift > 0:
    for each sell candidate (holding with qty_owned > 0, classified):
      simulate sell quantity → values[c] -= exposure[c] × qty
      score = (drift_before − drift_after) / sell_proceeds
    pick candidate with highest score > 0
    apply sell: update values[c], proceeds += price × qty, qty_remaining[idx] -= qty
  sell_proceeds become the buy phase cash pool (available_cash untouched)

Buy phase
  CashFlowOnly / SellToRebalance: cash = available_cash  |  sell_proceeds
  while cash > 0:
    drift_before = Σ |current_bps[c] − target_bps[c]|  for required non-cash categories
    for each candidate asset:
      if whole-share mode and cash < price: skip
      quantity = 1 share (whole-share) or fractional cap at next band bend (fractional)
      simulate buy → new_bps[c] = (current_value[c] + exposure[c] × qty) / total_value
      drift_after = Σ |new_bps[c] − target_bps[c]|
      score = (drift_before − drift_after) / amount
    pick candidate with highest score > 0  (tie-break: price ASC)
    if no candidate improves drift: stop
    apply buy: update values[c], cash -= amount

Hybrid pass-2 (after cash buys, if still overweight outside goal threshold)
  Check: any required category bps > threshold?
    ExactTarget → threshold = target_bps
    NearestBand → threshold = target_bps + drift_band
  If yes: run sell phase on post-buy values → sell_proceeds_2
    then run buy phase again with sell_proceeds_2
  Note: total_value is fixed. Cash buys are a cash↔asset swap and do not
  reduce an untouched overweight category's bps. Hybrid differs from
  SellToRebalance by ordering (buy first, sell residual), not by cash dilution.

Post-processing
  Sell trades + buy trades → SuggestedManualTrade[] (1 per asset per action)
  Drop sell trades where estimated_amount < min_trade_amount (recompute proceeds from kept)
  Drop buy trades where estimated_amount < min_trade_amount
  cash_used = sum of kept buy trade amounts
  cash_remaining = available_cash + sell_proceeds − cash_used
  after_bps_by_category = recompute from initial values + all kept trades

Output: trades[], warnings[], cash_used, cash_remaining, after_bps_by_category
```

---

## 4. Exposure vectors

Each asset is represented as a vector of per-share exposures across taxonomy
categories, derived from
`AllocationService::get_holding_contributions_for_taxonomy_for_accounts`.

```
              US equity   Intl equity   Bonds
VT              $60          $40          $0     (price $100 — fully classified)
AAPL           $100           $0          $0     (price $100 — single category)
XYZ             $70           $0          $0     (price $100 — partial: 70% known, 30% __UNKNOWN__)
```

For VT: buying 1 share adds $60 to US equity and $40 to international equity
simultaneously, improving drift in both categories in a single step.

`__UNKNOWN__` exposure is excluded from the vector. Partial exposure means the
greedy can improve drift for the known categories but not for the unclassified
remainder.

### Classification edge cases

| Situation                                     | Behaviour                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| All exposure in `__UNKNOWN__`                 | Skip as candidate. Warn `UnclassifiedAsset`.                                 |
| Partial exposure (<100% classified)           | Include with known exposure. Warn `PartialClassification`. Do not normalise. |
| Weights >100%                                 | `AllocationService` normalises to 100% (consistent with drift view).         |
| Cash holdings (`CASH` / `CASH_BANK_DEPOSITS`) | Excluded from candidates.                                                    |
| No price available (whole-share mode)         | Skip. Warn `MissingQuote`.                                                   |

---

## 5. Scoring

**Score = drift_improvement / price**

Where `drift_improvement = Σ|drift_bps[c]| before − Σ|drift_bps[c]| after`
across all required non-cash categories.

Key properties:

- **Multi-category benefit.** An ETF that simultaneously reduces drift in two
  categories scores higher than a single-category asset at the same price — the
  numerator captures the combined improvement.
- **Scale-invariant for same-category assets.** Two assets 100% in the same
  underweight category have identical scores regardless of price (buying more of
  a cheaper asset per dollar improves the category by the same bps as buying
  less of an expensive one). The tie-break resolves them by price ASC.
- **Stops when no improvement.** Once the portfolio reaches target (or no
  candidate can further reduce drift without overshooting), the greedy loop
  terminates. Any residual cash then flows into the proportional top-up (§6.5),
  and whatever still cannot be deployed stays as `cash_remaining`.

---

## 6. Whole-share vs fractional mode

| Mode        | Step                                  | Quantity |
| ----------- | ------------------------------------- | -------- |
| Whole-share | 1 share, batched within linear region | Integer  |
| Fractional  | Drift-capped slice                    | Decimal  |

Both modes use the same drift-improvement-per-dollar scoring and candidate
tie-breaks.

- **Whole-share mode** buys integer quantities only. It batches repeated buys of
  the selected candidate only when it is the sole improving candidate. If more
  than one asset can improve drift, it buys one share and re-scores, preserving
  strict greedy equivalence in coupled multi-category cases. Cash below the next
  usable share price remains as `cash_remaining`.
- **Fractional mode** sizes each selected buy as a decimal quantity from the
  start, capped at available cash and the next target/band bend for categories
  the candidate can improve. This avoids full-share overbuying when a fractional
  quantity already closes the drift.

---

## 6.5 Proportional top-up

The drift-improving greedy stops as soon as no buy further reduces drift. In a
cash-flow plan that often leaves cash undeployed (e.g. the portfolio is already
within band, or whole-share granularity blocks the last improving trade). Rather
than returning that cash as idle `cash_remaining`, `run_proportional_topup`
(`optimizer.rs`) deploys it **proportionally to `target_bps`**: each sleeve
receives a share of the leftover cash in proportion to its target weight, using
the same per-share exposure candidates.

Behaviour:

- Runs only after the greedy exhausts drift-improving buys, on the buy cash
  pool.
- Respects whole-share / fractional mode and `min_trade_amount` like the greedy.
- Preserves any required cash-sleeve target (it does not over-deploy past a
  `CASH` target weight).
- **Cash-flow / hybrid only.** `SellToRebalance` leftover sell proceeds are
  _not_ topped up — they stay as `cash_remaining` (selling to then re-buy
  proportionally would churn for no drift benefit).

This mirrors how M1 Finance and the robo-advisors deploy new cash: once drift is
resolved, remaining contributions are spread across the model rather than
parked.

---

## 7. After-drift computation

After filtering trades by `min_trade_amount`, `after_bps_by_category` is
recomputed from the initial portfolio state plus the kept trades only (not the
full greedy state). This keeps `cash_used`, `cash_remaining`, and
`after_bps_by_category` mutually consistent with what the user will actually
execute.

The frontend `BeforeAfterStack` visualisation uses `after_bps_by_category`
directly from the plan (not re-derived from trade amounts), which gives correct
results for multi-category ETFs.

---

## 8. Warnings emitted

| Warning kind            | Condition                                                    | User action                         |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------- |
| `UnclassifiedAsset`     | Holding has no taxonomy assignments for the active taxonomy  | Classify the asset                  |
| `PartialClassification` | Holding has partial weights (<100%); known exposure used     | Complete classification if possible |
| `MissingQuote`          | No valid price in whole-share mode                           | Refresh market data                 |
| `NoBuyCandidate`        | Required underweight category has no candidate with exposure | Allocate that category manually     |

`NoBuyCandidate` emits a sleeve-level dollar trade (no ticker) so the user sees
the suggested amount even when no holding covers that category.

---

## 9. PR-B decisions

`AllocationService::contribution_shares_for_holding` normalises weights >10000
bps silently (line 247: `weight_divisor = total.max(10000)`). This is consistent
with how drift reports and allocation views already handle over-allocated
assets. For the rebalance planner we align with this behaviour rather than
blocking on >100% weights.

If a hard block is desired, it should be write-time validation on
`AssetTaxonomyAssignment` in a separate data-quality PR, not planner-only
behaviour.

The old `WholeShareResidue` top-up warning is not carried forward. It was tied
to the old proportional sleeve planner and does not map cleanly to this
exposure-aware optimiser. Residual cash is now handled by the proportional
top-up (§6.5), which deploys leftover cash across sleeves ∝ `target_bps` instead
of leaving it idle; only cash that still cannot be deployed is reported as
`cash_remaining`.

---

## 10. Possible future improvements

| Idea                                                | Complexity | Status                                           |
| --------------------------------------------------- | ---------- | ------------------------------------------------ |
| Sell-to-rebalance (`allow_sells`)                   | Medium     | ✅ M3                                            |
| Proportional top-up of residual cash                | Low        | ✅ shipped (§6.5)                                |
| Relative tolerance bands (% of weight)              | Low/Med    | Proposed — see current-state-and-roadmap.md §4.3 |
| `HoldingTarget` — per-ticker allocations            | High       | V2 data model (SOTA §5.4)                        |
| Tax-lot awareness                                   | High       | Out of V1 scope (SOTA Phase 4)                   |
| `TaxAwareOptimizer` (greedy + tax penalty in score) | Medium     | M4 / Phase 4                                     |
| `MilpOptimizer` behind `--features milp`            | High       | When tax-aware / lot selection needed            |
| Multi-account / asset-location optimisation         | High       | SOTA Phase 3, future roadmap                     |

---

## 11. Implementation reference

- **Trait + types:** `crates/core/src/portfolio/allocation_targets/optimizer.rs`
  — `RebalanceOptimizer`, `DriftPriorityOptimizer`, `RebalanceInput`,
  `AssetCandidate`.
- **Orchestration:**
  `crates/core/src/portfolio/allocation_targets/rebalance_service.rs` —
  `RebalanceService::calculate_plan()` fetches holdings + contributions, builds
  candidates, calls optimizer.
- **Types:** `crates/core/src/portfolio/allocation_targets/model.rs` —
  `RebalancePlan`, `SuggestedManualTrade`, `RebalanceWarning`,
  `RebalanceWarningKind`.
- **Tests:** `rebalance_service.rs` `mod tests` — 36 tests covering cash
  enforcement, greedy selection, multi-category ETF exposure, classification
  edge cases, whole-share, nearest-band, min-trade filter, sell/hybrid
  scenarios, proportional top-up.
- **UI:**
  `apps/frontend/src/pages/allocation-targets/components/rebalance-tab.tsx`.
