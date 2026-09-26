//! Orchestration behind the calculated rebalancing worksheet.
//!
//! Implements §4 to §6 of
//! `docs/features/allocations/self-directed-rebalancing-design.md`.
//!
//! Split in two on purpose. The service methods only load: the target, the
//! drift report, what each selected account holds, prices, FX and constraints.
//! Every number is decided in [`AllocationWorksheetService::generate`] and
//! [`AllocationWorksheetService::preview`], which take those sources as plain
//! structs. That keeps the whole generation-to-preview flow testable without a
//! repository, while the arithmetic itself stays in
//! [`super::worksheet_calculator`].

use async_trait::async_trait;
use chrono::Utc;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
use std::sync::Arc;

use crate::accounts::{account_types, Account, AccountServiceTrait};
use crate::assets::{Asset, AssetServiceTrait};
use crate::errors::{DatabaseError, Error as CoreError, Result as CoreResult, ValidationError};
use crate::fx::{
    denormalization_multiplier, normalize_currency_code, ExchangeRate, FxServiceTrait,
};
use crate::portfolio::allocation::{
    AllocationServiceTrait, HoldingAllocationContribution, TaxonomyHoldingContributions,
};
use crate::portfolio::holdings::{Holding, HoldingType, HoldingsServiceTrait};
use crate::quotes::{LatestQuoteSnapshot, QuoteServiceTrait};
use crate::taxonomies::{AssetTaxonomyAssignment, TaxonomyServiceTrait, TaxonomyWithCategories};

use super::cash::{
    deployable_cash_from_contributions, has_deployable_cash_categories, tracked_cash,
};
use super::drift_service::DriftServiceTrait;
use super::model::{
    AllocationTarget, AllocationTargetConstraint, AllocationTargetWeight,
    AllocationWorksheetLineInput, AllocationWorksheetLineResult, AllocationWorksheetResult,
    CalculateAllocationWorksheetInput, CalculatedAdjustment, CalculatedAdjustments,
    ConstraintAction, ConstraintEffect, ConstraintSubjectType, DriftReport,
    GenerateCalculatedAdjustmentsInput, WorksheetCashInput, WorksheetCategoryExposure,
    WorksheetCategoryResult, WorksheetDirection, WorksheetInputMode, WorksheetMode,
    WorksheetPricingSource, WorksheetSourceRecord, WorksheetWarning, WorksheetWarningKind,
};
use super::target_service::AllocationTargetServiceTrait;
use super::worksheet_calculator::{
    account_funding, account_funding_shortfalls, apply_limits, assign_accounts, remaining_cash,
    run_sequence, turnover_cap_value, AssignedLine, CategoryTarget, LimitsInput, PositionInput,
    SecurityInput, SequenceInput,
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

/// One account the worksheet may change, as the repositories report it.
#[derive(Debug, Clone)]
struct AccountSource {
    account: Account,
    /// The account's own contributions, so its cash is classified exactly as
    /// the drift report classifies it.
    contributions: TaxonomyHoldingContributions,
    holdings: Vec<Holding>,
}

/// Everything a generation reads before any arithmetic happens.
#[derive(Debug, Clone)]
struct GenerationSources {
    target: AllocationTarget,
    drift: DriftReport,
    accounts: Vec<AccountSource>,
    constraints: Vec<AllocationTargetConstraint>,
    assets_by_id: HashMap<String, Asset>,
    quote_snapshots: HashMap<String, LatestQuoteSnapshot>,
    fx_rates: Vec<ExchangeRate>,
}

/// Everything a preview reads before any arithmetic happens.
///
/// Assets, quotes and classifications cover both the worksheet lines and every
/// security the selected accounts hold, so the source records describe the
/// whole picture the preview was computed from.
#[derive(Debug, Clone)]
struct PreviewSources {
    target: AllocationTarget,
    drift: DriftReport,
    weights: Vec<AllocationTargetWeight>,
    taxonomy: TaxonomyWithCategories,
    accounts: Vec<AccountSource>,
    constraints: Vec<AllocationTargetConstraint>,
    assets_by_id: HashMap<String, Asset>,
    quote_snapshots: HashMap<String, LatestQuoteSnapshot>,
    assignments: Vec<AssetTaxonomyAssignment>,
    fx_rates: Vec<ExchangeRate>,
}

pub struct AllocationWorksheetService {
    allocation_target_service: Arc<dyn AllocationTargetServiceTrait>,
    drift_service: Arc<dyn DriftServiceTrait>,
    allocation_service: Arc<dyn AllocationServiceTrait>,
    holdings_service: Arc<dyn HoldingsServiceTrait>,
    account_service: Arc<dyn AccountServiceTrait>,
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
        account_service: Arc<dyn AccountServiceTrait>,
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
            account_service,
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
    /// The chosen accounts cannot deploy cash they do not record, so an amount
    /// above what they hold is met with what exists rather than refused: cash
    /// that is not recorded yet belongs in the contribution input, where it
    /// stays visible as hypothetical. The preview reports the difference (§5).
    /// The prefill and the preview share the rule, so a prefilled worksheet
    /// never fails a check its own generation passed.
    fn tracked_cash_to_use(selected: Decimal, deployable: Decimal) -> Decimal {
        selected.clamp(Decimal::ZERO, deployable.max(Decimal::ZERO))
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

    fn min_line_amount(target: &AllocationTarget) -> Decimal {
        Decimal::from_str(&target.min_trade_amount)
            .unwrap_or(Decimal::ZERO)
            .max(Decimal::ZERO)
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

    // ── Accounts and cash (§6) ───────────────────────────────────────────────

    /// Whether an account can hold the securities a worksheet changes.
    ///
    /// Cash accounts track activity and cash rather than investments, so they
    /// can neither receive a security nor, with no transfer assumed, fund one
    /// elsewhere.
    fn can_hold_securities(account: &Account) -> bool {
        matches!(
            account.account_type.as_str(),
            account_types::SECURITIES | account_types::CRYPTOCURRENCY
        )
    }

    /// The accounts the user chose to change, validated against the target's
    /// scope, in the order they were chosen.
    fn selected_accounts(
        scope_account_ids: &[String],
        selected_account_ids: &[String],
        accounts: &[Account],
    ) -> CoreResult<Vec<Account>> {
        if selected_account_ids.is_empty() {
            return Err(Self::invalid(
                "Select at least one account the worksheet may change",
            ));
        }

        let mut seen = HashSet::new();
        let mut selected = Vec::new();
        for account_id in selected_account_ids {
            if !seen.insert(account_id.as_str()) {
                continue;
            }
            if !scope_account_ids.contains(account_id) {
                return Err(Self::invalid(format!(
                    "Account {account_id} is outside the resolved scope"
                )));
            }
            let account = accounts
                .iter()
                .find(|account| &account.id == account_id)
                .ok_or_else(|| Self::invalid(format!("Account {account_id} no longer exists")))?;
            if !Self::can_hold_securities(account) {
                return Err(Self::invalid(format!(
                    "{} holds cash rather than investments and cannot take part in the worksheet",
                    account.name
                )));
            }
            selected.push(account.clone());
        }
        Ok(selected)
    }

    /// The cash an account can deploy.
    ///
    /// One rule for each account and for the global total, so cash left out of
    /// one is left out of the other. With a cash sleeve, only cash classified
    /// into it counts: cash tagged into another sleeve stays where the user put
    /// it. Without one, every cash balance the account records counts.
    fn available_cash(taxonomy_id: &str, source: &AccountSource) -> Decimal {
        deployable_cash_from_contributions(taxonomy_id, &source.contributions)
            .unwrap_or_else(|| tracked_cash(&source.holdings))
    }

    fn available_cash_by_account(
        taxonomy_id: &str,
        accounts: &[AccountSource],
    ) -> HashMap<String, Decimal> {
        accounts
            .iter()
            .map(|source| {
                (
                    source.account.id.clone(),
                    Self::available_cash(taxonomy_id, source),
                )
            })
            .collect()
    }

    fn account_ids(accounts: &[AccountSource]) -> Vec<String> {
        accounts
            .iter()
            .map(|source| source.account.id.clone())
            .collect()
    }

    fn holdings_by_account(accounts: &[AccountSource]) -> HashMap<String, Vec<Holding>> {
        accounts
            .iter()
            .map(|source| (source.account.id.clone(), source.holdings.clone()))
            .collect()
    }

    fn validate_cash(cash: &WorksheetCashInput, account_ids: &[String]) -> CoreResult<()> {
        if cash.tracked_cash_to_use < Decimal::ZERO
            || cash
                .external_contribution
                .values()
                .any(|amount| *amount < Decimal::ZERO)
        {
            return Err(Self::invalid("Worksheet cash values must be non-negative"));
        }
        for account_id in cash.external_contribution.keys() {
            if !account_ids.contains(account_id) {
                return Err(Self::invalid(format!(
                    "External contribution for account {account_id} is outside the selected accounts"
                )));
            }
        }
        Ok(())
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
                // Prices arrive as 32-bit floats widened to decimals, so an
                // amount meant to buy N units can divide out a fraction of a
                // billionth below N. Rounding before the floor reads that as
                // the N it was.
                let quantity = if whole_shares_only {
                    (line.value / unit_price).round_dp(6).floor()
                } else {
                    line.value / unit_price
                };
                // An amount short of one whole unit places nothing. It is
                // reported rather than refused: refusing would fail the whole
                // preview over one line the user can still edit (§5).
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

    /// Every security the selected accounts hold, with what it is worth in each
    /// category, what a unit costs and where its units sit.
    ///
    /// The classification keeps the unclassified residual, so the projection
    /// spreads an amount exactly as the preview's exposures do. Constraints
    /// only ever look at the classified part of it.
    #[allow(clippy::too_many_arguments)]
    fn securities_from(
        contributions: &[&HoldingAllocationContribution],
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

    /// The accounts each security may be increased in (§6): selected, and not
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

    // ── Generation (§4) ──────────────────────────────────────────────────────

    /// The calculated adjustments, from sources already loaded.
    fn generate(
        input: &GenerateCalculatedAdjustmentsInput,
        sources: &GenerationSources,
    ) -> CoreResult<CalculatedAdjustments> {
        let target = &sources.target;
        if input.mode == WorksheetMode::Rebalance && !target.allow_sells {
            return Err(Self::invalid(
                "This target disables reductions; enable them before rebalancing",
            ));
        }

        let account_ids = Self::account_ids(&sources.accounts);
        Self::validate_cash(&input.cash, &account_ids)?;
        let cash_by_account =
            Self::available_cash_by_account(&target.taxonomy_id, &sources.accounts);
        let tracked_cash_to_use = Self::tracked_cash_to_use(
            input.cash.tracked_cash_to_use,
            cash_by_account.values().copied().sum::<Decimal>(),
        );

        // An empty allowlist is a valid state, not an error (§4.1): every
        // increase it leaves unplaced becomes an unresolved category amount.
        let eligible_asset_ids = input
            .eligible_asset_ids
            .as_ref()
            .map(|ids| ids.iter().cloned().collect::<HashSet<_>>());
        let contributions: Vec<&HoldingAllocationContribution> = sources
            .accounts
            .iter()
            .flat_map(|source| source.contributions.contributions.iter())
            .collect();
        let securities = Self::securities_from(
            &contributions,
            &sources.assets_by_id,
            &sources.quote_snapshots,
            &sources.fx_rates,
            &Self::holdings_by_account(&sources.accounts),
            &sources.constraints,
            eligible_asset_ids.as_ref(),
            &input.base_currency,
        );

        let categories: Vec<CategoryTarget> = sources
            .drift
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
            sources.drift.total_value,
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
            cash_category_id: sources
                .drift
                .rows
                .iter()
                .find(|row| row.is_cash)
                .map(|row| row.category_id.clone()),
        });

        let min_line_amount = Self::min_line_amount(target);
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
            &Self::eligible_accounts(&securities, &account_ids, &sources.constraints),
            target.whole_shares_only,
            min_line_amount,
        );

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
            mode: input.mode.clone(),
            rule: input.rule.clone(),
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

    // ── Preview (§5) ─────────────────────────────────────────────────────────

    /// The validated worksheet and its projection, from sources already
    /// loaded. A worksheet with no lines is valid and projects the current
    /// allocation.
    fn preview(
        input: &CalculateAllocationWorksheetInput,
        sources: &PreviewSources,
    ) -> CoreResult<AllocationWorksheetResult> {
        let target = &sources.target;
        let drift = &sources.drift;
        let account_ids = Self::account_ids(&sources.accounts);
        Self::validate_cash(&input.cash, &account_ids)?;

        let mut line_ids = HashSet::new();
        for line in &input.lines {
            if line.line_id.trim().is_empty() || !line_ids.insert(line.line_id.as_str()) {
                return Err(Self::invalid(
                    "Every worksheet line must have a unique lineId",
                ));
            }
            if !account_ids.contains(&line.account_id) {
                return Err(Self::line_invalid(
                    &line.line_id,
                    "the account is not one this worksheet may change",
                ));
            }
        }
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

        let cash_by_account =
            Self::available_cash_by_account(&target.taxonomy_id, &sources.accounts);
        let observed_tracked_cash = cash_by_account.values().copied().sum::<Decimal>();
        let tracked_cash_to_use =
            Self::tracked_cash_to_use(input.cash.tracked_cash_to_use, observed_tracked_cash);

        let holdings_by_account = Self::holdings_by_account(&sources.accounts);
        let assignments_by_asset = sources
            .assignments
            .iter()
            .filter(|assignment| assignment.taxonomy_id == target.taxonomy_id)
            .cloned()
            .fold(HashMap::<String, Vec<_>>::new(), |mut map, assignment| {
                map.entry(assignment.asset_id.clone())
                    .or_default()
                    .push(assignment);
                map
            });
        let category_names = sources
            .taxonomy
            .categories
            .iter()
            .map(|category| (category.id.clone(), category.name.clone()))
            .collect::<HashMap<_, _>>();
        let mut category_order = sources.taxonomy.categories.clone();
        category_order.sort_by_key(|category| category.sort_order);

        let external_total = input.cash.external_total();
        let mut warnings = Vec::new();
        if input.cash.tracked_cash_to_use > tracked_cash_to_use {
            warnings.push(Self::warning(
                WorksheetWarningKind::CashUnavailable,
                None,
                "cash-unavailable",
                format!(
                    "Deployed the {tracked_cash_to_use} of cash the chosen accounts record, not the {} asked for.",
                    input.cash.tracked_cash_to_use
                ),
            ));
        }
        if external_total > Decimal::ZERO {
            warnings.push(Self::warning(
                WorksheetWarningKind::ExternalContribution,
                None,
                "external-cash",
                format!("Includes {external_total} of hypothetical cash not currently recorded."),
            ));
        }

        let min_line_amount = Self::min_line_amount(target);
        let mut results = Vec::with_capacity(input.lines.len());
        let mut reduction_qty_by_position = HashMap::<(String, String), Decimal>::new();
        let mut used_fx_rates = HashMap::<String, ExchangeRate>::new();

        for line in &input.lines {
            let asset: &Asset = sources.assets_by_id.get(&line.asset_id).ok_or_else(|| {
                Self::line_invalid(&line.line_id, "selected tracked security no longer exists")
            })?;
            if !asset.is_active || !asset.kind.is_investment() {
                return Err(Self::line_invalid(
                    &line.line_id,
                    "selected asset is not an active tracked investment security",
                ));
            }
            let (snapshot, quote) = Self::quote_for_line(line, &sources.quote_snapshots)?;
            let (fx_rate, fx_source, line_fx_rates) = Self::resolve_fx_source(
                quote.currency.as_str(),
                input.base_currency.as_str(),
                &sources.fx_rates,
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
            for constraint in sources.constraints.iter().filter(|constraint| {
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
            if quantity.is_zero() {
                warnings.push(Self::warning(
                    WorksheetWarningKind::BelowOneUnit,
                    Some(&line.line_id),
                    "whole-units",
                    format!(
                        "{} buys less than one whole unit at {}, so this line places nothing.",
                        line.value.normalize(),
                        unit_price.round_dp(4).normalize()
                    ),
                ));
            } else if min_line_amount > Decimal::ZERO && amount < min_line_amount {
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
        // increase in another. The same ledger the prefill reads.
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
        let account_funding = account_funding(
            &assigned,
            &account_ids,
            &cash_by_account,
            &input.cash.external_contribution,
        );
        for shortfall in account_funding
            .iter()
            .filter(|funding| funding.remaining < Decimal::ZERO)
        {
            warnings.push(Self::warning(
                WorksheetWarningKind::AccountFunding,
                None,
                &shortfall.account_id,
                format!(
                    "Increases of {} in this account exceed the {} it can fund on its own; no transfer between accounts is assumed.",
                    shortfall.increases,
                    shortfall.increases + shortfall.remaining
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

        let target_bps_by_category = sources
            .weights
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
            id: sources.taxonomy.taxonomy.id.clone(),
            version: sources.taxonomy.taxonomy.updated_at.and_utc().to_rfc3339(),
            details: format!(
                "name={};scope={}",
                sources.taxonomy.taxonomy.name, sources.taxonomy.taxonomy.scope
            ),
        });
        for weight in &sources.weights {
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
        for category in &sources.taxonomy.categories {
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
        for asset in sources.assets_by_id.values() {
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
        for assignment in sources
            .assignments
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
        for constraint in &sources.constraints {
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
        for (asset_id, snapshot) in &sources.quote_snapshots {
            if let Some(quote) = &snapshot.quote {
                source_records.push(WorksheetSourceRecord {
                    source_type: "security_quote".to_string(),
                    id: quote.id.clone(),
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
        let source_fingerprint = Self::source_fingerprint(input, &source_records);

        Ok(AllocationWorksheetResult {
            target_id: target.id.clone(),
            target_name: target.name.clone(),
            base_currency: input.base_currency.clone(),
            calculated_at: Utc::now().to_rfc3339(),
            source_fingerprint,
            resolved_account_ids: input.account_ids.clone(),
            observed_tracked_cash,
            tracked_cash_to_use,
            external_contribution: external_total,
            increase_total,
            reduction_total,
            cash_remaining,
            max_difference_bps_before,
            max_difference_bps_after,
            lines: results,
            categories,
            account_funding,
            warnings,
            source_records,
        })
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    fn load_target(&self, target_id: &str) -> CoreResult<AllocationTarget> {
        self.allocation_target_service
            .get_target(target_id)?
            .ok_or_else(|| {
                CoreError::Database(DatabaseError::NotFound(format!(
                    "AllocationTarget {target_id} not found"
                )))
            })
    }

    /// Validates the selected accounts, then loads what each holds and how its
    /// cash is classified.
    async fn load_accounts(
        &self,
        scope_account_ids: &[String],
        selected_account_ids: &[String],
        base_currency: &str,
        taxonomy_id: &str,
    ) -> CoreResult<Vec<AccountSource>> {
        let known = self
            .account_service
            .get_accounts_by_ids(selected_account_ids)?;
        let selected = Self::selected_accounts(scope_account_ids, selected_account_ids, &known)?;

        let mut sources = Vec::with_capacity(selected.len());
        for account in selected {
            let account_ids = [account.id.clone()];
            let contributions = self
                .allocation_service
                .get_holding_contributions_for_taxonomy_for_accounts(
                    &account_ids,
                    base_currency,
                    taxonomy_id,
                    &account.id,
                )
                .await?;
            let holdings = self
                .holdings_service
                .get_holdings(&account.id, base_currency)
                .await?;
            sources.push(AccountSource {
                account,
                contributions,
                holdings,
            });
        }
        Ok(sources)
    }

    async fn load_assets(&self, asset_ids: &[String]) -> CoreResult<HashMap<String, Asset>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }
        Ok(self
            .asset_service
            .get_assets_by_asset_ids(asset_ids)
            .await?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect())
    }

    fn load_quotes(
        &self,
        asset_ids: &[String],
    ) -> CoreResult<HashMap<String, LatestQuoteSnapshot>> {
        if asset_ids.is_empty() {
            return Ok(HashMap::new());
        }
        self.quote_service.get_latest_quotes_snapshot(asset_ids)
    }
}

fn sorted_unique(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids.dedup();
    ids
}

#[async_trait]
impl AllocationWorksheetServiceTrait for AllocationWorksheetService {
    async fn generate_adjustments(
        &self,
        input: GenerateCalculatedAdjustmentsInput,
    ) -> CoreResult<CalculatedAdjustments> {
        let target = self.load_target(&input.target_id)?;
        let accounts = self
            .load_accounts(
                &input.account_ids,
                &input.selected_account_ids,
                &input.base_currency,
                &target.taxonomy_id,
            )
            .await?;
        let drift = self
            .drift_service
            .get_drift_report_for_target(
                &input.target_id,
                &input.account_ids,
                &input.base_currency,
                &input.aggregated_account_id,
            )
            .await?;

        let asset_ids = sorted_unique(
            accounts
                .iter()
                .flat_map(|source| source.contributions.contributions.iter())
                .filter(|contribution| contribution.holding_type != HoldingType::Cash)
                .map(|contribution| contribution.asset_id.clone())
                .collect(),
        );
        let sources = GenerationSources {
            constraints: self
                .allocation_target_service
                .list_target_constraints(&input.target_id)?,
            assets_by_id: self.load_assets(&asset_ids).await?,
            quote_snapshots: self.load_quotes(&asset_ids)?,
            fx_rates: self.fx_service.get_latest_exchange_rates()?,
            target,
            drift,
            accounts,
        };
        Self::generate(&input, &sources)
    }

    async fn calculate_worksheet(
        &self,
        input: CalculateAllocationWorksheetInput,
    ) -> CoreResult<AllocationWorksheetResult> {
        let target = self.load_target(&input.target_id)?;
        let accounts = self
            .load_accounts(
                &input.account_ids,
                &input.selected_account_ids,
                &input.base_currency,
                &target.taxonomy_id,
            )
            .await?;
        let drift = self
            .drift_service
            .get_drift_report_for_target(
                &input.target_id,
                &input.account_ids,
                &input.base_currency,
                &input.aggregated_account_id,
            )
            .await?;
        let taxonomy = self
            .taxonomy_service
            .get_taxonomy(&target.taxonomy_id)?
            .ok_or_else(|| Self::invalid("Target taxonomy no longer exists"))?;

        let asset_ids = sorted_unique(
            input
                .lines
                .iter()
                .map(|line| line.asset_id.clone())
                .chain(
                    accounts
                        .iter()
                        .flat_map(|source| source.holdings.iter())
                        .filter(|holding| holding.holding_type != HoldingType::Cash)
                        .map(Self::asset_key),
                )
                .collect(),
        );
        let assignments = if asset_ids.is_empty() {
            Vec::new()
        } else {
            self.taxonomy_service
                .get_asset_assignments_for_assets(&asset_ids)?
        };
        let sources = PreviewSources {
            weights: self
                .allocation_target_service
                .list_weights_for_target(&input.target_id)?,
            constraints: self
                .allocation_target_service
                .list_target_constraints(&input.target_id)?,
            assets_by_id: self.load_assets(&asset_ids).await?,
            quote_snapshots: self.load_quotes(&asset_ids)?,
            fx_rates: self.fx_service.get_latest_exchange_rates()?,
            assignments,
            target,
            drift,
            taxonomy,
            accounts,
        };
        Self::preview(&input, &sources)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// The arithmetic is covered in `worksheet_calculator`. What is tested here is
// the resolution of its inputs and the complete flow the service runs once the
// repositories have answered: generating adjustments, then previewing exactly
// the worksheet those adjustments prefill.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::AssetKind;
    use crate::portfolio::allocation_targets::{
        AllocationRule, BandType, DriftRow, DriftStatus, RebalanceGoal, ScopeType, TriggerType,
    };
    use crate::portfolio::holdings::{Instrument, MonetaryValue};
    use crate::quotes::Quote;
    use crate::taxonomies::{Category, Taxonomy};
    use rust_decimal_macros::dec;

    // ── Fixtures ─────────────────────────────────────────────────────────────

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

    fn account(id: &str, account_type: &str) -> Account {
        Account {
            id: id.to_string(),
            name: id.to_ascii_uppercase(),
            account_type: account_type.to_string(),
            currency: "USD".to_string(),
            is_active: true,
            ..Default::default()
        }
    }

    fn contribution_in(
        asset_id: &str,
        account_id: &str,
        category_id: &str,
        holding_type: HoldingType,
        value: Decimal,
    ) -> HoldingAllocationContribution {
        HoldingAllocationContribution {
            id: format!("{account_id}:{asset_id}:{category_id}"),
            holding_id: format!("{account_id}-{asset_id}"),
            asset_id: asset_id.to_string(),
            account_id: account_id.to_string(),
            source_account_ids: vec![],
            symbol: asset_id.to_ascii_uppercase(),
            name: asset_id.to_string(),
            exchange_mic: None,
            instrument_type: None,
            holding_type,
            quantity: Decimal::ONE,
            category_id: category_id.to_string(),
            category_name: category_id.to_string(),
            category_color: "#aaa".to_string(),
            value,
        }
    }

    fn contribution(
        asset_id: &str,
        category_id: &str,
        value: Decimal,
    ) -> HoldingAllocationContribution {
        contribution_in(asset_id, "acc-1", category_id, HoldingType::Security, value)
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

    fn cash_holding(account_id: &str, amount: Decimal) -> Holding {
        Holding {
            id: format!("{account_id}-cash"),
            holding_type: HoldingType::Cash,
            instrument: None,
            quantity: amount,
            market_value: MonetaryValue {
                local: amount,
                base: amount,
            },
            ..holding("cash", account_id, amount)
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

    fn assignment_for(asset_id: &str, category_id: &str, weight: i32) -> AssetTaxonomyAssignment {
        let now = Utc::now().naive_utc();
        AssetTaxonomyAssignment {
            id: format!("assignment-{asset_id}-{category_id}"),
            asset_id: asset_id.to_string(),
            taxonomy_id: "asset_classes".to_string(),
            category_id: category_id.to_string(),
            weight,
            source: "manual".to_string(),
            created_at: now,
            updated_at: now,
        }
    }

    fn assignment(category_id: &str, weight: i32) -> AssetTaxonomyAssignment {
        assignment_for("vti", category_id, weight)
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

    /// One security worth 1000 of equity, 10 units of it in `acc-1`, priced at
    /// 100 in the base currency.
    fn securities(
        constraints: &[AllocationTargetConstraint],
        eligible: Option<&HashSet<String>>,
    ) -> Vec<SecurityInput> {
        let rows = [contribution("vti", "EQUITY", dec!(1000))];
        AllocationWorksheetService::securities_from(
            &rows.iter().collect::<Vec<_>>(),
            &assets(&["vti"]),
            &HashMap::from([("vti".to_string(), snapshot("vti", dec!(100), "USD"))]),
            &[],
            &HashMap::from([("acc-1".to_string(), vec![holding("vti", "acc-1", dec!(10))])]),
            constraints,
            eligible,
            "USD",
        )
    }

    // ── A portfolio as the repositories would report it ─────────────────────

    /// A security held in one account: its category and how many units at 100.
    struct Position {
        asset_id: String,
        account_id: &'static str,
        category_id: &'static str,
        units: Decimal,
    }

    fn position(
        asset_id: &str,
        account_id: &'static str,
        category_id: &'static str,
        units: Decimal,
    ) -> Position {
        Position {
            asset_id: asset_id.to_string(),
            account_id,
            category_id,
            units,
        }
    }

    /// Cash recorded in one account, and the category its contribution lands in.
    struct CashBalance {
        account_id: &'static str,
        category_id: Option<&'static str>,
        amount: Decimal,
    }

    struct Portfolio {
        taxonomy_id: &'static str,
        /// `(category, current value, target bps, is the cash sleeve)`.
        categories: Vec<(&'static str, Decimal, i32, bool)>,
        total_value: Decimal,
        account_ids: Vec<&'static str>,
        positions: Vec<Position>,
        cash: Vec<CashBalance>,
        allow_sells: bool,
    }

    const PRICE: Decimal = dec!(100);

    impl Portfolio {
        fn target(&self) -> AllocationTarget {
            AllocationTarget {
                id: "target-1".to_string(),
                name: "Balanced".to_string(),
                scope_type: ScopeType::All,
                scope_id: None,
                taxonomy_id: self.taxonomy_id.to_string(),
                trigger_type: TriggerType::Manual,
                drift_band_bps: 500,
                band_type: BandType::Absolute,
                relative_factor_bps: 2000,
                rebalance_goal: RebalanceGoal::ExactTarget,
                min_trade_amount: "0".to_string(),
                whole_shares_only: false,
                allow_sells: self.allow_sells,
                max_turnover_bps: None,
                created_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:00Z".to_string(),
                archived_at: None,
            }
        }

        fn drift(&self) -> DriftReport {
            let rows = self
                .categories
                .iter()
                .map(|(category_id, current_value, target_bps, is_cash)| {
                    let current_bps =
                        AllocationWorksheetService::bps(*current_value, self.total_value);
                    let target_value =
                        Decimal::from(*target_bps) / Decimal::from(10_000) * self.total_value;
                    DriftRow {
                        category_id: category_id.to_string(),
                        category_name: category_id.to_string(),
                        color: "#aaa".to_string(),
                        current_bps,
                        target_bps: *target_bps,
                        drift_bps: current_bps - target_bps,
                        current_value: *current_value,
                        target_value,
                        value_delta: *current_value - target_value,
                        effective_band_bps: 500,
                        status: DriftStatus::InBand,
                        is_required: true,
                        is_zero_current: *current_value == Decimal::ZERO,
                        is_cash: *is_cash,
                    }
                })
                .collect();
            DriftReport {
                target_id: "target-1".to_string(),
                scope_type: ScopeType::All,
                scope_id: None,
                total_value: self.total_value,
                base_currency: "USD".to_string(),
                max_drift_bps: 0,
                out_of_band_count: 0,
                rows,
                holdings: None,
                deployable_cash: Decimal::ZERO,
            }
        }

        fn weights(&self) -> Vec<AllocationTargetWeight> {
            self.categories
                .iter()
                .map(|(category_id, _, target_bps, _)| AllocationTargetWeight {
                    id: format!("weight-{category_id}"),
                    target_id: "target-1".to_string(),
                    taxonomy_id: self.taxonomy_id.to_string(),
                    category_id: category_id.to_string(),
                    target_bps: *target_bps,
                    is_locked: false,
                    is_required: true,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    updated_at: "2026-01-01T00:00:00Z".to_string(),
                })
                .collect()
        }

        fn taxonomy(&self) -> TaxonomyWithCategories {
            let now = Utc::now().naive_utc();
            TaxonomyWithCategories {
                taxonomy: Taxonomy {
                    id: self.taxonomy_id.to_string(),
                    name: self.taxonomy_id.to_string(),
                    color: "#aaa".to_string(),
                    description: None,
                    is_system: true,
                    is_single_select: false,
                    sort_order: 0,
                    created_at: now,
                    updated_at: now,
                    scope: "asset".to_string(),
                },
                categories: self
                    .categories
                    .iter()
                    .enumerate()
                    .map(|(index, (category_id, ..))| Category {
                        id: category_id.to_string(),
                        taxonomy_id: self.taxonomy_id.to_string(),
                        parent_id: None,
                        name: category_id.to_string(),
                        key: category_id.to_string(),
                        color: "#aaa".to_string(),
                        description: None,
                        sort_order: index as i32,
                        created_at: now,
                        updated_at: now,
                        icon: None,
                    })
                    .collect(),
            }
        }

        fn accounts(&self) -> Vec<AccountSource> {
            self.account_ids
                .iter()
                .map(|account_id| {
                    let mut rows: Vec<HoldingAllocationContribution> = self
                        .positions
                        .iter()
                        .filter(|position| position.account_id == *account_id)
                        .map(|position| {
                            contribution_in(
                                &position.asset_id,
                                account_id,
                                position.category_id,
                                HoldingType::Security,
                                position.units * PRICE,
                            )
                        })
                        .collect();
                    let mut holdings: Vec<Holding> = self
                        .positions
                        .iter()
                        .filter(|position| position.account_id == *account_id)
                        .map(|position| holding(&position.asset_id, account_id, position.units))
                        .collect();
                    for balance in self
                        .cash
                        .iter()
                        .filter(|balance| balance.account_id == *account_id)
                    {
                        holdings.push(cash_holding(account_id, balance.amount));
                        if let Some(category_id) = balance.category_id {
                            rows.push(contribution_in(
                                "cash",
                                account_id,
                                category_id,
                                HoldingType::Cash,
                                balance.amount,
                            ));
                        }
                    }
                    AccountSource {
                        account: account(account_id, account_types::SECURITIES),
                        contributions: TaxonomyHoldingContributions {
                            taxonomy_id: self.taxonomy_id.to_string(),
                            taxonomy_name: self.taxonomy_id.to_string(),
                            total_value: rows.iter().map(|row| row.value).sum(),
                            currency: "USD".to_string(),
                            contributions: rows,
                        },
                        holdings,
                    }
                })
                .collect()
        }

        fn asset_ids(&self) -> Vec<String> {
            sorted_unique(self.positions.iter().map(|p| p.asset_id.clone()).collect())
        }

        fn assets_by_id(&self) -> HashMap<String, Asset> {
            self.asset_ids()
                .into_iter()
                .map(|id| (id.clone(), asset(&id)))
                .collect()
        }

        fn quotes(&self) -> HashMap<String, LatestQuoteSnapshot> {
            self.asset_ids()
                .into_iter()
                .map(|id| (id.clone(), snapshot(&id, PRICE, "USD")))
                .collect()
        }

        fn assignments(&self) -> Vec<AssetTaxonomyAssignment> {
            self.positions
                .iter()
                .map(|position| AssetTaxonomyAssignment {
                    taxonomy_id: self.taxonomy_id.to_string(),
                    ..assignment_for(&position.asset_id, position.category_id, 10_000)
                })
                .collect()
        }

        fn scope(&self) -> Vec<String> {
            self.account_ids.iter().map(|id| id.to_string()).collect()
        }

        fn generate(
            &self,
            mode: WorksheetMode,
            cash: WorksheetCashInput,
        ) -> CoreResult<CalculatedAdjustments> {
            AllocationWorksheetService::generate(
                &GenerateCalculatedAdjustmentsInput {
                    target_id: "target-1".to_string(),
                    account_ids: self.scope(),
                    base_currency: "USD".to_string(),
                    aggregated_account_id: "all".to_string(),
                    selected_account_ids: self.scope(),
                    mode,
                    rule: AllocationRule::CurrentHoldingProportions,
                    cash,
                    eligible_asset_ids: None,
                },
                &GenerationSources {
                    target: self.target(),
                    drift: self.drift(),
                    accounts: self.accounts(),
                    constraints: Vec::new(),
                    assets_by_id: self.assets_by_id(),
                    quote_snapshots: self.quotes(),
                    fx_rates: Vec::new(),
                },
            )
        }

        fn preview(
            &self,
            cash: WorksheetCashInput,
            lines: Vec<AllocationWorksheetLineInput>,
        ) -> CoreResult<AllocationWorksheetResult> {
            AllocationWorksheetService::preview(
                &CalculateAllocationWorksheetInput {
                    target_id: "target-1".to_string(),
                    cash,
                    lines,
                    account_ids: self.scope(),
                    base_currency: "USD".to_string(),
                    aggregated_account_id: "all".to_string(),
                    selected_account_ids: self.scope(),
                },
                &PreviewSources {
                    target: self.target(),
                    drift: self.drift(),
                    weights: self.weights(),
                    taxonomy: self.taxonomy(),
                    accounts: self.accounts(),
                    constraints: Vec::new(),
                    assets_by_id: self.assets_by_id(),
                    quote_snapshots: self.quotes(),
                    assignments: self.assignments(),
                    fx_rates: Vec::new(),
                },
            )
        }
    }

    fn tracked(amount: Decimal) -> WorksheetCashInput {
        WorksheetCashInput {
            tracked_cash_to_use: amount,
            external_contribution: HashMap::new(),
        }
    }

    /// The worksheet the calculated adjustments prefill, placed as calculated.
    fn prefilled_lines(calculated: &CalculatedAdjustments) -> Vec<AllocationWorksheetLineInput> {
        calculated
            .adjustments
            .iter()
            .map(|adjustment| AllocationWorksheetLineInput {
                line_id: adjustment.line_id.clone(),
                direction: adjustment.direction.clone(),
                asset_id: adjustment.asset_id.clone(),
                account_id: adjustment
                    .account_id
                    .clone()
                    .expect("a single-account worksheet places every line"),
                input_mode: WorksheetInputMode::Amount,
                value: adjustment.amount.abs(),
            })
            .collect()
    }

    fn projected_bps(result: &AllocationWorksheetResult, category_id: &str) -> i32 {
        result
            .categories
            .iter()
            .find(|category| category.category_id == category_id)
            .map(|category| category.projected_bps)
            .unwrap_or_else(|| panic!("no projection for {category_id}"))
    }

    fn has_warning(result: &AllocationWorksheetResult, kind: WorksheetWarningKind) -> bool {
        result.warnings.iter().any(|warning| warning.kind == kind)
    }

    /// One brokerage account on asset classes: 6000 of equity, 2000 of fixed
    /// income and 2000 of cash in the cash sleeve, out of 10000.
    fn brokerage(equity_bps: i32, fixed_income_bps: i32, cash_bps: i32) -> Portfolio {
        Portfolio {
            taxonomy_id: "asset_classes",
            categories: vec![
                ("EQUITY", dec!(6000), equity_bps, false),
                ("FIXED_INCOME", dec!(2000), fixed_income_bps, false),
                ("CASH", dec!(2000), cash_bps, true),
            ],
            total_value: dec!(10000),
            account_ids: vec!["acc-1"],
            positions: vec![
                position("vti", "acc-1", "EQUITY", dec!(60)),
                position("bnd", "acc-1", "FIXED_INCOME", dec!(20)),
            ],
            cash: vec![CashBalance {
                account_id: "acc-1",
                category_id: Some("CASH"),
                amount: dec!(2000),
            }],
            allow_sells: true,
        }
    }

    // ── Generation to preview ───────────────────────────────────────────────

    #[test]
    fn the_preview_projects_what_the_generation_aimed_for() {
        let portfolio = brokerage(7000, 3000, 0);

        let calculated = portfolio
            .generate(WorksheetMode::InvestCash, tracked(dec!(2000)))
            .unwrap();
        let result = portfolio
            .preview(tracked(dec!(2000)), prefilled_lines(&calculated))
            .unwrap();

        assert_eq!(projected_bps(&result, "EQUITY"), 7000);
        assert_eq!(projected_bps(&result, "FIXED_INCOME"), 3000);
        assert_eq!(projected_bps(&result, "CASH"), 0);
        assert_eq!(result.cash_remaining, calculated.remaining_cash);
        assert!(!has_warning(
            &result,
            WorksheetWarningKind::InsufficientFunding
        ));
        assert!(!has_warning(&result, WorksheetWarningKind::AccountFunding));
    }

    #[test]
    fn cash_left_undeployed_stays_in_the_sleeve_on_both_sides() {
        // The target only asks for 500 more equity, so 1500 of the 2000 stays
        // put. The generation reports it as remaining cash; the preview must
        // agree and keep it in the cash sleeve rather than in the basis alone.
        let portfolio = brokerage(6500, 2000, 1500);

        let calculated = portfolio
            .generate(WorksheetMode::InvestCash, tracked(dec!(2000)))
            .unwrap();
        let result = portfolio
            .preview(tracked(dec!(2000)), prefilled_lines(&calculated))
            .unwrap();

        assert_eq!(calculated.remaining_cash, dec!(1500));
        assert_eq!(result.cash_remaining, dec!(1500));
        assert_eq!(projected_bps(&result, "EQUITY"), 6500);
        assert_eq!(projected_bps(&result, "CASH"), 1500);
    }

    #[test]
    fn a_taxonomy_without_a_cash_category_is_sized_against_the_cash_it_deploys() {
        // Regions carry no cash sleeve, so the 2000 of cash is outside the 8000
        // the drift report totals. Deploying it grows the classified universe
        // to 10000, and both halves size the target against that.
        let portfolio = Portfolio {
            taxonomy_id: "regions",
            categories: vec![
                ("NORTH_AMERICA", dec!(6000), 7500, false),
                ("EUROPE", dec!(2000), 2500, false),
            ],
            total_value: dec!(8000),
            account_ids: vec!["acc-1"],
            positions: vec![
                position("vti", "acc-1", "NORTH_AMERICA", dec!(60)),
                position("veu", "acc-1", "EUROPE", dec!(20)),
            ],
            cash: vec![CashBalance {
                account_id: "acc-1",
                category_id: None,
                amount: dec!(2000),
            }],
            allow_sells: true,
        };

        let calculated = portfolio
            .generate(WorksheetMode::InvestCash, tracked(dec!(2000)))
            .unwrap();
        let result = portfolio
            .preview(tracked(dec!(2000)), prefilled_lines(&calculated))
            .unwrap();

        assert_eq!(calculated.adjustments.len(), 2);
        assert_eq!(projected_bps(&result, "NORTH_AMERICA"), 7500);
        assert_eq!(projected_bps(&result, "EUROPE"), 2500);
        assert_eq!(result.observed_tracked_cash, dec!(2000));
    }

    #[test]
    fn an_edit_past_the_available_funding_is_previewed_and_flagged() {
        let portfolio = brokerage(7000, 3000, 0);
        let calculated = portfolio
            .generate(WorksheetMode::InvestCash, tracked(dec!(2000)))
            .unwrap();
        let mut lines = prefilled_lines(&calculated);
        let vti = lines
            .iter_mut()
            .find(|line| line.asset_id == "vti")
            .unwrap();
        vti.value = dec!(3000);

        let result = portfolio.preview(tracked(dec!(2000)), lines).unwrap();

        assert_eq!(result.cash_remaining, dec!(-2000));
        assert!(has_warning(
            &result,
            WorksheetWarningKind::InsufficientFunding
        ));
        assert!(has_warning(&result, WorksheetWarningKind::AccountFunding));
        assert_eq!(result.account_funding[0].remaining, dec!(-2000));
    }

    #[test]
    fn cash_excluded_globally_is_excluded_from_each_account() {
        // The second account's cash is tagged as fixed income, so it is not
        // cash to deploy. It must not count in the total, and it must not fund
        // an increase placed in that account either.
        let portfolio = Portfolio {
            taxonomy_id: "asset_classes",
            categories: vec![
                ("EQUITY", dec!(6000), 7000, false),
                ("FIXED_INCOME", dec!(3000), 3000, false),
                ("CASH", dec!(1000), 0, true),
            ],
            total_value: dec!(10000),
            account_ids: vec!["acc-1", "acc-2"],
            positions: vec![
                position("vti", "acc-1", "EQUITY", dec!(60)),
                position("bnd", "acc-2", "FIXED_INCOME", dec!(20)),
            ],
            cash: vec![
                CashBalance {
                    account_id: "acc-1",
                    category_id: Some("CASH"),
                    amount: dec!(1000),
                },
                CashBalance {
                    account_id: "acc-2",
                    category_id: Some("FIXED_INCOME"),
                    amount: dec!(1000),
                },
            ],
            allow_sells: true,
        };

        // Only acc-1's cash is cash to deploy, so asking for 1500 deploys the
        // 1000 that exists rather than refusing the worksheet.
        let deployed = |calculated: &CalculatedAdjustments| {
            calculated
                .adjustments
                .iter()
                .map(|line| line.amount)
                .sum::<Decimal>()
        };
        let asked_for_more = portfolio
            .generate(WorksheetMode::InvestCash, tracked(dec!(1500)))
            .unwrap();
        let all_there_is = portfolio
            .generate(WorksheetMode::InvestCash, tracked(dec!(1000)))
            .unwrap();
        assert_eq!(deployed(&asked_for_more), deployed(&all_there_is));

        let clamped = portfolio.preview(tracked(dec!(1500)), Vec::new()).unwrap();
        assert_eq!(clamped.observed_tracked_cash, dec!(1000));
        assert_eq!(clamped.tracked_cash_to_use, dec!(1000));
        assert!(has_warning(&clamped, WorksheetWarningKind::CashUnavailable));

        let result = portfolio
            .preview(
                tracked(dec!(1000)),
                vec![AllocationWorksheetLineInput {
                    line_id: "vti-acc-2".to_string(),
                    direction: WorksheetDirection::Increase,
                    asset_id: "vti".to_string(),
                    account_id: "acc-2".to_string(),
                    input_mode: WorksheetInputMode::Amount,
                    value: dec!(800),
                }],
            )
            .unwrap();

        assert_eq!(result.observed_tracked_cash, dec!(1000));
        let second = result
            .account_funding
            .iter()
            .find(|funding| funding.account_id == "acc-2")
            .unwrap();
        assert_eq!(second.available_cash, Decimal::ZERO);
        assert_eq!(second.remaining, dec!(-800));
        assert!(has_warning(&result, WorksheetWarningKind::AccountFunding));
        assert!(!has_warning(
            &result,
            WorksheetWarningKind::InsufficientFunding
        ));
    }

    #[test]
    fn a_worksheet_with_no_adjustments_previews_the_current_allocation() {
        let portfolio = brokerage(7000, 3000, 0);

        let result = portfolio
            .preview(tracked(Decimal::ZERO), Vec::new())
            .unwrap();

        assert!(result.lines.is_empty());
        for category in &result.categories {
            assert_eq!(category.projected_bps, category.current_bps);
        }
        assert_eq!(result.account_funding.len(), 1);
    }

    #[test]
    fn a_worksheet_is_not_cut_to_fit_a_line_count() {
        // Sixty securities each receive a share of the cash. Every line the
        // generation produces must reach the preview.
        let portfolio = Portfolio {
            taxonomy_id: "asset_classes",
            categories: vec![
                ("EQUITY", dec!(6000), 10000, false),
                ("CASH", dec!(4000), 0, true),
            ],
            total_value: dec!(10000),
            account_ids: vec!["acc-1"],
            positions: (0..60)
                .map(|index| position(&format!("s{index:02}"), "acc-1", "EQUITY", dec!(1)))
                .collect(),
            cash: vec![CashBalance {
                account_id: "acc-1",
                category_id: Some("CASH"),
                amount: dec!(4000),
            }],
            allow_sells: true,
        };

        let calculated = portfolio
            .generate(WorksheetMode::InvestCash, tracked(dec!(3000)))
            .unwrap();
        let result = portfolio
            .preview(tracked(dec!(3000)), prefilled_lines(&calculated))
            .unwrap();

        assert_eq!(calculated.adjustments.len(), 60);
        assert_eq!(result.lines.len(), 60);
    }

    #[test]
    fn a_cash_account_cannot_take_part_in_the_worksheet() {
        let scope = vec!["acc-1".to_string(), "bank".to_string()];
        let known = vec![
            account("acc-1", account_types::SECURITIES),
            account("bank", account_types::CASH),
        ];

        assert!(AllocationWorksheetService::selected_accounts(
            &scope,
            &["bank".to_string()],
            &known
        )
        .is_err());
        let selected =
            AllocationWorksheetService::selected_accounts(&scope, &["acc-1".to_string()], &known)
                .unwrap();
        assert_eq!(selected.len(), 1);
    }

    #[test]
    fn an_account_outside_the_scope_cannot_be_selected() {
        let known = vec![account("acc-9", account_types::SECURITIES)];

        assert!(AllocationWorksheetService::selected_accounts(
            &["acc-1".to_string()],
            &["acc-9".to_string()],
            &known
        )
        .is_err());
        assert!(
            AllocationWorksheetService::selected_accounts(&["acc-1".to_string()], &[], &known)
                .is_err()
        );
    }

    // ── Calculator inputs ───────────────────────────────────────────────────

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
        // amounts. It is not a validation error.
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
        let rows = [contribution("vti", "EQUITY", dec!(1000))];

        let securities = AllocationWorksheetService::securities_from(
            &rows.iter().collect::<Vec<_>>(),
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
        let rows = [contribution("vti", "EQUITY", dec!(1000))];

        let securities = AllocationWorksheetService::securities_from(
            &rows.iter().collect::<Vec<_>>(),
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
        let rows = [contribution("vti", "EQUITY", dec!(1000))];

        let securities = AllocationWorksheetService::securities_from(
            &rows.iter().collect::<Vec<_>>(),
            &assets(&["vti"]),
            &HashMap::from([("vti".to_string(), snapshot("vti", dec!(100), "EUR"))]),
            &[fx_rate("eur-usd", "EUR", "USD", dec!(1.1))],
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
        let rows = [
            contribution("vti", "EQUITY", dec!(650)),
            contribution("vti", UNKNOWN_CATEGORY_ID, dec!(350)),
        ];

        let securities = AllocationWorksheetService::securities_from(
            &rows.iter().collect::<Vec<_>>(),
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

    #[test]
    fn a_position_is_where_the_units_actually_sit() {
        let rows = [contribution("vti", "EQUITY", dec!(1000))];

        let securities = AllocationWorksheetService::securities_from(
            &rows.iter().collect::<Vec<_>>(),
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

    // ── Worksheet lines ─────────────────────────────────────────────────────

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
            cash: tracked(dec!(10)),
            lines: vec![line(WorksheetInputMode::Amount, dec!(10))],
            account_ids: vec!["acc-1".to_string()],
            base_currency: "USD".to_string(),
            aggregated_account_id: "all".to_string(),
            selected_account_ids: vec!["acc-1".to_string()],
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
    fn a_price_carrying_float_residue_still_buys_its_whole_unit() {
        // Providers send 32-bit floats, so 9.173 is recorded as a price a
        // fraction of a billionth above the amount meant to buy one of it.
        let (quantity, _) = AllocationWorksheetService::resolved_quantity_and_amount(
            &line(WorksheetInputMode::Amount, dec!(9.173)),
            dec!(9.173000335693359375),
            true,
        )
        .unwrap();

        assert_eq!(quantity, dec!(1));
    }

    #[test]
    fn an_amount_below_one_whole_unit_places_nothing_rather_than_failing() {
        // Refusing would fail the whole preview over one line the user can
        // still edit, and §5 reports an edit rather than correcting it.
        let (quantity, amount) = AllocationWorksheetService::resolved_quantity_and_amount(
            &line(WorksheetInputMode::Amount, dec!(40)),
            dec!(100),
            true,
        )
        .unwrap();

        assert_eq!(quantity, Decimal::ZERO);
        assert_eq!(amount, Decimal::ZERO);
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
    fn cash_to_deploy_is_met_with_what_the_chosen_accounts_record() {
        // Both halves of the service share the rule, so a prefilled worksheet
        // never fails a check its own generation passed.
        assert_eq!(
            AllocationWorksheetService::tracked_cash_to_use(dec!(600), dec!(1000)),
            dec!(600)
        );
        assert_eq!(
            AllocationWorksheetService::tracked_cash_to_use(dec!(1100), dec!(1000)),
            dec!(1000)
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
}
