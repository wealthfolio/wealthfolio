//! Arithmetic behind the calculated rebalancing worksheet.
//!
//! Implements §4 of `docs/features/allocations/self-directed-rebalancing-design.md`.
//! Everything here is a pure function over inputs the service has already
//! resolved: no repositories, no clock, no currency conversion. The service
//! fetches the drift report, the taxonomy contributions, prices and
//! constraints, and hands them over as the structs below.
//!
//! The product boundary this file has to hold: it spreads amounts the user's
//! own target implies, over securities the user marked eligible, by a rule the
//! user picked. It never ranks, scores or chooses between securities.

use std::collections::HashMap;

use rust_decimal::Decimal;

use super::model::{
    AdjustmentScaling, UnresolvedCategoryAmount, UnresolvedReason, WorksheetDirection,
    WorksheetMode,
};

/// A target category as the calculation sees it, taken from the drift report.
#[derive(Debug, Clone)]
pub struct CategoryTarget {
    pub category_id: String,
    pub category_name: String,
    pub target_bps: i32,
    pub current_value: Decimal,
    /// The taxonomy's cash sleeve. No security carries it, so the allocation
    /// rule has nothing to spread its gap over — it is filled by the cash left
    /// after the increases, and by what the reductions raise.
    pub is_cash: bool,
}

/// Where one security's units sit, and whether they may be reduced.
#[derive(Debug, Clone)]
pub struct PositionInput {
    pub account_id: String,
    pub quantity: Decimal,
    /// False when a do-not-sell or avoid-selling constraint from #1177 covers
    /// this position. Eligibility never sets this — it gates increases only.
    pub can_reduce: bool,
}

/// A recorded security: what it is worth in each category, what a unit costs,
/// and where its units sit.
#[derive(Debug, Clone)]
pub struct SecurityInput {
    pub asset_id: String,
    pub symbol: String,
    /// Base currency, contract multiplier already applied. `None` when no
    /// usable price could be resolved.
    pub unit_price: Option<Decimal>,
    /// Chosen by the user as able to receive increases (§4.1).
    pub is_eligible_for_increase: bool,
    /// Value attributed to each category, in base currency. A security
    /// classified across several categories appears once per category.
    pub category_values: Vec<(String, Decimal)>,
    pub positions: Vec<PositionInput>,
}

impl SecurityInput {
    fn value_in(&self, category_id: &str) -> Decimal {
        self.category_values
            .iter()
            .find(|(id, _)| id == category_id)
            .map(|(_, value)| *value)
            .unwrap_or(Decimal::ZERO)
    }

    fn reducible_quantity(&self) -> Decimal {
        self.positions
            .iter()
            .filter(|position| position.can_reduce)
            .map(|position| position.quantity)
            .sum()
    }
}

/// One category's share of what a security should be adjusted by, before the
/// per-security amounts are combined (§4.5).
#[derive(Debug, Clone, PartialEq)]
pub struct Intent {
    pub asset_id: String,
    pub category_id: String,
    /// Signed: positive increases the position, negative reduces it.
    pub amount: Decimal,
}

/// The gap between a category's target value and what it currently holds
/// (§4.2). Positive means underweight, so the category wants an increase.
///
/// `planning_total` rather than the drift report's total, because the two
/// differ when the taxonomy has no cash sleeve and the cash being deployed
/// widens the basis.
pub fn category_gaps(
    categories: &[CategoryTarget],
    planning_total: Decimal,
) -> Vec<(String, Decimal)> {
    categories
        .iter()
        .map(|category| {
            let target_value =
                Decimal::from(category.target_bps) / Decimal::from(10_000) * planning_total;
            (
                category.category_id.clone(),
                target_value - category.current_value,
            )
        })
        .collect()
}

/// Spreads one category's gap across the securities that carry it, in
/// proportion to what each already holds of that category (§4.2).
///
/// ```text
/// weight_i    = value_i,c / Σ_j value_j,c
/// intent_i,c  = category_gap(c) × weight_i
/// ```
///
/// Returns the reason instead when the gap cannot be placed at all, which the
/// caller turns into an unresolved category amount (§4.4).
pub fn split_gap(
    category_id: &str,
    gap: Decimal,
    securities: &[SecurityInput],
) -> Result<Vec<Intent>, UnresolvedReason> {
    if gap == Decimal::ZERO {
        return Ok(Vec::new());
    }

    let direction = if gap > Decimal::ZERO {
        WorksheetDirection::Increase
    } else {
        WorksheetDirection::Reduce
    };

    let exposed: Vec<&SecurityInput> = securities
        .iter()
        .filter(|security| security.value_in(category_id) > Decimal::ZERO)
        .collect();
    if exposed.is_empty() {
        return Err(UnresolvedReason::NoRecordedSecurity);
    }

    // Eligibility gates increases and never restricts reductions (§4.1). A
    // reduction needs somewhere to draw from instead, so a position covered by
    // a do-not-sell constraint is not a carrier either.
    let permitted: Vec<&SecurityInput> = exposed
        .into_iter()
        .filter(|security| match direction {
            WorksheetDirection::Increase => security.is_eligible_for_increase,
            WorksheetDirection::Reduce => security.reducible_quantity() > Decimal::ZERO,
        })
        .collect();
    if permitted.is_empty() {
        return Err(UnresolvedReason::NoEligibleSecurity);
    }

    let carriers: Vec<&SecurityInput> = permitted
        .into_iter()
        .filter(|security| {
            security
                .unit_price
                .is_some_and(|price| price > Decimal::ZERO)
        })
        .collect();
    if carriers.is_empty() {
        return Err(UnresolvedReason::NoUsablePrice);
    }

    let total: Decimal = carriers
        .iter()
        .map(|security| security.value_in(category_id))
        .sum();
    // Allocating by current holding proportions needs proportions to work
    // from. Carriers worth nothing give none, and inventing a split between
    // them would be the app choosing between securities.
    if total <= Decimal::ZERO {
        return Err(UnresolvedReason::NoRecordedSecurity);
    }

    Ok(carriers
        .iter()
        .map(|security| Intent {
            asset_id: security.asset_id.clone(),
            category_id: category_id.to_string(),
            amount: gap * security.value_in(category_id) / total,
        })
        .collect())
}

/// Combines every category's intent for a security into the one amount that
/// gets applied to it (§4.5).
///
/// A security classified 60 % equity / 40 % fixed income moves both categories
/// once, by the amount actually applied to it — so the projection is
/// recalculated from these combined amounts, never from the intents that
/// produced them.
pub fn combine_intents(intents: &[Intent]) -> HashMap<String, Decimal> {
    let mut combined: HashMap<String, Decimal> = HashMap::new();
    for intent in intents {
        *combined.entry(intent.asset_id.clone()).or_default() += intent.amount;
    }
    combined
}

/// Runs §4.2 over every category, keeping the intents that placed and the
/// amounts that did not.
pub fn spread_gaps(
    categories: &[CategoryTarget],
    planning_total: Decimal,
    securities: &[SecurityInput],
) -> (Vec<Intent>, Vec<UnresolvedCategoryAmount>) {
    spread_gaps_where(categories, planning_total, securities, |_| true)
}

/// [`spread_gaps`], restricted to the gaps a pass is allowed to act on.
///
/// The first pass only fills underweight categories, since cash cannot create
/// a reduction. A gap the pass skips is not unresolved — it is simply not this
/// pass's business.
fn spread_gaps_where(
    categories: &[CategoryTarget],
    planning_total: Decimal,
    securities: &[SecurityInput],
    accept: impl Fn(Decimal) -> bool,
) -> (Vec<Intent>, Vec<UnresolvedCategoryAmount>) {
    let mut intents = Vec::new();
    let mut unresolved = Vec::new();

    let is_cash: HashMap<&str, bool> = categories
        .iter()
        .map(|category| (category.category_id.as_str(), category.is_cash))
        .collect();

    for (category_id, gap) in category_gaps(categories, planning_total) {
        if !accept(gap) {
            continue;
        }
        // The cash sleeve is not filled by buying a security, so its gap is
        // neither spread nor unresolved. Deploying less cash and raising more
        // through reductions is what moves it.
        if is_cash.get(category_id.as_str()).copied().unwrap_or(false) {
            continue;
        }
        match split_gap(&category_id, gap, securities) {
            Ok(placed) => intents.extend(placed),
            Err(reason) => {
                let category = categories
                    .iter()
                    .find(|candidate| candidate.category_id == category_id);
                unresolved.push(UnresolvedCategoryAmount {
                    category_id: category_id.clone(),
                    category_name: category
                        .map(|category| category.category_name.clone())
                        .unwrap_or_else(|| category_id.clone()),
                    amount: gap,
                    reason,
                });
            }
        }
    }

    (intents, unresolved)
}

// ── Pass sequence (§4.5) ─────────────────────────────────────────────────────

/// Recomputes each category's current value from the amounts actually applied
/// to securities (§4.5).
///
/// A multi-category security's amount is spread by its own classification, so
/// a security classified 60 % equity / 40 % fixed income moves both categories
/// once, by the amount applied to it — never by the per-category intents that
/// produced that amount.
pub fn project_categories(
    categories: &[CategoryTarget],
    securities: &[SecurityInput],
    applied: &HashMap<String, Decimal>,
    cash_drawdown: Option<(&str, Decimal)>,
) -> Vec<CategoryTarget> {
    let mut deltas: HashMap<String, Decimal> = HashMap::new();

    for security in securities {
        let Some(amount) = applied.get(&security.asset_id).copied() else {
            continue;
        };
        let classified: Decimal = security
            .category_values
            .iter()
            .map(|(_, value)| *value)
            .sum();
        if amount == Decimal::ZERO || classified <= Decimal::ZERO {
            continue;
        }
        for (category_id, value) in &security.category_values {
            *deltas.entry(category_id.clone()).or_default() += amount * *value / classified;
        }
    }

    // Cash spent leaves the cash sleeve. Without this the second pass would
    // still see the cash sitting there and keep reducing to fill categories the
    // first pass already filled.
    if let Some((cash_category_id, drawn)) = cash_drawdown {
        *deltas.entry(cash_category_id.to_string()).or_default() -= drawn;
    }

    categories
        .iter()
        .map(|category| CategoryTarget {
            current_value: category.current_value
                + deltas
                    .get(&category.category_id)
                    .copied()
                    .unwrap_or(Decimal::ZERO),
            ..category.clone()
        })
        .collect()
}

/// What the pass sequence needs to know.
#[derive(Debug, Clone)]
pub struct SequenceInput<'a> {
    pub mode: WorksheetMode,
    pub categories: &'a [CategoryTarget],
    pub securities: &'a [SecurityInput],
    pub planning_total: Decimal,
    /// Recorded cash the user selected for deployment. Already sitting in the
    /// cash sleeve, so deploying it draws that sleeve down.
    pub cash: Decimal,
    /// Hypothetical cash not recorded anywhere yet. It arrives in the sleeve
    /// before it is deployed, so it must not be drawn out of a balance that
    /// never held it.
    pub external_cash: Decimal,
    /// The taxonomy's cash sleeve, when it has one. The second pass has to see
    /// what the first one spent.
    pub cash_category_id: Option<String>,
}

impl SequenceInput<'_> {
    fn deployable_cash(&self) -> Decimal {
        self.cash + self.external_cash
    }
}

#[derive(Debug, Clone)]
pub struct SequenceOutput {
    pub increases: Vec<DraftIncrease>,
    pub reductions: Vec<DraftReduction>,
    pub unresolved: Vec<UnresolvedCategoryAmount>,
}

fn sorted_by_asset(amounts: HashMap<String, Decimal>) -> Vec<(String, Decimal)> {
    let mut sorted: Vec<(String, Decimal)> = amounts.into_iter().collect();
    sorted.sort_by(|left, right| left.0.cmp(&right.0));
    sorted
}

/// Runs the mode's pass sequence (§4.5).
///
/// **Invest cash** runs one pass. **Rebalance** runs a fixed sequence of
/// exactly two, cash first. It is fixed, not a loop: nothing is recalculated
/// again after the second pass, and the number of passes never depends on the
/// result.
pub fn run_sequence(input: &SequenceInput) -> SequenceOutput {
    // Pass 1 — deploy the selected cash against the gaps. Only underweight
    // categories are filled, since cash cannot create a reduction.
    let (intents, unresolved) = spread_gaps_where(
        input.categories,
        input.planning_total,
        input.securities,
        |gap| gap > Decimal::ZERO,
    );
    let mut cash_intents = combine_intents(&intents);

    // The cash is what it is. When the gaps ask for more, every intent is
    // scaled by the same factor — dropping one would be a choice between
    // securities.
    let available = input.deployable_cash();
    let wanted: Decimal = cash_intents.values().sum();
    let deployed = wanted.min(available);
    if wanted > available && wanted > Decimal::ZERO {
        let factor = available / wanted;
        for amount in cash_intents.values_mut() {
            *amount *= factor;
        }
    }

    let mut increases: Vec<DraftIncrease> = sorted_by_asset(cash_intents.clone())
        .into_iter()
        .filter(|(_, amount)| *amount > Decimal::ZERO)
        .map(|(asset_id, amount)| DraftIncrease { asset_id, amount })
        .collect();

    if input.mode == WorksheetMode::InvestCash {
        return SequenceOutput {
            increases,
            reductions: Vec::new(),
            unresolved,
        };
    }

    // Pass 2 — reductions cover the differences the cash did not, and fund the
    // increases those differences imply.
    let projected = project_categories(
        input.categories,
        input.securities,
        &cash_intents,
        // External cash lands in the sleeve on its way out, so only the part
        // that was already recorded there is actually drawn down. Deploying
        // less than the contribution leaves the sleeve fuller than it started.
        input
            .cash_category_id
            .as_deref()
            .map(|category_id| (category_id, deployed - input.external_cash)),
    );
    let (remaining_intents, remaining_unresolved) =
        spread_gaps(&projected, input.planning_total, input.securities);

    let mut reductions = Vec::new();
    for (asset_id, amount) in sorted_by_asset(combine_intents(&remaining_intents)) {
        if amount > Decimal::ZERO {
            increases.push(DraftIncrease { asset_id, amount });
        } else if amount < Decimal::ZERO {
            reductions.push(DraftReduction {
                asset_id,
                amount: -amount,
            });
        }
    }

    SequenceOutput {
        increases,
        reductions,
        // The second pass sees the projected state, so its list is the complete
        // one: a category the first pass could not place is still unplaced here.
        unresolved: remaining_unresolved,
    }
}

// ── Limits (§4.6) ────────────────────────────────────────────────────────────
//
// Applied in the order below before the worksheet is prefilled. Every step
// either scales proportionally or reports; none of them drops a line, since
// dropping would be a choice between securities.

/// An increase before the limits are applied. Amount is positive.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftIncrease {
    pub asset_id: String,
    pub amount: Decimal,
}

/// A reduction before the limits are applied. Amount is a positive magnitude.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftReduction {
    pub asset_id: String,
    pub amount: Decimal,
}

/// What the user's target and guardrails allow, in base currency.
#[derive(Debug, Clone)]
pub struct LimitsInput {
    /// Tracked cash the user selected for deployment.
    pub tracked_cash: Decimal,
    /// Hypothetical cash not currently recorded.
    pub external_cash: Decimal,
    /// Absolute cap on the reduction total. Derive it from the target's
    /// `max_turnover_bps` with [`turnover_cap_value`].
    pub turnover_cap: Option<Decimal>,
    pub min_line_amount: Decimal,
    pub whole_shares_only: bool,
}

/// One line after the limits are applied.
#[derive(Debug, Clone, PartialEq)]
pub struct LimitedLine {
    pub asset_id: String,
    /// Signed: negative for a reduction.
    pub amount: Decimal,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    /// Below the target's minimum — reported, never dropped, never re-rounded
    /// to lift it over the threshold (§4.6 step 6).
    pub is_below_minimum: bool,
}

#[derive(Debug, Clone)]
pub struct LimitedAdjustments {
    /// One line per security, signed (§4.5). A security the first pass
    /// increased and the second reduced nets out rather than producing two
    /// opposing lines. Ordered by asset id so the result is reproducible.
    pub lines: Vec<LimitedLine>,
    pub scaling: AdjustmentScaling,
    /// Left after rounding and minimum-line reporting, before the lines are
    /// placed in accounts. Never redistributed. Use [`remaining_cash`] once
    /// assignment has run, since a whole-unit split can raise less than this.
    pub remaining_cash: Decimal,
}

impl LimitedAdjustments {
    pub fn increases(&self) -> impl Iterator<Item = &LimitedLine> {
        self.lines.iter().filter(|line| line.amount > Decimal::ZERO)
    }

    pub fn reductions(&self) -> impl Iterator<Item = &LimitedLine> {
        self.lines.iter().filter(|line| line.amount < Decimal::ZERO)
    }
}

/// The turnover cap as an amount, from the target's `max_turnover_bps`.
pub fn turnover_cap_value(
    planning_total: Decimal,
    max_turnover_bps: Option<i32>,
) -> Option<Decimal> {
    max_turnover_bps.map(|bps| planning_total * Decimal::from(bps) / Decimal::from(10_000))
}

fn unit_price_of(securities: &[SecurityInput], asset_id: &str) -> Option<Decimal> {
    securities
        .iter()
        .find(|security| security.asset_id == asset_id)
        .and_then(|security| security.unit_price)
        .filter(|price| *price > Decimal::ZERO)
}

/// A security's single net amount, once every pass has had its say (§4.5).
///
/// The limits act on this rather than on the passes' drafts: a security bought
/// through one category and sold through another is one trade, and only what
/// survives the netting is actually bought or sold.
#[derive(Debug, Clone, PartialEq)]
struct NetAdjustment {
    asset_id: String,
    /// Signed: negative for a reduction.
    amount: Decimal,
}

/// §4.5 — one amount per security, ordered by asset id so the result is
/// reproducible in an export.
fn net_by_security(
    increases: &[DraftIncrease],
    reductions: &[DraftReduction],
) -> Vec<NetAdjustment> {
    let mut totals: HashMap<String, Decimal> = HashMap::new();
    for increase in increases {
        *totals.entry(increase.asset_id.clone()).or_default() += increase.amount;
    }
    for reduction in reductions {
        *totals.entry(reduction.asset_id.clone()).or_default() -= reduction.amount;
    }

    let mut netted: Vec<NetAdjustment> = totals
        .into_iter()
        .filter(|(_, amount)| *amount != Decimal::ZERO)
        .map(|(asset_id, amount)| NetAdjustment { asset_id, amount })
        .collect();
    netted.sort_by(|left, right| left.asset_id.cmp(&right.asset_id));
    netted
}

/// §4.6 step 1 — a reduction cannot exceed the recorded position it is drawn
/// from. Positions a do-not-sell constraint covers are not drawn from at all.
fn cap_to_held_quantity(nets: &mut [NetAdjustment], securities: &[SecurityInput]) {
    for net in nets.iter_mut().filter(|net| net.amount < Decimal::ZERO) {
        let held_value = securities
            .iter()
            .find(|security| security.asset_id == net.asset_id)
            .map(|security| {
                security.unit_price.unwrap_or(Decimal::ZERO) * security.reducible_quantity()
            })
            .unwrap_or(Decimal::ZERO);
        net.amount = net.amount.max(-held_value);
    }
}

/// §4.6 step 2 — every reduction is scaled by the same factor to fit the cap.
///
/// The cap measures what is actually sold, so it looks at the netted amounts:
/// a security the passes bought through one category and sold through another
/// consumes no turnover if it ends up bought.
fn scale_to_turnover_cap(nets: &mut [NetAdjustment], cap: Option<Decimal>) -> Option<Decimal> {
    let cap = cap?;
    let total: Decimal = nets
        .iter()
        .filter(|net| net.amount < Decimal::ZERO)
        .map(|net| -net.amount)
        .sum();
    if total <= cap || total <= Decimal::ZERO {
        return None;
    }

    let factor = cap / total;
    for net in nets.iter_mut().filter(|net| net.amount < Decimal::ZERO) {
        net.amount *= factor;
    }
    Some(factor)
}

/// §4.6 step 4 — every positive net adjustment is scaled by the same factor
/// when the funding falls short.
///
/// No increase is protected: the cash-first sequence exists to reduce how much
/// has to be sold, not to shelter the increases it happened to fund. Scaling
/// them all equally spends the funding down to the last unit and keeps the
/// result independent of which pass produced a line.
fn scale_to_funding(nets: &mut [NetAdjustment], available: Decimal) -> Option<Decimal> {
    let total: Decimal = nets
        .iter()
        .filter(|net| net.amount > Decimal::ZERO)
        .map(|net| net.amount)
        .sum();
    if total <= available || total <= Decimal::ZERO {
        return None;
    }

    let factor = (available / total).max(Decimal::ZERO);
    for net in nets.iter_mut().filter(|net| net.amount > Decimal::ZERO) {
        net.amount *= factor;
    }
    Some(factor)
}

/// §4.6 steps 5 and 6 — quantities are floored under whole-unit policy, and a
/// line below the minimum is flagged rather than dropped or re-rounded.
///
/// `amount` is signed. Flooring works on the magnitude, so a whole-unit policy
/// buys fewer units and sells fewer units — never more than asked either way.
fn finalize(
    asset_id: &str,
    amount: Decimal,
    unit_price: Decimal,
    limits: &LimitsInput,
) -> LimitedLine {
    let sign = if amount < Decimal::ZERO {
        Decimal::NEGATIVE_ONE
    } else {
        Decimal::ONE
    };
    let mut quantity = amount.abs() / unit_price;
    if limits.whole_shares_only {
        quantity = quantity.floor();
    }
    let resolved = quantity * unit_price;
    let is_below_minimum =
        limits.min_line_amount > Decimal::ZERO && resolved < limits.min_line_amount;

    LimitedLine {
        asset_id: asset_id.to_string(),
        amount: resolved * sign,
        quantity: quantity * sign,
        unit_price,
        is_below_minimum,
    }
}

/// Applies §4.6 in order, to one net amount per security: held quantity,
/// turnover cap, available proceeds, funding, rounding, minimum line size,
/// remaining cash.
pub fn apply_limits(
    increases: Vec<DraftIncrease>,
    reductions: Vec<DraftReduction>,
    securities: &[SecurityInput],
    limits: &LimitsInput,
) -> LimitedAdjustments {
    let mut nets = net_by_security(&increases, &reductions);

    cap_to_held_quantity(&mut nets, securities);
    let reduction_factor = scale_to_turnover_cap(&mut nets, limits.turnover_cap);

    // Step 3 — what the reductions actually raise, added to the cash the user
    // selected, is the funding available to the increases.
    let proceeds: Decimal = nets
        .iter()
        .filter(|net| net.amount < Decimal::ZERO)
        .map(|net| -net.amount)
        .sum();
    let available = limits.tracked_cash + limits.external_cash + proceeds;

    let increase_factor = scale_to_funding(&mut nets, available);

    let lines: Vec<LimitedLine> = nets
        .into_iter()
        .filter_map(|net| {
            let price = unit_price_of(securities, &net.asset_id)?;
            Some(finalize(&net.asset_id, net.amount, price, limits))
        })
        .filter(|line| line.amount != Decimal::ZERO)
        .collect();

    // Step 7 — whatever rounding and minimum-line reporting left behind. Not
    // redistributed: that would be another round of construction. Signed
    // amounts mean the reductions already offset what they raised.
    let net_deployed: Decimal = lines.iter().map(|line| line.amount).sum();
    let remaining_cash = limits.tracked_cash + limits.external_cash - net_deployed;

    LimitedAdjustments {
        lines,
        scaling: AdjustmentScaling {
            reduction_factor,
            increase_factor,
        },
        remaining_cash,
    }
}

// ── Accounts (§6) ────────────────────────────────────────────────────────────

/// A line once it knows which account it belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct AssignedLine {
    pub asset_id: String,
    /// `None` when several accounts could receive the increase, so the user
    /// places it. Reductions always carry the account they are drawn from.
    pub account_id: Option<String>,
    /// Signed: negative for a reduction.
    pub amount: Decimal,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub is_below_minimum: bool,
}

/// An increase assigned to an account that account cannot fund on its own
/// (§6). No transfer between accounts is assumed, so this is reported rather
/// than resolved by moving cash.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountFundingShortfall {
    pub account_id: String,
    pub required: Decimal,
    pub available: Decimal,
}

/// Splits a quantity across accounts in proportion to what each holds.
///
/// Proportional to the recorded position is the only split that states a fact.
/// Sending the units to one account over another would be an assignment, and
/// §6 keeps that out of the app — the account a reduction comes from decides
/// which tax wrapper it leaves, which is exactly the judgement the non-goals
/// in §3 rule out.
///
/// Under whole-unit policy each share is floored and the remainder is simply
/// not drawn. Handing that last unit to one account would reintroduce the
/// choice this split exists to avoid, so the reduction comes out slightly
/// smaller instead and shows up in the remaining cash.
fn apportion(
    total: Decimal,
    weights: &[(String, Decimal)],
    whole_units: bool,
) -> Vec<(String, Decimal)> {
    let weight_total: Decimal = weights.iter().map(|(_, weight)| *weight).sum();
    if weight_total <= Decimal::ZERO {
        return Vec::new();
    }

    weights
        .iter()
        .map(|(account_id, weight)| {
            let share = total * *weight / weight_total;
            (
                account_id.clone(),
                if whole_units { share.floor() } else { share },
            )
        })
        .collect()
}

/// Places each line in an account (§6).
///
/// A reduction is drawn from the accounts that actually hold the security,
/// which is a fact rather than an assignment. An increase is auto-assigned only
/// when exactly one account is eligible; when several are, the line arrives
/// unallocated and the user places it. No default, no tiebreak, no
/// largest-position heuristic.
///
/// `eligible_accounts` maps an asset to the accounts permitted to receive it:
/// in scope, and not blocked by a constraint. Account type, tax wrapper and
/// contribution room are never inputs.
/// `min_line_amount` re-checks §4.6 step 6 against the lines the user actually
/// sees: **Review adjustments** is account-level, so a security-level reduction
/// that clears the minimum can split into account lines that do not.
pub fn assign_accounts(
    lines: &[LimitedLine],
    securities: &[SecurityInput],
    eligible_accounts: &HashMap<String, Vec<String>>,
    whole_shares_only: bool,
    min_line_amount: Decimal,
) -> Vec<AssignedLine> {
    let below_minimum =
        |amount: Decimal| min_line_amount > Decimal::ZERO && amount.abs() < min_line_amount;
    let mut assigned = Vec::new();

    for line in lines {
        let security = securities
            .iter()
            .find(|security| security.asset_id == line.asset_id);

        if line.amount >= Decimal::ZERO {
            let mut eligible = eligible_accounts
                .get(&line.asset_id)
                .cloned()
                .unwrap_or_default();
            eligible.sort();
            eligible.dedup();
            assigned.push(AssignedLine {
                asset_id: line.asset_id.clone(),
                account_id: match eligible.as_slice() {
                    [only] => Some(only.clone()),
                    _ => None,
                },
                amount: line.amount,
                quantity: line.quantity,
                unit_price: line.unit_price,
                is_below_minimum: below_minimum(line.amount),
            });
            continue;
        }

        let mut sources: Vec<(String, Decimal)> = security
            .map(|security| {
                security
                    .positions
                    .iter()
                    .filter(|position| position.can_reduce && position.quantity > Decimal::ZERO)
                    .map(|position| (position.account_id.clone(), position.quantity))
                    .collect()
            })
            .unwrap_or_default();
        sources.sort_by(|left, right| left.0.cmp(&right.0));

        for (account_id, quantity) in apportion(line.quantity.abs(), &sources, whole_shares_only) {
            if quantity <= Decimal::ZERO {
                continue;
            }
            assigned.push(AssignedLine {
                asset_id: line.asset_id.clone(),
                account_id: Some(account_id),
                amount: -(quantity * line.unit_price),
                quantity: -quantity,
                unit_price: line.unit_price,
                is_below_minimum: below_minimum(quantity * line.unit_price),
            });
        }
    }

    assigned
}

/// Cash left once the lines are placed in accounts (§4.6 step 7).
///
/// Recomputed after assignment, because a whole-unit split across several
/// accounts draws fewer units than the security-level reduction asked for and
/// therefore raises less. Prefer this over
/// [`LimitedAdjustments::remaining_cash`], which is the figure before the lines
/// know where they sit.
///
/// Goes negative when the increases were sized against proceeds the split did
/// not raise. That is a funding gap to report, not something to redistribute.
pub fn remaining_cash(
    lines: &[AssignedLine],
    tracked_cash: Decimal,
    external_cash: Decimal,
) -> Decimal {
    tracked_cash + external_cash - lines.iter().map(|line| line.amount).sum::<Decimal>()
}

/// Checks that every increase an account was given can be funded from that
/// account (§6).
///
/// An increase in one account cannot be funded by cash recorded in another, and
/// no transfer is assumed or implied. Hypothetical external cash is not
/// recorded anywhere, so it counts everywhere. Unallocated increases are not
/// checked: the user has not placed them yet.
pub fn account_funding_shortfalls(
    lines: &[AssignedLine],
    cash_by_account: &HashMap<String, Decimal>,
    external_cash: Decimal,
) -> Vec<AccountFundingShortfall> {
    let mut required: HashMap<String, Decimal> = HashMap::new();
    let mut raised: HashMap<String, Decimal> = HashMap::new();

    for line in lines {
        let Some(account_id) = line.account_id.as_ref() else {
            continue;
        };
        if line.amount > Decimal::ZERO {
            *required.entry(account_id.clone()).or_default() += line.amount;
        } else {
            *raised.entry(account_id.clone()).or_default() += -line.amount;
        }
    }

    let mut shortfalls: Vec<AccountFundingShortfall> = required
        .into_iter()
        .filter_map(|(account_id, needed)| {
            let available = cash_by_account
                .get(&account_id)
                .copied()
                .unwrap_or(Decimal::ZERO)
                + raised.get(&account_id).copied().unwrap_or(Decimal::ZERO)
                + external_cash;
            (needed > available).then_some(AccountFundingShortfall {
                account_id,
                required: needed,
                available,
            })
        })
        .collect();
    shortfalls.sort_by(|left, right| left.account_id.cmp(&right.account_id));
    shortfalls
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn category(id: &str, target_bps: i32, current_value: Decimal) -> CategoryTarget {
        CategoryTarget {
            category_id: id.to_string(),
            category_name: format!("{id} name"),
            target_bps,
            current_value,
            is_cash: false,
        }
    }

    fn security(id: &str, values: &[(&str, Decimal)]) -> SecurityInput {
        SecurityInput {
            asset_id: id.to_string(),
            symbol: id.to_string(),
            unit_price: Some(dec!(100)),
            is_eligible_for_increase: true,
            category_values: values
                .iter()
                .map(|(category, value)| (category.to_string(), *value))
                .collect(),
            positions: vec![PositionInput {
                account_id: "acc-1".to_string(),
                quantity: dec!(10),
                can_reduce: true,
            }],
        }
    }

    #[test]
    fn gap_is_target_value_minus_current_value() {
        let categories = vec![
            category("EQUITY", 6000, dec!(5000)),
            category("FIXED_INCOME", 4000, dec!(5000)),
        ];

        let gaps = category_gaps(&categories, dec!(10000));

        assert_eq!(gaps[0], ("EQUITY".to_string(), dec!(1000)));
        assert_eq!(gaps[1], ("FIXED_INCOME".to_string(), dec!(-1000)));
    }

    #[test]
    fn gap_uses_planning_total_not_current_total() {
        // Taxonomy without a cash sleeve: the cash being deployed widens the
        // basis, so a category already at its target against the old total is
        // underweight against the new one.
        let categories = vec![category("EQUITY", 10000, dec!(10000))];

        let gaps = category_gaps(&categories, dec!(12000));

        assert_eq!(gaps[0].1, dec!(2000));
    }

    #[test]
    fn split_follows_current_holding_proportions() {
        let securities = vec![
            security("vti", &[("EQUITY", dec!(7500))]),
            security("vxus", &[("EQUITY", dec!(2500))]),
        ];

        let intents = split_gap("EQUITY", dec!(1000), &securities).unwrap();

        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].amount, dec!(750));
        assert_eq!(intents[1].amount, dec!(250));
    }

    #[test]
    fn split_of_a_negative_gap_produces_reductions() {
        let securities = vec![
            security("vti", &[("EQUITY", dec!(6000))]),
            security("vxus", &[("EQUITY", dec!(2000))]),
        ];

        let intents = split_gap("EQUITY", dec!(-800), &securities).unwrap();

        assert_eq!(intents[0].amount, dec!(-600));
        assert_eq!(intents[1].amount, dec!(-200));
    }

    #[test]
    fn split_weights_only_the_value_attributed_to_the_category() {
        // A 60/40 security carries 6000 of equity, not its whole 10000.
        let securities = vec![
            security(
                "blend",
                &[("EQUITY", dec!(6000)), ("FIXED_INCOME", dec!(4000))],
            ),
            security("vti", &[("EQUITY", dec!(2000))]),
        ];

        let intents = split_gap("EQUITY", dec!(800), &securities).unwrap();

        assert_eq!(intents[0].amount, dec!(600));
        assert_eq!(intents[1].amount, dec!(200));
    }

    #[test]
    fn combination_sums_every_category_intent_for_a_security() {
        let intents = vec![
            Intent {
                asset_id: "blend".to_string(),
                category_id: "EQUITY".to_string(),
                amount: dec!(600),
            },
            Intent {
                asset_id: "blend".to_string(),
                category_id: "FIXED_INCOME".to_string(),
                amount: dec!(-250),
            },
            Intent {
                asset_id: "vti".to_string(),
                category_id: "EQUITY".to_string(),
                amount: dec!(200),
            },
        ];

        let combined = combine_intents(&intents);

        assert_eq!(combined["blend"], dec!(350));
        assert_eq!(combined["vti"], dec!(200));
    }

    #[test]
    fn ineligible_securities_cannot_receive_an_increase() {
        let mut securities = vec![
            security("vti", &[("EQUITY", dec!(7500))]),
            security("vxus", &[("EQUITY", dec!(2500))]),
        ];
        securities[0].is_eligible_for_increase = false;

        let intents = split_gap("EQUITY", dec!(1000), &securities).unwrap();

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].asset_id, "vxus");
        assert_eq!(intents[0].amount, dec!(1000));
    }

    #[test]
    fn eligibility_never_restricts_reductions() {
        let mut securities = vec![security("vti", &[("EQUITY", dec!(8000))])];
        securities[0].is_eligible_for_increase = false;

        let intents = split_gap("EQUITY", dec!(-500), &securities).unwrap();

        assert_eq!(intents[0].asset_id, "vti");
        assert_eq!(intents[0].amount, dec!(-500));
    }

    #[test]
    fn protected_positions_cannot_carry_a_reduction() {
        let mut securities = vec![security("vti", &[("EQUITY", dec!(8000))])];
        securities[0].positions[0].can_reduce = false;

        let reason = split_gap("EQUITY", dec!(-500), &securities).unwrap_err();

        assert_eq!(reason, UnresolvedReason::NoEligibleSecurity);
    }

    #[test]
    fn category_with_nothing_recorded_is_unresolved() {
        let securities = vec![security("vti", &[("EQUITY", dec!(8000))])];

        let reason = split_gap("COMMODITIES", dec!(1000), &securities).unwrap_err();

        assert_eq!(reason, UnresolvedReason::NoRecordedSecurity);
    }

    #[test]
    fn category_with_everything_excluded_is_unresolved() {
        let mut securities = vec![security("gld", &[("COMMODITIES", dec!(1000))])];
        securities[0].is_eligible_for_increase = false;

        let reason = split_gap("COMMODITIES", dec!(1000), &securities).unwrap_err();

        assert_eq!(reason, UnresolvedReason::NoEligibleSecurity);
    }

    #[test]
    fn category_without_a_usable_price_is_unresolved() {
        let mut securities = vec![security("gld", &[("COMMODITIES", dec!(1000))])];
        securities[0].unit_price = None;

        let reason = split_gap("COMMODITIES", dec!(1000), &securities).unwrap_err();

        assert_eq!(reason, UnresolvedReason::NoUsablePrice);
    }

    #[test]
    fn carriers_worth_nothing_give_no_proportions_to_work_from() {
        let securities = vec![security("gld", &[("COMMODITIES", dec!(0))])];

        let reason = split_gap("COMMODITIES", dec!(1000), &securities).unwrap_err();

        assert_eq!(reason, UnresolvedReason::NoRecordedSecurity);
    }

    #[test]
    fn a_category_already_on_target_produces_nothing() {
        let securities = vec![security("vti", &[("EQUITY", dec!(8000))])];

        assert!(split_gap("EQUITY", Decimal::ZERO, &securities)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn spreading_keeps_placed_intents_and_unresolved_amounts_apart() {
        let categories = vec![
            category("EQUITY", 8000, dec!(7000)),
            category("COMMODITIES", 2000, dec!(1000)),
        ];
        let securities = vec![security("vti", &[("EQUITY", dec!(7000))])];

        let (intents, unresolved) = spread_gaps(&categories, dec!(10000), &securities);

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].asset_id, "vti");
        assert_eq!(intents[0].amount, dec!(1000));
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].category_id, "COMMODITIES");
        assert_eq!(unresolved[0].amount, dec!(1000));
        assert_eq!(unresolved[0].reason, UnresolvedReason::NoRecordedSecurity);
    }

    // ── Limits (§4.6) ────────────────────────────────────────────────────────

    fn limits() -> LimitsInput {
        LimitsInput {
            tracked_cash: Decimal::ZERO,
            external_cash: Decimal::ZERO,
            turnover_cap: None,
            min_line_amount: Decimal::ZERO,
            whole_shares_only: false,
        }
    }

    fn increase(asset_id: &str, amount: Decimal) -> DraftIncrease {
        DraftIncrease {
            asset_id: asset_id.to_string(),
            amount,
        }
    }

    fn reduction(asset_id: &str, amount: Decimal) -> DraftReduction {
        DraftReduction {
            asset_id: asset_id.to_string(),
            amount,
        }
    }

    #[test]
    fn turnover_cap_derives_an_amount_from_basis_points() {
        assert_eq!(
            turnover_cap_value(dec!(10000), Some(1000)),
            Some(dec!(1000))
        );
        assert_eq!(turnover_cap_value(dec!(10000), None), None);
    }

    #[test]
    fn a_reduction_cannot_exceed_the_recorded_position() {
        // 10 units at 100 is 1000 held, against a 2500 intent.
        let securities = vec![security("vti", &[("EQUITY", dec!(1000))])];

        let result = apply_limits(
            vec![],
            vec![reduction("vti", dec!(2500))],
            &securities,
            &limits(),
        );

        assert_eq!(result.reductions().next().unwrap().amount, dec!(-1000));
        assert_eq!(result.reductions().next().unwrap().quantity, dec!(-10));
    }

    #[test]
    fn a_protected_position_holds_nothing_to_reduce() {
        let mut securities = vec![security("vti", &[("EQUITY", dec!(1000))])];
        securities[0].positions[0].can_reduce = false;

        let result = apply_limits(
            vec![],
            vec![reduction("vti", dec!(500))],
            &securities,
            &limits(),
        );

        assert_eq!(result.reductions().count(), 0);
    }

    #[test]
    fn turnover_cap_scales_every_reduction_by_the_same_factor() {
        let securities = vec![
            security("vti", &[("EQUITY", dec!(1000))]),
            security("vxus", &[("EQUITY", dec!(1000))]),
        ];
        let mut input = limits();
        input.turnover_cap = Some(dec!(600));

        let result = apply_limits(
            vec![],
            vec![reduction("vti", dec!(800)), reduction("vxus", dec!(400))],
            &securities,
            &input,
        );

        // 1200 of reductions scaled by 0.5 to fit a 600 cap.
        assert_eq!(result.scaling.reduction_factor, Some(dec!(0.5)));
        assert_eq!(result.reductions().next().unwrap().amount, dec!(-400));
        assert_eq!(result.reductions().nth(1).unwrap().amount, dec!(-200));
    }

    #[test]
    fn turnover_cap_that_does_not_bind_is_not_reported() {
        let securities = vec![security("vti", &[("EQUITY", dec!(1000))])];
        let mut input = limits();
        input.turnover_cap = Some(dec!(900));

        let result = apply_limits(
            vec![],
            vec![reduction("vti", dec!(500))],
            &securities,
            &input,
        );

        assert_eq!(result.scaling.reduction_factor, None);
        assert_eq!(result.reductions().next().unwrap().amount, dec!(-500));
    }

    #[test]
    fn increases_are_scaled_to_the_funding_available() {
        let securities = vec![security("vti", &[("EQUITY", dec!(1000))])];
        let mut input = limits();
        input.tracked_cash = dec!(400);

        let result = apply_limits(
            vec![increase("vti", dec!(1000))],
            vec![],
            &securities,
            &input,
        );

        assert_eq!(result.scaling.increase_factor, Some(dec!(0.4)));
        assert_eq!(result.increases().next().unwrap().amount, dec!(400));
    }

    #[test]
    fn a_shortfall_scales_every_increase_by_the_same_factor() {
        // 1000 of increases against 500 of cash and a turnover cap that lets
        // the reductions raise only 200. No increase is sheltered because the
        // first pass happened to fund it: all of them take the same 0.7.
        let securities = vec![
            security("vti", &[("EQUITY", dec!(1000))]),
            security("vxus", &[("EQUITY", dec!(1000))]),
            security("bnd", &[("FIXED_INCOME", dec!(1000))]),
        ];
        let mut input = limits();
        input.tracked_cash = dec!(500);
        input.turnover_cap = Some(dec!(200));

        let result = apply_limits(
            vec![increase("vti", dec!(500)), increase("vxus", dec!(500))],
            vec![reduction("bnd", dec!(500))],
            &securities,
            &input,
        );

        assert_eq!(result.scaling.increase_factor, Some(dec!(0.7)));
        assert_eq!(result.increases().next().unwrap().amount, dec!(350));
        assert_eq!(result.increases().nth(1).unwrap().amount, dec!(350));
        // The funding is spent down to the last unit.
        let deployed: Decimal = result.increases().map(|line| line.amount).sum();
        assert_eq!(deployed, dec!(700));
    }

    #[test]
    fn funding_that_covers_everything_scales_nothing() {
        let securities = vec![security("vti", &[("EQUITY", dec!(1000))])];
        let mut input = limits();
        input.tracked_cash = dec!(1000);

        let result = apply_limits(
            vec![increase("vti", dec!(600))],
            vec![],
            &securities,
            &input,
        );

        assert_eq!(result.scaling.increase_factor, None);
        assert_eq!(result.increases().next().unwrap().amount, dec!(600));
        assert_eq!(result.remaining_cash, dec!(400));
    }

    #[test]
    fn whole_unit_policy_floors_quantities_and_leaves_the_residue_as_cash() {
        let securities = vec![security("vti", &[("EQUITY", dec!(1000))])];
        let mut input = limits();
        input.tracked_cash = dec!(950);
        input.whole_shares_only = true;

        let result = apply_limits(
            vec![increase("vti", dec!(950))],
            vec![],
            &securities,
            &input,
        );

        // 9.5 units at 100 floors to 9, so 900 is deployed and 50 is left.
        assert_eq!(result.increases().next().unwrap().quantity, dec!(9));
        assert_eq!(result.increases().next().unwrap().amount, dec!(900));
        assert_eq!(result.remaining_cash, dec!(50));
    }

    #[test]
    fn a_sub_minimum_line_is_reported_rather_than_dropped() {
        let securities = vec![security("vti", &[("EQUITY", dec!(1000))])];
        let mut input = limits();
        input.tracked_cash = dec!(50);
        input.min_line_amount = dec!(200);

        let result = apply_limits(vec![increase("vti", dec!(50))], vec![], &securities, &input);

        assert_eq!(result.increases().count(), 1);
        assert!(result.increases().next().unwrap().is_below_minimum);
        assert_eq!(
            result.increases().next().unwrap().amount,
            dec!(50),
            "never re-rounded up"
        );
    }

    #[test]
    fn reduction_proceeds_fund_increases() {
        let securities = vec![
            security("vti", &[("EQUITY", dec!(1000))]),
            security("bnd", &[("FIXED_INCOME", dec!(1000))]),
        ];

        let result = apply_limits(
            vec![increase("vti", dec!(700))],
            vec![reduction("bnd", dec!(700))],
            &securities,
            &limits(),
        );

        assert_eq!(result.scaling.increase_factor, None);
        assert_eq!(result.increases().next().unwrap().amount, dec!(700));
        assert_eq!(result.reductions().next().unwrap().amount, dec!(-700));
        assert_eq!(result.remaining_cash, Decimal::ZERO);
    }

    #[test]
    fn a_security_increased_then_reduced_nets_into_one_line() {
        // The first pass buys 500 of a 60/40 security through equity, the
        // second sells 300 of it through fixed income. One line, not two.
        let securities = vec![security(
            "blend",
            &[("EQUITY", dec!(6000)), ("FIXED_INCOME", dec!(4000))],
        )];
        let mut input = limits();
        input.tracked_cash = dec!(500);

        let result = apply_limits(
            vec![increase("blend", dec!(500))],
            vec![reduction("blend", dec!(300))],
            &securities,
            &input,
        );

        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].amount, dec!(200));
        assert_eq!(result.lines[0].quantity, dec!(2));
    }

    // ── Pass sequence (§4.5) ─────────────────────────────────────────────────

    /// A security whose recorded quantity matches the value it carries, so
    /// reduction caps and category values agree.
    fn holding(id: &str, values: &[(&str, Decimal)]) -> SecurityInput {
        let total: Decimal = values.iter().map(|(_, value)| *value).sum();
        let mut security = security(id, values);
        security.positions[0].quantity = total / dec!(100);
        security
    }

    fn sequence<'a>(
        mode: WorksheetMode,
        categories: &'a [CategoryTarget],
        securities: &'a [SecurityInput],
        cash: Decimal,
    ) -> SequenceInput<'a> {
        SequenceInput {
            mode,
            categories,
            securities,
            planning_total: dec!(10000),
            cash,
            external_cash: Decimal::ZERO,
            cash_category_id: None,
        }
    }

    /// 4000 of equity against a 6000 target, 6000 of fixed income against 4000.
    fn tilted() -> (Vec<CategoryTarget>, Vec<SecurityInput>) {
        (
            vec![
                category("EQUITY", 6000, dec!(4000)),
                category("FIXED_INCOME", 4000, dec!(6000)),
            ],
            vec![
                holding("vti", &[("EQUITY", dec!(4000))]),
                holding("bnd", &[("FIXED_INCOME", dec!(6000))]),
            ],
        )
    }

    #[test]
    fn invest_cash_never_reduces_an_overweight_category() {
        let (categories, securities) = tilted();

        let result = run_sequence(&sequence(
            WorksheetMode::InvestCash,
            &categories,
            &securities,
            dec!(500),
        ));

        assert!(result.reductions.is_empty());
        // Fixed income stays overweight, and that is not an unresolved amount —
        // the mode simply does not act on it.
        assert!(result.unresolved.is_empty());
    }

    #[test]
    fn invest_cash_scales_every_intent_to_the_cash_available() {
        let (categories, securities) = tilted();

        let result = run_sequence(&sequence(
            WorksheetMode::InvestCash,
            &categories,
            &securities,
            dec!(500),
        ));

        // The equity gap asks for 2000 and only 500 is on the table.
        assert_eq!(result.increases.len(), 1);
        assert_eq!(result.increases[0].asset_id, "vti");
        assert_eq!(result.increases[0].amount, dec!(500));
    }

    #[test]
    fn rebalance_deploys_cash_first_then_covers_the_rest_with_reductions() {
        let (categories, securities) = tilted();

        let result = run_sequence(&sequence(
            WorksheetMode::Rebalance,
            &categories,
            &securities,
            dec!(500),
        ));

        // Pass 1 puts the 500 of cash into equity. Pass 2 sees equity at 4500,
        // so 1500 of the gap is left for the reductions to fund.
        assert_eq!(result.increases.len(), 2);
        assert_eq!(result.increases[0].amount, dec!(500));
        assert_eq!(result.increases[1].amount, dec!(1500));
        assert_eq!(result.reductions.len(), 1);
        assert_eq!(result.reductions[0].asset_id, "bnd");
        assert_eq!(result.reductions[0].amount, dec!(2000));
    }

    #[test]
    fn rebalance_without_cash_is_reductions_funding_increases() {
        let (categories, securities) = tilted();

        let result = run_sequence(&sequence(
            WorksheetMode::Rebalance,
            &categories,
            &securities,
            Decimal::ZERO,
        ));

        // What the retired sell-to-rebalance mode did: a single pass in
        // substance, since the first one deploys nothing.
        assert_eq!(result.increases.len(), 1);
        assert_eq!(result.increases[0].amount, dec!(2000));
        assert_eq!(result.reductions[0].amount, dec!(2000));
    }

    #[test]
    fn projection_spreads_an_amount_by_the_security_own_classification() {
        let categories = vec![
            category("EQUITY", 6000, dec!(6000)),
            category("FIXED_INCOME", 4000, dec!(4000)),
        ];
        let securities = vec![holding(
            "blend",
            &[("EQUITY", dec!(6000)), ("FIXED_INCOME", dec!(4000))],
        )];
        let applied = HashMap::from([("blend".to_string(), dec!(1000))]);

        let projected = project_categories(&categories, &securities, &applied, None);

        assert_eq!(projected[0].current_value, dec!(6600));
        assert_eq!(projected[1].current_value, dec!(4400));
    }

    #[test]
    fn projection_draws_deployed_cash_out_of_the_cash_sleeve() {
        let categories = vec![
            category("CASH", 0, dec!(1000)),
            category("EQUITY", 10000, dec!(9000)),
        ];
        let securities = vec![holding("vti", &[("EQUITY", dec!(9000))])];
        let applied = HashMap::from([("vti".to_string(), dec!(500))]);

        let projected = project_categories(
            &categories,
            &securities,
            &applied,
            Some(("CASH", dec!(500))),
        );

        assert_eq!(projected[0].current_value, dec!(500));
        assert_eq!(projected[1].current_value, dec!(9500));
    }

    #[test]
    fn the_second_pass_sees_the_cash_the_first_one_spent() {
        // Without the drawdown the second pass would still count the cash as
        // sitting in its sleeve and reduce equity to refill it.
        let categories = vec![
            category("CASH", 1000, dec!(2000)),
            category("EQUITY", 9000, dec!(8000)),
        ];
        let securities = vec![holding("vti", &[("EQUITY", dec!(8000))])];
        let mut input = sequence(
            WorksheetMode::Rebalance,
            &categories,
            &securities,
            dec!(1000),
        );
        input.cash_category_id = Some("CASH".to_string());

        let result = run_sequence(&input);

        // Cash goes from 2000 to 1000, which is its target, so the second pass
        // has nothing left to reduce.
        assert_eq!(result.increases[0].amount, dec!(1000));
        assert!(result.reductions.is_empty());
    }

    #[test]
    fn an_unplaceable_category_survives_both_passes_as_unresolved() {
        let categories = vec![
            category("EQUITY", 8000, dec!(9000)),
            category("COMMODITIES", 2000, dec!(1000)),
        ];
        let securities = vec![holding("vti", &[("EQUITY", dec!(9000))])];

        let result = run_sequence(&sequence(
            WorksheetMode::Rebalance,
            &categories,
            &securities,
            dec!(500),
        ));

        assert_eq!(result.unresolved.len(), 1);
        assert_eq!(result.unresolved[0].category_id, "COMMODITIES");
        assert_eq!(result.unresolved[0].amount, dec!(1000));
        assert_eq!(
            result.unresolved[0].reason,
            UnresolvedReason::NoRecordedSecurity
        );
    }

    // ── Accounts (§6) ────────────────────────────────────────────────────────

    fn line(asset_id: &str, amount: Decimal) -> LimitedLine {
        LimitedLine {
            asset_id: asset_id.to_string(),
            amount,
            quantity: amount / dec!(100),
            unit_price: dec!(100),
            is_below_minimum: false,
        }
    }

    fn in_accounts(security: &mut SecurityInput, accounts: &[(&str, Decimal)]) {
        security.positions = accounts
            .iter()
            .map(|(account_id, quantity)| PositionInput {
                account_id: account_id.to_string(),
                quantity: *quantity,
                can_reduce: true,
            })
            .collect();
    }

    #[test]
    fn an_increase_is_assigned_when_exactly_one_account_is_eligible() {
        let securities = vec![holding("vti", &[("EQUITY", dec!(1000))])];
        let eligible = HashMap::from([("vti".to_string(), vec!["acc-1".to_string()])]);

        let assigned = assign_accounts(
            &[line("vti", dec!(500))],
            &securities,
            &eligible,
            false,
            Decimal::ZERO,
        );

        assert_eq!(assigned[0].account_id.as_deref(), Some("acc-1"));
    }

    #[test]
    fn an_increase_with_several_eligible_accounts_stays_unallocated() {
        let securities = vec![holding("vti", &[("EQUITY", dec!(1000))])];
        let eligible = HashMap::from([(
            "vti".to_string(),
            vec!["acc-1".to_string(), "acc-2".to_string()],
        )]);

        let assigned = assign_accounts(
            &[line("vti", dec!(500))],
            &securities,
            &eligible,
            false,
            Decimal::ZERO,
        );

        // No default, no tiebreak, no largest-position heuristic.
        assert_eq!(assigned.len(), 1);
        assert_eq!(assigned[0].account_id, None);
        assert_eq!(assigned[0].amount, dec!(500));
    }

    #[test]
    fn an_increase_with_no_eligible_account_stays_unallocated() {
        let securities = vec![holding("vti", &[("EQUITY", dec!(1000))])];

        let assigned = assign_accounts(
            &[line("vti", dec!(500))],
            &securities,
            &HashMap::new(),
            false,
            Decimal::ZERO,
        );

        assert_eq!(assigned[0].account_id, None);
    }

    #[test]
    fn a_reduction_is_drawn_from_the_accounts_that_hold_it() {
        let mut security = holding("vti", &[("EQUITY", dec!(4000))]);
        in_accounts(&mut security, &[("acc-1", dec!(30)), ("acc-2", dec!(10))]);

        let assigned = assign_accounts(
            &[line("vti", dec!(-1000))],
            &[security],
            &HashMap::new(),
            false,
            Decimal::ZERO,
        );

        // 10 units split 30/10, which is a fact about where they sit.
        assert_eq!(assigned.len(), 2);
        assert_eq!(assigned[0].account_id.as_deref(), Some("acc-1"));
        assert_eq!(assigned[0].quantity, dec!(-7.5));
        assert_eq!(assigned[1].account_id.as_deref(), Some("acc-2"));
        assert_eq!(assigned[1].quantity, dec!(-2.5));
    }

    #[test]
    fn a_protected_account_is_not_drawn_from() {
        let mut security = holding("vti", &[("EQUITY", dec!(4000))]);
        in_accounts(&mut security, &[("acc-1", dec!(30)), ("acc-2", dec!(10))]);
        security.positions[1].can_reduce = false;

        let assigned = assign_accounts(
            &[line("vti", dec!(-1000))],
            &[security],
            &HashMap::new(),
            false,
            Decimal::ZERO,
        );

        assert_eq!(assigned.len(), 1);
        assert_eq!(assigned[0].account_id.as_deref(), Some("acc-1"));
        assert_eq!(assigned[0].quantity, dec!(-10));
    }

    #[test]
    fn a_whole_unit_split_draws_less_rather_than_favouring_an_account() {
        let mut security = holding("vti", &[("EQUITY", dec!(4000))]);
        in_accounts(&mut security, &[("acc-1", dec!(20)), ("acc-2", dec!(10))]);

        // 7 units over a 2:1 split is 4.67 and 2.33. Both floor, so 6 units are
        // drawn and the seventh is left alone: handing it to one account would
        // decide which wrapper it leaves.
        let assigned = assign_accounts(
            &[line("vti", dec!(-700))],
            &[security],
            &HashMap::new(),
            true,
            Decimal::ZERO,
        );

        assert_eq!(assigned[0].quantity, dec!(-4));
        assert_eq!(assigned[1].quantity, dec!(-2));
        let total: Decimal = assigned.iter().map(|line| line.quantity).sum();
        assert_eq!(total, dec!(-6));
    }

    #[test]
    fn the_unit_a_split_left_behind_shows_up_in_the_remaining_cash() {
        let mut security = holding("vti", &[("EQUITY", dec!(4000))]);
        in_accounts(&mut security, &[("acc-1", dec!(20)), ("acc-2", dec!(10))]);

        let assigned = assign_accounts(
            &[line("vti", dec!(-700))],
            &[security],
            &HashMap::new(),
            true,
            Decimal::ZERO,
        );

        // The security-level line raised 700; placed in accounts it raises 600.
        assert_eq!(
            remaining_cash(&assigned, Decimal::ZERO, Decimal::ZERO),
            dec!(600)
        );
    }

    #[test]
    fn remaining_cash_goes_negative_when_a_split_underfunds_the_increases() {
        let assigned = vec![
            AssignedLine {
                asset_id: "vti".to_string(),
                account_id: Some("acc-1".to_string()),
                amount: dec!(700),
                quantity: dec!(7),
                unit_price: dec!(100),
                is_below_minimum: false,
            },
            AssignedLine {
                asset_id: "bnd".to_string(),
                account_id: Some("acc-1".to_string()),
                amount: dec!(-600),
                quantity: dec!(-6),
                unit_price: dec!(100),
                is_below_minimum: false,
            },
        ];

        // A funding gap to report, not something to redistribute.
        assert_eq!(
            remaining_cash(&assigned, Decimal::ZERO, Decimal::ZERO),
            dec!(-100)
        );
    }

    #[test]
    fn an_account_cannot_fund_an_increase_with_another_account_cash() {
        let lines = vec![AssignedLine {
            asset_id: "vti".to_string(),
            account_id: Some("acc-1".to_string()),
            amount: dec!(500),
            quantity: dec!(5),
            unit_price: dec!(100),
            is_below_minimum: false,
        }];
        let cash = HashMap::from([("acc-2".to_string(), dec!(1000))]);

        let shortfalls = account_funding_shortfalls(&lines, &cash, Decimal::ZERO);

        assert_eq!(shortfalls.len(), 1);
        assert_eq!(shortfalls[0].account_id, "acc-1");
        assert_eq!(shortfalls[0].required, dec!(500));
        assert_eq!(shortfalls[0].available, Decimal::ZERO);
    }

    #[test]
    fn proceeds_raised_in_an_account_fund_increases_in_that_account() {
        let lines = vec![
            AssignedLine {
                asset_id: "vti".to_string(),
                account_id: Some("acc-1".to_string()),
                amount: dec!(500),
                quantity: dec!(5),
                unit_price: dec!(100),
                is_below_minimum: false,
            },
            AssignedLine {
                asset_id: "bnd".to_string(),
                account_id: Some("acc-1".to_string()),
                amount: dec!(-500),
                quantity: dec!(-5),
                unit_price: dec!(100),
                is_below_minimum: false,
            },
        ];

        let shortfalls = account_funding_shortfalls(&lines, &HashMap::new(), Decimal::ZERO);

        assert!(shortfalls.is_empty());
    }

    // ── Review findings on #1612 ─────────────────────────────────────────────

    #[test]
    fn turnover_is_measured_on_what_is_actually_sold() {
        // +500 through equity and -300 through fixed income on one security is
        // a 200 purchase. Nothing is sold, so no turnover is consumed and a
        // 100 cap has nothing to bite on.
        let securities = vec![security(
            "blend",
            &[("EQUITY", dec!(6000)), ("FIXED_INCOME", dec!(4000))],
        )];
        let mut input = limits();
        input.tracked_cash = dec!(500);
        input.turnover_cap = Some(dec!(100));

        let result = apply_limits(
            vec![increase("blend", dec!(500))],
            vec![reduction("blend", dec!(300))],
            &securities,
            &input,
        );

        assert_eq!(result.lines.len(), 1);
        assert_eq!(result.lines[0].amount, dec!(200));
        assert_eq!(result.scaling.reduction_factor, None);
    }

    #[test]
    fn external_cash_arrives_in_the_sleeve_before_it_is_deployed() {
        // The 500 is not recorded anywhere yet, so deploying it must not push
        // the cash sleeve below zero.
        let categories = vec![
            category("CASH", 0, Decimal::ZERO),
            category("EQUITY", 10000, dec!(1000)),
        ];
        let securities = vec![holding("vti", &[("EQUITY", dec!(1000))])];
        let mut input = sequence(
            WorksheetMode::Rebalance,
            &categories,
            &securities,
            dec!(500),
        );
        input.cash_category_id = Some("CASH".to_string());
        input.external_cash = dec!(500);

        let result = run_sequence(&input);

        assert!(result.reductions.is_empty(), "nothing should be sold here");
    }

    #[test]
    fn a_cash_sleeve_is_filled_by_proceeds_not_by_buying_a_security() {
        // No security carries cash. An underweight cash sleeve is filled by
        // what the reductions raise, so it is not an unresolved amount.
        let categories = vec![
            CategoryTarget {
                is_cash: true,
                ..category("CASH", 1000, Decimal::ZERO)
            },
            category("EQUITY", 9000, dec!(10000)),
        ];
        let securities = vec![holding("vti", &[("EQUITY", dec!(10000))])];

        let result = run_sequence(&sequence(
            WorksheetMode::Rebalance,
            &categories,
            &securities,
            Decimal::ZERO,
        ));

        assert!(
            result.unresolved.is_empty(),
            "cash is not an unresolved category: {:?}",
            result.unresolved
        );
        assert_eq!(result.reductions[0].amount, dec!(1000));
    }

    #[test]
    fn minimum_line_status_follows_the_lines_the_user_sees() {
        let mut security = holding("vti", &[("EQUITY", dec!(3000))]);
        in_accounts(
            &mut security,
            &[
                ("acc-1", dec!(10)),
                ("acc-2", dec!(10)),
                ("acc-3", dec!(10)),
            ],
        );

        // One 900 reduction clears a 500 minimum; split three ways it is 300 an
        // account, and the account line is what Review adjustments shows.
        let assigned = assign_accounts(
            &[LimitedLine {
                asset_id: "vti".to_string(),
                amount: dec!(-900),
                quantity: dec!(-9),
                unit_price: dec!(100),
                is_below_minimum: false,
            }],
            &[security],
            &HashMap::new(),
            false,
            dec!(500),
        );

        assert_eq!(assigned.len(), 3);
        assert!(assigned.iter().all(|line| line.is_below_minimum));
    }

    #[test]
    fn an_unallocated_increase_is_not_checked_for_funding() {
        let lines = vec![AssignedLine {
            asset_id: "vti".to_string(),
            account_id: None,
            amount: dec!(500),
            quantity: dec!(5),
            unit_price: dec!(100),
            is_below_minimum: false,
        }];

        let shortfalls = account_funding_shortfalls(&lines, &HashMap::new(), Decimal::ZERO);

        assert!(shortfalls.is_empty());
    }
}
