use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc};
use rust_decimal::Decimal;
use wealthfolio_core::accounts::{
    account_supports_purpose, AccountPurpose, AccountRepositoryTrait,
};
use wealthfolio_core::activities::{Activity, ActivityRepositoryTrait};
use wealthfolio_core::fx::FxServiceTrait;
use wealthfolio_core::taxonomies::TaxonomyServiceTrait;

use super::model::{
    AmountBlock, AmountSource, CategoryBreakdownRow, CategoryInsight, CompareMode, DayBucket,
    DayCategoryBucket, GroupInsight, Headline, HealthStatus, MonthBucket, MonthlyAmount, PaceState,
    PeriodMeta, SpendingInsight, SpendingInsightRequest, UncategorizedBucket,
};
use crate::activity_allocations::{
    allocations_for_taxonomy, group_assignments as group_activity_assignments, group_splits,
    AssignmentsByActivity, SplitsByActivity,
};
use crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait;
use crate::activity_classification::{
    activity_abs_amount, classify_activity, classify_activity_for_aggregation, decimal_to_f64,
    within_spending_transfer_groups,
};
use crate::activity_splits::ActivitySplitRepositoryTrait;
use crate::budget::service::{
    category_meta, resolve_group_for_category, top_category_id, top_level_categories, TargetIndex,
};
use crate::budget::BudgetRepositoryTrait;
use crate::error::SpendingError;
use crate::settings::SpendingSettingsService;

const SPENDING_TAXONOMY: &str = "spending_categories";
const INCOME_TAXONOMY: &str = "income_sources";
const SAVINGS_TAXONOMY: &str = "savings_categories";
const UNCATEGORIZED_CATEGORY_ID: &str = "__uncategorized__";
const OTHER_GROUP_KEY: &str = "other";
/// The system "Savings" budget group. Savings is now its own headline figure
/// (an income-pattern bucket), not a consumption budget line — so its group is
/// retired from the spending "Where it went" breakdown.
const SAVINGS_GROUP_KEY: &str = "savings";
const TRAILING_WINDOW_DAYS: i64 = 7;
/// Pace status flips to `Approaching` when projected spend reaches 90% of budget.
const APPROACHING_THRESHOLD: f64 = 0.9;

/// Builds reconciled spending-insight payloads for the dashboard.
pub struct InsightService {
    budget_repo: Arc<dyn BudgetRepositoryTrait>,
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    account_repo: Arc<dyn AccountRepositoryTrait>,
    assignment_repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
    split_repo: Arc<dyn ActivitySplitRepositoryTrait>,
    settings: Arc<SpendingSettingsService>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
}

impl InsightService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        budget_repo: Arc<dyn BudgetRepositoryTrait>,
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        account_repo: Arc<dyn AccountRepositoryTrait>,
        assignment_repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        split_repo: Arc<dyn ActivitySplitRepositoryTrait>,
        settings: Arc<SpendingSettingsService>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self {
            budget_repo,
            activity_repo,
            account_repo,
            assignment_repo,
            split_repo,
            settings,
            taxonomy_service,
            fx_service,
        }
    }

    pub async fn compute(
        &self,
        req: SpendingInsightRequest,
        currency: &str,
        timezone: &str,
    ) -> Result<SpendingInsight> {
        let start = parse_rfc3339(&req.start_date)?;
        let end = parse_rfc3339(&req.end_date)?;
        if end < start {
            return Err(SpendingError::InvalidInput {
                message: "end_date must be >= start_date".to_string(),
            }
            .into());
        }
        let compare = req.compare.unwrap_or_default();
        let prior_window = explicit_compare_window(&req)?
            .unwrap_or_else(|| compute_prior_window(start, end, compare));

        let period = PeriodMeta::from_window(start, end);
        let prior = PeriodMeta::from_window(prior_window.0, prior_window.1);

        // ── 1. Settings gate ──────────────────────────────────────────────────
        let settings = self.settings.get().await?;
        if !settings.enabled || settings.account_ids.is_empty() {
            return Ok(empty_insight(period, prior, currency));
        }

        // ── 2. Resolve target accounts ────────────────────────────────────────
        let configured: HashSet<String> = settings.account_ids.iter().cloned().collect();
        let requested: Vec<String> = match req.account_ids.clone() {
            Some(ids) => ids
                .into_iter()
                .filter(|id| configured.contains(id))
                .collect(),
            None => settings.account_ids.clone(),
        };
        if requested.is_empty() {
            return Ok(empty_insight(period, prior, currency));
        }
        let accounts = self
            .account_repo
            .list(None, Some(false), Some(&settings.account_ids))
            .map_err(|e| anyhow!(e.to_string()))?;
        let account_types: HashMap<String, String> = accounts
            .into_iter()
            .filter(|a| account_supports_purpose(&a.account_type, AccountPurpose::Spending))
            .map(|a| (a.id, a.account_type))
            .collect();
        if account_types.is_empty() {
            return Ok(empty_insight(period, prior, currency));
        }
        let all_spending_account_ids: Vec<String> = account_types.keys().cloned().collect();
        let account_ids: Vec<String> = requested
            .into_iter()
            .filter(|id| account_types.contains_key(id))
            .collect();
        if account_ids.is_empty() {
            return Ok(empty_insight(period, prior, currency));
        }
        let target_account_ids: HashSet<String> = account_ids.iter().cloned().collect();

        // ── 3. Load reference data ────────────────────────────────────────────
        let groups = self.budget_repo.list_groups().await?;
        let group_assignments = self.budget_repo.list_group_assignments().await?;
        let targets = self.budget_repo.list_targets().await?;
        let taxonomy = self.taxonomy_service.get_taxonomy(SPENDING_TAXONOMY)?;
        let spending_categories = taxonomy.map(|t| t.categories).unwrap_or_default();
        let spending_meta = category_meta(&spending_categories);
        let top_categories = top_level_categories(&spending_categories);

        // "Other" is the catch-all bucket for categories that aren't assigned
        // to any explicit group. It's seeded by the migration + ensured by
        // BudgetService::ensure_system_groups, so it normally exists. If the
        // user has deleted/renamed it, degrade gracefully: fall back to the
        // last group (typically the lowest-priority one) and log a warning
        // rather than blanking the whole dashboard. If no groups exist at all
        // we return an empty insight — the user hasn't set anything up yet.
        let other_group_id = match groups.iter().find(|g| g.key == OTHER_GROUP_KEY) {
            Some(g) => g.id.clone(),
            None => match groups.last() {
                Some(fallback) => {
                    log::warn!(
                        "spending insight: 'Other' budget group missing; falling back to '{}' as catch-all. \
                         Run BudgetService::reset_groups() or restore the seed to fix.",
                        fallback.name,
                    );
                    fallback.id.clone()
                }
                None => return Ok(empty_insight(period, prior, currency)),
            },
        };
        let assignment_by_category: HashMap<String, String> = group_assignments
            .iter()
            .filter(|a| a.taxonomy_id == SPENDING_TAXONOMY)
            .map(|a| (a.category_id.clone(), a.group_id.clone()))
            .collect();

        // ── 4. Fetch activities and partition into current + prior windows ────
        let activities = self
            .activity_repo
            .get_activities_by_account_ids(&all_spending_account_ids)
            .map_err(|e| anyhow!(e.to_string()))?;
        let transfer_context_acts: Vec<&Activity> = activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        let in_window = |a: &Activity, lo: DateTime<Utc>, hi: DateTime<Utc>| {
            a.activity_date >= lo && a.activity_date <= hi
        };
        let current_acts: Vec<&Activity> = activities
            .iter()
            .filter(|a| target_account_ids.contains(&a.account_id) && in_window(a, start, end))
            .collect();
        let prior_acts: Vec<&Activity> = activities
            .iter()
            .filter(|a| {
                target_account_ids.contains(&a.account_id)
                    && in_window(a, prior_window.0, prior_window.1)
            })
            .collect();

        let activity_ids: Vec<String> = current_acts
            .iter()
            .chain(prior_acts.iter())
            .map(|a| a.id.clone())
            .collect();
        let assignments = self
            .assignment_repo
            .list_for_activities(&activity_ids)
            .await?;
        let assignments_by_activity = group_activity_assignments(assignments);
        let splits_by_activity =
            group_splits(self.split_repo.list_for_activities(&activity_ids).await?);

        // ── 5. Aggregate spend (current + prior) ──────────────────────────────
        // FX is applied inline: each activity's spending/income amount is
        // converted from its native currency to `currency` (the report target,
        // typically base) using FxService at `period.end`. Matches the
        // net_worth snapshot-date convention — one rate per report.
        let fx_as_of = end.date_naive();
        let current_agg = aggregate_spend_with_splits(
            &current_acts,
            &account_types,
            &transfer_groups,
            &assignments_by_activity,
            &splits_by_activity,
            &spending_meta,
            self.fx_service.as_ref(),
            currency,
            fx_as_of,
        );
        let prior_agg = aggregate_spend_with_splits(
            &prior_acts,
            &account_types,
            &transfer_groups,
            &assignments_by_activity,
            &splits_by_activity,
            &spending_meta,
            self.fx_service.as_ref(),
            currency,
            // Prior window converts at its own end date so the prior period's
            // numbers reflect what the user would have seen at the time.
            prior_window.1.date_naive(),
        );

        // ── 6. Fan out budgets per month with proration ───────────────────────
        let target_index = TargetIndex::new(&targets);
        let month_prorations = build_month_prorations(start, end, &period.months);

        let mut category_budgets: HashMap<String, AmountBlock> = HashMap::new();
        for cat in &top_categories {
            let block = fanout_amount(&month_prorations, |month| {
                let amount =
                    target_index.effective_category_decimal(month, SPENDING_TAXONOMY, &cat.id);
                let has_override =
                    target_index.has_month_category(month, SPENDING_TAXONOMY, &cat.id);
                (amount, has_override)
            });
            category_budgets.insert(cat.id.clone(), block);
        }

        let mut group_buffers: HashMap<String, AmountBlock> = HashMap::new();
        for g in &groups {
            let block = fanout_amount(&month_prorations, |month| {
                let amount = target_index.effective_group_buffer_decimal(month, &g.id);
                let has_override = target_index.has_month_group_buffer(month, &g.id);
                (amount, has_override)
            });
            group_buffers.insert(g.id.clone(), block);
        }

        // ── 7. Build the group/category tree ──────────────────────────────────
        let mut rows_by_group: HashMap<String, Vec<CategoryInsight>> = HashMap::new();
        for cat in &top_categories {
            let group_id = resolve_group_for_category(
                &cat.id,
                &assignment_by_category,
                &spending_meta,
                &other_group_id,
            );
            let (spent_decimal, txn_count) = current_agg
                .spending_by_top
                .get(&cat.id)
                .copied()
                .unwrap_or((Decimal::ZERO, 0));
            let spent = decimal_to_f64(spent_decimal);
            let prior_spent = decimal_to_f64(
                prior_agg
                    .spending_by_top
                    .get(&cat.id)
                    .map(|(amount, _)| *amount)
                    .unwrap_or(Decimal::ZERO),
            );
            let budget = category_budgets.remove(&cat.id).unwrap_or_default();
            let remaining = budget.total - spent;
            rows_by_group
                .entry(group_id)
                .or_default()
                .push(CategoryInsight {
                    taxonomy_id: SPENDING_TAXONOMY.to_string(),
                    category_id: cat.id.clone(),
                    name: cat.name.clone(),
                    color: Some(cat.color.clone()),
                    icon: cat.icon.clone(),
                    parent_id: cat.parent_id.clone(),
                    budget,
                    spent,
                    prior_spent,
                    delta_vs_prior_pct: pct_change(spent, prior_spent),
                    remaining,
                    overspent: remaining < 0.0,
                    // Filled in after total_spent is known.
                    pct_of_total_spent: None,
                    txn_count,
                });
        }

        let mut group_insights: Vec<GroupInsight> = Vec::with_capacity(groups.len());
        for g in &groups {
            // Savings is tracked as its own headline figure, not a consumption
            // budget group — skip it so it doesn't show as an empty row.
            if g.key == SAVINGS_GROUP_KEY {
                continue;
            }
            let mut categories = rows_by_group.remove(&g.id).unwrap_or_default();
            categories.sort_by(|a, b| {
                b.spent
                    .partial_cmp(&a.spent)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let category_budget_total: f64 = categories.iter().map(|c| c.budget.total).sum();
            let group_spent: f64 = categories.iter().map(|c| c.spent).sum();
            let group_prior_spent: f64 = categories.iter().map(|c| c.prior_spent).sum();
            let category_block = AmountBlock {
                total: category_budget_total,
                monthly_breakdown: combine_monthly(categories.iter().map(|c| &c.budget)),
            };
            let buffer = group_buffers.remove(&g.id).unwrap_or_default();
            let remaining = category_block.total + buffer.total - group_spent;
            group_insights.push(GroupInsight {
                group: g.clone(),
                budget: category_block,
                buffer,
                spent: group_spent,
                prior_spent: group_prior_spent,
                delta_vs_prior_pct: pct_change(group_spent, group_prior_spent),
                remaining,
                overspent: remaining < 0.0,
                pct_of_total_spent: None,
                categories,
            });
        }
        group_insights.sort_by(|a, b| {
            a.group
                .sort_order
                .cmp(&b.group.sort_order)
                .then(a.group.name.cmp(&b.group.name))
        });

        // ── 8. Uncategorized ──────────────────────────────────────────────────
        let uncategorized_spend = decimal_to_f64(current_agg.uncategorized_spend);
        let prior_uncategorized_spend = decimal_to_f64(prior_agg.uncategorized_spend);
        let mut uncategorized = UncategorizedBucket {
            spent: uncategorized_spend,
            prior_spent: prior_uncategorized_spend,
            delta_vs_prior_pct: pct_change(uncategorized_spend, prior_uncategorized_spend),
            // Filled in after total_spent is known.
            pct_of_total_spent: None,
            txn_count: current_agg.uncategorized_count,
        };

        // ── 9. Headline + pace + status ───────────────────────────────────────
        let total_spent = decimal_to_f64(current_agg.total_outflow);
        let total_income = decimal_to_f64(current_agg.total_income);
        let total_saved = decimal_to_f64(current_agg.total_saved);
        let prior_total_spent = decimal_to_f64(prior_agg.total_outflow);
        let total_budget: f64 = group_insights
            .iter()
            .map(|g| g.budget.total + g.buffer.total)
            .sum();
        let now = Utc::now();
        let pace = compute_pace(
            &current_acts,
            &account_types,
            start,
            end,
            now,
            total_spent,
            total_budget,
            self.fx_service.as_ref(),
            currency,
            fx_as_of,
            timezone,
        );
        let status = compute_health_status(
            total_spent,
            total_budget,
            total_income,
            pace.projected_spend,
        );

        // ── 10. Backfill pct_of_total_spent now that we know the total ────────
        for g in &mut group_insights {
            g.pct_of_total_spent = pct_share(g.spent, total_spent);
            for c in &mut g.categories {
                c.pct_of_total_spent = pct_share(c.spent, total_spent);
            }
        }
        uncategorized.pct_of_total_spent = pct_share(uncategorized.spent, total_spent);

        // ── 11. Daily + monthly time series ───────────────────────────────────
        // Bucket by user-local calendar day so a midnight-local activity lands
        // on the date the user perceives. Falls back to UTC for empty/invalid tz.
        // Amounts FX-converted to `currency` at period.end (same rate the
        // aggregate headline used) so totals reconcile across surfaces.
        let by_day = compute_by_day(
            &current_acts,
            &account_types,
            timezone,
            self.fx_service.as_ref(),
            currency,
            fx_as_of,
        );
        let by_day_by_category = compute_by_day_by_category_with_splits(
            &current_acts,
            &account_types,
            &assignments_by_activity,
            &splits_by_activity,
            timezone,
            self.fx_service.as_ref(),
            currency,
            fx_as_of,
        );
        let by_month = compute_by_month(
            &current_acts,
            &account_types,
            &transfer_groups,
            &period.months,
            timezone,
            self.fx_service.as_ref(),
            currency,
            fx_as_of,
        );

        let headline = Headline {
            spent: total_spent,
            income: total_income,
            saved: total_saved,
            net_cashflow: total_income - total_spent - total_saved,
            budget: total_budget,
            remaining: total_budget - total_spent,
            prior_spent: prior_total_spent,
            delta_vs_prior_pct: pct_change(total_spent, prior_total_spent),
            pace,
            status,
        };

        // Build the foreign-currency summary from the aggregator's native
        // totals: which non-target currencies contributed and how much in
        // their native units. UI can surface a "source: €1,200 EUR" hint
        // (single-foreign-currency reports) or a generic FX-converted notice.
        let foreign_currencies: Vec<String> = {
            let mut keys: Vec<String> = current_agg
                .native_outflow_by_currency
                .keys()
                .filter(|c| c.as_str() != currency && !c.is_empty())
                .cloned()
                .collect();
            keys.sort();
            keys
        };
        let native_outflow_by_currency: HashMap<String, f64> = current_agg
            .native_outflow_by_currency
            .iter()
            .filter(|(c, _)| c.as_str() != currency && !c.is_empty())
            .map(|(c, v)| (c.clone(), decimal_to_f64(*v)))
            .collect();
        let income_breakdown =
            category_breakdown_rows(INCOME_TAXONOMY, &current_agg.income_by_category);
        let savings_breakdown =
            category_breakdown_rows(SAVINGS_TAXONOMY, &current_agg.savings_by_category);

        let insight = SpendingInsight {
            period,
            prior,
            currency: currency.to_string(),
            foreign_currencies,
            native_outflow_by_currency,
            headline,
            groups: group_insights,
            uncategorized,
            income_breakdown,
            savings_breakdown,
            by_day,
            by_day_by_category,
            by_month,
        };

        debug_assert_reconciliation(&insight);
        Ok(insight)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Aggregation helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Aggregated outputs for a single window. All monetary fields are in the
/// report's target currency; per-activity values are FX-converted inline
/// during aggregation.
#[derive(Default)]
struct SpendAggregate {
    /// Consumption outflow (sum of spending_amount for non-saving outflows,
    /// converted to target currency). Excludes money routed to the Savings
    /// taxonomy — that lives in `total_saved`.
    total_outflow: Decimal,
    total_income: Decimal,
    /// Money classified as Saving — `Σ saving_amount` (cross-boundary cash
    /// transfer-outs). Its own headline bucket, never part of `total_outflow`,
    /// so "Spending" stays consumption.
    total_saved: Decimal,
    /// Top-level spending category id → (spend, txn_count).
    spending_by_top: HashMap<String, (Decimal, u32)>,
    /// Income source category id → (income, txn_count). Includes a synthetic
    /// uncategorized row when income has no `income_sources` assignment.
    income_by_category: HashMap<String, (Decimal, u32)>,
    /// Savings category id → (saved, txn_count). Includes a synthetic
    /// uncategorized row when saving has no `savings_categories` assignment.
    savings_by_category: HashMap<String, (Decimal, u32)>,
    /// Spend on activities that have no `spending_categories` assignment.
    uncategorized_spend: Decimal,
    uncategorized_count: u32,
    /// Native-currency outflow totals before FX, indexed by source currency.
    /// Empty (or single-entry equal to target) when no conversion happened.
    /// Lets the UI surface "source: €1,200" hints for single-foreign-currency
    /// reports and the list of contributing currencies for mixed reports.
    native_outflow_by_currency: HashMap<String, Decimal>,
}

/// Convert a native amount to the report's target currency at `as_of` date.
/// Matches the net_worth convention: one rate per report (snapshot date),
/// not per-activity-date. On error (no rate available even after the
/// inverse-pair and latest-rate fallbacks), returns None so callers can exclude
/// the native amount instead of mixing currencies into the target total.
fn fx_to_target(
    fx: &dyn FxServiceTrait,
    amount: Decimal,
    from: &str,
    to: &str,
    as_of: NaiveDate,
) -> Option<Decimal> {
    if amount == Decimal::ZERO || from == to || from.is_empty() {
        return Some(amount);
    }
    match fx.convert_currency_for_date(amount, from, to, as_of) {
        Ok(converted) => Some(converted),
        Err(e) => {
            log::warn!(
                "spending insight FX conversion {}→{} on {} failed ({}); excluding native amount",
                from,
                to,
                as_of,
                e,
            );
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn aggregate_spend(
    acts: &[&Activity],
    account_types: &HashMap<String, String>,
    transfer_groups: &HashSet<String>,
    assignments_by_activity: &HashMap<
        String,
        Vec<crate::activity_assignments::ActivityTaxonomyAssignment>,
    >,
    spending_meta: &HashMap<String, wealthfolio_core::taxonomies::Category>,
    fx: &dyn FxServiceTrait,
    target_currency: &str,
    fx_as_of: NaiveDate,
) -> SpendAggregate {
    let splits_by_activity = SplitsByActivity::new();
    aggregate_spend_with_splits(
        acts,
        account_types,
        transfer_groups,
        assignments_by_activity,
        &splits_by_activity,
        spending_meta,
        fx,
        target_currency,
        fx_as_of,
    )
}

#[allow(clippy::too_many_arguments)]
fn aggregate_spend_with_splits(
    acts: &[&Activity],
    account_types: &HashMap<String, String>,
    transfer_groups: &HashSet<String>,
    assignments_by_activity: &AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
    spending_meta: &HashMap<String, wealthfolio_core::taxonomies::Category>,
    fx: &dyn FxServiceTrait,
    target_currency: &str,
    fx_as_of: NaiveDate,
) -> SpendAggregate {
    let mut agg = SpendAggregate::default();
    for a in acts {
        let Some(account_type) = account_types.get(&a.account_id) else {
            continue;
        };
        // Income-pattern buckets: classification alone decides spend vs income
        // vs saving (a cross-boundary transfer-out → Saving). The three amounts
        // never overlap, so "spent" excludes saving automatically.
        let classification = classify_activity_for_aggregation(a, account_type, transfer_groups);
        let amount = activity_abs_amount(a);
        let spending_native = classification.spending_amount(amount);
        let income_native = classification.income_amount(amount);
        let saving_native = classification.saving_amount(amount);
        if spending_native == Decimal::ZERO
            && income_native == Decimal::ZERO
            && saving_native == Decimal::ZERO
        {
            continue;
        }
        let spending_converted =
            fx_to_target(fx, spending_native, &a.currency, target_currency, fx_as_of);
        let spending = spending_converted.unwrap_or(Decimal::ZERO);
        let income = fx_to_target(fx, income_native, &a.currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        let saved = fx_to_target(fx, saving_native, &a.currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        agg.total_income += income;
        agg.total_saved += saved;

        if income != Decimal::ZERO {
            add_taxonomy_breakdown(
                &mut agg.income_by_category,
                assignments_by_activity,
                splits_by_activity,
                &a.id,
                INCOME_TAXONOMY,
                income_native,
                fx,
                &a.currency,
                target_currency,
                fx_as_of,
            );
        }
        if saved != Decimal::ZERO {
            add_taxonomy_breakdown(
                &mut agg.savings_by_category,
                assignments_by_activity,
                splits_by_activity,
                &a.id,
                SAVINGS_TAXONOMY,
                saving_native,
                fx,
                &a.currency,
                target_currency,
                fx_as_of,
            );
        }

        if spending == Decimal::ZERO {
            continue;
        }

        agg.total_outflow += spending;
        if spending_native != Decimal::ZERO && spending_converted.is_some() {
            *agg.native_outflow_by_currency
                .entry(a.currency.clone())
                .or_insert(Decimal::ZERO) += spending_native;
        }

        let allocations = allocations_for_taxonomy(
            &a.id,
            SPENDING_TAXONOMY,
            spending_native,
            assignments_by_activity,
            splits_by_activity,
        );

        if allocations.is_empty() {
            agg.uncategorized_spend += spending;
            agg.uncategorized_count += 1;
            continue;
        }

        for allocation in allocations {
            let Some(amount) = fx_to_target(
                fx,
                allocation.amount,
                &a.currency,
                target_currency,
                fx_as_of,
            ) else {
                continue;
            };
            if amount == Decimal::ZERO {
                continue;
            }
            let top_id = top_category_id(&allocation.category_id, spending_meta);
            let entry = agg
                .spending_by_top
                .entry(top_id)
                .or_insert((Decimal::ZERO, 0));
            entry.0 += amount;
            entry.1 += 1;
        }
    }
    // outflow may go slightly negative due to refunds — keep it as-is so totals stay reconciled.
    agg
}

#[allow(clippy::too_many_arguments)]
fn add_taxonomy_breakdown(
    bucket: &mut HashMap<String, (Decimal, u32)>,
    assignments_by_activity: &AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
    activity_id: &str,
    taxonomy_id: &str,
    native_amount: Decimal,
    fx: &dyn FxServiceTrait,
    from_currency: &str,
    target_currency: &str,
    fx_as_of: NaiveDate,
) {
    let allocations = allocations_for_taxonomy(
        activity_id,
        taxonomy_id,
        native_amount,
        assignments_by_activity,
        splits_by_activity,
    );
    if allocations.is_empty() {
        let amount = fx_to_target(fx, native_amount, from_currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        if amount == Decimal::ZERO {
            return;
        }
        let entry = bucket
            .entry(UNCATEGORIZED_CATEGORY_ID.to_string())
            .or_insert((Decimal::ZERO, 0));
        entry.0 += amount;
        entry.1 += 1;
        return;
    }

    for allocation in allocations {
        let amount = fx_to_target(
            fx,
            allocation.amount,
            from_currency,
            target_currency,
            fx_as_of,
        )
        .unwrap_or(Decimal::ZERO);
        if amount == Decimal::ZERO {
            continue;
        }
        let entry = bucket
            .entry(allocation.category_id)
            .or_insert((Decimal::ZERO, 0));
        entry.0 += amount;
        entry.1 += 1;
    }
}

fn category_breakdown_rows(
    taxonomy_id: &str,
    bucket: &HashMap<String, (Decimal, u32)>,
) -> Vec<CategoryBreakdownRow> {
    let mut rows: Vec<CategoryBreakdownRow> = bucket
        .iter()
        .filter(|(_, (amount, _))| *amount != Decimal::ZERO)
        .map(|(category_id, (amount, count))| CategoryBreakdownRow {
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.clone(),
            amount: decimal_to_f64(*amount),
            count: *count,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.amount
            .partial_cmp(&a.amount)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

fn compute_by_day(
    acts: &[&Activity],
    account_types: &HashMap<String, String>,
    timezone: &str,
    fx: &dyn FxServiceTrait,
    target_currency: &str,
    fx_as_of: NaiveDate,
) -> Vec<DayBucket> {
    let mut map: HashMap<NaiveDate, (Decimal, Decimal)> = HashMap::new();
    for a in acts {
        let Some(account_type) = account_types.get(&a.account_id) else {
            continue;
        };
        // Transfers classify as Saving/InternalTransfer → spending_amount is 0,
        // so they're naturally excluded from the spend series (matches headline).
        let classification = classify_activity(a, account_type);
        let amount = activity_abs_amount(a);
        let spending_native = classification.spending_amount(amount);
        let income_native = classification.income_amount(amount);
        if spending_native == Decimal::ZERO && income_native == Decimal::ZERO {
            continue;
        }
        // FX-convert per activity using the same as-of date as the headline
        // aggregate so day-buckets sum to total_outflow within rounding.
        let spending = fx_to_target(fx, spending_native, &a.currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        let income = fx_to_target(fx, income_native, &a.currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        let date = wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(
            a.activity_date,
            timezone,
        );
        let entry = map.entry(date).or_insert((Decimal::ZERO, Decimal::ZERO));
        entry.0 += spending;
        entry.1 += income;
    }
    // Emit signed per-day spent + income so that
    // `Σ by_day.spent == headline.spent` (signed) — required by the
    // reconciliation invariant. A previous version of this function clamped
    // each day at zero, which broke the invariant on refund-heavy days. Chart
    // consumers that want non-negative bars should clamp at render time
    // rather than at emit time.
    let mut out: Vec<DayBucket> = map
        .into_iter()
        .map(|(d, (spent, income))| DayBucket {
            date: format_date(d),
            spent: decimal_to_f64(spent),
            income: decimal_to_f64(income),
        })
        .collect();
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

#[cfg(test)]
fn compute_by_day_by_category(
    acts: &[&Activity],
    account_types: &HashMap<String, String>,
    assignments_by_activity: &HashMap<
        String,
        Vec<crate::activity_assignments::ActivityTaxonomyAssignment>,
    >,
    timezone: &str,
    fx: &dyn FxServiceTrait,
    target_currency: &str,
    fx_as_of: NaiveDate,
) -> Vec<DayCategoryBucket> {
    let splits_by_activity = SplitsByActivity::new();
    compute_by_day_by_category_with_splits(
        acts,
        account_types,
        assignments_by_activity,
        &splits_by_activity,
        timezone,
        fx,
        target_currency,
        fx_as_of,
    )
}

#[allow(clippy::too_many_arguments)]
fn compute_by_day_by_category_with_splits(
    acts: &[&Activity],
    account_types: &HashMap<String, String>,
    assignments_by_activity: &AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
    timezone: &str,
    fx: &dyn FxServiceTrait,
    target_currency: &str,
    fx_as_of: NaiveDate,
) -> Vec<DayCategoryBucket> {
    let mut map: HashMap<(String, String, String), (Decimal, u32)> = HashMap::new();
    for a in acts {
        let Some(account_type) = account_types.get(&a.account_id) else {
            continue;
        };
        let classification = classify_activity(a, account_type);
        let spending_native = classification.spending_amount(activity_abs_amount(a));
        if spending_native == Decimal::ZERO {
            continue;
        }
        let Some(amount) =
            fx_to_target(fx, spending_native, &a.currency, target_currency, fx_as_of)
        else {
            continue;
        };
        if amount == Decimal::ZERO {
            continue;
        }

        let date = wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(
            a.activity_date,
            timezone,
        );
        let date = format_date(date);
        let allocations = allocations_for_taxonomy(
            &a.id,
            SPENDING_TAXONOMY,
            spending_native,
            assignments_by_activity,
            splits_by_activity,
        );
        if allocations.is_empty() {
            let entry = map
                .entry((
                    date,
                    SPENDING_TAXONOMY.to_string(),
                    UNCATEGORIZED_CATEGORY_ID.to_string(),
                ))
                .or_insert((Decimal::ZERO, 0));
            entry.0 += amount;
            entry.1 += 1;
            continue;
        }

        for allocation in allocations {
            let Some(line_amount) = fx_to_target(
                fx,
                allocation.amount,
                &a.currency,
                target_currency,
                fx_as_of,
            ) else {
                continue;
            };
            if line_amount == Decimal::ZERO {
                continue;
            }
            let entry = map
                .entry((
                    date.clone(),
                    SPENDING_TAXONOMY.to_string(),
                    allocation.category_id,
                ))
                .or_insert((Decimal::ZERO, 0));
            entry.0 += line_amount;
            entry.1 += 1;
        }
    }

    let mut out: Vec<DayCategoryBucket> = map
        .into_iter()
        .map(
            |((date, taxonomy_id, category_id), (amount, count))| DayCategoryBucket {
                date,
                taxonomy_id,
                category_id,
                amount: decimal_to_f64(amount),
                count,
            },
        )
        .collect();
    out.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then(a.taxonomy_id.cmp(&b.taxonomy_id))
            .then(a.category_id.cmp(&b.category_id))
    });
    out
}

#[allow(clippy::too_many_arguments)]
fn compute_by_month(
    acts: &[&Activity],
    account_types: &HashMap<String, String>,
    transfer_groups: &HashSet<String>,
    months: &[String],
    timezone: &str,
    fx: &dyn FxServiceTrait,
    target_currency: &str,
    fx_as_of: NaiveDate,
) -> Vec<MonthBucket> {
    let mut map: HashMap<String, (Decimal, Decimal, Decimal)> = HashMap::new();
    for m in months {
        map.insert(m.clone(), (Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
    }
    for a in acts {
        let Some(account_type) = account_types.get(&a.account_id) else {
            continue;
        };
        let classification = classify_activity_for_aggregation(a, account_type, transfer_groups);
        let amount = activity_abs_amount(a);
        let spending_native = classification.spending_amount(amount);
        let income_native = classification.income_amount(amount);
        let saving_native = classification.saving_amount(amount);
        if spending_native == Decimal::ZERO
            && income_native == Decimal::ZERO
            && saving_native == Decimal::ZERO
        {
            continue;
        }
        let spending = fx_to_target(fx, spending_native, &a.currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        let income = fx_to_target(fx, income_native, &a.currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        let saved = fx_to_target(fx, saving_native, &a.currency, target_currency, fx_as_of)
            .unwrap_or(Decimal::ZERO);
        let key = period_key_for_date_in_tz(a.activity_date, timezone);
        let entry = map
            .entry(key)
            .or_insert((Decimal::ZERO, Decimal::ZERO, Decimal::ZERO));
        entry.0 += spending;
        entry.1 += income;
        entry.2 += saved;
    }
    // Signed values (see compute_by_day comment): reconciliation invariant
    // `Σ by_month.spent == headline.spent` requires no per-bucket clamping.
    let mut out: Vec<MonthBucket> = map
        .into_iter()
        .map(|(month, (spent, income, saved))| MonthBucket {
            month,
            spent: decimal_to_f64(spent),
            income: decimal_to_f64(income),
            saved: decimal_to_f64(saved),
        })
        .collect();
    out.sort_by(|a, b| a.month.cmp(&b.month));
    out
}

// ──────────────────────────────────────────────────────────────────────────────
// Period meta + proration
// ──────────────────────────────────────────────────────────────────────────────

impl PeriodMeta {
    fn from_window(start: DateTime<Utc>, end: DateTime<Utc>) -> Self {
        let day_count = (end.date_naive() - start.date_naive()).num_days() + 1;
        let months = months_in_window(start, end);
        Self {
            start: start.to_rfc3339(),
            end: end.to_rfc3339(),
            months,
            day_count,
        }
    }
}

#[derive(Clone)]
struct MonthProration {
    month: String,
    /// `days_in_window_for_this_month / days_in_this_month` — 1.0 for fully-covered months.
    factor: Decimal,
    /// True when the window does not fully cover the month.
    prorated: bool,
}

fn build_month_prorations(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    months: &[String],
) -> Vec<MonthProration> {
    let start_d = start.date_naive();
    let end_d = end.date_naive();
    months
        .iter()
        .map(|month| {
            let (m_start, m_end) = month_bounds(month);
            let win_start = start_d.max(m_start);
            let win_end = end_d.min(m_end);
            let days_in_window = (win_end - win_start).num_days() + 1;
            let days_in_month = (m_end - m_start).num_days() + 1;
            let factor = if days_in_month > 0 {
                Decimal::from(days_in_window) / Decimal::from(days_in_month)
            } else {
                Decimal::ZERO
            };
            MonthProration {
                month: month.clone(),
                factor: factor.clamp(Decimal::ZERO, Decimal::ONE),
                prorated: days_in_window != days_in_month,
            }
        })
        .collect()
}

fn fanout_amount<F>(prorations: &[MonthProration], lookup: F) -> AmountBlock
where
    F: Fn(&str) -> (Decimal, bool),
{
    let mut breakdown = Vec::with_capacity(prorations.len());
    let mut total = Decimal::ZERO;
    for p in prorations {
        let (full_amount, has_override) = lookup(&p.month);
        let prorated_amount = full_amount * p.factor;
        total += prorated_amount;
        let source = match (has_override, p.prorated) {
            (true, true) => AmountSource::ProratedOverride,
            (true, false) => AmountSource::Override,
            (false, true) => AmountSource::Prorated,
            (false, false) => AmountSource::Default,
        };
        breakdown.push(MonthlyAmount {
            month: p.month.clone(),
            amount: decimal_to_f64(prorated_amount),
            full_monthly_amount: decimal_to_f64(full_amount),
            source,
        });
    }
    AmountBlock {
        total: decimal_to_f64(total),
        monthly_breakdown: breakdown,
    }
}

fn combine_monthly<'a, I>(blocks: I) -> Vec<MonthlyAmount>
where
    I: IntoIterator<Item = &'a AmountBlock>,
{
    let mut by_month: HashMap<String, (f64, f64, AmountSource)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for block in blocks {
        for entry in &block.monthly_breakdown {
            let slot = by_month.entry(entry.month.clone()).or_insert_with(|| {
                order.push(entry.month.clone());
                (0.0, 0.0, entry.source)
            });
            slot.0 += entry.amount;
            slot.1 += entry.full_monthly_amount;
            slot.2 = merge_source(slot.2, entry.source);
        }
    }
    let mut out: Vec<MonthlyAmount> = order
        .into_iter()
        .map(|month| {
            let (amount, full, source) = by_month.remove(&month).unwrap();
            MonthlyAmount {
                month,
                amount,
                full_monthly_amount: full,
                source,
            }
        })
        .collect();
    out.sort_by(|a, b| a.month.cmp(&b.month));
    out
}

fn merge_source(a: AmountSource, b: AmountSource) -> AmountSource {
    use AmountSource::*;
    // Promote to the "most informative" source — any override wins; any proration wins.
    let prorated =
        matches!(a, Prorated | ProratedOverride) || matches!(b, Prorated | ProratedOverride);
    let overridden =
        matches!(a, Override | ProratedOverride) || matches!(b, Override | ProratedOverride);
    match (overridden, prorated) {
        (true, true) => ProratedOverride,
        (true, false) => Override,
        (false, true) => Prorated,
        (false, false) => Default,
    }
}

fn months_in_window(start: DateTime<Utc>, end: DateTime<Utc>) -> Vec<String> {
    let (mut year, mut month) = (start.year(), start.month());
    let (end_year, end_month) = (end.year(), end.month());
    let mut out = Vec::new();
    while year < end_year || (year == end_year && month <= end_month) {
        out.push(format!("{:04}-{:02}", year, month));
        if month == 12 {
            year += 1;
            month = 1;
        } else {
            month += 1;
        }
    }
    out
}

fn month_bounds(month_key: &str) -> (NaiveDate, NaiveDate) {
    let year: i32 = month_key[0..4].parse().unwrap_or(1970);
    let month: u32 = month_key[5..7].parse().unwrap_or(1);
    let start = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let end = NaiveDate::from_ymd_opt(next_year, next_month, 1).unwrap() - Duration::days(1);
    (start, end)
}

fn period_key_for_date_in_tz(date: DateTime<Utc>, timezone: &str) -> String {
    let d = wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(date, timezone);
    format!("{:04}-{:02}", d.year(), d.month())
}

fn format_date(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

// ──────────────────────────────────────────────────────────────────────────────
// Prior window
// ──────────────────────────────────────────────────────────────────────────────

fn explicit_compare_window(
    req: &SpendingInsightRequest,
) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>> {
    match (&req.compare_start_date, &req.compare_end_date) {
        (None, None) => Ok(None),
        (Some(start), Some(end)) => {
            let start = parse_rfc3339(start)?;
            let end = parse_rfc3339(end)?;
            if end < start {
                return Err(SpendingError::InvalidInput {
                    message: "compare_end_date must be >= compare_start_date".to_string(),
                }
                .into());
            }
            Ok(Some((start, end)))
        }
        _ => Err(SpendingError::InvalidInput {
            message: "compare_start_date and compare_end_date must be provided together"
                .to_string(),
        }
        .into()),
    }
}

fn compute_prior_window(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    compare: CompareMode,
) -> (DateTime<Utc>, DateTime<Utc>) {
    match compare {
        CompareMode::Prior => {
            let span = (end - start).num_seconds().max(0) + 1;
            let prior_end = start - Duration::seconds(1);
            let prior_start = prior_end - Duration::seconds(span - 1);
            (prior_start, prior_end)
        }
        CompareMode::YearOverYear => {
            let prior_start = subtract_year(start);
            let prior_end = subtract_year(end);
            (prior_start, prior_end)
        }
    }
}

fn subtract_year(dt: DateTime<Utc>) -> DateTime<Utc> {
    let year = dt.year() - 1;
    // Handle Feb 29 → Feb 28 in non-leap years.
    let day = if dt.month() == 2 && dt.day() == 29 && !is_leap(year) {
        28
    } else {
        dt.day()
    };
    Utc.with_ymd_and_hms(year, dt.month(), day, dt.hour(), dt.minute(), dt.second())
        .single()
        .unwrap_or(dt)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

// ──────────────────────────────────────────────────────────────────────────────
// Pace + status
// ──────────────────────────────────────────────────────────────────────────────

// 11 args is intentional — splitting into a struct here would just be
// shuffling the same fields with no shared call site to benefit. The window
// inputs (start/end/now), the FX trio (fx/target_currency/fx_as_of), and
// the result-aggregation pair (spent/budget) all serve different concerns.
#[allow(clippy::too_many_arguments)]
fn compute_pace(
    acts: &[&Activity],
    account_types: &HashMap<String, String>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    now: DateTime<Utc>,
    spent: f64,
    budget: f64,
    fx: &dyn FxServiceTrait,
    target_currency: &str,
    fx_as_of: NaiveDate,
    timezone: &str,
) -> PaceState {
    // All day anchors in the user's local timezone so the trailing-7 boundary
    // and the activity-day comparison below are in the same domain. Otherwise
    // a UTC±12 user near midnight would see a day shift between
    // `trail_start..=elapsed_d` (UTC) and `d` (user-local), dropping or
    // adding a day's worth of activities.
    let start_d =
        wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(start, timezone);
    let end_d = wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(end, timezone);
    let now_d = wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(now, timezone);
    let total_days = (end_d - start_d).num_days() + 1;

    // Day relative to the window:
    //   window is in the past   → elapsed = total
    //   window is in the future → elapsed = 0
    //   window includes today   → elapsed = days from start to today (inclusive)
    let elapsed_d = if now_d > end_d {
        end_d
    } else if now_d < start_d {
        start_d - Duration::days(1)
    } else {
        now_d
    };
    let days_elapsed = (elapsed_d - start_d).num_days() + 1;
    let days_elapsed = days_elapsed.clamp(0, total_days);
    let days_remaining = (total_days - days_elapsed).max(0);

    // Trailing-7 average: sum of spend on the last min(7, days_elapsed) days ending at elapsed_d.
    let trail_days = TRAILING_WINDOW_DAYS.min(days_elapsed);
    let daily_avg = if trail_days > 0 {
        let trail_start = elapsed_d - Duration::days(trail_days - 1);
        let mut sum = Decimal::ZERO;
        for a in acts {
            let Some(account_type) = account_types.get(&a.account_id) else {
                continue;
            };
            // Filter by user-local day so the trailing-7 window matches the
            // days the user perceives, consistent with compute_by_day's
            // bucketing convention. Both endpoints (`trail_start`,
            // `elapsed_d`) are derived from `now.date_naive()` upstream — for
            // TZ-consistency they should be in user-local too, which is the
            // natural read of "today" / "7 days ago".
            let d = wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(
                a.activity_date,
                timezone,
            );
            if d < trail_start || d > elapsed_d {
                continue;
            }
            let classification = classify_activity(a, account_type);
            let native = classification.spending_amount(activity_abs_amount(a));
            if let Some(amount) = fx_to_target(fx, native, &a.currency, target_currency, fx_as_of) {
                sum += amount;
            }
        }
        // Clamp at zero: a refund-heavy trailing window would otherwise produce
        // a negative daily_avg and a projection lower than current spent, which
        // is misleading. The actual run-rate of charges (net of refunds) is
        // bounded below by zero — refunds don't predict future "negative spend".
        (decimal_to_f64(sum) / trail_days as f64).max(0.0)
    } else {
        0.0
    };

    let projected_spend = spent + daily_avg * days_remaining as f64;
    let expected_spend_to_date = if total_days > 0 {
        budget * (days_elapsed as f64 / total_days as f64)
    } else {
        0.0
    };

    PaceState {
        daily_avg,
        days_elapsed,
        days_remaining,
        projected_spend,
        expected_spend_to_date,
    }
}

fn compute_health_status(spent: f64, budget: f64, income: f64, projected: f64) -> HealthStatus {
    if budget > 0.0 && spent > budget {
        return HealthStatus::Over;
    }
    // Only fire CashflowNegative when *some* income was observed and it failed
    // to cover spend. Credit-card-only spending accounts (paycheck tracked
    // elsewhere) routinely show zero income — flagging that every time would
    // be noise, not signal.
    if income > 0.0 && income < spent {
        return HealthStatus::CashflowNegative;
    }
    if budget <= 0.0 && spent > 0.0 {
        return HealthStatus::Over;
    }
    if budget > 0.0 && (projected > budget || spent / budget > APPROACHING_THRESHOLD) {
        return HealthStatus::Approaching;
    }
    HealthStatus::OnTrack
}

// ──────────────────────────────────────────────────────────────────────────────
// Small math helpers
// ──────────────────────────────────────────────────────────────────────────────

fn pct_change(current: f64, prior: f64) -> Option<f64> {
    if prior.abs() < f64::EPSILON {
        None
    } else {
        Some((current - prior) / prior)
    }
}

fn pct_share(part: f64, total: f64) -> Option<f64> {
    if total.abs() < f64::EPSILON {
        None
    } else {
        Some(part / total)
    }
}

fn parse_rfc3339(value: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| {
            SpendingError::InvalidInput {
                message: format!("Invalid RFC3339 timestamp `{value}`: {e}"),
            }
            .into()
        })
}

// ──────────────────────────────────────────────────────────────────────────────
// Reconciliation invariants (asserted in debug builds; tested in #[cfg(test)])
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(debug_assertions)]
fn debug_assert_reconciliation(insight: &SpendingInsight) {
    use float_eq::assert_within;
    // 1) headline.spent == Σ groups.spent + uncategorized.spent
    let group_spent: f64 = insight.groups.iter().map(|g| g.spent).sum();
    assert_within(
        insight.headline.spent,
        group_spent + insight.uncategorized.spent,
    );

    // 2) headline.budget == Σ (group.budget + group.buffer)
    let total_budget: f64 = insight
        .groups
        .iter()
        .map(|g| g.budget.total + g.buffer.total)
        .sum();
    assert_within(insight.headline.budget, total_budget);

    // 3) per group: spent == Σ categories.spent
    for g in &insight.groups {
        let sum: f64 = g.categories.iter().map(|c| c.spent).sum();
        assert_within(g.spent, sum);
    }

    let by_day_category_spent: f64 = insight
        .by_day_by_category
        .iter()
        .filter(|b| b.taxonomy_id == SPENDING_TAXONOMY)
        .map(|b| b.amount)
        .sum();
    assert_within(insight.headline.spent, by_day_category_spent);

    // 4) per group: budget == Σ categories.budget
    for g in &insight.groups {
        let sum: f64 = g.categories.iter().map(|c| c.budget.total).sum();
        assert_within(g.budget.total, sum);
    }

    // 5) every AmountBlock: total == Σ monthly_breakdown.amount (catches
    //    drift between fanout_amount and combine_monthly).
    for g in &insight.groups {
        assert_within(
            g.budget.total,
            g.budget.monthly_breakdown.iter().map(|m| m.amount).sum(),
        );
        assert_within(
            g.buffer.total,
            g.buffer.monthly_breakdown.iter().map(|m| m.amount).sum(),
        );
        for c in &g.categories {
            assert_within(
                c.budget.total,
                c.budget.monthly_breakdown.iter().map(|m| m.amount).sum(),
            );
        }
    }
}

#[cfg(not(debug_assertions))]
fn debug_assert_reconciliation(_insight: &SpendingInsight) {}

#[cfg(debug_assertions)]
mod float_eq {
    pub fn assert_within(a: f64, b: f64) {
        let diff = (a - b).abs();
        let tol = (a.abs().max(b.abs()) * 1e-6).max(0.005);
        debug_assert!(
            diff <= tol,
            "reconciliation drift: {a} vs {b} (diff {diff}, tol {tol})"
        );
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Empty-insight constructor for the gated path
// ──────────────────────────────────────────────────────────────────────────────

fn empty_insight(period: PeriodMeta, prior: PeriodMeta, currency: &str) -> SpendingInsight {
    let pace = PaceState {
        daily_avg: 0.0,
        days_elapsed: 0,
        days_remaining: 0,
        projected_spend: 0.0,
        expected_spend_to_date: 0.0,
    };
    SpendingInsight {
        period,
        prior,
        currency: currency.to_string(),
        foreign_currencies: vec![],
        native_outflow_by_currency: HashMap::new(),
        headline: Headline {
            spent: 0.0,
            income: 0.0,
            saved: 0.0,
            net_cashflow: 0.0,
            budget: 0.0,
            remaining: 0.0,
            prior_spent: 0.0,
            delta_vs_prior_pct: None,
            pace,
            status: HealthStatus::OnTrack,
        },
        groups: vec![],
        uncategorized: UncategorizedBucket::default(),
        income_breakdown: vec![],
        savings_breakdown: vec![],
        by_day: vec![],
        by_day_by_category: vec![],
        by_month: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::TimeZone;
    use wealthfolio_core::fx::{ExchangeRate, NewExchangeRate};

    fn dt(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap()
    }

    /// No-op FX stub: pass-through (rate = 1, regardless of pair). Lets unit
    /// tests cover the same-currency happy path without standing up the real
    /// FxService + DB. Cross-currency conversion is exercised by integration
    /// tests at the repository layer.
    struct PassthroughFx {
        fail_cross_currency: bool,
    }

    type CoreResult<T> = std::result::Result<T, wealthfolio_core::Error>;

    #[async_trait]
    impl FxServiceTrait for PassthroughFx {
        fn initialize(&self) -> CoreResult<()> {
            Ok(())
        }
        fn get_historical_rates(&self, _: &str, _: &str, _: i64) -> CoreResult<Vec<ExchangeRate>> {
            Ok(vec![])
        }
        fn get_latest_exchange_rate(&self, _: &str, _: &str) -> CoreResult<Decimal> {
            Ok(Decimal::ONE)
        }
        fn get_exchange_rate_for_date(
            &self,
            _: &str,
            _: &str,
            _: NaiveDate,
        ) -> CoreResult<Decimal> {
            Ok(Decimal::ONE)
        }
        fn convert_currency(&self, amount: Decimal, _: &str, _: &str) -> CoreResult<Decimal> {
            Ok(amount)
        }
        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            from: &str,
            to: &str,
            _: NaiveDate,
        ) -> CoreResult<Decimal> {
            if self.fail_cross_currency && from != to {
                return Err(wealthfolio_core::Error::CurrencyConversionFailed(
                    "missing test rate".to_string(),
                ));
            }
            Ok(amount)
        }
        fn get_latest_exchange_rates(&self) -> CoreResult<Vec<ExchangeRate>> {
            Ok(vec![])
        }
        async fn add_exchange_rate(&self, _: NewExchangeRate) -> CoreResult<ExchangeRate> {
            unimplemented!("PassthroughFx is read-only")
        }
        async fn update_exchange_rate(
            &self,
            _: &str,
            _: &str,
            _: Decimal,
        ) -> CoreResult<ExchangeRate> {
            unimplemented!("PassthroughFx is read-only")
        }
        async fn delete_exchange_rate(&self, _: &str) -> CoreResult<()> {
            Ok(())
        }
        async fn register_currency_pair(&self, _: &str, _: &str) -> CoreResult<()> {
            Ok(())
        }
        async fn register_currency_pair_manual(&self, _: &str, _: &str) -> CoreResult<()> {
            Ok(())
        }
        async fn ensure_fx_pairs(&self, _: Vec<(String, String)>) -> CoreResult<()> {
            Ok(())
        }
    }

    fn fx() -> PassthroughFx {
        PassthroughFx {
            fail_cross_currency: false,
        }
    }

    fn failing_cross_currency_fx() -> PassthroughFx {
        PassthroughFx {
            fail_cross_currency: true,
        }
    }

    // ── PeriodMeta + months_in_window ─────────────────────────────────────────

    #[test]
    fn months_cover_inclusive_range() {
        let p = PeriodMeta::from_window(dt(2026, 3, 1), dt(2026, 5, 19));
        assert_eq!(p.months, vec!["2026-03", "2026-04", "2026-05"]);
        assert_eq!(p.day_count, 31 + 30 + 19);
    }

    #[test]
    fn months_wrap_across_year_boundary() {
        let p = PeriodMeta::from_window(dt(2025, 11, 15), dt(2026, 2, 5));
        assert_eq!(p.months, vec!["2025-11", "2025-12", "2026-01", "2026-02"]);
    }

    #[test]
    fn months_for_single_day_window() {
        let p = PeriodMeta::from_window(dt(2026, 5, 19), dt(2026, 5, 19));
        assert_eq!(p.months, vec!["2026-05"]);
        assert_eq!(p.day_count, 1);
    }

    // ── build_month_prorations ────────────────────────────────────────────────

    #[test]
    fn proration_is_one_for_fully_covered_months() {
        let p = build_month_prorations(
            dt(2026, 3, 1),
            dt(2026, 5, 19),
            &[
                "2026-03".to_string(),
                "2026-04".to_string(),
                "2026-05".to_string(),
            ],
        );
        assert_eq!(p[0].factor, Decimal::ONE);
        assert!(!p[0].prorated);
        assert_eq!(p[1].factor, Decimal::ONE);
        assert!(!p[1].prorated);
        // May only partially covered: 19 / 31
        assert_eq!(p[2].factor, Decimal::from(19) / Decimal::from(31));
        assert!(p[2].prorated);
    }

    #[test]
    fn proration_handles_partial_start_month() {
        let p = build_month_prorations(
            dt(2026, 3, 15),
            dt(2026, 4, 30),
            &["2026-03".to_string(), "2026-04".to_string()],
        );
        // March: days 15..=31 = 17 days out of 31.
        assert_eq!(p[0].factor, Decimal::from(17) / Decimal::from(31));
        assert!(p[0].prorated);
        // April: fully covered.
        assert_eq!(p[1].factor, Decimal::ONE);
    }

    // ── fanout_amount + source labelling ──────────────────────────────────────

    #[test]
    fn fanout_sums_prorated_amounts_and_tags_source() {
        let prorations = build_month_prorations(
            dt(2026, 3, 1),
            dt(2026, 5, 19),
            &[
                "2026-03".to_string(),
                "2026-04".to_string(),
                "2026-05".to_string(),
            ],
        );
        // Education: default 50/mo, May override 150.
        let block = fanout_amount(&prorations, |month| match month {
            "2026-05" => (Decimal::new(150, 0), true),
            _ => (Decimal::new(50, 0), false),
        });
        let expected = 50.0 + 50.0 + 150.0 * (19.0 / 31.0);
        assert!((block.total - expected).abs() < 1e-9);
        assert_eq!(block.monthly_breakdown[0].source, AmountSource::Default);
        assert_eq!(block.monthly_breakdown[1].source, AmountSource::Default);
        assert_eq!(
            block.monthly_breakdown[2].source,
            AmountSource::ProratedOverride
        );
        assert_eq!(block.monthly_breakdown[2].full_monthly_amount, 150.0);
    }

    #[test]
    fn merge_source_prefers_most_informative() {
        use AmountSource::*;
        assert_eq!(merge_source(Default, Default), Default);
        assert_eq!(merge_source(Default, Override), Override);
        assert_eq!(merge_source(Default, Prorated), Prorated);
        assert_eq!(merge_source(Override, Prorated), ProratedOverride);
        assert_eq!(merge_source(ProratedOverride, Default), ProratedOverride);
    }

    #[test]
    fn combine_monthly_sums_category_blocks_into_group_block() {
        let prorations = build_month_prorations(
            dt(2026, 3, 1),
            dt(2026, 4, 30),
            &["2026-03".to_string(), "2026-04".to_string()],
        );
        let a = fanout_amount(&prorations, |_| (Decimal::new(100, 0), false));
        let b = fanout_amount(&prorations, |month| match month {
            "2026-04" => (Decimal::new(50, 0), true),
            _ => (Decimal::new(50, 0), false),
        });
        let combined = combine_monthly([&a, &b]);
        assert_eq!(combined.len(), 2);
        assert!((combined[0].amount - 150.0).abs() < 1e-9);
        assert!((combined[1].amount - 150.0).abs() < 1e-9);
        assert_eq!(combined[1].source, AmountSource::Override);
    }

    // ── Prior window ──────────────────────────────────────────────────────────

    #[test]
    fn prior_window_matches_size_of_current() {
        let (s, e) = compute_prior_window(dt(2026, 3, 1), dt(2026, 5, 19), CompareMode::Prior);
        let span = (dt(2026, 5, 19) - dt(2026, 3, 1)).num_seconds() + 1;
        assert_eq!((e - s).num_seconds() + 1, span);
        assert!(e < dt(2026, 3, 1));
    }

    #[test]
    fn explicit_compare_window_uses_request_dates() {
        let req = SpendingInsightRequest {
            start_date: dt(2026, 6, 1).to_rfc3339(),
            end_date: dt(2026, 6, 4).to_rfc3339(),
            compare_start_date: Some(dt(2026, 5, 1).to_rfc3339()),
            compare_end_date: Some(dt(2026, 5, 4).to_rfc3339()),
            account_ids: None,
            compare: Some(CompareMode::Prior),
        };

        let (s, e) = explicit_compare_window(&req).unwrap().unwrap();

        assert_eq!(s, dt(2026, 5, 1));
        assert_eq!(e, dt(2026, 5, 4));
    }

    #[test]
    fn explicit_compare_window_requires_both_dates() {
        let req = SpendingInsightRequest {
            start_date: dt(2026, 6, 1).to_rfc3339(),
            end_date: dt(2026, 6, 4).to_rfc3339(),
            compare_start_date: Some(dt(2026, 5, 1).to_rfc3339()),
            compare_end_date: None,
            account_ids: None,
            compare: Some(CompareMode::Prior),
        };

        assert!(explicit_compare_window(&req).is_err());
    }

    #[test]
    fn yoy_window_offsets_by_one_year() {
        let (s, e) =
            compute_prior_window(dt(2026, 3, 1), dt(2026, 5, 19), CompareMode::YearOverYear);
        assert_eq!(s, dt(2025, 3, 1));
        assert_eq!(e, dt(2025, 5, 19));
    }

    #[test]
    fn yoy_handles_leap_day() {
        let (s, _) =
            compute_prior_window(dt(2024, 2, 29), dt(2024, 3, 5), CompareMode::YearOverYear);
        // 2023 is not a leap year — should fall back to Feb 28.
        assert_eq!(s, dt(2023, 2, 28));
    }

    // ── Pct helpers ───────────────────────────────────────────────────────────

    #[test]
    fn pct_change_returns_none_when_prior_is_zero() {
        assert!(pct_change(100.0, 0.0).is_none());
        assert_eq!(pct_change(150.0, 100.0), Some(0.5));
        assert_eq!(pct_change(50.0, 100.0), Some(-0.5));
    }

    #[test]
    fn pct_share_returns_none_when_total_is_zero() {
        assert!(pct_share(0.0, 0.0).is_none());
        assert_eq!(pct_share(25.0, 100.0), Some(0.25));
    }

    // ── Health status ─────────────────────────────────────────────────────────

    #[test]
    fn status_over_when_spent_exceeds_budget() {
        assert_eq!(
            compute_health_status(150.0, 100.0, 200.0, 150.0),
            HealthStatus::Over
        );
    }

    #[test]
    fn status_cashflow_negative_only_when_income_present_and_below_spend() {
        // Some income observed, but it didn't cover spend.
        assert_eq!(
            compute_health_status(80.0, 1000.0, 50.0, 80.0),
            HealthStatus::CashflowNegative
        );
        // Zero income should NOT trigger CashflowNegative — that's the normal
        // state for credit-card-only spending accounts.
        assert_eq!(
            compute_health_status(50.0, 100.0, 0.0, 50.0),
            HealthStatus::OnTrack
        );
    }

    #[test]
    fn status_over_when_spending_without_budget() {
        assert_eq!(
            compute_health_status(50.0, 0.0, 0.0, 50.0),
            HealthStatus::Over
        );
    }

    #[test]
    fn status_approaching_when_projection_breaches_budget() {
        // Spent comfortably under, but projection blows past.
        assert_eq!(
            compute_health_status(60.0, 100.0, 100.0, 130.0),
            HealthStatus::Approaching
        );
    }

    #[test]
    fn status_on_track_for_healthy_run() {
        assert_eq!(
            compute_health_status(40.0, 100.0, 100.0, 80.0),
            HealthStatus::OnTrack
        );
    }

    // ── Trailing-7 pace ───────────────────────────────────────────────────────

    #[test]
    fn pace_projects_zero_remaining_for_closed_window() {
        let pace = compute_pace(
            &[],
            &HashMap::new(),
            dt(2026, 3, 1),
            dt(2026, 5, 19),
            dt(2026, 5, 19),
            1000.0,
            500.0,
            &fx(),
            "USD",
            NaiveDate::from_ymd_opt(2026, 5, 19).unwrap(),
            "",
        );
        assert_eq!(pace.days_remaining, 0);
        assert_eq!(pace.projected_spend, 1000.0);
    }

    #[test]
    fn pace_uses_trailing_window_for_open_periods() {
        use rust_decimal::Decimal;
        use serde_json::Value;
        use wealthfolio_core::accounts::account_types;
        use wealthfolio_core::activities::{Activity, ActivityStatus};

        // Window: May 1 → May 31; today = May 19. days_elapsed=19, days_remaining=12.
        // Trailing 7 = May 13..=19; put $100 on each of those days → $100/day average.
        let mut acts: Vec<Activity> = Vec::new();
        for d in 13..=19 {
            acts.push(activity_on(dt(2026, 5, d), Decimal::new(10000, 2)));
        }
        let refs: Vec<&Activity> = acts.iter().collect();
        let mut account_types = HashMap::new();
        account_types.insert(
            "account-1".to_string(),
            account_types::CREDIT_CARD.to_string(),
        );

        let spent_to_date = 800.0; // includes earlier days outside trailing 7
        let pace = compute_pace(
            &refs,
            &account_types,
            dt(2026, 5, 1),
            dt(2026, 5, 31),
            dt(2026, 5, 19),
            spent_to_date,
            2000.0,
            &fx(),
            "USD",
            NaiveDate::from_ymd_opt(2026, 5, 19).unwrap(),
            "",
        );
        assert_eq!(pace.days_elapsed, 19);
        assert_eq!(pace.days_remaining, 12);
        assert!((pace.daily_avg - 100.0).abs() < 1e-9);
        // projection = 800 + 100 * 12 = 2000
        assert!((pace.projected_spend - 2000.0).abs() < 1e-9);
        // expected = 2000 * (19/31)
        assert!((pace.expected_spend_to_date - 2000.0 * 19.0 / 31.0).abs() < 1e-9);

        fn activity_on(
            date: DateTime<Utc>,
            amount: rust_decimal::Decimal,
        ) -> wealthfolio_core::activities::Activity {
            Activity {
                id: format!("act-{}", date.timestamp()),
                account_id: "account-1".to_string(),
                asset_id: None,
                activity_type: "WITHDRAWAL".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: date,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(amount),
                fee: None,
                tax: None,
                currency: "USD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: None::<Value>,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: date,
                updated_at: date,
            }
        }
    }

    // ── aggregate_spend: single-select attribution + uncategorized ────────────

    #[test]
    fn aggregate_attributes_full_amount_to_single_assignment_and_buckets_unassigned_separately() {
        use rust_decimal::Decimal;
        use serde_json::Value;
        use wealthfolio_core::accounts::account_types;
        use wealthfolio_core::activities::{Activity, ActivityStatus};
        use wealthfolio_core::taxonomies::Category;

        let categorized = Activity {
            id: "a1".to_string(),
            account_id: "acct".to_string(),
            asset_id: None,
            activity_type: "WITHDRAWAL".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: dt(2026, 5, 10),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(10000, 2)), // 100.00
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None::<Value>,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: dt(2026, 5, 10),
            updated_at: dt(2026, 5, 10),
        };
        let uncategorized = Activity {
            id: "a2".to_string(),
            amount: Some(Decimal::new(5000, 2)), // 50.00
            ..categorized.clone()
        };

        let acts: Vec<&Activity> = vec![&categorized, &uncategorized];
        let mut account_types = HashMap::new();
        account_types.insert("acct".to_string(), account_types::CREDIT_CARD.to_string());

        let mut assignments = HashMap::new();
        assignments.insert(
            "a1".to_string(),
            vec![crate::activity_assignments::ActivityTaxonomyAssignment {
                id: "asg-1".to_string(),
                activity_id: "a1".to_string(),
                taxonomy_id: SPENDING_TAXONOMY.to_string(),
                category_id: "cat_food".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
                created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
            }],
        );

        let mut meta = HashMap::new();
        meta.insert(
            "cat_food".to_string(),
            Category {
                id: "cat_food".to_string(),
                taxonomy_id: SPENDING_TAXONOMY.to_string(),
                parent_id: None,
                name: "Food".to_string(),
                key: "cat_food".to_string(),
                color: "#000".to_string(),
                icon: None,
                description: None,
                sort_order: 0,
                created_at: chrono::Utc::now().naive_utc(),
                updated_at: chrono::Utc::now().naive_utc(),
            },
        );

        let agg = aggregate_spend(
            &acts,
            &account_types,
            &within_spending_transfer_groups(&acts),
            &assignments,
            &meta,
            &fx(),
            "USD",
            NaiveDate::from_ymd_opt(2026, 5, 31).unwrap(),
        );
        assert_eq!(agg.total_outflow, Decimal::new(150, 0));
        assert_eq!(agg.uncategorized_spend, Decimal::new(50, 0));
        assert_eq!(agg.uncategorized_count, 1);
        assert_eq!(
            agg.spending_by_top.get("cat_food").unwrap().0,
            Decimal::new(100, 0)
        );
        assert_eq!(agg.spending_by_top.get("cat_food").unwrap().1, 1);

        let day_categories = compute_by_day_by_category(
            &acts,
            &account_types,
            &assignments,
            "UTC",
            &fx(),
            "USD",
            NaiveDate::from_ymd_opt(2026, 5, 31).unwrap(),
        );
        let by_category: HashMap<String, f64> = day_categories
            .iter()
            .map(|bucket| (bucket.category_id.clone(), bucket.amount))
            .collect();
        assert_eq!(day_categories.len(), 2);
        assert_eq!(by_category.get("cat_food"), Some(&100.0));
        assert_eq!(by_category.get(UNCATEGORIZED_CATEGORY_ID), Some(&50.0));
    }

    #[test]
    fn aggregate_emits_income_and_savings_breakdown_rows() {
        use rust_decimal::Decimal;
        use serde_json::Value;
        use wealthfolio_core::accounts::account_types;
        use wealthfolio_core::activities::{Activity, ActivityStatus};

        let income = Activity {
            id: "income".to_string(),
            account_id: "acct".to_string(),
            asset_id: None,
            activity_type: "DEPOSIT".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: dt(2026, 5, 10),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(900000, 2)),
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None::<Value>,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: dt(2026, 5, 10),
            updated_at: dt(2026, 5, 10),
        };
        let saving = Activity {
            id: "saving".to_string(),
            activity_type: "TRANSFER_OUT".to_string(),
            amount: Some(Decimal::new(100000, 2)),
            source_group_id: Some("linked-saving-transfer".to_string()),
            ..income.clone()
        };
        let acts: Vec<&Activity> = vec![&income, &saving];
        let mut account_types = HashMap::new();
        account_types.insert("acct".to_string(), account_types::CASH.to_string());

        let now = chrono::Utc::now().naive_utc();
        let mut assignments = HashMap::new();
        assignments.insert(
            "income".to_string(),
            vec![crate::activity_assignments::ActivityTaxonomyAssignment {
                id: "asg-income".to_string(),
                activity_id: "income".to_string(),
                taxonomy_id: INCOME_TAXONOMY.to_string(),
                category_id: "cat_salary".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
                created_at: now,
                updated_at: now,
            }],
        );
        assignments.insert(
            "saving".to_string(),
            vec![crate::activity_assignments::ActivityTaxonomyAssignment {
                id: "asg-saving".to_string(),
                activity_id: "saving".to_string(),
                taxonomy_id: SAVINGS_TAXONOMY.to_string(),
                category_id: "cat_investments".to_string(),
                weight: 10_000,
                source: "manual".to_string(),
                created_at: now,
                updated_at: now,
            }],
        );

        let transfer_groups = within_spending_transfer_groups(&acts);
        let agg = aggregate_spend(
            &acts,
            &account_types,
            &transfer_groups,
            &assignments,
            &HashMap::new(),
            &fx(),
            "USD",
            NaiveDate::from_ymd_opt(2026, 5, 31).unwrap(),
        );

        assert_eq!(agg.total_income, Decimal::new(9000, 0));
        assert_eq!(agg.total_saved, Decimal::new(1000, 0));
        assert_eq!(
            agg.income_by_category.get("cat_salary").unwrap().0,
            Decimal::new(9000, 0)
        );
        assert_eq!(
            agg.savings_by_category.get("cat_investments").unwrap().0,
            Decimal::new(1000, 0)
        );

        let monthly = compute_by_month(
            &acts,
            &account_types,
            &transfer_groups,
            &["2026-05".to_string()],
            "UTC",
            &fx(),
            "USD",
            NaiveDate::from_ymd_opt(2026, 5, 31).unwrap(),
        );
        assert_eq!(monthly[0].income, 9000.0);
        assert_eq!(monthly[0].saved, 1000.0);
    }

    #[test]
    fn aggregate_excludes_native_outflow_when_fx_conversion_fails() {
        use rust_decimal::Decimal;
        use serde_json::Value;
        use wealthfolio_core::accounts::account_types;
        use wealthfolio_core::activities::{Activity, ActivityStatus};

        let activity = Activity {
            id: "foreign-spend".to_string(),
            account_id: "acct".to_string(),
            asset_id: None,
            activity_type: "WITHDRAWAL".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: dt(2026, 5, 10),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(10000, 2)),
            fee: None,
            tax: None,
            currency: "EUR".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None::<Value>,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: dt(2026, 5, 10),
            updated_at: dt(2026, 5, 10),
        };
        let acts = vec![&activity];
        let mut account_types = HashMap::new();
        account_types.insert("acct".to_string(), account_types::CREDIT_CARD.to_string());

        let agg = aggregate_spend(
            &acts,
            &account_types,
            &within_spending_transfer_groups(&acts),
            &HashMap::new(),
            &HashMap::new(),
            &failing_cross_currency_fx(),
            "USD",
            NaiveDate::from_ymd_opt(2026, 5, 31).unwrap(),
        );

        assert_eq!(agg.total_outflow, Decimal::ZERO);
        assert!(agg.native_outflow_by_currency.is_empty());
    }
}
