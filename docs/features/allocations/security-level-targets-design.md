# Security-Level Targets — Design Note

Status: Proposal, to agree before any schema, migration or API Date: 2026-11-09
Authors: @Jonjon-prog Reviewers: @afadil, @kwaich

Context: §9 of
[`self-directed-rebalancing-design.md`](./self-directed-rebalancing-design.md),
[PR #2587](https://github.com/wealthfolio/wealthfolio/pull/2587),
[issue #1836](https://github.com/wealthfolio/wealthfolio/issues/1836).

§9 settles the shape of security-level targets: per-category instrument weights
nested under the category target. It defers the behaviour, and asks for
agreement on three points before any schema, migration or API: how a partially
specified category resolves, whether ranges apply per security, and how the
worksheet prefill presents it. This note answers those three points, covers the
stock-picking case from #1836, and proposes the persistence and milestones that
follow. It does not reopen the shape.

`§` numbers refer to the self-directed rebalancing design. This note's own
sections are written "section N". Statements about current code were checked on
`main` at `fc695b2ea`, and statements about #2587 at its head `07f0cdbd8`. Every
figure in the examples was recomputed with a throwaway simulation of the rules
below, kept outside the repository (single-class securities, no accounts, no
whole units). The same simulation ran the random checks quoted in sections 3.3
and 3.4. It models the rules, not the Rust code.

---

## 1. Problem and use cases

### 1.1 What the app does today

A target weights the categories of one asset taxonomy, and the weights add up to
100 % (`validate_weights_sum`). Inside a category the user states nothing. The
worksheet spreads the category's gap over the eligible securities in proportion
to what each holds (§4.2, `split_gap` in `worksheet_calculator.rs`), and the
drift holdings view shows each holding a target derived the same way: its share
of the category's current value times the category target
(`build_drift_holdings_report` in `drift_service.rs`). That derived figure is
the per-holding target #1836 shows in its screenshot and cannot edit.

### 1.2 Case A: a fund inside a sleeve

"Equity 60 %, and within Equity, 50 % VWCE; the rest as I hold it." The user
plans by asset class and wants one security pinned inside one class. Today the
VWCE share of Equity is whatever it happens to be, and each calculation spreads
the Equity gap by it.

### 1.3 Case B: the stock picker of #1836

"30 % AAPL, 20 % MSFT, 25 % NVDA, 25 % GOOGL." The user does not plan by asset
class at all. In #2587, kwaich listed the two ways the nested shape could
express this, each with a friction:

1. **One catch-all category holding every security.** The category means nothing
   to the user, and every new security has to be added to it.
2. **Securities under their real classes.** The class weights are only the sums
   of the security weights, so changing one security means changing two numbers.

### 1.4 How the nested shape serves case B

This note takes option 2 and removes its friction in the editor, without storing
anything beyond the nested weights:

- **No catch-all category.** A listed stock already carries its asset class in
  the target's taxonomy, the same classification every category target relies
  on. Auto-classification puts the EQUITY and ETF quote types in Equity
  (`auto_classification.rs`); a security left unclassified (for instance an
  ECNQUOTE or NONE quote type) sits in `__UNKNOWN__` and has to be classified
  before it can carry a weight, as it has to today before it counts toward a
  category.
- **Entry by security.** The target editor offers a second way to enter the same
  numbers: one row per security, showing and accepting its share of the whole
  portfolio, with each class weight derived as the sum of its rows. What is
  stored stays nested: the class weight, and each security's share within its
  class (section 5). A user who plans by class and a stock picker edit the same
  figures from opposite ends. The editor opens by security when every class with
  a weight has security weights, and by class otherwise; a toggle switches.
  Nothing about the mode is stored. A security classified in several classes
  keeps its own split when its total changes: a 60/40 fund going from 10 % to 12
  % of the portfolio becomes 7.2 % in Equity and 4.8 % in Fixed income.
- **One number per change.** Changing AAPL from 30 % to 35 % is one input. The
  editor's existing redistribution (`redistribute` in
  `target-weight-editor.tsx`) takes the difference from the rows that are
  neither locked nor set by hand, and the class weights and shares within
  classes are rewritten from the result.
- **New securities need no filing.** A security bought after the target was
  saved appears in the editor as a row with no weight, under the class it is
  classified in, as #2587 already does for its flat rows. Until it has a weight
  it belongs to its class's rest (section 3.1).

Worked example, one class. AAPL 30, MSFT 20, NVDA 25, GOOGL 25, all Equity.
Equity is stored at 100 % and nobody typed it; the four shares within Equity are
the four numbers typed. With MSFT locked, AAPL 30 → 35 leaves 45 points for NVDA
and GOOGL, which the redistribution splits in proportion: 22.5 each.

Worked example, two classes. The same picker also holds a bond fund: AAPL 30,
MSFT 20, NVDA 20, GOOGL 20 in Equity, AGG 10 in Fixed income. The editor stores
Equity 90 %, Fixed income 10 %, and within Equity 3334 / 2222 / 2222 / 2222 bps.
If AGG is not locked when AAPL goes to 35, part of the 5 points comes from AGG
and Fixed income's weight goes down with it: the class weight is derived, not
typed.

Rounding. Shares are stored in bps of their class, as every weight is stored in
bps. In the by-security entry the share within the class is derived: 30 % of the
portfolio inside a 90 % class is 33.333… % of the class, stored as 33.33 % or
33.34 %. The four shares of Equity must add up to exactly 100 %, so one of them
is rounded up, by largest remainder (the rounding #2587's `spread_bps` uses):
AAPL gets 33.34 %. Shown back as a share of the portfolio, AAPL is then 90 % ×
33.34 % = 30.006 %.

**Display: one decimal suggested.** This note suggests showing security weights
the way the editor shows category weights now (`target-weight-editor.tsx`): one
decimal on screen, input accepted to 0.01 %.

- AAPL reads 30.0 %, so the round trip above never shows.
- The cost is the one category weights already pay: a typed 33.33 % reads 33.3
  %, and three equal weights (3333 / 3333 / 3334 bps) read 33.3 % each while the
  total reads 100.0 %.

**What two decimals would change.** Much of the app shows percentages with two
decimals: `formatPercent` defaults to two (`packages/ui/src/lib/formatting.ts`),
and about half of its calls in the frontend rely on that default, while the
allocation-target screens ask for one. Classification weights, also stored in
bps, have shown two decimals since `9f0570bb8`. Two decimals would align
security weights with the rest of the app, and would show 33.33 / 33.33 / 33.34
as typed. But AAPL would read 30.01 % after a reload, in the by-security entry,
whenever its class is below 100 %. Two ways to live with that:

- accept it: the difference stays under 0.01 point, and appears only in the
  by-security entry of a class below 100 %;
- remove it: store shares in a unit finer than bps (for instance millionths of
  the category), unlike every other weight. That decision belongs to the schema,
  so it has to come before S2 (section 7, question 4).

With one class at 100 % there is no round trip at all, whatever the display.

The case is therefore in scope: it uses the same arithmetic as case A, and the
only addition is an editor mode.

---

## 2. Shape and what this note reuses from #2587

### 2.1 The shape (§9, settled)

> The shape that fits the model is per-category instrument weights nested under
> the category target, so the strategic layer stays in asset classes and one
> number does not have to be restated across every security.

In this note that means:

- Category weights are unchanged: one per category, in bps of the portfolio,
  adding up to 100 %.
- A security weight belongs to one category of the target and is expressed in
  bps **of that category**. The weights of one category add up to at most 100 %.
- Changing a category weight scales the targets of its securities; their shares
  within the category do not move.
- There is no target type, and no target made only of securities.

### 2.2 What carries over from #2587

#2587 by @kwaich is the groundwork for this note. Its known-limitations section
is where section 5.7 starts, and most of its code carries over. Commits that
port it credit kwaich with a `Co-authored-by` trailer. Checked in the PR at
`07f0cdbd8`:

| From #2587                                                   | Where                                                                                                                                                                             | In the nested shape                                                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset weight table and storage model                         | migration `2026-11-09-000001_asset_allocation_targets`, `AllocationTargetAssetWeightDB`                                                                                           | Kept, with `category_id` added; `target_type`, its five triggers and `is_required` dropped (section 5.3)                                                                                            |
| Saving with the category weights, deleting with the target   | `save_target_with_weights` and `delete_target` in `storage-sqlite/src/portfolio/allocation_targets/repository.rs`                                                                 | Kept                                                                                                                                                                                                |
| Sync registration                                            | `SyncEntity::AllocationTargetAssetWeight`, outbox model, adapter descriptor, `entity_storage_mapping`, device-sync mapping, canonical order after the weights                     | Kept                                                                                                                                                                                                |
| Validation                                                   | shared `validate_weight_entries`; `validate_target_asset_weights` (the asset exists and is an investment)                                                                         | Kept; per-category sum and category checks added (section 5.4)                                                                                                                                      |
| Weight merge when an unknown asset is resolved               | `reassign_allocation_target_weights`, called first in `merge_unknown_asset`; test `reassign_allocation_target_weights_moves_and_merges_weights`                                   | Kept, keyed by category as well                                                                                                                                                                     |
| Editor rows                                                  | `security-target-rows.ts` (`buildSecurityTargetRows`, `securityCurrentAllocation`, `equalWeightBps`) and its tests                                                                | Adapted: rows grouped by category, shares within the category                                                                                                                                       |
| Editor behaviour                                             | Equal weight start; a row at 0 % is saved only when locked (`targetBps > 0 \|\| isLocked`); a security bought since the save starts at 0 %; `targets-tab-securities.test.tsx`     | Kept and adapted. The lock itself is the existing `TargetWeightEditor` lock on `main`                                                                                                               |
| Holdings drift split across the holding rows of one security | f285eb145; test `asset_target_holdings_split_target_across_rows_of_one_asset`                                                                                                     | Kept, with the target taken from the security weight                                                                                                                                                |
| Account cleanup coverage                                     | `storage-sqlite/src/accounts/cleanup_tests.rs`                                                                                                                                    | Kept                                                                                                                                                                                                |
| Adapters and commands                                        | Tauri and Axum handlers, `listAllocationTargetAssetWeights`, web `core.ts`, `adapter-command-parity.test.ts`                                                                      | Kept, with `categoryId` in the payload                                                                                                                                                              |
| Spreading a removed weight                                   | `spread_bps`, `spread_into_target`, `remove_asset_from_targets`                                                                                                                   | Spreading is not needed: a weight that disappears falls into its category's rest (section 5.7). The largest-remainder rounding of `spread_bps` is the one the by-security entry needs (section 1.4) |
| Snapshot restore of a table referencing assets               | ca4e8bd61                                                                                                                                                                         | Depends on the asset foreign key (section 7, question 4)                                                                                                                                            |
| Blocking the local delete of a weighted asset                | `delete` in `storage-sqlite/src/assets/repository.rs`                                                                                                                             | Optional (section 5.7)                                                                                                                                                                              |
| Flat type                                                    | `TargetType`, `INDIVIDUAL_SECURITIES_TAXONOMY_ID`, synthetic taxonomy in `worksheet_service.rs`, `get_security_holding_contributions_for_accounts`, flat drift and rails branches | Not used: the nested shape reads the existing taxonomy contributions, which already carry the asset of each contribution                                                                            |

---

## 3. Behaviour: the three open questions

Each answer starts from kwaich's proposal in #2587 and says where this note
agrees or differs.

### 3.0 Notation

The symbols of §4.2, one level down:

```
T(c)        = target_bps(c)/10000 × planning_total     // category target value, as today
v(i,c)      = security i's value attributed to c       // as in §4.2
w(i,c)      = weight of i within c, in bps of c        // Σ_i w(i,c) ≤ 10000
T(i,c)      = w(i,c)/10000 × T(c)
gap(i,c)    = T(i,c) − v(i,c)

R(c)        = securities carrying c with no weight in c   // the rest
T(rest,c)   = (1 − Σ_i w(i,c)/10000) × T(c)
gap(rest,c) = T(rest,c) − Σ_{j∈R(c)} v(j,c)
```

Each weighted security, and the rest, is a _part_ of the category. The parts'
gaps add up to the category gap of §4.2:

```
Σ_i gap(i,c) + gap(rest,c) = T(c) − Σ_all v(·,c) = category_gap(c)
```

A part _can take_ an increase when it is a weighted security that is eligible
and priced, or a rest with at least one such security. It _can give_ a reduction
when it holds a position that may be reduced (§4.1, #1177).

A category with no security weight has a single part, the rest, at 100 %: that
is §4.2 exactly as today.

### 3.1 (a) A partially specified category

**kwaich's proposal:** the proportional rule of §4.2 fills whatever the weights
leave unspecified (#2587 itself required the weights to reach 100 %).
**Agreed**, with these edges fixed:

1. The rest receives T(rest,c), spread over R(c) by §4.2: current holding
   proportions, over eligible securities with a usable price.
2. A part that cannot take its share (a rest with no eligible security to carry
   it, or a weighted security left out this time) hands it to the other parts of
   the category that are still below their target, never past that target
   (section 3.3). What is left is an **unresolved amount** for the category
   (§4.4, same reasons), which the user can still place by hand.
3. Weights adding up to 100 % leave a rest of 0 %: securities in the category
   without a weight have a target of 0. That is how an untargeted category
   behaves today (`build_drift_rows` gives it a target of 0, and `generate`
   passes every drift row to the calculation): Invest cash never reduces it,
   Rebalance can. The editor shows the rest as its own row, so an empty rest is
   visible before saving.
4. An explicit zero (kwaich's 0 % lock) and no weight are different statements.
   A zero is a target of nothing for that security, whatever the rest is; no
   weight means the security is part of the rest. Stored, that is a row at 0
   versus no row.
5. A weight applies to the security's value attributed to the category, v(i,c),
   as §4.2 does. A 60/40 fund weighted in Equity only has its fixed income slice
   in Fixed income's rest.
6. A weight on a security that is not classified in the category (reclassified
   since, or an unknown asset resolved into another class) does not apply. Its
   share falls into the rest, and the editor flags the row.

Example. Planning total 100 000; Equity 60 %, so T(Equity) = 60 000. Held in
Equity: VWCE 20 000, AAPL 15 000, MSFT 5 000, so 40 000 and a category gap of
+20 000. One weight: VWCE 50 % of Equity.

| Part        | Target | Held   | Gap     | Split                             |
| ----------- | ------ | ------ | ------- | --------------------------------- |
| VWCE        | 30 000 | 20 000 | +10 000 | VWCE +10 000                      |
| Rest (50 %) | 30 000 | 20 000 | +10 000 | AAPL +7 500, MSFT +2 500 (15 : 5) |
| Equity      | 60 000 | 40 000 | +20 000 |                                   |

With §4.4. Same target, but VWCE is the only Equity holding, at 40 000, and
Invest cash deploys 20 000. VWCE's part is above its target (−10 000), so it
cannot take anything; the rest asks for 30 000 and has no security to carry it.
All of Equity's 20 000 is an unresolved amount (`NoRecordedSecurity`), and the
20 000 stays as remaining cash. Without the weight, §4.2 would put the 20 000 on
VWCE.

### 3.2 (b) Ranges per security

**kwaich's proposal:** only the target-wide drift band, as in #2587. **Agreed:**
no per-security band, no new field, nothing new stored. One clarification: the
target's band settings (`drift_band_bps`, `band_type`, `relative_factor_bps`)
are evaluated, as today, on every category row, and also on every security that
has a weight, against its share of the portfolio:

```
p(i)    = w(i,c)/10000 × target_bps(c)       // bps of the portfolio
band(i) = band_type.effective_band_bps(p(i), drift_band_bps, relative_factor_bps)
```

Without this a stock picker would never see anything outside range: their single
class is always at 100 % of 100 %, and Overview's target card reports "inside
target range" whenever `outOfBandCount` is 0 (`target-rails-card.tsx`).

- Securities in a rest have no status. They keep the derived target the holdings
  view shows today.
- The status is computed on the security's total in scope; its target is then
  split across its holding rows, as #2587 does.
- The calculated adjustments do not use bands: `generate` builds each category
  from `target_bps` alone, and the band settings appear only in the worksheet's
  source record. So (b) changes drift, Overview and the out-of-range counts,
  never the worksheet.
- `out_of_band_count` keeps counting categories, so its meaning does not change
  for its current readers, among them Overview, the worksheet Setup and the
  add-on SDK's drift report (`outOfBandCount` in `data-types.ts`). The drift
  report gains a separate count of weighted securities outside range.

Example, hybrid band with a 5-point floor and a 20 % relative factor (500 and
2000 bps):

| Security, weight             | p(i) | Band            | Range   | Held | Status  |
| ---------------------------- | ---- | --------------- | ------- | ---- | ------- |
| AAPL, 30 % of Equity (100 %) | 30 % | max(5, 6) = 6   | 24–36 % | 37 % | Outside |
| MSFT, 20 % of Equity (100 %) | 20 % | max(5, 4) = 5   | 15–25 % | 16 % | Inside  |
| VWCE, 15 % of Equity (60 %)  | 9 %  | max(5, 1.8) = 5 | 4–14 %  | 12 % | Inside  |

With the 5-point floor, a small security target rarely leaves its range. A user
who wants a tighter range lowers the floor, the setting that exists today.

### 3.3 (c) How the worksheet prefill presents it

**kwaich's proposal:** within a category, explicit weights take the place of the
proportional split for that category's gap (#2587 fed each security to the
worksheet as if it were a category). **Agreed on the scope:** category gaps, the
cash-first sequence and the limits stay as they are; only the split inside a
weighted category changes. **Corrected on the split itself:** splitting the gap
in proportion to the weights can add to a security that is already above its own
target. The split goes toward each part's target instead.

Example. Planning total 100 000: 90 000 invested and 10 000 cash to invest.
Equity 60 % (T = 60 000) holds VWCE 40 000 and AAPL 10 000, a gap of +10 000.
Weights VWCE 50 %, AAPL 50 %: targets of 30 000 each. Fixed income 40 % holds 40
000, on target.

| Split of Equity's +10 000                 | VWCE   | AAPL    | VWCE / AAPL after |
| ----------------------------------------- | ------ | ------- | ----------------- |
| §4.2, current holding proportions (today) | +8 000 | +2 000  | 48 000 / 12 000   |
| Gap × weight                              | +5 000 | +5 000  | 45 000 / 15 000   |
| Toward each part's target (this note)     | 0      | +10 000 | 40 000 / 20 000   |

VWCE is already 10 000 above its 30 000 target; the first two splits add to it.

The rule, per pass of §4.5. The passes do not change: Invest cash runs one,
Rebalance exactly two, cash first.

- **Increases only** (Invest cash, and Rebalance step 1). As today, only
  underweight categories are filled. Within one, the category gap goes to the
  parts below their target that can take an increase, in proportion to how far
  below they are, and never past their target:

  ```
  E             = parts with gap(p,c) > 0 that can take an increase
  f             = min(1, category_gap(c) / Σ_{q∈E} gap(q,c))
  intent(p,c)   = f × gap(p,c)                  for p in E
  unresolved(c) = category_gap(c) − Σ_p intent(p,c)
  ```

  When every part can take its share, the parts' gaps add up to at least the
  category gap, so f is the plain proportional share and nothing is unresolved.
  When one cannot, the others take its share up to their own targets (section
  4.1). The rest's intent is then spread over R(c) by §4.2.

- **Reductions allowed** (Rebalance step 2), measured on the projection after
  step 1, in two pieces:
  1. _Category move._ The category's remaining gap is shared exactly as above,
     on its own side: an underweight category increases the parts below their
     target that can take it, an overweight one reduces the parts above their
     target that can give it, never below their target. The category only ever
     moves toward its target, as today.
  2. _Internal swap._ Parts still above their target that can give a reduction,
     and parts still below their target that can take an increase, exchange
     equal amounts: S = min(total excess, total shortfall), each side spread in
     proportion. A part that cannot execute stays out of the swap, and a part
     above its target offers no more than it can actually sell: its reducible
     holdings, less what the category move already reduces. Otherwise §4.6 step
     1 (held quantity) would cut the sale and not the purchase. With both sides
     bounded this way, the swap never moves the category.

  When every part can execute, the two pieces together bring each part exactly
  to its target. A category without weights has one part, so only the category
  move applies: §4.2 as today, and the test
  `a_category_already_on_target_produces_nothing` keeps holding for it. Over 20
  000 generated targets without weights, the simulation found no difference from
  today's rule.

Why two pieces rather than "each part receives its own gap". The target of the
§4.4 example in section 3.1, in Rebalance: VWCE alone in Equity at 40 000 with a
50 % weight, Fixed income 40 % held at 50 000, 10 000 cash. Giving each part its
own gap sells 10 000 of VWCE while Equity is 20 000 below its target and its
rest cannot be bought: the category moves away from its target. With two pieces,
VWCE is left alone, Fixed income is reduced to 40 000, and Equity's 20 000 is
unresolved.

In Rebalance the example of this section continues: step 1 puts the 10 000 cash
on AAPL (40 000 / 20 000, Equity on target); in step 2 the category move is zero
and the internal swap reduces VWCE by 10 000 and increases AAPL by 10 000,
ending at 30 000 / 30 000 before limits.

**What the user sees.** The worksheet keeps its structure (§5): one line per
security, the same controls, the same calculated or edited status. Setup states
the rule per category, as facts: "Allocation rule: current holding proportions.
Equity: your security weights (VWCE 50 %), the rest by current holding
proportions." A weighted security not held in scope appears in Setup's security
list as named by the target. Unresolved parts show next to their category, as
today.

### 3.4 Internal swaps and the limits of §4.6

Before the limits of §4.6, the rule never takes a category past its target, nor
a weighted security past its own (random checks over 20 000 generated targets,
with random eligibility and protected positions: no case). §4.6 then acts on one
net amount per security, as afadil asked on 2026-09-01 (#1612, comment
5499526997), with one factor for every reduction when the turnover cap binds
(step 2) and one factor for every increase when funding is short (step 4), as he
decided on 2026-09-03 (comment 5526490781):

> Let's scale all positive net adjustments equally when funding is short. Keep
> cash-first to reduce sells. It should not protect specific increases. This
> uses all available funding and removes the need for `cash_committed`.

Without weights, step 2 only increases or only reduces a category, so neither
factor can take it past its target: the simulation found no case, with or
without random eligibility and protected positions. An internal swap puts a
reduction and an increase in the same category. When the two factors differ, the
category itself moves:

- **The turnover cap binds**, so the reduction factor is below the increase
  factor, and the category ends **above** its target. Example: Equity 60 % on
  target but split VWCE 40 000 / AAPL 20 000 (weights 50 / 50), Fixed income 40
  % held at 30 000, 10 000 cash, a 5 % cap. The cap halves the VWCE sale,
  funding scales the increases by 0.75, and Equity ends at 62 500.
- **Funding is short**, for instance because a position elsewhere is protected,
  so the increase factor is below the reduction factor: the swap's sale pays for
  another category, and the category ends **below** its target. Example: Equity
  60 % split VWCE 40 000 / AAPL 20 000 (weights 50 / 50), Fixed income 30 % held
  at 20 000, Gold 10 % held at 20 000 under a do-not-sell constraint, no cash.
  Equity ends at 55 000 and Fixed income at 25 000. Without weights nothing
  happens, since Fixed income has no funding.

Four ways to handle it, each computed by the simulation. The last column counts
the categories that ended above or below their target over 20 000 generated
targets.

| Option                                     | What it does                                                                                                                                            | Cap example                                         | Shortfall example                  | Above / below | Change to §4.6                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------- | ------------- | -------------------------------------------------------------- |
| **B**, keep §4.6 as written                | Reports the category outside its range, in the outside-range strip and Current · Projected · Target (§4.5)                                              | Equity 62 500, Fixed income 37 500                  | Equity 55 000, Fixed income 25 000 | 402 / 129     | None                                                           |
| **F**, a ceiling per category after step 4 | A weighted category that would end above its target has its net increases scaled by one factor to land on it; the money left is remaining cash (step 7) | Equity 60 000, Fixed income 37 500, 2 500 cash left | Equity 55 000, Fixed income 25 000 | 0 / 129       | One step after step 4, for weighted categories only            |
| **F2**, F plus a floor                     | As F; in addition, when funding is short, the sale of an internal swap takes the same factor as its purchase, so it never pays for another category     | Equity 60 000, Fixed income 37 500, 2 500 cash left | Equity 60 000, Fixed income 20 000 | 0 / 0         | F's step, and a swap's sale can be scaled below the cap factor |
| **A**, a swap scaled as one movement       | Both halves of an internal swap take the reduction factor; the swap's sale pays only for the swap's purchase                                            | Equity 60 000, Fixed income 40 000                  | Equity 60 000, Fixed income 20 000 | 0 / 0         | Swap purchases leave the single increase factor of step 4      |

- None of the four changes anything for a target without weights, and none
  spends more than the funding available (simulation).
- F acts in 2.0 % of the generated targets. When it does, it leaves a median of
  1.8 points of the planning total unspent. It does not touch the second case.
- F2 adds a floor to F. When funding is short, the common increase factor is
  computed with the swaps left aside, since each pays for itself; every
  increase, swap purchases included, takes that one factor, and each swap's sale
  takes it too. This is computed once, not iterated. In the shortfall example
  the factor is zero, so nothing moves, as without weights. The floor changes
  the result in 2.2 % of the generated targets. F2 keeps the single increase
  factor of step 4 in every case; its cost is F's unspent cash, and a swap that
  sells less than the cap would allow when its purchase cannot be funded.
- A also keeps a category from falling below its target, and spends all the cash
  in the cap example. Tying a swap's purchase to the cap factor rather than to
  the step 4 factor is, however, a reservation close to the `cash_committed`
  afadil removed.
- A variant combines A's handling of the cap with F2's floor: it spends all the
  cash in the cap example, like A, and moves nothing in the shortfall example,
  like F2 (0 / 0 as well). It is not detailed further here.
- For A, F2 and the variant, a security classified in several classes inside a
  swap needs a rule of its own (not simulated).

Rejected:

- No internal swap at all: a stock picker's single class is always on target, so
  Rebalance would never adjust anything.
- Swaps only when they fit entirely under the cap: the result jumps, and a whole
  kind of adjustment is dropped.
- Scaling the whole of step 2 by the cap factor before netting: it brings back
  afadil's case of 2026-09-01, where +500 and −300 with a cap of 100 must give
  +200, not +400.

The note does not pick among B, F, F2 and A; the choice is section 7,
question 1. In short: B changes nothing and reports; F prevents the overshoot
only; F2 prevents both effects and keeps the single increase factor, at the cost
of cash left unspent; A prevents both and spends the cash, at the cost of a
reservation.

---

## 4. Interactions

### 4.1 Eligible securities (#1486, §4.1)

- The Increase and Reduce switches work as today, per run.
- A weighted security left out of increases, or without a usable price, cannot
  take its share. The share goes to the other parts of the category that are
  still below their target, up to that target, with one common factor (section
  3.3). What is left is unresolved for the category (`NoEligibleSecurity`,
  `NoUsablePrice`) and stays available to place by hand, as unresolved amounts
  are today. §4.2 also hands an excluded security's share to the other eligible
  securities, without a ceiling
  (`ineligible_securities_cannot_receive_an_increase`: VTI left out, VXUS
  receives the whole 1 000). The ceiling keeps every number the user set.

  Example: Equity target 60 000 with VWCE 50 %, AAPL 30 %, MSFT 20 % (targets 30
  000 / 18 000 / 12 000), held 34 000 / 10 000 / 6 000, a gap of +10 000. With
  every security eligible, AAPL receives +5 714 and MSFT +4 286. With AAPL left
  out:

  | Rule                              | VWCE                 | MSFT                        | Unresolved |
  | --------------------------------- | -------------------- | --------------------------- | ---------- |
  | §4.2 without weights (today)      | +8 500               | +1 500                      | 0          |
  | AAPL's share left unresolved      | 0                    | +4 286                      | 5 714      |
  | This note: redistribution, capped | 0 (above its target) | +6 000 (reaches its target) | 4 000      |

- A weighted security that cannot be reduced (a #1177 constraint, or Reduce off)
  gives nothing. In the category move its share of a reduction goes to the other
  parts above their target, never below it; what is left stays a negative
  unresolved amount, as `split_gap` returns today for a category with nothing
  reducible. It takes no part in an internal swap.
- A weighted security not held in scope has v = 0 and gap = T(i,c), so it
  receives a calculated amount. This extends §4.1, where an added security gets
  nothing from §4.2. Setup lists it with Increase on by default: the target
  names it, which is a fact, not a selection. Two code paths change for it:
  `securities_from` builds securities only from held contributions, and
  `project_categories` skips a security whose classified value is zero. An
  unheld weighted security has to enter with its price and its taxonomy
  assignment, and its amount has to be projected by that assignment.

### 4.2 Accounts (§6)

Unchanged. Reductions keep their source accounts. An increase is placed
automatically only when exactly one account is eligible or exactly one eligible
account holds the security. An unheld weighted security has no holder, so it is
placed automatically only when exactly one account is eligible; otherwise it
arrives unallocated.

### 4.3 Cash-first sequence and limits (§4.5, §4.6)

Unchanged in order and in number of passes. Weights change only how a category's
amount is split between its securities; nothing is recalculated after step 2.
Reductions inside a category count toward the turnover cap like any other.

Section 3.3 in Rebalance with a 5 % turnover cap (5 000): before limits, AAPL
+20 000 (10 000 from cash, 10 000 from the swap) and VWCE −10 000. §4.6 step 2
scales the reduction to 5 000. Funding is 10 000 cash plus 5 000 proceeds, so
step 4 scales AAPL to +15 000 (factor 0.75). Result: VWCE 35 000, AAPL 25 000,
Equity 60 000, with both factors stated; the four options of section 3.4 give
the same result here, since only Equity receives cash. Section 3.4 covers the
cases where the two factors move a category.

### 4.4 Drift and Overview

- Category rows are unchanged.
- Holdings view: a weighted security's target is T(i,c), split across its
  holding rows in proportion to their value (#2587's split). A rest security's
  target is its share of the rest's current value times T(rest,c): today's
  formula, applied to the rest instead of the whole category.
- Weighted securities get a status (section 3.2), and their count outside range
  sits next to `out_of_band_count`.
- Overview's target card keeps its category rails and adds one line when
  weighted securities are outside range ("2 securities outside range"), opening
  the holdings view. For a stock picker with one class, that line is the signal
  that matters.

### 4.5 Export (§8)

- Header: the allocation rule says which categories use security weights
  ("Current holding proportions; security weights in Equity").
- Rows unchanged: one per security and account, with status, direction and
  amounts. Unresolved amounts stay rows with category and amount only, one per
  category and reason.

### 4.6 Copy (§7)

- Facts only, in §7's vocabulary. New terms: **Security weights**, **No
  weight**, **By class** and **By security** for the editor entry,
  `Rest of {{category}}`, and `Weights in {{category}} add up to {{percent}}`.
- Avoid: recommended, suggested, model portfolio, picks, ideal weights.
- `worksheet.reviewDisclaimer` stays as it is ("calculated these adjustments
  from your target, eligible securities, and allocation rule"): security weights
  are part of the target.
- The editor never fills in weights the user did not ask for. Its starts are
  From current holdings (a fact) and Equal weight (the arithmetic §4.2 cites as
  acceptable), both explicit choices; Build from scratch starts at 0.
- Example weights (§10) stay category-only. No example names a security.

### 4.7 AI guardrails

No change needed. No AI tool reads allocation targets today (nothing in
`crates/agent-tools` or `crates/ai` refers to them), and
`crates/ai/src/system_prompt.txt` already says: "Do not select, rank, optimize,
or recommend a specific security, account, direction, target, or amount from the
user's personal data." A request for security weights falls under it. If a tool
later exposes targets, security weights are reported as the user's own figures.
No eval in `crates/ai` covers allocation requests yet; adding one is outside
this note.

### 4.8 Add-on SDK (e71a80634)

`allocationTargets.getAll()` returns each target's category weights
(`AllocationTargetWeight`: category id, key, name and `targetBps`), and
`getDrift()` returns its category rows with `outOfBandCount`. Both stay as they
are, so existing add-ons see the same data. Security weights can be added later
as an optional field on `AllocationTarget`, behind the same grant, with an SDK
changelog entry. They are not part of the milestones below.

---

## 5. Persistence

### 5.1 What is stored

Per target, category and security: one weight in bps of the category, and the
lock flag the editor saves, as category weights do.

### 5.2 Why new persisted data

**The failure it prevents.** "50 % VWCE in Equity" has to survive a restart and
reach the user's other devices, and drift and Overview have to read it whenever
they show the target. The only place the worksheet keeps inputs today is its
device-local draft (§11), which drift does not read and sync does not carry.
Without storage the weight is lost on reload, and drift keeps showing the
derived target #1836 asks to edit.

**Why the existing tables do not fit.**

| Option                                                                          | Why not                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allocation_target_weights`                                                     | Category rows in bps of the portfolio, unique on (target, taxonomy, category). Security rows would need a table rebuild to change that key, and every current reader (drift, worksheet, export, the add-on bridge) would start receiving rows in another unit.  |
| `allocation_target_constraints` (#1177; §11's likely home for the eligible set) | A list of (subject, action, effect) rules with no numeric value. A weight would have to sit in `metadata_json`, outside the range check, the unique key and any per-category sum check. §11's route stays right for the eligible set, a yes or no per security. |
| `allocation_target_asset_weights` from #2587, as is                             | The right grain, with the lock, but flat: no category, and a `target_type` column with triggers that allow one kind of weight per target.                                                                                                                       |

So: #2587's table, made nested.

### 5.3 Schema

```sql
CREATE TABLE allocation_target_asset_weights (
    id TEXT PRIMARY KEY NOT NULL,
    target_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    -- share of the category, not of the portfolio
    target_bps INTEGER NOT NULL CHECK (target_bps >= 0 AND target_bps <= 10000),
    is_locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE,
    UNIQUE(target_id, category_id, asset_id)
);

CREATE INDEX idx_allocation_target_asset_weights_target
ON allocation_target_asset_weights(target_id);
```

Against #2587's migration: `category_id` is added and joins the unique key.
`is_required` is dropped: a weighted security always has a row to show, so the
flag has nothing to decide. `allocation_targets` gets no `target_type` column,
and none of the five type triggers is needed. The foreign key on `asset_id` is
left open (section 7, question 4).

No foreign key to the category. Category weights are deleted and reinserted with
new ids on every save (`build_domain_weights` draws a new UUID per row, and the
repository deletes before inserting), so a cascading key would delete security
rows on every save, without outbox events. The service checks the category on
write, and the read path ignores weights whose category the target no longer
weights (section 5.5).

No `taxonomy_id` column: the target fixes the taxonomy. A save that changes it
already replaces the category weights (test
`save_target_with_weights_allows_taxonomy_change_with_replacement_weights`), and
replaces the security weights in the same transaction.

The unit is bps of the category, as every other weight is in bps. With weights
displayed at one decimal, as the editor does today, its round trip (section 1.4)
never shows. Two decimals would make it show unless shares get a finer unit,
which is why the display is settled with the schema (section 7, question 4).

### 5.4 Write path and API

- `save_target_with_weights` saves the target, its category weights and its
  security weights in one transaction, replacing each set, with one outbox event
  per row. This is #2587's repository code.
- Input
  `NewAllocationTargetAssetWeight { categoryId, assetId, targetBps, isLocked }`,
  result `SaveAllocationTargetResult.assetWeights`, and the list command
  `list_allocation_target_asset_weights`: #2587's, with `categoryId` added. Both
  runtimes are wired and the parity test covers them.
- Service validation: each weight between 0 and 10 000; no duplicate (category,
  security); the weights of each category add up to at most 10 000; the category
  is one the target weights and not its cash category; the asset exists and is
  an investment (#2587's `validate_target_asset_weights`) and is classified in
  that category.

### 5.5 Read path

Rows that did not go through the service (sync replay, a restore, an older app
editing the target) are tolerated on read:

- a weight whose category the target does not weight is ignored;
- a weight whose asset is missing, or no longer classified in the category, is
  ignored, and its share falls into the rest;
- when the weights of one category add up to more than 100 %, none of them
  applies (§4.2 for the whole category) and the target says "Weights in Equity
  add up to 140 %" until it is saved again. This is required behaviour, not
  extra resilience: the rest would otherwise be negative.

### 5.6 Sync and older versions

- New entity `allocation_target_asset_weight`, after `allocation_target_weight`
  in the canonical order, parent before child. This is #2587's registration.
- An older app skips an unknown remote entity with a warning
  (`sync_entity_from_remote` returns `None` in `device-sync/src/engine/mod.rs`)
  and keeps computing §4.2 for every category. If it saves the target, its
  repository does not know the table, so the security rows survive. If it
  removes a category, that category's security rows are ignored on read (section
  5.5).

### 5.7 Conflicts and limits

Starting from the known limitations of #2587:

1. **Concurrent replacement of one target** by two offline devices. Rows sync
   one by one, and each save writes new ids, so both sets can land. When both
   sets weight the same security in the same category, the second insert breaks
   the unique key and is dead-lettered, as any failing replay event is (replay
   loop in `storage-sqlite/src/sync/app_sync/repository.rs`). When they weight
   different securities, a category can exceed 100 %, and section 5.5 applies.
   Category weights share this gap today. Closing it needs target-level conflict
   resolution, the follow-up #2587 names; it is not part of this note.
2. **A weight edited offline for a security another device deleted.** With
   `asset_id REFERENCES assets ON DELETE RESTRICT`, as in #2587, the insert
   fails its foreign key and is dead-lettered, leaving that target short on the
   deleting device. Without the key, the row lands and is ignored on read.
3. **A remote asset delete, or a snapshot restore that drops a security.** #2587
   spreads the weight over the target's other securities to keep its 100 %
   total. Nested weights add up to at most 100 % by design: a missing security's
   share falls into the rest, so nothing needs spreading. Without the asset
   foreign key nothing is needed at all. With it, the remote delete still has to
   delete the rows, and the restore still needs #2587's stash, both without the
   spreading.
4. **An unknown asset resolved.** Required: otherwise the user's number silently
   joins the rest after a routine import fix. #2587's
   `reassign_allocation_target_weights`, keyed by (target, category, security).
   Its "no clamp" comment still holds, because two weights merged into one row
   were in the same category, whose weights add up to at most 100 %.
5. **The local delete of a weighted asset.** #2587 blocks it. Without the
   foreign key, blocking is optional, since the weight would fall into the rest;
   it stays out unless agreed.

---

## 6. Non-goals, migration and milestones

### 6.1 Non-goals

- A target type made only of securities, or a security weight outside a
  category.
- Bands, caps, minimums or maximums per security, including a per-security
  turnover cap.
- Weights under subcategories. `asset_classes`, `industries_gics`, `regions` and
  `instrument_type` targets weight top-level categories only
  (`requires_top_level_target_weights`), and security weights nest one level
  under the categories a target weights.
- Weights under the cash category, which no security carries.
- Any list of securities proposed by the app: example security weights, filling
  from an index, ranking, substitution.
- Weights suggested by the AI assistant.
- Persisting the eligible set (§11) and accounts as a dimension (#1600).
- Target-level sync conflict resolution (section 5.7).

### 6.2 Migration of existing data

- One migration creates the table. Nothing is altered in `allocation_targets` or
  `allocation_target_weights`, and no row is written.
- No existing target has a security weight, so each of its categories resolves
  as one rest at 100 %, which is §4.2 as today. Drift, the worksheet and the
  export return what they return now.
- The down migration drops the table.

### 6.3 Milestones

| #     | Content                                                                                                                                                                                                                                                                      | Verify                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Calculation in core: parts and rest, the split rules of section 3.3, the option of section 3.4 that afadil picks, unresolved parts, unheld weighted securities projected by their assignment. Pure functions in `worksheet_calculator.rs`, weights passed in, nothing stored | core tests for every example in sections 3 and 4: partial category, a rest without a security, an empty rest, an explicit zero, the gap × weight counterexample, the capped redistribution when a weighted security is excluded, unpriced or protected, the two-piece step 2 and its moving-away counterexample, the cap and shortfall examples of section 3.4, an unheld weighted security moving its category, two passes and no more; a target without weights gives today's results; every existing `worksheet_calculator` test unchanged |
| S2    | Persistence, API and sync: the table of section 5.3 from #2587, repository, validation, read-path tolerance, unknown-asset merge, Tauri and Axum, adapters, sync registration                                                                                                | storage tests for save, replace, delete and outbox rows; `cleanup_tests`; the adapted reassign test; read-path tests (category not weighted, missing asset, sum above 100 %); `adapter-command-parity.test.ts`; `cargo check` of both runtimes, fmt and Clippy; the migration on a populated database leaves existing targets and weights unchanged                                                                                                                                                                                           |
| S3    | Worksheet and drift services: weights loaded into S1, the Setup statement, holdings targets and statuses, the count of weighted securities outside range                                                                                                                     | service tests: a target without security weights gives the same adjustments and drift report as before (snapshot); the adapted split-across-rows test; the band examples of section 3.2                                                                                                                                                                                                                                                                                                                                                       |
| S4    | Editor, Overview, export and copy: rows per category with a rest row, explicit zero, entry by class or by security, Equal weight start; the Overview line; the export header; every locale                                                                                   | vitest: both entries write the same stored weights, AAPL 30 → 35 is one input, rounding adds up to 100 % of the class; copy-contract test and `i18n:check`; export snapshot; the changed flows checked on screen, left-to-right and `?dir=rtl`                                                                                                                                                                                                                                                                                                |
| Later | Add-on SDK field for security weights (section 4.8)                                                                                                                                                                                                                          | type-bridge tests and SDK changelog                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 7. Open questions for @afadil

Only what blocks a milestone. The shape is settled and not part of these.

1. **Internal swaps under the limits of §4.6** (section 3.4). Without weights, a
   category in step 2 is only increased or only reduced, so the two factors of
   §4.6 cannot take it past its target. A swap inside a weighted category can,
   in both directions. Which option?
   - **B**: keep §4.6 as written and report the category outside its range.
   - **F**: a weighted category never ends above its target; the money left is
     remaining cash, and a category can still end below its target when funding
     is short.
   - **F2**: F, plus a floor: when funding is short, a swap's sale takes its
     purchase's factor, so no category ends below its target either. The single
     increase factor of step 4 holds in every case.
   - **A**: a swap's purchase is scaled with its sale by the cap factor, which
     prevents both effects and spends all the cash, at the cost of a reservation
     close to the `cash_committed` you removed on 2026-09-03.

   Answering also confirms the split of section 3.3: toward each part's target,
   with the capped redistribution and the two-piece step 2. Blocks S1.

2. **(b), the status of weighted securities.** The target-wide band evaluated on
   each weighted security against its share of the portfolio, with a separate
   count beside `out_of_band_count` (section 3.2). Or against its share of the
   category? Blocks S3.
3. **The #1836 stock picker.** Entry by security in the editor, class weights
   derived from it, storage nested (section 1.4). Agreed as the answer to #1836?
   Blocks S4.
4. **Two schema details.** (i) `asset_id` without a foreign key, like the #1177
   constraints, which removes the cases in section 5.7 items 2 and 3
   (recommended), or `REFERENCES assets ON DELETE RESTRICT` as in #2587, with
   its remote-delete and restore handling? (ii) Display and unit: one decimal,
   as the allocation-target screens show today, with shares in bps of the
   category (suggested); or two decimals like most of the app, either accepting
   a 0.01 round trip in the by-security entry or storing shares in a finer unit
   (section 1.4). Blocks S2.

---

## 8. Changes to the self-directed design once agreed

These lines of the design change with this note, and are folded back into it
once the questions above are answered:

- §2, row "Which security inside a category": the user's weight where stated,
  otherwise the rule, mechanically.
- §4.3, "that statement replaces the rule for that category": it replaces the
  rule for the weighted part; the rule still fills the rest.
- §4.1, "The proportional rule (§4.2) gives it nothing": still true for an added
  security without a weight. A weighted security not held receives a calculated
  amount.
- §4.1, excluded securities: the share of an excluded weighted security goes to
  the other securities of the category only up to their own target, and what is
  left is unresolved. §4.2 gives it to the other eligible securities without a
  ceiling.
- §4.5: Rebalance step 2 in a weighted category has two pieces, a category move
  and an internal swap; in a category on target only the swap acts. The number
  of passes does not change, and categories without weights are unchanged.
- §4.6, depending on question 1: nothing with B; with F, a step after step 4 for
  weighted categories; with F2, that step, and a swap's sale taking its
  purchase's factor when funding is short; with A, the purchase of an internal
  swap takes the reduction factor instead of the step 4 factor.
- §8: the header's allocation rule says which categories use security weights.
- §9 and §12: "no schema, no migration, no API" and "Future" point to this note
  and its milestones.
- §11 is unchanged: the eligible set still belongs in
  `allocation_target_constraints`.

---

## 9. References

- [`self-directed-rebalancing-design.md`](./self-directed-rebalancing-design.md),
  §4 to §9, §11 and §12.
- [PR #2587](https://github.com/wealthfolio/wealthfolio/pull/2587) at
  `07f0cdbd8`, its known limitations, and the discussion in comments 6744503641
  and 6744773094.
- [Issue #1836](https://github.com/wealthfolio/wealthfolio/issues/1836).
- PR #1612, comments 5499526997 (limits on net amounts, 2026-09-01) and
  5526490781 (one factor for every increase, 2026-09-03).
- PR #1177 (constraints and turnover cap) and its execution-policy design.
- e71a80634 (add-on SDK read of allocation targets).
- Code checked on `main` at `fc695b2ea`: `worksheet_calculator.rs`,
  `worksheet_service.rs`, `drift_service.rs`, `target_service.rs` and
  `validation.rs` in `crates/core/src/portfolio/allocation_targets/`;
  `crates/core/src/assets/auto_classification.rs`; the allocation migrations and
  repository in `crates/storage-sqlite`; `target-weight-editor.tsx` and
  `target-rails-card.tsx`; the sync entity registration in `crates/core`,
  `crates/device-sync` and `crates/storage-sqlite`;
  `crates/ai/src/system_prompt.txt`; `packages/addon-sdk/src/data-types.ts` and
  `apps/frontend/src/addons/type-bridge.ts`.
