//! Orchestration behind the calculated rebalancing worksheet.
//!
//! Implements §4 to §6 of
//! `docs/features/allocations/self-directed-rebalancing-design.md`. The
//! arithmetic lives in [`super::worksheet_calculator`] and stays pure: this
//! file resolves the drift report, the taxonomy contributions, prices, FX and
//! constraints, and hands them over as plain structs.

use async_trait::async_trait;
use chrono::Utc;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
use std::sync::Arc;

use crate::assets::{Asset, AssetServiceTrait};
use crate::errors::{DatabaseError, Error as CoreError, Result as CoreResult, ValidationError};
use crate::fx::currency::currency_minor_unit;
use crate::fx::{
    denormalization_multiplier, normalize_currency_code, ExchangeRate, FxServiceTrait,
};
use crate::portfolio::allocation::{AllocationServiceTrait, HoldingAllocationContribution};
use crate::portfolio::holdings::{Holding, HoldingType, HoldingsServiceTrait};
use crate::quotes::{LatestQuoteSnapshot, QuoteServiceTrait};
use crate::taxonomies::{AssetTaxonomyAssignment, TaxonomyServiceTrait};

use super::cash::{has_deployable_cash_categories, tracked_cash};
use super::drift_service::DriftServiceTrait;
use super::model::{
    AllocationTargetConstraint, AllocationWorksheetLineInput, AllocationWorksheetLineResult,
    AllocationWorksheetResult, CalculateAllocationWorksheetInput, CalculatedAdjustment,
    CalculatedAdjustments, ConstraintAction, ConstraintEffect, ConstraintSubjectType,
    GenerateCalculatedAdjustmentsInput, WorksheetCategoryExposure, WorksheetCategoryResult,
    WorksheetDirection, WorksheetInputMode, WorksheetMode, WorksheetPricingSource,
    WorksheetSourceRecord, WorksheetWarning, WorksheetWarningKind,
};
use super::target_service::AllocationTargetServiceTrait;
use super::worksheet_calculator::{
    account_funding_shortfalls, apply_limits, assign_accounts, remaining_cash, run_sequence,
    turnover_cap_value, AssignedLine, CategoryTarget, LimitsInput, PositionInput, SecurityInput,
    SequenceInput,
};

const UNKNOWN_CATEGORY_ID: &str = "__UNKNOWN__";
const UNKNOWN_CATEGORY_NAME: &str = "Unclassified exposure";

#[async_trait]
pub trait AllocationWorksheetServiceTrait: Send + Sync {
    /// Prefills the worksheet from the target, the eligible securities and the
    /// allocation rule (§4).
    async fn generate_adjustments(
        &self,
        input: GenerateCalculatedAdjustmentsInput,
    ) -> CoreResult<CalculatedAdjustments>;

    /// Validates the worksheet as the user has it and produces the projection
    /// shown next to it (§5).
    ///
    /// It never re-derives the adjustments: once prefilled, the worksheet is
    /// the source of truth, and an edit that breaks a limit is reported rather
    /// than corrected.
    async fn calculate_worksheet(
        &self,
        input: CalculateAllocationWorksheetInput,
    ) -> CoreResult<AllocationWorksheetResult>;
}

pub struct AllocationWorksheetService {
    allocation_target_service: Arc<dyn AllocationTargetServiceTrait>,
    drift_service: Arc<dyn DriftServiceTrait>,
    allocation_service: Arc<dyn AllocationServiceTrait>,
    holdings_service: Arc<dyn HoldingsServiceTrait>,
    asset_service: Arc<dyn AssetServiceTrait>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
}

impl AllocationWorksheetService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        allocation_target_service: Arc<dyn AllocationTargetServiceTrait>,
        drift_service: Arc<dyn DriftServiceTrait>,
        allocation_service: Arc<dyn AllocationServiceTrait>,
        holdings_service: Arc<dyn HoldingsServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self {
            allocation_target_service,
            drift_service,
            allocation_service,
            holdings_service,
            asset_service,
            taxonomy_service,
            quote_service,
            fx_service,
        }
    }

    fn invalid(message: impl Into<String>) -> CoreError {
        CoreError::Validation(ValidationError::InvalidInput(message.into()))
    }

    fn line_invalid(line_id: &str, message: impl AsRef<str>) -> CoreError {
        Self::invalid(format!("Worksheet line {line_id}: {}", message.as_ref()))
    }

    fn warning(
        kind: WorksheetWarningKind,
        line_id: Option<&str>,
        suffix: &str,
        message: String,
    ) -> WorksheetWarning {
        let kind_key = format!("{kind:?}").to_ascii_lowercase();
        WorksheetWarning {
            id: format!("{}:{}:{}", kind_key, line_id.unwrap_or("worksheet"), suffix),
            kind,
            line_id: line_id.map(str::to_string),
            message,
            acknowledgement_required: true,
        }
    }

    /// The tracked cash the worksheet may actually deploy.
    ///
    /// A rounding-sized overage is clamped rather than refused, since the
    /// amount arrives from a control showing a rounded balance. The prefill and
    /// the preview share the rule so a prefilled worksheet never fails a check
    /// its own generation passed.
    fn tracked_cash_to_use(
        selected: Decimal,
        deployable: Decimal,
        base_currency: &str,
    ) -> CoreResult<Decimal> {
        if selected <= deployable {
            return Ok(selected);
        }
        if selected - deployable <= currency_minor_unit(base_currency) {
            return Ok(deployable);
        }
        Err(Self::invalid(format!(
            "Tracked cash selected ({selected}) exceeds observed deployable cash ({deployable})"
        )))
    }

    fn bps(value: Decimal, total: Decimal) -> i32 {
        if total <= Decimal::ZERO {
            return 0;
        }
        (value / total * Decimal::from(10_000))
            .round()
            .to_i32()
            .unwrap_or(0)
    }

    fn asset_key(holding: &Holding) -> String {
        holding
            .instrument
            .as_ref()
            .map(|instrument| instrument.id.clone())
            .unwrap_or_else(|| holding.id.clone())
    }

    fn symbol_of(asset: &Asset) -> String {
        asset
            .display_code
            .clone()
            .or_else(|| asset.instrument_symbol.clone())
            .unwrap_or_else(|| asset.id.clone())
    }

    /// The basis every target weight is sized against.
    ///
    /// §4.2 uses `planning_total` without defining it. Cash the worksheet
    /// deploys joins the classified universe once it is spent, so sizing the
    /// sleeves against a total the worksheet itself grows under-sizes every
    /// target and pushes the surplus onto whatever is already overweight.
    ///
    /// With a cash sleeve the tracked cash is already inside `total_value`, so
    /// only the hypothetical contribution widens the basis.
    ///
    /// The prefill and the preview share this denominator on purpose: a
    /// projection computed against a different total would contradict the
    /// prefill that produced it.
    fn planning_total(
        total_value: Decimal,
        tracked_cash_to_use: Decimal,
        external_cash: Decimal,
        has_cash_sleeve: bool,
    ) -> Decimal {
        if has_cash_sleeve {
            total_value + external_cash
        } else {
            total_value + tracked_cash_to_use + external_cash
        }
    }

    // ── Constraints (#1177) ──────────────────────────────────────────────────

    fn action_matches(direction: &WorksheetDirection, action: &ConstraintAction) -> bool {
        matches!(action, ConstraintAction::Trade)
            || matches!(
                (direction, action),
                (WorksheetDirection::Increase, ConstraintAction::Buy)
                    | (WorksheetDirection::Reduce, ConstraintAction::Sell)
            )
    }

    /// Whether a constraint covers the change being considered.
    ///
    /// `account_id` is `None` where the change has no account yet — the prefill
    /// decides a security's eligibility before §6 places it.
    fn constraint_matches(
        constraint: &AllocationTargetConstraint,
        direction: &WorksheetDirection,
        asset_id: &str,
        account_id: Option<&str>,
        category_ids: &[String],
    ) -> bool {
        if !Self::action_matches(direction, &constraint.action) {
            return false;
        }
        match constraint.subject_type {
            ConstraintSubjectType::Asset => constraint.subject_id == asset_id,
            ConstraintSubjectType::Account => {
                account_id.is_some_and(|id| constraint.subject_id == id)
            }
            ConstraintSubjectType::Category => category_ids.contains(&constraint.subject_id),
        }
    }

    /// A blocking constraint is honoured by the prefill so it never produces a
    /// line the preview would reject. `Avoid` only warns, so it is left to the
    /// preview.
    fn is_blocked(
        constraints: &[AllocationTargetConstraint],
        direction: &WorksheetDirection,
        asset_id: &str,
        account_id: Option<&str>,
        category_ids: &[String],
    ) -> bool {
        constraints.iter().any(|constraint| {
            matches!(constraint.effect, ConstraintEffect::Block)
                && Self::constraint_matches(
                    constraint,
                    direction,
                    asset_id,
                    account_id,
                    category_ids,
                )
        })
    }

    // ── Pricing ──────────────────────────────────────────────────────────────

    fn resolve_fx_source(
        from_currency: &str,
        to_currency: &str,
        rates: &[ExchangeRate],
    ) -> CoreResult<(Decimal, Option<WorksheetPricingSource>, Vec<ExchangeRate>)> {
        let normalized_from = normalize_currency_code(from_currency).to_ascii_uppercase();
        let normalized_to = normalize_currency_code(to_currency).to_ascii_uppercase();
        let source_multiplier = if normalized_from.eq_ignore_ascii_case(from_currency) {
            Decimal::ONE
        } else {
            Decimal::ONE / denormalization_multiplier(from_currency)
        };
        let target_multiplier = denormalization_multiplier(to_currency);
        if normalized_from == normalized_to {
            return Ok((source_multiplier * target_multiplier, None, Vec::new()));
        }

        let mut adjacency = HashMap::<String, Vec<(String, Decimal, usize)>>::new();
        for (index, rate) in rates.iter().enumerate() {
            if rate.rate <= Decimal::ZERO {
                continue;
            }
            let from = normalize_currency_code(&rate.from_currency).to_ascii_uppercase();
            let to = normalize_currency_code(&rate.to_currency).to_ascii_uppercase();
            if from == to {
                continue;
            }
            adjacency
                .entry(from.clone())
                .or_default()
                .push((to.clone(), rate.rate, index));
            adjacency
                .entry(to)
                .or_default()
                .push((from, Decimal::ONE / rate.rate, index));
        }
        for edges in adjacency.values_mut() {
            edges.sort_by(|left, right| {
                left.0
                    .cmp(&right.0)
                    .then_with(|| rates[left.2].id.cmp(&rates[right.2].id))
            });
        }

        let mut queue = VecDeque::from([(normalized_from.clone(), Decimal::ONE, Vec::new())]);
        let mut visited = HashSet::from([normalized_from.clone()]);
        let mut resolved = None;
        while let Some((currency, accumulated_rate, path)) = queue.pop_front() {
            if currency == normalized_to {
                resolved = Some((accumulated_rate, path));
                break;
            }
            for (next_currency, edge_rate, rate_index) in
                adjacency.get(&currency).into_iter().flatten()
            {
                if visited.insert(next_currency.clone()) {
                    let mut next_path = path.clone();
                    next_path.push(*rate_index);
                    queue.push_back((
                        next_currency.clone(),
                        accumulated_rate * *edge_rate,
                        next_path,
                    ));
                }
            }
        }

        let (path_rate, path) = resolved.ok_or_else(|| {
            Self::invalid(format!(
                "No attributable FX rate is available for {from_currency}/{to_currency}"
            ))
        })?;
        let used_rates = path
            .into_iter()
            .map(|index| rates[index].clone())
            .collect::<Vec<_>>();
        let applied_rate = source_multiplier * path_rate * target_multiplier;
        let oldest_timestamp = used_rates
            .iter()
            .map(|rate| rate.timestamp)
            .min()
            .ok_or_else(|| Self::invalid("Resolved FX conversion has no source records"))?;
        let is_stale = used_rates
            .iter()
            .any(|rate| rate.timestamp.date_naive() < Utc::now().date_naive());
        let source_id = used_rates
            .iter()
            .map(|rate| rate.id.as_str())
            .collect::<Vec<_>>()
            .join(">");
        Ok((
            applied_rate,
            Some(WorksheetPricingSource {
                id: source_id,
                source_type: if used_rates.len() == 1 {
                    "fx_rate".to_string()
                } else {
                    "fx_path".to_string()
                },
                value: applied_rate,
                from_currency: from_currency.to_string(),
                to_currency: to_currency.to_string(),
                timestamp: oldest_timestamp.to_rfc3339(),
                is_stale,
            }),
            used_rates,
        ))
    }

    /// A unit price in base currency, contract multiplier applied.
    ///
    /// `None` where the preview would refuse to price the line — no snapshot,
    /// no quote, a non-positive close or no attributable FX path — so the
    /// category amount becomes unresolved (§4.4) rather than a line that cannot
    /// be reviewed.
    fn resolved_unit_price(
        asset: &Asset,
        snapshots: &HashMap<String, LatestQuoteSnapshot>,
        base_currency: &str,
        fx_rates: &[ExchangeRate],
    ) -> Option<Decimal> {
        let quote = snapshots.get(&asset.id)?.quote.as_ref()?;
        if quote.close <= Decimal::ZERO {
            return None;
        }
        let (fx_rate, _, _) =
            Self::resolve_fx_source(&quote.currency, base_currency, fx_rates).ok()?;
        let price = quote.close * fx_rate * asset.contract_multiplier();
        (price > Decimal::ZERO).then_some(price)
    }

    // ── Worksheet lines ──────────────────────────────────────────────────────

    fn quote_for_line<'a>(
        line: &AllocationWorksheetLineInput,
        snapshots: &'a HashMap<String, LatestQuoteSnapshot>,
    ) -> CoreResult<(&'a LatestQuoteSnapshot, &'a crate::quotes::Quote)> {
        let snapshot = snapshots.get(&line.asset_id).ok_or_else(|| {
            Self::line_invalid(
                &line.line_id,
                "no quote snapshot is available; refresh the price",
            )
        })?;
        let quote = snapshot.quote.as_ref().ok_or_else(|| {
            let detail = snapshot
                .no_quote_reason
                .as_ref()
                .map(|reason| reason.message.as_str())
                .unwrap_or("refresh or add a manual price");
            Self::line_invalid(&line.line_id, format!("no quote is available; {detail}"))
        })?;
        if quote.close <= Decimal::ZERO {
            return Err(Self::line_invalid(
                &line.line_id,
                "quote must be positive; refresh or correct the price",
            ));
        }
        Ok((snapshot, quote))
    }

    fn resolved_quantity_and_amount(
        line: &AllocationWorksheetLineInput,
        unit_price: Decimal,
        whole_shares_only: bool,
    ) -> CoreResult<(Decimal, Decimal)> {
        if line.value <= Decimal::ZERO {
            return Err(Self::line_invalid(&line.line_id, "value must be positive"));
        }
        if unit_price <= Decimal::ZERO {
            return Err(Self::line_invalid(
                &line.line_id,
                "resolved unit price must be positive",
            ));
        }

        match line.input_mode {
            WorksheetInputMode::Amount => {
                let quantity = if whole_shares_only {
                    (line.value / unit_price).floor()
                } else {
                    line.value / unit_price
                };
                if quantity <= Decimal::ZERO {
                    return Err(Self::line_invalid(
                        &line.line_id,
                        "amount is below one whole unit at the resolved price",
                    ));
                }
                Ok((quantity, quantity * unit_price))
            }
            WorksheetInputMode::Quantity => {
                if whole_shares_only && !line.value.fract().is_zero() {
                    return Err(Self::line_invalid(
                        &line.line_id,
                        "quantity must be a whole number for this target",
                    ));
                }
                Ok((line.value, line.value * unit_price))
            }
        }
    }

    fn category_exposures(
        line: &AllocationWorksheetLineInput,
        amount: Decimal,
        assignments: &[AssetTaxonomyAssignment],
        category_names: &HashMap<String, String>,
    ) -> CoreResult<Vec<WorksheetCategoryExposure>> {
        let total_bps: i32 = assignments.iter().map(|assignment| assignment.weight).sum();
        if total_bps > 10_000 {
            let total_percent = Decimal::from(total_bps) / Decimal::from(100);
            return Err(Self::line_invalid(
                &line.line_id,
                format!(
                    "classification weights total {total_percent}% and cannot exceed 100%; edit the security classification before calculating"
                ),
            ));
        }
        let sign = match line.direction {
            WorksheetDirection::Increase => Decimal::ONE,
            WorksheetDirection::Reduce => -Decimal::ONE,
        };
        let mut exposures = assignments
            .iter()
            .map(|assignment| WorksheetCategoryExposure {
                category_id: assignment.category_id.clone(),
                category_name: category_names
                    .get(&assignment.category_id)
                    .cloned()
                    .unwrap_or_else(|| assignment.category_id.clone()),
                weight_bps: assignment.weight,
                value_delta: sign * amount * Decimal::from(assignment.weight)
                    / Decimal::from(10_000),
                is_unclassified: false,
            })
            .collect::<Vec<_>>();
        if total_bps < 10_000 {
            let residual = 10_000 - total_bps;
            exposures.push(WorksheetCategoryExposure {
                category_id: UNKNOWN_CATEGORY_ID.to_string(),
                category_name: UNKNOWN_CATEGORY_NAME.to_string(),
                weight_bps: residual,
                value_delta: sign * amount * Decimal::from(residual) / Decimal::from(10_000),
                is_unclassified: true,
            });
        }
        Ok(exposures)
    }

    /// Funding left once the worksheet is applied, signed.
    ///
    /// Negative means the edit spends more than the selected cash and the
    /// reduction proceeds. §5 reports that and leaves the numbers as the user
    /// typed them: after prefill the worksheet is the source of truth, so
    /// refusing the calculation would leave the user with no preview of what
    /// they just typed.
    fn cash_remaining(
        tracked_cash: Decimal,
        external_cash: Decimal,
        increase_total: Decimal,
        reduction_total: Decimal,
    ) -> Decimal {
        tracked_cash + external_cash + reduction_total - increase_total
    }

    fn source_fingerprint(
        input: &CalculateAllocationWorksheetInput,
        source_records: &[WorksheetSourceRecord],
    ) -> String {
        let source = serde_json::to_vec(&(input, source_records))
            .expect("worksheet fingerprint inputs are serializable");
        hex::encode(Sha256::digest(source))
    }

    // ── Calculator inputs ────────────────────────────────────────────────────

    /// Every recorded security the calculation can act on, with what it is
    /// worth in each category, what a unit costs and where its units sit.
    async fn build_securities(
        &self,
        contributions: &[HoldingAllocationContribution],
        holdings_by_account: &HashMap<String, Vec<Holding>>,
        constraints: &[AllocationTargetConstraint],
        eligible_asset_ids: Option<&HashSet<String>>,
        base_currency: &str,
    ) -> CoreResult<Vec<SecurityInput>> {
        let mut asset_ids: Vec<String> = contributions
            .iter()
            .filter(|contribution| contribution.holding_type != HoldingType::Cash)
            .map(|contribution| contribution.asset_id.clone())
            .collect();
        asset_ids.sort();
        asset_ids.dedup();

        let assets_by_id = self
            .asset_service
            .get_assets_by_asset_ids(&asset_ids)
            .await?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect::<HashMap<_, _>>();

        Ok(Self::securities_from(
            contributions,
            &assets_by_id,
            &self.quote_service.get_latest_quotes_snapshot(&asset_ids)?,
            &self.fx_service.get_latest_exchange_rates()?,
            holdings_by_account,
            constraints,
            eligible_asset_ids,
            base_currency,
        ))
    }

    /// [`build_securities`](Self::build_securities) once every repository has
    /// answered.
    ///
    /// The classification keeps the unclassified residual, so the projection
    /// spreads an amount exactly as the preview's exposures do. Constraints
    /// only ever look at the classified part of it.
    #[allow(clippy::too_many_arguments)]
    fn securities_from(
        contributions: &[HoldingAllocationContribution],
        assets_by_id: &HashMap<String, Asset>,
        snapshots: &HashMap<String, LatestQuoteSnapshot>,
        fx_rates: &[ExchangeRate],
        holdings_by_account: &HashMap<String, Vec<Holding>>,
        constraints: &[AllocationTargetConstraint],
        eligible_asset_ids: Option<&HashSet<String>>,
        base_currency: &str,
    ) -> Vec<SecurityInput> {
        let mut values_by_asset: HashMap<&str, HashMap<&str, Decimal>> = HashMap::new();
        for contribution in contributions
            .iter()
            .filter(|contribution| contribution.holding_type != HoldingType::Cash)
        {
            *values_by_asset
                .entry(contribution.asset_id.as_str())
                .or_default()
                .entry(contribution.category_id.as_str())
                .or_default() += contribution.value;
        }

        let mut asset_ids: Vec<&str> = values_by_asset.keys().copied().collect();
        asset_ids.sort_unstable();

        let mut quantities_by_asset: HashMap<String, HashMap<String, Decimal>> = HashMap::new();
        for (account_id, holdings) in holdings_by_account {
            for holding in holdings.iter().filter(|holding| {
                holding.holding_type != HoldingType::Cash && holding.quantity > Decimal::ZERO
            }) {
                *quantities_by_asset
                    .entry(Self::asset_key(holding))
                    .or_default()
                    .entry(account_id.clone())
                    .or_default() += holding.quantity;
            }
        }

        let mut securities = Vec::new();
        for asset_id in asset_ids {
            let Some(asset) = assets_by_id.get(asset_id) else {
                continue;
            };
            // The preview refuses a line on anything that is not an active
            // tracked investment, so the prefill must not produce one.
            if !asset.is_active || !asset.kind.is_investment() {
                continue;
            }

            let mut category_values: Vec<(String, Decimal)> = values_by_asset
                .get(asset_id)
                .into_iter()
                .flatten()
                .map(|(category_id, value)| (category_id.to_string(), *value))
                .collect();
            category_values.sort_by(|left, right| left.0.cmp(&right.0));
            let classified: Vec<String> = category_values
                .iter()
                .filter(|(category_id, _)| category_id != UNKNOWN_CATEGORY_ID)
                .map(|(category_id, _)| category_id.clone())
                .collect();

            let mut positions: Vec<PositionInput> = quantities_by_asset
                .get(asset_id)
                .into_iter()
                .flatten()
                .map(|(account_id, quantity)| PositionInput {
                    account_id: account_id.clone(),
                    quantity: *quantity,
                    // Eligibility never restricts a reduction (§4.1); the
                    // do-not-sell and avoid-selling constraints do.
                    can_reduce: !Self::is_blocked(
                        constraints,
                        &WorksheetDirection::Reduce,
                        asset_id,
                        Some(account_id),
                        &classified,
                    ),
                })
                .collect();
            positions.sort_by(|left, right| left.account_id.cmp(&right.account_id));

            securities.push(SecurityInput {
                asset_id: asset_id.to_string(),
                symbol: Self::symbol_of(asset),
                unit_price: Self::resolved_unit_price(asset, snapshots, base_currency, fx_rates),
                is_eligible_for_increase: eligible_asset_ids
                    .is_none_or(|eligible| eligible.contains(asset_id))
                    && !Self::is_blocked(
                        constraints,
                        &WorksheetDirection::Increase,
                        asset_id,
                        None,
                        &classified,
                    ),
                category_values,
                positions,
            });
        }

        securities
    }

    /// The accounts each security may be increased in (§6): in scope, and not
    /// blocked from receiving it. Account type, tax wrapper and contribution
    /// room are never inputs.
    fn eligible_accounts(
        securities: &[SecurityInput],
        account_ids: &[String],
        constraints: &[AllocationTargetConstraint],
    ) -> HashMap<String, Vec<String>> {
        securities
            .iter()
            .map(|security| {
                let classified: Vec<String> = security
                    .category_values
                    .iter()
                    .filter(|(category_id, _)| category_id != UNKNOWN_CATEGORY_ID)
                    .map(|(category_id, _)| category_id.clone())
                    .collect();
                let accounts = account_ids
                    .iter()
                    .filter(|account_id| {
                        !Self::is_blocked(
                            constraints,
                            &WorksheetDirection::Increase,
                            &security.asset_id,
                            Some(account_id),
                            &classified,
                        )
                    })
                    .cloned()
                    .collect();
                (security.asset_id.clone(), accounts)
            })
            .collect()
    }
}

#[async_trait]
impl AllocationWorksheetServiceTrait for AllocationWorksheetService {
    async fn generate_adjustments(
        &self,
        input: GenerateCalculatedAdjustmentsInput,
    ) -> CoreResult<CalculatedAdjustments> {
        if input.cash.tracked_cash_to_use < Decimal::ZERO
            || input
                .cash
                .external_contribution
                .values()
                .any(|amount| *amount < Decimal::ZERO)
        {
            return Err(Self::invalid("Worksheet cash values must be non-negative"));
        }
        for account_id in input.cash.external_contribution.keys() {
            if !input.account_ids.contains(account_id) {
                return Err(Self::invalid(format!(
                    "External contribution for account {account_id} is outside the resolved scope"
                )));
            }
        }

        let target = self
            .allocation_target_service
            .get_target(&input.target_id)?
            .ok_or_else(|| {
                CoreError::Database(DatabaseError::NotFound(format!(
                    "AllocationTarget {} not found",
                    input.target_id
                )))
            })?;
        if input.mode == WorksheetMode::Rebalance && !target.allow_sells {
            return Err(Self::invalid(
                "This target disables reductions; enable them before rebalancing",
            ));
        }

        let drift = self
            .drift_service
            .get_drift_report_for_target(
                &input.target_id,
                &input.account_ids,
                &input.base_currency,
                &input.aggregated_account_id,
            )
            .await?;

        let tracked_cash_to_use = Self::tracked_cash_to_use(
            input.cash.tracked_cash_to_use,
            drift.deployable_cash,
            &input.base_currency,
        )?;

        let contributions = self
            .allocation_service
            .get_holding_contributions_for_taxonomy_for_accounts(
                &input.account_ids,
                &input.base_currency,
                &target.taxonomy_id,
                &input.aggregated_account_id,
            )
            .await?;

        let mut holdings_by_account = HashMap::<String, Vec<Holding>>::new();
        for account_id in &input.account_ids {
            holdings_by_account.insert(
                account_id.clone(),
                self.holdings_service
                    .get_holdings(account_id, &input.base_currency)
                    .await?,
            );
        }

        let constraints = self
            .allocation_target_service
            .list_target_constraints(&input.target_id)?;

        // An empty allowlist is a valid state, not an error (§4.1): every
        // increase it leaves unplaced becomes an unresolved category amount.
        let eligible_asset_ids = input
            .eligible_asset_ids
            .as_ref()
            .map(|ids| ids.iter().cloned().collect::<HashSet<_>>());
        let securities = self
            .build_securities(
                &contributions.contributions,
                &holdings_by_account,
                &constraints,
                eligible_asset_ids.as_ref(),
                &input.base_currency,
            )
            .await?;

        let categories: Vec<CategoryTarget> = drift
            .rows
            .iter()
            .map(|row| CategoryTarget {
                category_id: row.category_id.clone(),
                category_name: row.category_name.clone(),
                target_bps: row.target_bps,
                current_value: row.current_value,
                is_cash: row.is_cash,
            })
            .collect();

        let external_total = input.cash.external_total();
        let planning_total = Self::planning_total(
            drift.total_value,
            tracked_cash_to_use,
            external_total,
            has_deployable_cash_categories(&target.taxonomy_id),
        );

        let sequence = run_sequence(&SequenceInput {
            mode: input.mode.clone(),
            categories: &categories,
            securities: &securities,
            planning_total,
            cash: tracked_cash_to_use,
            external_cash: &input.cash.external_contribution,
            cash_category_id: drift
                .rows
                .iter()
                .find(|row| row.is_cash)
                .map(|row| row.category_id.clone()),
        });

        let min_line_amount = Decimal::from_str(&target.min_trade_amount)
            .unwrap_or(Decimal::ZERO)
            .max(Decimal::ZERO);
        let limited = apply_limits(
            sequence.increases,
            sequence.reductions,
            &securities,
            &LimitsInput {
                tracked_cash: tracked_cash_to_use,
                external_cash: input.cash.external_contribution.clone(),
                turnover_cap: turnover_cap_value(planning_total, target.max_turnover_bps),
                min_line_amount,
                whole_shares_only: target.whole_shares_only,
            },
        );

        let assigned = assign_accounts(
            &limited.lines,
            &securities,
            &Self::eligible_accounts(&securities, &input.account_ids, &constraints),
            target.whole_shares_only,
            min_line_amount,
        );

        // Recorded cash, per account. What the user selected caps the total the
        // limits will spend; this check only answers whether the cash is in the
        // account the increase was placed in (§6).
        let cash_by_account: HashMap<String, Decimal> = holdings_by_account
            .iter()
            .map(|(account_id, holdings)| (account_id.clone(), tracked_cash(holdings)))
            .collect();
        let funding_shortfalls = account_funding_shortfalls(
            &assigned,
            &cash_by_account,
            &input.cash.external_contribution,
        );
        let remaining = remaining_cash(&assigned, tracked_cash_to_use, external_total);

        let symbols: HashMap<&str, &str> = securities
            .iter()
            .map(|security| (security.asset_id.as_str(), security.symbol.as_str()))
            .collect();

        Ok(CalculatedAdjustments {
            mode: input.mode,
            rule: input.rule,
            adjustments: assigned
                .into_iter()
                .map(|line| CalculatedAdjustment {
                    line_id: format!(
                        "calc:{}:{}",
                        line.asset_id,
                        line.account_id.as_deref().unwrap_or("unassigned")
                    ),
                    direction: if line.amount < Decimal::ZERO {
                        WorksheetDirection::Reduce
                    } else {
                        WorksheetDirection::Increase
                    },
                    symbol: symbols
                        .get(line.asset_id.as_str())
                        .map(|symbol| symbol.to_string())
                        .unwrap_or_else(|| line.asset_id.clone()),
                    asset_id: line.asset_id,
                    account_id: line.account_id,
                    amount: line.amount,
                    quantity: line.quantity,
                    unit_price: line.unit_price,
                    is_below_minimum: line.is_below_minimum,
                })
                .collect(),
            unresolved: sequence.unresolved,
            scaling: limited.scaling,
            remaining_cash: remaining,
            funding_shortfalls,
        })
    }

    async fn calculate_worksheet(
        &self,
        input: CalculateAllocationWorksheetInput,
    ) -> CoreResult<AllocationWorksheetResult> {
        if input.lines.is_empty() || input.lines.len() > 50 {
            return Err(Self::invalid(
                "Worksheet must contain between 1 and 50 lines",
            ));
        }
        if input.cash.tracked_cash_to_use < Decimal::ZERO
            || input
                .cash
                .external_contribution
                .values()
                .any(|amount| *amount < Decimal::ZERO)
        {
            return Err(Self::invalid("Worksheet cash values must be non-negative"));
        }
        let mut line_ids = HashSet::new();
        for line in &input.lines {
            if line.line_id.trim().is_empty() || !line_ids.insert(line.line_id.as_str()) {
                return Err(Self::invalid(
                    "Every worksheet line must have a unique lineId",
                ));
            }
            if !input.account_ids.contains(&line.account_id) {
                return Err(Self::line_invalid(
                    &line.line_id,
                    "selected account is outside the resolved scope",
                ));
            }
        }
        for account_id in input.cash.external_contribution.keys() {
            if !input.account_ids.contains(account_id) {
                return Err(Self::invalid(format!(
                    "External contribution for account {account_id} is outside the resolved scope"
                )));
            }
        }

        let target = self
            .allocation_target_service
            .get_target(&input.target_id)?
            .ok_or_else(|| {
                CoreError::Database(DatabaseError::NotFound(format!(
                    "AllocationTarget {} not found",
                    input.target_id
                )))
            })?;
        if !target.allow_sells
            && input
                .lines
                .iter()
                .any(|line| matches!(line.direction, WorksheetDirection::Reduce))
        {
            return Err(Self::invalid(
                "This target disables reductions; enable reduction rows in worksheet guardrails",
            ));
        }

        let drift = self
            .drift_service
            .get_drift_report_for_target(
                &input.target_id,
                &input.account_ids,
                &input.base_currency,
                &input.aggregated_account_id,
            )
            .await?;
        let tracked_cash_to_use = Self::tracked_cash_to_use(
            input.cash.tracked_cash_to_use,
            drift.deployable_cash,
            &input.base_currency,
        )?;

        let asset_ids = input
            .lines
            .iter()
            .map(|line| line.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let assets = self
            .asset_service
            .get_assets_by_asset_ids(&asset_ids)
            .await?;
        let assets_by_id = assets
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect::<HashMap<_, _>>();
        let quote_snapshots = self.quote_service.get_latest_quotes_snapshot(&asset_ids)?;
        let assignments = self
            .taxonomy_service
            .get_asset_assignments_for_assets(&asset_ids)?;
        let assignments_by_asset = assignments
            .iter()
            .filter(|assignment| assignment.taxonomy_id == target.taxonomy_id)
            .cloned()
            .fold(HashMap::<String, Vec<_>>::new(), |mut map, assignment| {
                map.entry(assignment.asset_id.clone())
                    .or_default()
                    .push(assignment);
                map
            });
        let taxonomy = self
            .taxonomy_service
            .get_taxonomy(&target.taxonomy_id)?
            .ok_or_else(|| Self::invalid("Target taxonomy no longer exists"))?;
        let category_names = taxonomy
            .categories
            .iter()
            .map(|category| (category.id.clone(), category.name.clone()))
            .collect::<HashMap<_, _>>();
        let mut category_order = taxonomy.categories.clone();
        category_order.sort_by_key(|category| category.sort_order);
        let fx_rates = self.fx_service.get_latest_exchange_rates()?;
        let constraints = self
            .allocation_target_service
            .list_target_constraints(&input.target_id)?;

        let mut holdings_by_account = HashMap::<String, Vec<Holding>>::new();
        for account_id in &input.account_ids {
            holdings_by_account.insert(
                account_id.to_string(),
                self.holdings_service
                    .get_holdings(account_id, &input.base_currency)
                    .await?,
            );
        }

        let external_total = input.cash.external_total();
        let mut warnings = Vec::new();
        if external_total > Decimal::ZERO {
            warnings.push(Self::warning(
                WorksheetWarningKind::ExternalContribution,
                None,
                "external-cash",
                format!("Includes {external_total} of hypothetical cash not currently recorded."),
            ));
        }

        let min_line_amount = Decimal::from_str(&target.min_trade_amount)
            .unwrap_or(Decimal::ZERO)
            .max(Decimal::ZERO);
        let mut results = Vec::with_capacity(input.lines.len());
        let mut reduction_qty_by_position = HashMap::<(String, String), Decimal>::new();
        let mut used_fx_rates = HashMap::<String, ExchangeRate>::new();

        for line in &input.lines {
            let asset: &Asset = assets_by_id.get(&line.asset_id).ok_or_else(|| {
                Self::line_invalid(&line.line_id, "selected tracked security no longer exists")
            })?;
            if !asset.is_active || !asset.kind.is_investment() {
                return Err(Self::line_invalid(
                    &line.line_id,
                    "selected asset is not an active tracked investment security",
                ));
            }
            let (snapshot, quote) = Self::quote_for_line(line, &quote_snapshots)?;
            let (fx_rate, fx_source, line_fx_rates) = Self::resolve_fx_source(
                quote.currency.as_str(),
                input.base_currency.as_str(),
                &fx_rates,
            )?;
            for rate in line_fx_rates {
                used_fx_rates.insert(rate.id.clone(), rate);
            }
            let multiplier = asset.contract_multiplier();
            let unit_price = quote.close * fx_rate * multiplier;
            let (quantity, amount) =
                Self::resolved_quantity_and_amount(line, unit_price, target.whole_shares_only)?;
            let line_assignments = assignments_by_asset
                .get(&line.asset_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let exposures =
                Self::category_exposures(line, amount, line_assignments, &category_names)?;

            if matches!(line.direction, WorksheetDirection::Reduce) {
                let owned = holdings_by_account
                    .get(&line.account_id)
                    .into_iter()
                    .flatten()
                    .filter(|holding| {
                        holding.holding_type != HoldingType::Cash
                            && Self::asset_key(holding) == line.asset_id
                    })
                    .map(|holding| holding.quantity)
                    .sum::<Decimal>();
                let key = (line.account_id.clone(), line.asset_id.clone());
                let reduced = reduction_qty_by_position.entry(key).or_default();
                *reduced += quantity;
                if *reduced > owned {
                    return Err(Self::line_invalid(
                        &line.line_id,
                        format!(
                            "reduction exceeds the {owned} units currently held in this account"
                        ),
                    ));
                }
            }

            let exposed_categories = exposures
                .iter()
                .map(|exposure| exposure.category_id.clone())
                .collect::<Vec<_>>();
            for constraint in constraints.iter().filter(|constraint| {
                Self::constraint_matches(
                    constraint,
                    &line.direction,
                    &line.asset_id,
                    Some(&line.account_id),
                    &exposed_categories,
                )
            }) {
                match constraint.effect {
                    ConstraintEffect::Block => {
                        return Err(Self::line_invalid(
                            &line.line_id,
                            format!(
                                "blocked by your worksheet constraint{}",
                                constraint
                                    .reason
                                    .as_deref()
                                    .map(|reason| format!(": {reason}"))
                                    .unwrap_or_default()
                            ),
                        ));
                    }
                    ConstraintEffect::Avoid => warnings.push(Self::warning(
                        WorksheetWarningKind::AvoidConstraint,
                        Some(&line.line_id),
                        &constraint.id,
                        format!(
                            "This line conflicts with your Avoid constraint{}.",
                            constraint
                                .reason
                                .as_deref()
                                .map(|reason| format!(" ({reason})"))
                                .unwrap_or_default()
                        ),
                    )),
                }
            }
            if snapshot.is_stale {
                warnings.push(Self::warning(
                    WorksheetWarningKind::StaleQuote,
                    Some(&line.line_id),
                    &quote.id,
                    format!(
                        "Uses a dated security price from {}.",
                        quote.timestamp.date_naive()
                    ),
                ));
            }
            if let Some(fx) = fx_source.as_ref().filter(|source| source.is_stale) {
                warnings.push(Self::warning(
                    WorksheetWarningKind::StaleFx,
                    Some(&line.line_id),
                    &fx.id,
                    format!("Uses a dated FX rate from {}.", fx.timestamp),
                ));
            }
            let classified_bps: i32 = line_assignments.iter().map(|item| item.weight).sum();
            if classified_bps == 0 {
                warnings.push(Self::warning(
                    WorksheetWarningKind::UnclassifiedAsset,
                    Some(&line.line_id),
                    &line.asset_id,
                    "The security is unclassified; its full value is shown as unclassified exposure."
                        .to_string(),
                ));
            } else if classified_bps < 10_000 {
                warnings.push(Self::warning(
                    WorksheetWarningKind::PartialClassification,
                    Some(&line.line_id),
                    &line.asset_id,
                    format!(
                        "The security is classified for {classified_bps} bps; the remaining {} bps is shown as unclassified exposure.",
                        10_000 - classified_bps
                    ),
                ));
            }
            if min_line_amount > Decimal::ZERO && amount < min_line_amount {
                warnings.push(Self::warning(
                    WorksheetWarningKind::BelowMinimumLine,
                    Some(&line.line_id),
                    "minimum-line",
                    format!(
                        "Resolved amount {amount} is below your worksheet minimum of {min_line_amount}."
                    ),
                ));
            }

            results.push(AllocationWorksheetLineResult {
                line_id: line.line_id.clone(),
                direction: line.direction.clone(),
                asset_id: line.asset_id.clone(),
                account_id: line.account_id.clone(),
                symbol: Self::symbol_of(asset),
                name: asset.name.clone().unwrap_or_default(),
                input_mode: line.input_mode.clone(),
                input_value: line.value,
                quantity,
                unit_price,
                estimated_amount: amount,
                contract_multiplier: multiplier,
                quote_source: WorksheetPricingSource {
                    id: quote.id.clone(),
                    source_type: "security_quote".to_string(),
                    value: quote.close,
                    from_currency: quote.currency.clone(),
                    to_currency: quote.currency.clone(),
                    timestamp: quote.timestamp.to_rfc3339(),
                    is_stale: snapshot.is_stale,
                },
                fx_source,
                category_exposures: exposures,
            });
        }

        let increase_total = results
            .iter()
            .filter(|line| matches!(line.direction, WorksheetDirection::Increase))
            .map(|line| line.estimated_amount)
            .sum::<Decimal>();
        let reduction_total = results
            .iter()
            .filter(|line| matches!(line.direction, WorksheetDirection::Reduce))
            .map(|line| line.estimated_amount)
            .sum::<Decimal>();

        // §5 — an edit that spends more than the funding available is reported
        // and left alone. The worksheet is the source of truth once prefilled,
        // so nothing here rounds the numbers back into the budget.
        let funding = tracked_cash_to_use + external_total + reduction_total;
        let cash_remaining = Self::cash_remaining(
            tracked_cash_to_use,
            external_total,
            increase_total,
            reduction_total,
        );
        if cash_remaining < Decimal::ZERO {
            warnings.push(Self::warning(
                WorksheetWarningKind::InsufficientFunding,
                None,
                "funding",
                format!(
                    "Increases of {increase_total} exceed the {funding} of selected cash and reduction proceeds."
                ),
            ));
        }

        // §6 — and separately, cash recorded in one account cannot fund an
        // increase in another. Same check the prefill runs.
        let assigned = results
            .iter()
            .map(|line| AssignedLine {
                asset_id: line.asset_id.clone(),
                account_id: Some(line.account_id.clone()),
                amount: match line.direction {
                    WorksheetDirection::Increase => line.estimated_amount,
                    WorksheetDirection::Reduce => -line.estimated_amount,
                },
                quantity: line.quantity,
                unit_price: line.unit_price,
                is_below_minimum: min_line_amount > Decimal::ZERO
                    && line.estimated_amount < min_line_amount,
            })
            .collect::<Vec<_>>();
        let cash_by_account = holdings_by_account
            .iter()
            .map(|(account_id, holdings)| (account_id.clone(), tracked_cash(holdings)))
            .collect::<HashMap<_, _>>();
        for shortfall in account_funding_shortfalls(
            &assigned,
            &cash_by_account,
            &input.cash.external_contribution,
        ) {
            warnings.push(Self::warning(
                WorksheetWarningKind::AccountFunding,
                None,
                &shortfall.account_id,
                format!(
                    "Increases of {} in this account exceed the {} it can fund on its own; no transfer between accounts is assumed.",
                    shortfall.required, shortfall.available
                ),
            ));
        }

        let planning_total = Self::planning_total(
            drift.total_value,
            tracked_cash_to_use,
            external_total,
            has_deployable_cash_categories(&target.taxonomy_id),
        );

        if let Some(max_turnover_bps) = target.max_turnover_bps {
            let turnover_bps = Self::bps(reduction_total, planning_total);
            if turnover_bps > max_turnover_bps {
                warnings.push(Self::warning(
                    WorksheetWarningKind::TurnoverExceeded,
                    None,
                    "turnover",
                    format!(
                        "Reductions equal {turnover_bps} bps of current value, above your {max_turnover_bps} bps worksheet guardrail."
                    ),
                ));
            }
        }

        let weights = self
            .allocation_target_service
            .list_weights_for_target(&input.target_id)?;
        let target_bps_by_category = weights
            .iter()
            .map(|weight| (weight.category_id.clone(), weight.target_bps))
            .collect::<HashMap<_, _>>();
        let mut current_values = drift
            .rows
            .iter()
            .map(|row| (row.category_id.clone(), row.current_value))
            .collect::<HashMap<_, _>>();
        let mut projected_values = current_values.clone();
        for line in &results {
            for exposure in &line.category_exposures {
                *projected_values
                    .entry(exposure.category_id.clone())
                    .or_default() += exposure.value_delta;
            }
        }
        // The cash sleeve is what the worksheet spends out of and pays back
        // into. It can end up negative, and that is left standing: the funding
        // warning above already says why.
        if let Some(cash_category_id) = drift
            .rows
            .iter()
            .find(|row| row.is_cash)
            .map(|row| row.category_id.clone())
        {
            *projected_values.entry(cash_category_id).or_default() +=
                external_total - increase_total + reduction_total;
        }

        let mut ordered_ids = category_order
            .iter()
            .map(|category| category.id.clone())
            .collect::<Vec<_>>();
        for category_id in current_values
            .keys()
            .chain(projected_values.keys())
            .chain(target_bps_by_category.keys())
        {
            if !ordered_ids.contains(category_id) {
                ordered_ids.push(category_id.clone());
            }
        }
        if ordered_ids.contains(&UNKNOWN_CATEGORY_ID.to_string()) {
            ordered_ids.retain(|id| id != UNKNOWN_CATEGORY_ID);
            ordered_ids.push(UNKNOWN_CATEGORY_ID.to_string());
        }
        let drift_by_id = drift
            .rows
            .iter()
            .map(|row| (row.category_id.as_str(), row))
            .collect::<HashMap<_, _>>();
        let mut categories = Vec::new();
        for category_id in ordered_ids {
            let current_value = current_values.remove(&category_id).unwrap_or_default();
            let projected_value = projected_values.remove(&category_id).unwrap_or_default();
            let target_bps = target_bps_by_category
                .get(&category_id)
                .copied()
                .unwrap_or(0);
            if current_value == Decimal::ZERO
                && projected_value == Decimal::ZERO
                && !target_bps_by_category.contains_key(&category_id)
            {
                continue;
            }
            let current_bps = Self::bps(current_value, drift.total_value);
            let projected_bps = Self::bps(projected_value, planning_total);
            let drift_row = drift_by_id.get(category_id.as_str()).copied();
            categories.push(WorksheetCategoryResult {
                category_id: category_id.clone(),
                category_name: if category_id == UNKNOWN_CATEGORY_ID {
                    UNKNOWN_CATEGORY_NAME.to_string()
                } else {
                    category_names
                        .get(&category_id)
                        .cloned()
                        .or_else(|| drift_row.map(|row| row.category_name.clone()))
                        .unwrap_or_else(|| category_id.clone())
                },
                color: drift_row
                    .map(|row| row.color.clone())
                    .unwrap_or_else(|| "#94a3b8".to_string()),
                target_bps,
                current_value,
                projected_value,
                current_bps,
                projected_bps,
                current_difference_bps: current_bps - target_bps,
                projected_difference_bps: projected_bps - target_bps,
                is_cash: drift_row.map(|row| row.is_cash).unwrap_or(false),
                is_unclassified: category_id == UNKNOWN_CATEGORY_ID,
            });
        }

        let target_ids = target_bps_by_category.keys().collect::<HashSet<_>>();
        let max_difference_bps_before = categories
            .iter()
            .filter(|category| target_ids.contains(&category.category_id))
            .map(|category| category.current_difference_bps.unsigned_abs() as i32)
            .max()
            .unwrap_or(0);
        let max_difference_bps_after = categories
            .iter()
            .filter(|category| target_ids.contains(&category.category_id))
            .map(|category| category.projected_difference_bps.unsigned_abs() as i32)
            .max()
            .unwrap_or(0);

        let mut source_asset_ids = asset_ids.clone();
        for holding in holdings_by_account.values().flatten() {
            if holding.holding_type != HoldingType::Cash {
                source_asset_ids.push(Self::asset_key(holding));
            }
        }
        source_asset_ids.sort();
        source_asset_ids.dedup();
        let source_assignments = self
            .taxonomy_service
            .get_asset_assignments_for_assets(&source_asset_ids)?;
        let source_quotes = self
            .quote_service
            .get_latest_quotes_snapshot(&source_asset_ids)?;
        let mut source_records = vec![WorksheetSourceRecord {
            source_type: "allocation_target".to_string(),
            id: target.id.clone(),
            version: target.updated_at.clone(),
            details: format!(
                "taxonomy={};band={:?}/{};relative={};reductions={};whole_shares={};minimum={};turnover={:?}",
                target.taxonomy_id,
                target.band_type,
                target.drift_band_bps,
                target.relative_factor_bps,
                target.allow_sells,
                target.whole_shares_only,
                target.min_trade_amount,
                target.max_turnover_bps,
            ),
        }];
        source_records.push(WorksheetSourceRecord {
            source_type: "taxonomy".to_string(),
            id: taxonomy.taxonomy.id.clone(),
            version: taxonomy.taxonomy.updated_at.and_utc().to_rfc3339(),
            details: format!(
                "name={};scope={}",
                taxonomy.taxonomy.name, taxonomy.taxonomy.scope
            ),
        });
        for weight in &weights {
            source_records.push(WorksheetSourceRecord {
                source_type: "target_weight".to_string(),
                id: weight.id.clone(),
                version: weight.updated_at.clone(),
                details: format!(
                    "category={};bps={};required={};locked={}",
                    weight.category_id, weight.target_bps, weight.is_required, weight.is_locked
                ),
            });
        }
        for category in &taxonomy.categories {
            source_records.push(WorksheetSourceRecord {
                source_type: "taxonomy_category".to_string(),
                id: category.id.clone(),
                version: category.updated_at.and_utc().to_rfc3339(),
                details: format!(
                    "name={};parent={:?};order={};color={}",
                    category.name, category.parent_id, category.sort_order, category.color
                ),
            });
        }
        for asset in assets_by_id.values() {
            source_records.push(WorksheetSourceRecord {
                source_type: "asset".to_string(),
                id: asset.id.clone(),
                version: asset.updated_at.and_utc().to_rfc3339(),
                details: format!(
                    "active={};kind={:?};currency={};multiplier={}",
                    asset.is_active,
                    asset.kind,
                    asset.quote_ccy,
                    asset.contract_multiplier()
                ),
            });
        }
        for holding in holdings_by_account.values().flatten() {
            source_records.push(WorksheetSourceRecord {
                source_type: "holding".to_string(),
                id: holding.id.clone(),
                version: holding.as_of_date.to_string(),
                details: format!(
                    "account={};asset={};quantity={};value={};price={:?}",
                    holding.account_id,
                    Self::asset_key(holding),
                    holding.quantity,
                    holding.market_value.base,
                    holding.price
                ),
            });
        }
        for assignment in source_assignments
            .iter()
            .filter(|assignment| assignment.taxonomy_id == target.taxonomy_id)
        {
            source_records.push(WorksheetSourceRecord {
                source_type: "classification".to_string(),
                id: assignment.id.clone(),
                version: assignment.updated_at.and_utc().to_rfc3339(),
                details: format!(
                    "asset={};category={};bps={};source={}",
                    assignment.asset_id,
                    assignment.category_id,
                    assignment.weight,
                    assignment.source
                ),
            });
        }
        for constraint in &constraints {
            source_records.push(WorksheetSourceRecord {
                source_type: "constraint".to_string(),
                id: constraint.id.clone(),
                version: constraint.updated_at.clone(),
                details: format!(
                    "subject={}:{};action={};effect={}",
                    constraint.subject_type.as_str(),
                    constraint.subject_id,
                    constraint.action.as_str(),
                    constraint.effect.as_str()
                ),
            });
        }
        for (asset_id, snapshot) in source_quotes {
            if let Some(quote) = snapshot.quote {
                source_records.push(WorksheetSourceRecord {
                    source_type: "security_quote".to_string(),
                    id: quote.id,
                    version: quote.timestamp.to_rfc3339(),
                    details: format!(
                        "asset={};close={};currency={};source={}",
                        asset_id, quote.close, quote.currency, quote.data_source
                    ),
                });
            }
        }
        for rate in used_fx_rates.values() {
            source_records.push(WorksheetSourceRecord {
                source_type: "fx_rate".to_string(),
                id: rate.id.clone(),
                version: rate.timestamp.to_rfc3339(),
                details: format!(
                    "pair={}/{};rate={};source={}",
                    rate.from_currency, rate.to_currency, rate.rate, rate.source
                ),
            });
        }
        for row in &drift.rows {
            source_records.push(WorksheetSourceRecord {
                source_type: "drift_row".to_string(),
                id: row.category_id.clone(),
                version: "derived".to_string(),
                details: format!(
                    "current_value={};current_bps={};target_bps={};cash={}",
                    row.current_value, row.current_bps, row.target_bps, row.is_cash
                ),
            });
        }
        source_records.sort_by(|left, right| {
            left.source_type
                .cmp(&right.source_type)
                .then_with(|| left.id.cmp(&right.id))
                .then_with(|| left.version.cmp(&right.version))
                .then_with(|| left.details.cmp(&right.details))
        });
        source_records.dedup_by(|left, right| {
            left.source_type == right.source_type
                && left.id == right.id
                && left.version == right.version
                && left.details == right.details
        });
        warnings.sort_by(|a, b| a.id.cmp(&b.id));
        warnings.dedup_by(|a, b| a.id == b.id);
        let source_fingerprint = Self::source_fingerprint(&input, &source_records);

        Ok(AllocationWorksheetResult {
            target_id: target.id,
            target_name: target.name,
            base_currency: input.base_currency,
            calculated_at: Utc::now().to_rfc3339(),
            source_fingerprint,
            resolved_account_ids: input.account_ids,
            observed_tracked_cash: drift.deployable_cash,
            tracked_cash_to_use,
            external_contribution: external_total,
            increase_total,
            reduction_total,
            cash_remaining,
            max_difference_bps_before,
            max_difference_bps_after,
            lines: results,
            categories,
            warnings,
            source_records,
        })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// The calculation itself is covered in `worksheet_calculator`, which is pure by
// design. What is left here is the resolution of its inputs: who may be
// increased, who may be reduced, what a unit costs and what the weights are
// sized against.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::AssetKind;
    use crate::portfolio::allocation_targets::WorksheetCashInput;
    use crate::portfolio::holdings::{Instrument, MonetaryValue};
    use crate::quotes::Quote;
    use rust_decimal_macros::dec;

    fn asset(id: &str) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Investment,
            display_code: Some(id.to_ascii_uppercase()),
            is_active: true,
            quote_ccy: "USD".to_string(),
            ..Default::default()
        }
    }

    fn assets(ids: &[&str]) -> HashMap<String, Asset> {
        ids.iter().map(|id| (id.to_string(), asset(id))).collect()
    }

    fn contribution(
        asset_id: &str,
        category_id: &str,
        value: Decimal,
    ) -> HoldingAllocationContribution {
        HoldingAllocationContribution {
            id: format!("{asset_id}:{category_id}"),
            holding_id: format!("holding-{asset_id}"),
            asset_id: asset_id.to_string(),
            account_id: "acc-1".to_string(),
            source_account_ids: vec![],
            symbol: asset_id.to_ascii_uppercase(),
            name: asset_id.to_string(),
            holding_type: HoldingType::Security,
            quantity: Decimal::ONE,
            category_id: category_id.to_string(),
            category_name: category_id.to_string(),
            category_color: "#aaa".to_string(),
            value,
        }
    }

    fn holding(asset_id: &str, account_id: &str, quantity: Decimal) -> Holding {
        Holding {
            id: format!("{account_id}-{asset_id}"),
            account_id: account_id.to_string(),
            holding_type: HoldingType::Security,
            is_closed: false,
            instrument: Some(Instrument {
                id: asset_id.to_string(),
                symbol: asset_id.to_ascii_uppercase(),
                name: None,
                currency: "USD".to_string(),
                notes: None,
                pricing_mode: "auto".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                instrument_type: None,
                classifications: None,
            }),
            asset_kind: None,
            quantity,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate: None,
            market_value: MonetaryValue {
                local: quantity,
                base: quantity,
            },
            cost_basis: None,
            price: None,
            purchase_price: None,
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Decimal::ZERO,
            as_of_date: chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            metadata: None,
            source_account_ids: vec![],
        }
    }

    fn snapshot(asset_id: &str, close: Decimal, currency: &str) -> LatestQuoteSnapshot {
        LatestQuoteSnapshot {
            quote: Some(Quote {
                id: format!("quote-{asset_id}"),
                asset_id: asset_id.to_string(),
                timestamp: Utc::now(),
                close,
                currency: currency.to_string(),
                data_source: "manual".to_string(),
                ..Default::default()
            }),
            is_stale: false,
            effective_market_date: "2026-01-01".to_string(),
            quote_date: Some("2026-01-01".to_string()),
            no_quote_reason: None,
        }
    }

    fn constraint(
        subject_type: ConstraintSubjectType,
        subject_id: &str,
        action: ConstraintAction,
        effect: ConstraintEffect,
    ) -> AllocationTargetConstraint {
        AllocationTargetConstraint {
            id: format!("constraint-{subject_id}"),
            target_id: "target-1".to_string(),
            subject_type,
            subject_id: subject_id.to_string(),
            action,
            effect,
            reason: None,
            metadata_json: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    /// One security worth 1000 of equity, 10 units of it in `acc-1`, priced at
    /// 100 in the base currency.
    fn securities(
        constraints: &[AllocationTargetConstraint],
        eligible: Option<&HashSet<String>>,
    ) -> Vec<SecurityInput> {
        AllocationWorksheetService::securities_from(
            &[contribution("vti", "EQUITY", dec!(1000))],
            &assets(&["vti"]),
            &HashMap::from([("vti".to_string(), snapshot("vti", dec!(100), "USD"))]),
            &[],
            &HashMap::from([("acc-1".to_string(), vec![holding("vti", "acc-1", dec!(10))])]),
            constraints,
            eligible,
            "USD",
        )
    }

    #[test]
    fn the_prefill_and_the_preview_are_sized_against_the_same_total() {
        // With a cash sleeve the tracked cash is already counted; without one,
        // deploying it grows the classified universe.
        assert_eq!(
            AllocationWorksheetService::planning_total(dec!(1000), dec!(200), dec!(100), true),
            dec!(1100)
        );
        assert_eq!(
            AllocationWorksheetService::planning_total(dec!(1000), dec!(200), dec!(100), false),
            dec!(1300)
        );
    }

    #[test]
    fn selecting_no_eligible_security_is_a_valid_state() {
        // §4.1 — the increases that cannot be placed become unresolved category
        // amounts. It is not a validation error, which is what `main` makes it.
        let securities = securities(&[], Some(&HashSet::new()));

        assert_eq!(securities.len(), 1);
        assert!(!securities[0].is_eligible_for_increase);
    }

    #[test]
    fn eligibility_gates_increases_and_never_reductions() {
        let securities = securities(&[], Some(&HashSet::from(["other".to_string()])));

        assert!(!securities[0].is_eligible_for_increase);
        assert!(
            securities[0]
                .positions
                .iter()
                .all(|position| position.can_reduce),
            "an excluded security can still be sold: not adding to it is a different intent"
        );
    }

    #[test]
    fn no_allowlist_means_every_recorded_security() {
        assert!(securities(&[], None)[0].is_eligible_for_increase);
    }

    #[test]
    fn a_do_not_sell_constraint_protects_the_position_it_covers() {
        let blocked = securities(
            &[constraint(
                ConstraintSubjectType::Asset,
                "vti",
                ConstraintAction::Sell,
                ConstraintEffect::Block,
            )],
            None,
        );

        assert!(blocked[0]
            .positions
            .iter()
            .all(|position| !position.can_reduce));
        assert!(
            blocked[0].is_eligible_for_increase,
            "a do-not-sell constraint says nothing about buying"
        );
    }

    #[test]
    fn an_avoid_constraint_leaves_the_prefill_alone() {
        // Avoid warns on the reviewed worksheet; only Block keeps a line from
        // being produced in the first place.
        let securities = securities(
            &[constraint(
                ConstraintSubjectType::Asset,
                "vti",
                ConstraintAction::Trade,
                ConstraintEffect::Avoid,
            )],
            None,
        );

        assert!(securities[0].is_eligible_for_increase);
        assert!(securities[0]
            .positions
            .iter()
            .all(|position| position.can_reduce));
    }

    #[test]
    fn a_category_constraint_covers_the_securities_that_carry_it() {
        let securities = securities(
            &[constraint(
                ConstraintSubjectType::Category,
                "EQUITY",
                ConstraintAction::Buy,
                ConstraintEffect::Block,
            )],
            None,
        );

        assert!(!securities[0].is_eligible_for_increase);
    }

    #[test]
    fn an_account_blocked_from_buying_cannot_receive_an_increase() {
        let constraints = vec![constraint(
            ConstraintSubjectType::Account,
            "acc-2",
            ConstraintAction::Buy,
            ConstraintEffect::Block,
        )];
        let securities = securities(&constraints, None);

        let eligible = AllocationWorksheetService::eligible_accounts(
            &securities,
            &["acc-1".to_string(), "acc-2".to_string()],
            &constraints,
        );

        assert_eq!(eligible["vti"], vec!["acc-1".to_string()]);
    }

    #[test]
    fn a_security_the_preview_would_refuse_is_never_a_candidate() {
        let mut inactive = asset("vti");
        inactive.is_active = false;

        let securities = AllocationWorksheetService::securities_from(
            &[contribution("vti", "EQUITY", dec!(1000))],
            &HashMap::from([("vti".to_string(), inactive)]),
            &HashMap::from([("vti".to_string(), snapshot("vti", dec!(100), "USD"))]),
            &[],
            &HashMap::new(),
            &[],
            None,
            "USD",
        );

        assert!(securities.is_empty());
    }

    #[test]
    fn a_security_without_a_usable_price_carries_none() {
        let securities = AllocationWorksheetService::securities_from(
            &[contribution("vti", "EQUITY", dec!(1000))],
            &assets(&["vti"]),
            &HashMap::new(),
            &[],
            &HashMap::new(),
            &[],
            None,
            "USD",
        );

        assert_eq!(securities[0].unit_price, None);
    }

    #[test]
    fn a_price_is_converted_into_the_base_currency() {
        let rates = vec![ExchangeRate {
            id: "eur-usd".to_string(),
            from_currency: "EUR".to_string(),
            to_currency: "USD".to_string(),
            rate: dec!(1.1),
            source: "manual".to_string(),
            timestamp: Utc::now(),
        }];

        let securities = AllocationWorksheetService::securities_from(
            &[contribution("vti", "EQUITY", dec!(1000))],
            &assets(&["vti"]),
            &HashMap::from([("vti".to_string(), snapshot("vti", dec!(100), "EUR"))]),
            &rates,
            &HashMap::new(),
            &[],
            None,
            "USD",
        );

        assert_eq!(securities[0].unit_price, Some(dec!(110.0)));
    }

    #[test]
    fn the_unclassified_residual_travels_with_the_classification() {
        // The projection has to spread an amount exactly as the preview's
        // exposures do, so the residual is part of the security's value. It
        // carries no target, so no category gap ever reaches it.
        let securities = AllocationWorksheetService::securities_from(
            &[
                contribution("vti", "EQUITY", dec!(650)),
                contribution("vti", UNKNOWN_CATEGORY_ID, dec!(350)),
            ],
            &assets(&["vti"]),
            &HashMap::from([("vti".to_string(), snapshot("vti", dec!(100), "USD"))]),
            &[],
            &HashMap::new(),
            &[],
            None,
            "USD",
        );

        assert_eq!(
            securities[0].category_values,
            vec![
                ("EQUITY".to_string(), dec!(650)),
                (UNKNOWN_CATEGORY_ID.to_string(), dec!(350)),
            ]
        );
    }

    // ── Preview of an edited worksheet (§5) ──────────────────────────────

    fn line(mode: WorksheetInputMode, value: Decimal) -> AllocationWorksheetLineInput {
        AllocationWorksheetLineInput {
            line_id: "line-1".to_string(),
            direction: WorksheetDirection::Increase,
            asset_id: "vti".to_string(),
            account_id: "acc-1".to_string(),
            input_mode: mode,
            value,
        }
    }

    fn request() -> CalculateAllocationWorksheetInput {
        CalculateAllocationWorksheetInput {
            target_id: "target-1".to_string(),
            cash: WorksheetCashInput {
                tracked_cash_to_use: dec!(10),
                external_contribution: HashMap::new(),
            },
            lines: vec![line(WorksheetInputMode::Amount, dec!(10))],
            account_ids: vec!["acc-1".to_string()],
            base_currency: "USD".to_string(),
            aggregated_account_id: "all".to_string(),
        }
    }

    fn assignment(category_id: &str, weight: i32) -> AssetTaxonomyAssignment {
        let now = Utc::now().naive_utc();
        AssetTaxonomyAssignment {
            id: format!("assignment-{category_id}"),
            asset_id: "vti".to_string(),
            taxonomy_id: "asset_classes".to_string(),
            category_id: category_id.to_string(),
            weight,
            source: "manual".to_string(),
            created_at: now,
            updated_at: now,
        }
    }

    fn fx_rate(id: &str, from: &str, to: &str, rate: Decimal) -> ExchangeRate {
        ExchangeRate {
            id: id.to_string(),
            from_currency: from.to_string(),
            to_currency: to.to_string(),
            rate,
            source: "manual".to_string(),
            timestamp: Utc::now(),
        }
    }

    #[test]
    fn amount_mode_floors_whole_units() {
        let (quantity, amount) = AllocationWorksheetService::resolved_quantity_and_amount(
            &line(WorksheetInputMode::Amount, dec!(250)),
            dec!(100),
            true,
        )
        .unwrap();

        assert_eq!(quantity, dec!(2));
        assert_eq!(amount, dec!(200));
    }

    #[test]
    fn quantity_mode_rejects_fractional_whole_units() {
        assert!(AllocationWorksheetService::resolved_quantity_and_amount(
            &line(WorksheetInputMode::Quantity, dec!(1.5)),
            dec!(100),
            true,
        )
        .is_err());
    }

    #[test]
    fn missing_classification_becomes_unknown_exposure() {
        let exposures = AllocationWorksheetService::category_exposures(
            &line(WorksheetInputMode::Amount, dec!(100)),
            dec!(100),
            &[],
            &HashMap::new(),
        )
        .unwrap();

        assert_eq!(exposures.len(), 1);
        assert_eq!(exposures[0].category_id, UNKNOWN_CATEGORY_ID);
        assert_eq!(exposures[0].weight_bps, 10_000);
        assert_eq!(exposures[0].value_delta, dec!(100));
    }

    #[test]
    fn partial_classification_keeps_known_and_residual_exposure() {
        let exposures = AllocationWorksheetService::category_exposures(
            &line(WorksheetInputMode::Amount, dec!(100)),
            dec!(100),
            &[assignment("EQUITY", 6500)],
            &HashMap::from([("EQUITY".to_string(), "Equity".to_string())]),
        )
        .unwrap();

        assert_eq!(exposures.len(), 2);
        assert_eq!(exposures[0].weight_bps, 6500);
        assert_eq!(exposures[0].value_delta, dec!(65));
        assert_eq!(exposures[1].category_id, UNKNOWN_CATEGORY_ID);
        assert_eq!(exposures[1].weight_bps, 3500);
        assert_eq!(exposures[1].value_delta, dec!(35));
    }

    #[test]
    fn overclassified_security_is_rejected() {
        assert!(AllocationWorksheetService::category_exposures(
            &line(WorksheetInputMode::Amount, dec!(100)),
            dec!(100),
            &[assignment("EQUITY", 6000), assignment("FIXED_INCOME", 5000)],
            &HashMap::new(),
        )
        .is_err());
    }

    #[test]
    fn fx_resolution_attributes_a_direct_or_inverse_rate() {
        let rates = vec![fx_rate("eur-usd", "EUR", "USD", dec!(1.1))];

        let (direct, direct_source, direct_records) =
            AllocationWorksheetService::resolve_fx_source("EUR", "USD", &rates).unwrap();
        assert_eq!(direct, dec!(1.1));
        assert_eq!(direct_source.unwrap().id, "eur-usd");
        assert_eq!(direct_records.len(), 1);

        let (inverse, inverse_source, inverse_records) =
            AllocationWorksheetService::resolve_fx_source("USD", "EUR", &rates).unwrap();
        assert_eq!(inverse, Decimal::ONE / dec!(1.1));
        assert_eq!(inverse_source.unwrap().id, "eur-usd");
        assert_eq!(inverse_records.len(), 1);
    }

    #[test]
    fn fx_resolution_attributes_every_rate_in_a_cross_currency_path() {
        let rates = vec![
            fx_rate("eur-usd", "EUR", "USD", dec!(1.1)),
            fx_rate("usd-cad", "USD", "CAD", dec!(1.35)),
            fx_rate("aud-nzd", "AUD", "NZD", dec!(1.08)),
        ];

        let (rate, source, records) =
            AllocationWorksheetService::resolve_fx_source("EUR", "CAD", &rates).unwrap();

        assert_eq!(rate, dec!(1.485));
        assert_eq!(source.unwrap().source_type, "fx_path");
        assert_eq!(
            records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec!["eur-usd", "usd-cad"]
        );
    }

    #[test]
    fn an_edit_over_the_available_funding_is_reported_not_rejected() {
        // §5 — the worksheet is the source of truth once prefilled, so the
        // overspend comes back as a negative remainder the caller warns on
        // rather than as a refusal to calculate.
        assert_eq!(
            AllocationWorksheetService::cash_remaining(dec!(100), dec!(25), dec!(160), dec!(50)),
            dec!(15)
        );
        assert_eq!(
            AllocationWorksheetService::cash_remaining(
                dec!(100),
                Decimal::ZERO,
                dec!(200),
                dec!(50)
            ),
            dec!(-50)
        );
    }

    #[test]
    fn a_rounding_sized_cash_overage_is_clamped_rather_than_refused() {
        // Both halves of the service share the rule, so a prefilled worksheet
        // never fails a check its own generation passed.
        assert_eq!(
            AllocationWorksheetService::tracked_cash_to_use(dec!(1000.004), dec!(1000), "USD")
                .unwrap(),
            dec!(1000)
        );
        assert!(
            AllocationWorksheetService::tracked_cash_to_use(dec!(1100), dec!(1000), "USD").is_err()
        );
    }

    #[test]
    fn fingerprint_changes_with_inputs_and_each_source_version() {
        let records = vec![WorksheetSourceRecord {
            source_type: "security_quote".to_string(),
            id: "quote-1".to_string(),
            version: "2026-01-01T00:00:00Z".to_string(),
            details: "close=100".to_string(),
        }];
        let original = AllocationWorksheetService::source_fingerprint(&request(), &records);

        let mut input_changed = request();
        input_changed
            .cash
            .external_contribution
            .insert("acc-1".to_string(), dec!(1));
        assert_ne!(
            original,
            AllocationWorksheetService::source_fingerprint(&input_changed, &records)
        );

        let mut source_changed = records.clone();
        source_changed[0].version = "2026-01-02T00:00:00Z".to_string();
        assert_ne!(
            original,
            AllocationWorksheetService::source_fingerprint(&request(), &source_changed)
        );

        source_changed[0].version = records[0].version.clone();
        source_changed[0].details = "close=101".to_string();
        assert_ne!(
            original,
            AllocationWorksheetService::source_fingerprint(&request(), &source_changed)
        );
    }

    #[test]
    fn a_position_is_where_the_units_actually_sit() {
        let securities = AllocationWorksheetService::securities_from(
            &[contribution("vti", "EQUITY", dec!(1000))],
            &assets(&["vti"]),
            &HashMap::from([("vti".to_string(), snapshot("vti", dec!(100), "USD"))]),
            &[],
            &HashMap::from([
                ("acc-1".to_string(), vec![holding("vti", "acc-1", dec!(6))]),
                ("acc-2".to_string(), vec![holding("vti", "acc-2", dec!(4))]),
            ]),
            &[],
            None,
            "USD",
        );

        let positions = &securities[0].positions;
        assert_eq!(positions.len(), 2);
        assert_eq!(positions[0].account_id, "acc-1");
        assert_eq!(positions[0].quantity, dec!(6));
        assert_eq!(positions[1].account_id, "acc-2");
        assert_eq!(positions[1].quantity, dec!(4));
    }
}
