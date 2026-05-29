use crate::activities::{
    Activity, ActivityRepositoryTrait, ActivityStatus, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::errors::{CalculatorError, Error as CoreError, Result as CoreResult};
use crate::fx::currency::normalize_currency_code;
use crate::fx::FxServiceTrait;
use crate::portfolio::performance::{
    classify_flow_for_scope, classify_transfer_for_account_scope, infer_paired_transfer_account_id,
    FlowType, PerformanceScope,
};
use crate::portfolio::snapshot::{Position, SnapshotServiceTrait};
use crate::portfolio::valuation::valuation_calculator::calculate_valuation;
use crate::portfolio::valuation::valuation_model::{DailyAccountValuation, NegativeBalanceInfo};
use crate::portfolio::valuation::ValuationRepositoryTrait;
use crate::quotes::QuoteServiceTrait;
use crate::utils::time_utils;
use async_trait::async_trait;
use chrono::NaiveDate;
use log::{debug, error, warn};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use super::DailyFxRateMap;

static VALUATION_SERVICE_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Controls the scope of a valuation history recalculation.
#[derive(Clone, Debug)]
pub enum ValuationRecalcMode {
    /// Delete all valuations and recalculate from the first snapshot.
    Full,
    /// Resume from the latest saved valuation date, only computing new dates forward.
    IncrementalFromLast,
    /// Delete valuations from `date` forward and recalculate from that date.
    SinceDate(NaiveDate),
}

#[async_trait]
pub trait ValuationServiceTrait: Send + Sync {
    /// Ensures the valuation history for the account is calculated and stored.
    ///
    /// The `mode` controls how much history is recomputed:
    /// - `Full`: delete all valuations and recalculate from the first snapshot.
    /// - `IncrementalFromLast`: resume from the latest saved valuation date.
    /// - `SinceDate(date)`: delete valuations from `date` forward and recalculate from that date.
    ///
    /// Args:
    ///     account_id: The ID of a real account.
    ///     mode: Controls the recalculation scope.
    async fn calculate_valuation_history(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()>;

    /// Loads the valuation data for the account within the specified date range.
    ///
    /// Args:
    ///     account_id: The ID of a real account.
    ///     start_date_opt: Optional start date (inclusive).
    ///     end_date_opt: Optional end date (inclusive).
    ///
    /// Returns:
    ///     A `Result` containing a vector of `DailyAccountValuation` or an error.
    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Loads and aggregates valuation history for a concrete account scope.
    fn get_historical_valuations_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Loads the latest valuation history record for a list of accounts.
    ///
    /// Args:
    ///     account_ids: A slice of account IDs.
    ///
    /// Returns:
    ///     A `Result` containing a `HashMap` mapping account IDs to their
    ///     latest `DailyAccountValuation` (if found), or `None` if no history exists.
    ///     latest `DailyAccountValuation` for each account that has one.
    fn get_latest_valuations(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> CoreResult<Vec<DailyAccountValuation>>;

    /// Returns info about accounts that have at least one negative total_value in their history.
    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<NegativeBalanceInfo>>;
}

#[derive(Clone)]
pub struct ValuationService {
    base_currency: Arc<RwLock<String>>,
    valuation_repository: Arc<dyn ValuationRepositoryTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    activity_repository: Option<Arc<dyn ActivityRepositoryTrait>>,
    timezone: Arc<RwLock<String>>,
    scoped_history_cache: Arc<RwLock<HashMap<ScopedValuationCacheKey, Vec<DailyAccountValuation>>>>,
    service_instance_id: u64,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ScopedValuationCacheKey {
    service_instance_id: u64,
    scope_id: String,
    membership_hash: String,
    base_currency: String,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    max_calculated_at: String,
}

impl ValuationService {
    pub fn new(
        base_currency: Arc<RwLock<String>>,
        valuation_repository: Arc<dyn ValuationRepositoryTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self {
            base_currency,
            snapshot_service,
            quote_service,
            fx_service,
            valuation_repository,
            activity_repository: None,
            timezone: Arc::new(RwLock::new(String::new())),
            scoped_history_cache: Arc::new(RwLock::new(HashMap::new())),
            service_instance_id: VALUATION_SERVICE_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed),
        }
    }

    pub fn with_activity_repository(
        mut self,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        self.activity_repository = Some(activity_repository);
        self.timezone = timezone;
        self
    }

    fn membership_hash(account_ids: &[String]) -> String {
        let mut ids = account_ids.to_vec();
        ids.sort();
        ids.dedup();
        let digest = Sha256::digest(ids.join("\n").as_bytes());
        hex::encode(&digest[..8])
    }

    fn position_requires_price_quote(position: &Position) -> bool {
        !position.is_alternative
    }

    fn position_counts_for_quote_gating(position: &Position) -> bool {
        Self::position_requires_price_quote(position) && !position.quantity.is_zero()
    }

    async fn fetch_fx_rates_for_range(
        &self,
        pairs: &HashSet<(String, String)>,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> CoreResult<HashMap<NaiveDate, DailyFxRateMap>> {
        if pairs.is_empty() {
            return Ok(HashMap::new());
        }

        let mut fx_rates_by_date: HashMap<NaiveDate, DailyFxRateMap> = HashMap::new();
        let date_range = time_utils::get_days_between(start_date, end_date);

        for current_date in date_range {
            let mut daily_map: DailyFxRateMap = HashMap::with_capacity(pairs.len());
            for (from_curr, to_curr) in pairs {
                match self
                    .fx_service
                    .get_exchange_rate_for_date(from_curr, to_curr, current_date)
                {
                    Ok(rate) => {
                        daily_map.insert((from_curr.clone(), to_curr.clone()), rate);
                    }
                    Err(e) => {
                        warn!(
                            "Failed to get FX rate {}->{} for date {}: {}. Valuation for this date might be affected.",
                            from_curr, to_curr, current_date, e
                        );
                    }
                }
            }
            if !daily_map.is_empty() {
                fx_rates_by_date.insert(current_date, daily_map);
            }
        }

        Ok(fx_rates_by_date)
    }

    async fn fetch_fx_rates_for_dates(
        &self,
        pairs: &HashSet<(String, String)>,
        dates: &HashSet<NaiveDate>,
    ) -> CoreResult<HashMap<NaiveDate, DailyFxRateMap>> {
        if pairs.is_empty() || dates.is_empty() {
            return Ok(HashMap::new());
        }

        let mut fx_rates_by_date: HashMap<NaiveDate, DailyFxRateMap> =
            HashMap::with_capacity(dates.len());

        for current_date in dates {
            let mut daily_map: DailyFxRateMap = HashMap::with_capacity(pairs.len());
            for (from_curr, to_curr) in pairs {
                match self
                    .fx_service
                    .get_exchange_rate_for_date(from_curr, to_curr, *current_date)
                {
                    Ok(rate) => {
                        daily_map.insert((from_curr.clone(), to_curr.clone()), rate);
                    }
                    Err(e) => {
                        warn!(
                            "Failed to get acquisition FX rate {}->{} for date {}: {}.",
                            from_curr, to_curr, current_date, e
                        );
                    }
                }
            }
            if !daily_map.is_empty() {
                fx_rates_by_date.insert(*current_date, daily_map);
            }
        }

        Ok(fx_rates_by_date)
    }

    fn aggregate_scoped_valuations(
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        histories: Vec<Vec<DailyAccountValuation>>,
        external_flows_by_date: Option<&HashMap<NaiveDate, (Decimal, Decimal)>>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        Self::validate_scoped_history_completeness(account_ids, &histories)?;

        let mut by_date: std::collections::BTreeMap<NaiveDate, DailyAccountValuation> =
            std::collections::BTreeMap::new();

        for valuation in histories.into_iter().flatten() {
            let entry =
                by_date
                    .entry(valuation.valuation_date)
                    .or_insert_with(|| DailyAccountValuation {
                        id: format!("{}_{}", scope_id, valuation.valuation_date),
                        account_id: scope_id.to_string(),
                        valuation_date: valuation.valuation_date,
                        account_currency: base_currency.to_string(),
                        base_currency: base_currency.to_string(),
                        fx_rate_to_base: rust_decimal::Decimal::ONE,
                        cash_balance: rust_decimal::Decimal::ZERO,
                        investment_market_value: rust_decimal::Decimal::ZERO,
                        total_value: rust_decimal::Decimal::ZERO,
                        cost_basis: rust_decimal::Decimal::ZERO,
                        net_contribution: rust_decimal::Decimal::ZERO,
                        cash_balance_base: rust_decimal::Decimal::ZERO,
                        investment_market_value_base: rust_decimal::Decimal::ZERO,
                        total_value_base: rust_decimal::Decimal::ZERO,
                        cost_basis_base: rust_decimal::Decimal::ZERO,
                        net_contribution_base: rust_decimal::Decimal::ZERO,
                        external_inflow_base: rust_decimal::Decimal::ZERO,
                        external_outflow_base: rust_decimal::Decimal::ZERO,
                        performance_eligible_value_base: rust_decimal::Decimal::ZERO,
                        calculated_at: valuation.calculated_at,
                    });

            entry.cash_balance += valuation.cash_balance_base;
            entry.investment_market_value += valuation.investment_market_value_base;
            entry.total_value += valuation.total_value_base;
            entry.cost_basis += valuation.cost_basis_base;
            entry.net_contribution += valuation.net_contribution_base;
            entry.cash_balance_base += valuation.cash_balance_base;
            entry.investment_market_value_base += valuation.investment_market_value_base;
            entry.total_value_base += valuation.total_value_base;
            entry.cost_basis_base += valuation.cost_basis_base;
            entry.net_contribution_base += valuation.net_contribution_base;
            entry.performance_eligible_value_base += valuation.performance_eligible_value_base;
            entry.calculated_at = entry.calculated_at.max(valuation.calculated_at);
        }

        let mut values: Vec<_> = by_date.into_values().collect();
        match external_flows_by_date {
            Some(flows_by_date) => {
                Self::set_external_flows_from_activity_map_or_net_contribution_base(
                    &mut values,
                    flows_by_date,
                );
            }
            None => Self::set_external_flows_from_net_contribution_base(&mut values),
        }
        Ok(values)
    }

    fn validate_scoped_history_completeness(
        account_ids: &[String],
        histories: &[Vec<DailyAccountValuation>],
    ) -> CoreResult<()> {
        if histories.len() != account_ids.len() {
            return Err(CoreError::Calculation(CalculatorError::Calculation(
                format!(
                "Scoped valuation history count mismatch: expected {} account histories, got {}",
                account_ids.len(),
                histories.len()
            ),
            )));
        }

        let union_dates: BTreeSet<NaiveDate> = histories
            .iter()
            .flat_map(|history| history.iter().map(|valuation| valuation.valuation_date))
            .collect();
        let scope_last_date = union_dates.iter().next_back().copied();

        for (account_id, history) in account_ids.iter().zip(histories.iter()) {
            if history.is_empty() {
                continue;
            }

            let account_dates: HashSet<NaiveDate> = history
                .iter()
                .map(|valuation| valuation.valuation_date)
                .collect();
            let first_date = history
                .iter()
                .map(|valuation| valuation.valuation_date)
                .min()
                .expect("non-empty history has first date");
            let last_date = history
                .iter()
                .map(|valuation| valuation.valuation_date)
                .max()
                .expect("non-empty history has last date");

            let missing_dates: Vec<NaiveDate> = union_dates
                .iter()
                .copied()
                .filter(|date| {
                    *date >= first_date && *date <= last_date && !account_dates.contains(date)
                })
                .take(5)
                .collect();

            if !missing_dates.is_empty() {
                let preview = missing_dates
                    .iter()
                    .map(|date| date.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(CoreError::Calculation(CalculatorError::Calculation(format!(
                    "Incomplete scoped valuation history for account '{}': missing valuation date(s) inside its active range: {}",
                    account_id, preview
                ))));
            }

            if let Some(scope_last_date) = scope_last_date {
                if last_date < scope_last_date {
                    let latest = history
                        .iter()
                        .max_by_key(|valuation| valuation.valuation_date)
                        .expect("non-empty history has latest valuation");
                    if !latest.total_value_base.is_zero() {
                        return Err(CoreError::Calculation(CalculatorError::Calculation(format!(
                            "Incomplete scoped valuation history for account '{}': latest valuation is {}, but scope continues through {}",
                            account_id, last_date, scope_last_date
                        ))));
                    }
                }
            }
        }

        Ok(())
    }

    fn split_external_flow(delta: Decimal) -> (Decimal, Decimal) {
        if delta.is_sign_negative() {
            (Decimal::ZERO, -delta)
        } else {
            (delta, Decimal::ZERO)
        }
    }

    fn set_external_flows_from_net_contribution_base(values: &mut [DailyAccountValuation]) {
        if values.is_empty() {
            return;
        }

        values.sort_by_key(|valuation| valuation.valuation_date);
        values[0].external_inflow_base = rust_decimal::Decimal::ZERO;
        values[0].external_outflow_base = rust_decimal::Decimal::ZERO;

        for index in 1..values.len() {
            let delta =
                values[index].net_contribution_base - values[index - 1].net_contribution_base;
            let (inflow, outflow) = Self::split_external_flow(delta);
            values[index].external_inflow_base = inflow;
            values[index].external_outflow_base = outflow;
        }
    }

    fn set_external_flows_from_activity_map_or_net_contribution_base(
        values: &mut [DailyAccountValuation],
        flows_by_date: &HashMap<NaiveDate, (Decimal, Decimal)>,
    ) {
        if values.is_empty() {
            return;
        }

        values.sort_by_key(|valuation| valuation.valuation_date);
        values[0].external_inflow_base = Decimal::ZERO;
        values[0].external_outflow_base = Decimal::ZERO;

        for index in 1..values.len() {
            let delta =
                values[index].net_contribution_base - values[index - 1].net_contribution_base;
            if let Some((inflow, outflow)) = flows_by_date.get(&values[index].valuation_date) {
                let classified_net_flow = *inflow - *outflow;
                let residual_net_flow = delta - classified_net_flow;
                let (residual_inflow, residual_outflow) =
                    Self::split_external_flow(residual_net_flow);
                values[index].external_inflow_base = *inflow + residual_inflow;
                values[index].external_outflow_base = *outflow + residual_outflow;
                continue;
            }

            let (inflow, outflow) = Self::split_external_flow(delta);
            values[index].external_inflow_base = inflow;
            values[index].external_outflow_base = outflow;
        }
    }

    fn activity_flow_amount(activity: &Activity) -> Decimal {
        activity
            .amount
            .or_else(|| Some(activity.quantity? * activity.unit_price?))
            .unwrap_or(Decimal::ZERO)
            .abs()
    }

    fn activity_is_outflow(activity: &Activity) -> bool {
        let effective_type = activity.effective_type();
        effective_type == ACTIVITY_TYPE_WITHDRAWAL || effective_type == ACTIVITY_TYPE_TRANSFER_OUT
    }

    fn activity_flow_amount_base(
        &self,
        activity: &Activity,
        base_currency: &str,
        activity_date: NaiveDate,
    ) -> Decimal {
        let amount = Self::activity_flow_amount(activity);
        if amount.is_zero() {
            return Decimal::ZERO;
        }

        let activity_currency = normalize_currency_code(&activity.currency);
        let base_currency = normalize_currency_code(base_currency);
        if activity_currency == base_currency {
            return amount;
        }

        match self.fx_service.convert_currency_for_date(
            amount,
            activity_currency,
            base_currency,
            activity_date,
        ) {
            Ok(converted) => converted,
            Err(err) => {
                warn!(
                    "Failed to convert external flow {} {}->{} on {} for activity {}: {}. Flow omitted.",
                    amount, activity_currency, base_currency, activity_date, activity.id, err
                );
                Decimal::ZERO
            }
        }
    }

    fn scoped_external_flows_by_date(
        &self,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Option<HashMap<NaiveDate, (Decimal, Decimal)>>> {
        let Some(activity_repository) = &self.activity_repository else {
            return Ok(None);
        };
        if account_ids.is_empty() {
            return Ok(Some(HashMap::new()));
        }

        let all_activities: Vec<Activity> = activity_repository
            .get_activities()?
            .into_iter()
            .filter(|activity| matches!(activity.status, ActivityStatus::Posted))
            .collect();
        let scope_account_ids: HashSet<String> = account_ids.iter().cloned().collect();
        let timezone = {
            let timezone_guard = self.timezone.read().unwrap();
            time_utils::parse_user_timezone_or_default(&timezone_guard)
        };

        let mut flows_by_date: HashMap<NaiveDate, (Decimal, Decimal)> = HashMap::new();

        for activity in all_activities
            .iter()
            .filter(|activity| scope_account_ids.contains(&activity.account_id))
        {
            let activity_date = time_utils::activity_date_in_tz(activity.activity_date, timezone);
            if start_date_opt
                .map(|start_date| activity_date < start_date)
                .unwrap_or(false)
                || end_date_opt
                    .map(|end_date| activity_date > end_date)
                    .unwrap_or(false)
            {
                continue;
            }

            let effective_type = activity.effective_type();
            let flow_type = if effective_type == ACTIVITY_TYPE_TRANSFER_IN
                || effective_type == ACTIVITY_TYPE_TRANSFER_OUT
            {
                let paired_account_id =
                    infer_paired_transfer_account_id(activity, &all_activities, |candidate| {
                        time_utils::activity_date_in_tz(candidate.activity_date, timezone)
                    });
                let flow_type = classify_transfer_for_account_scope(
                    activity,
                    &scope_account_ids,
                    paired_account_id.as_deref(),
                );
                if flow_type == FlowType::External && paired_account_id.is_none() {
                    warn!(
                        "Unpaired transfer activity {} on {} treated as an external scoped flow.",
                        activity.id, activity_date
                    );
                }
                flow_type
            } else {
                classify_flow_for_scope(activity, PerformanceScope::Portfolio)
            };

            if flow_type != FlowType::External {
                continue;
            }

            let amount_base =
                self.activity_flow_amount_base(activity, base_currency, activity_date);
            if amount_base.is_zero() {
                continue;
            }

            let entry = flows_by_date
                .entry(activity_date)
                .or_insert((Decimal::ZERO, Decimal::ZERO));
            if Self::activity_is_outflow(activity) {
                entry.1 += amount_base;
            } else {
                entry.0 += amount_base;
            }
        }

        Ok(Some(flows_by_date))
    }
}

#[async_trait]
impl ValuationServiceTrait for ValuationService {
    async fn calculate_valuation_history(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()> {
        let total_start_time = Instant::now();
        debug!(
            "Starting valuation data update/recalculation for account '{}', mode: {:?}",
            account_id, mode
        );

        let mut calculation_start_date: Option<NaiveDate> = None;
        let mut incremental_anchor_date: Option<NaiveDate> = None;
        let replace_since_date = match &mode {
            ValuationRecalcMode::Full => Some(None),
            ValuationRecalcMode::SinceDate(date) => Some(Some(*date)),
            ValuationRecalcMode::IncrementalFromLast => None,
        };

        match &mode {
            ValuationRecalcMode::Full => {}
            ValuationRecalcMode::SinceDate(date) => {
                calculation_start_date = Some(*date);
            }
            ValuationRecalcMode::IncrementalFromLast => {
                let last_saved_date_opt = self
                    .valuation_repository
                    .load_latest_valuation_date(account_id)?;

                if let Some(last_saved) = last_saved_date_opt {
                    calculation_start_date = Some(last_saved);
                    incremental_anchor_date = Some(last_saved);
                }
            }
        }

        let snapshots_to_process = self
            .snapshot_service
            .get_daily_holdings_snapshots(account_id, calculation_start_date, None)
            .map_err(|e| {
                CoreError::Calculation(CalculatorError::Calculation(format!(
                    "Failed snapshot fetch for account {}: {}",
                    account_id, e
                )))
            })?;

        if snapshots_to_process.is_empty() {
            if let Some(since_date) = replace_since_date {
                self.valuation_repository
                    .replace_valuations_for_account(account_id, since_date, &[])
                    .await?;
            }
            return Ok(());
        }

        let actual_calculation_start_date = snapshots_to_process.first().unwrap().snapshot_date;
        let calculation_end_date = snapshots_to_process.last().unwrap().snapshot_date;

        let mut required_asset_ids = HashSet::new();
        let mut required_fx_pairs = HashSet::new();
        let mut acquisition_fx_pairs = HashSet::new();
        let mut acquisition_fx_dates = HashSet::new();
        let base_curr = {
            let base_guard = self.base_currency.read().unwrap();
            normalize_currency_code(&base_guard).to_string()
        };
        let mut normalized_account_currency: Option<String> = None;

        for snapshot in &snapshots_to_process {
            let account_curr = normalize_currency_code(&snapshot.currency);
            if normalized_account_currency.is_none() {
                normalized_account_currency = Some(account_curr.to_string());
            }
            if account_curr != base_curr {
                required_fx_pairs.insert((account_curr.to_string(), base_curr.clone()));
            }
            for (asset_id, position) in &snapshot.positions {
                if !Self::position_requires_price_quote(position) {
                    continue;
                }
                required_asset_ids.insert(asset_id.clone());
                let position_currency = normalize_currency_code(&position.currency);
                if position_currency != account_curr {
                    required_fx_pairs
                        .insert((position_currency.to_string(), account_curr.to_string()));
                }
                if position_currency != base_curr {
                    required_fx_pairs.insert((position_currency.to_string(), base_curr.clone()));
                    if !position.lots.is_empty() {
                        acquisition_fx_pairs
                            .insert((position_currency.to_string(), base_curr.clone()));
                        for lot in &position.lots {
                            acquisition_fx_dates.insert(lot.acquisition_date.date_naive());
                        }
                    }
                }
            }
            for cash_curr in snapshot.cash_balances.keys() {
                let normalized_cash_currency = normalize_currency_code(cash_curr);
                if normalized_cash_currency != account_curr {
                    required_fx_pairs.insert((
                        normalized_cash_currency.to_string(),
                        account_curr.to_string(),
                    ));
                }
            }
        }

        let account_curr = normalized_account_currency.unwrap_or_else(|| base_curr.clone());

        // Fetch quotes with single call
        let quotes_vec = self.quote_service.get_quotes_in_range_filled(
            &required_asset_ids,
            actual_calculation_start_date,
            calculation_end_date,
        )?;

        for quote in &quotes_vec {
            let normalized_quote_currency = normalize_currency_code(&quote.currency);
            if normalized_quote_currency != account_curr.as_str() {
                required_fx_pairs
                    .insert((normalized_quote_currency.to_string(), account_curr.clone()));
            }
        }

        let mut fx_rates_by_date = self
            .fetch_fx_rates_for_range(
                &required_fx_pairs,
                actual_calculation_start_date,
                calculation_end_date,
            )
            .await?;
        let acquisition_fx_rates_by_date = self
            .fetch_fx_rates_for_dates(&acquisition_fx_pairs, &acquisition_fx_dates)
            .await?;
        for (date, rates) in acquisition_fx_rates_by_date {
            fx_rates_by_date.entry(date).or_default().extend(rates);
        }

        // Build quotes_by_date and track which assets have ANY quotes at all
        let mut assets_with_quotes: HashSet<String> = HashSet::new();
        let quotes_by_date = {
            let mut map = HashMap::new();
            for quote in quotes_vec {
                assets_with_quotes.insert(quote.asset_id.clone());
                map.entry(quote.timestamp.date_naive())
                    .or_insert_with(HashMap::new)
                    .insert(quote.asset_id.clone(), quote);
            }
            map
        };

        let mut skipped_incomplete_dates: Vec<(NaiveDate, String)> = Vec::new();
        let mut newly_calculated_valuations: Vec<DailyAccountValuation> = snapshots_to_process
            .into_iter()
            .filter_map(|holdings_snapshot| {
                let current_date = holdings_snapshot.snapshot_date;
                let account_id_clone = account_id.to_string();
                let base_curr_clone = base_curr.clone();

                let quotes_for_current_date =
                    quotes_by_date.get(&current_date).cloned().unwrap_or_default();

                let fx_for_current_date = fx_rates_by_date
                    .get(&current_date)
                    .cloned()
                    .unwrap_or_default();

                // Count quotable positions (those with quotes somewhere in the range)
                // and how many are missing a quote on this specific date.
                let quotable_positions: Vec<_> = holdings_snapshot
                    .positions
                    .iter()
                    .filter(|(_, position)| Self::position_counts_for_quote_gating(position))
                    .map(|(symbol, _)| symbol)
                    .filter(|symbol| assets_with_quotes.contains(*symbol))
                    .cloned()
                    .collect();

                let missing_quotes: Vec<_> = quotable_positions
                    .iter()
                    .filter(|symbol| !quotes_for_current_date.contains_key(*symbol))
                    .cloned()
                    .collect();

                // Full gap: no quotes at all for any quotable position → skip day
                // to avoid recording a fake zero-value valuation.
                if !quotable_positions.is_empty() && missing_quotes.len() == quotable_positions.len()
                {
                    debug!(
                        "No quotes for any quotable position on {} (account '{}'). Skipping day.",
                        current_date, account_id_clone
                    );
                    return None;
                }

                // Partial gap: some quotes present, some missing → proceed.
                // Missing positions valued at ZERO by the calculator, which is
                // better than dropping the entire day (see #683).
                if !missing_quotes.is_empty() {
                    debug!(
                        "Partial quote gap for {:?} on {} (account '{}').",
                        missing_quotes, current_date, account_id_clone
                    );
                }
                let account_curr = &holdings_snapshot.currency;
                if account_curr != &base_curr_clone
                    && !fx_for_current_date
                        .contains_key(&(account_curr.clone(), base_curr_clone.clone()))
                {
                    warn!(
                        "Base currency FX rate ({}->{}) missing for {} (account '{}'). Skipping day.",
                        account_curr, base_curr_clone, current_date, account_id_clone
                    );
                    skipped_incomplete_dates.push((
                        current_date,
                        format!(
                            "missing base-currency FX rate {}->{}",
                            account_curr, base_curr_clone
                        ),
                    ));
                    return None;
                }

                match calculate_valuation(
                    &holdings_snapshot,
                    &quotes_for_current_date,
                    &fx_for_current_date,
                    &fx_rates_by_date,
                    current_date,
                    &base_curr_clone,
                ) {
                    Ok(valuation_result) => Some(valuation_result),
                    Err(e) => {
                        error!(
                            "Failed to calculate valuation for account {} on date {}: {}. Skipping this date.",
                            account_id, current_date, e
                        );
                        skipped_incomplete_dates.push((current_date, e.to_string()));
                        None
                    }
                }
            })
            .collect();

        if !skipped_incomplete_dates.is_empty() {
            let preview = skipped_incomplete_dates
                .iter()
                .take(5)
                .map(|(date, reason)| format!("{} ({})", date, reason))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(CoreError::Calculation(CalculatorError::Calculation(format!(
                "Incomplete valuation history for account '{}': {} date(s) could not be calculated. First skipped dates: {}",
                account_id,
                skipped_incomplete_dates.len(),
                preview
            ))));
        }

        Self::set_external_flows_from_net_contribution_base(&mut newly_calculated_valuations);

        if let Some(anchor_date) = incremental_anchor_date {
            newly_calculated_valuations.retain(|valuation| valuation.valuation_date != anchor_date);
        }

        if let Some(since_date) = replace_since_date {
            self.valuation_repository
                .replace_valuations_for_account(
                    account_id,
                    since_date,
                    &newly_calculated_valuations,
                )
                .await?;
        } else if !newly_calculated_valuations.is_empty() {
            self.valuation_repository
                .save_valuations(&newly_calculated_valuations)
                .await?;
        }

        let total_duration = total_start_time.elapsed();
        debug!(
            "Successfully updated/recalculated valuation data for account '{}' in {:?}",
            account_id, total_duration
        );

        Ok(())
    }

    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        debug!(
            "Loading historical valuations for account '{}' from {:?} to {:?}",
            account_id, start_date_opt, end_date_opt
        );
        self.valuation_repository.get_historical_valuations(
            account_id,
            start_date_opt,
            end_date_opt,
        )
    }

    fn get_historical_valuations_for_accounts(
        &self,
        scope_id: &str,
        account_ids: &[String],
        base_currency: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        let records = self
            .valuation_repository
            .get_historical_valuations_for_accounts(account_ids, start_date_opt, end_date_opt)?;

        let max_calculated_at = records
            .iter()
            .map(|valuation| valuation.calculated_at.to_rfc3339())
            .max()
            .unwrap_or_default();
        let cache_key = ScopedValuationCacheKey {
            service_instance_id: self.service_instance_id,
            scope_id: scope_id.to_string(),
            membership_hash: Self::membership_hash(account_ids),
            base_currency: base_currency.to_string(),
            start_date: start_date_opt,
            end_date: end_date_opt,
            max_calculated_at,
        };

        if let Some(cached) = self
            .scoped_history_cache
            .read()
            .unwrap()
            .get(&cache_key)
            .cloned()
        {
            return Ok(cached);
        }

        let mut histories_by_account: HashMap<String, Vec<DailyAccountValuation>> =
            HashMap::with_capacity(account_ids.len());
        for record in records {
            histories_by_account
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
        let histories = account_ids
            .iter()
            .map(|account_id| histories_by_account.remove(account_id).unwrap_or_default())
            .collect();

        let external_flows_by_date = self.scoped_external_flows_by_date(
            account_ids,
            base_currency,
            start_date_opt,
            end_date_opt,
        )?;

        let aggregate = Self::aggregate_scoped_valuations(
            scope_id,
            account_ids,
            base_currency,
            histories,
            external_flows_by_date.as_ref(),
        )?;

        {
            let mut cache = self.scoped_history_cache.write().unwrap();
            if cache.len() > 128 {
                cache.clear();
            }
            cache.insert(cache_key, aggregate.clone());
        }

        Ok(aggregate)
    }

    fn get_latest_valuations(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        debug!("Loading latest valuations for accounts: {:?}", account_ids);
        self.valuation_repository.get_latest_valuations(account_ids)
    }

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> CoreResult<Vec<DailyAccountValuation>> {
        debug!(
            "Loading valuations for accounts {:?} on date {}",
            account_ids, date
        );
        self.valuation_repository
            .get_valuations_on_date(account_ids, date)
    }

    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> CoreResult<Vec<NegativeBalanceInfo>> {
        self.valuation_repository
            .get_accounts_with_negative_balance(account_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;

    fn valuation(
        account_id: &str,
        date: &str,
        total_value_base: Decimal,
        net_contribution_base: Decimal,
        external_inflow_base: Decimal,
        external_outflow_base: Decimal,
    ) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("{}-{}", account_id, date),
            account_id: account_id.to_string(),
            valuation_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            account_currency: "CAD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: total_value_base,
            investment_market_value: Decimal::ZERO,
            total_value: total_value_base,
            cost_basis: Decimal::ZERO,
            net_contribution: net_contribution_base,
            cash_balance_base: total_value_base,
            investment_market_value_base: Decimal::ZERO,
            total_value_base,
            cost_basis_base: Decimal::ZERO,
            net_contribution_base,
            external_inflow_base,
            external_outflow_base,
            performance_eligible_value_base: total_value_base,
            calculated_at: DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
        }
    }

    #[test]
    fn quote_gating_ignores_alternative_positions() {
        let market_position = Position {
            quantity: dec!(1),
            is_alternative: false,
            ..Position::default()
        };
        let alternative_position = Position {
            quantity: dec!(1),
            is_alternative: true,
            ..Position::default()
        };

        assert!(ValuationService::position_requires_price_quote(
            &market_position
        ));
        assert!(ValuationService::position_counts_for_quote_gating(
            &market_position
        ));
        assert!(!ValuationService::position_requires_price_quote(
            &alternative_position
        ));
        assert!(!ValuationService::position_counts_for_quote_gating(
            &alternative_position
        ));
    }

    #[test]
    fn scoped_aggregation_sums_base_values_and_recomputes_external_flows() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    dec!(50),
                ),
                valuation(
                    "a1",
                    "2026-05-03",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(50),
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-03",
                    dec!(70),
                    dec!(70),
                    dec!(20),
                    Decimal::ZERO,
                ),
            ],
        ];

        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate.len(), 3);
        assert_eq!(aggregate[0].account_id, "accounts:test");
        assert_eq!(aggregate[0].account_currency, "USD");
        assert_eq!(aggregate[0].total_value, dec!(100));
        assert_eq!(aggregate[0].total_value_base, dec!(100));
        assert_eq!(aggregate[1].net_contribution_base, dec!(100));
        assert_eq!(aggregate[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(aggregate[2].net_contribution_base, dec!(120));
        assert_eq!(aggregate[2].external_inflow_base, dec!(20));
        assert_eq!(aggregate[2].external_outflow_base, Decimal::ZERO);
    }

    #[test]
    fn scoped_aggregation_uses_activity_external_flows_when_available() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    dec!(100),
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(100),
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(flow_date, (dec!(100), dec!(100)));

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            Some(&flows_by_date),
        )
        .expect("complete scoped histories should aggregate");

        assert_eq!(aggregate[1].net_contribution_base, dec!(100));
        assert_eq!(aggregate[1].external_inflow_base, dec!(100));
        assert_eq!(aggregate[1].external_outflow_base, dec!(100));
    }

    #[test]
    fn scoped_aggregation_adds_residual_snapshot_flow_on_activity_flow_date() {
        let histories = vec![
            vec![
                valuation(
                    "transactions",
                    "2026-05-01",
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "transactions",
                    "2026-05-02",
                    dec!(200),
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "holdings",
                    "2026-05-01",
                    dec!(1000),
                    dec!(1000),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "holdings",
                    "2026-05-02",
                    dec!(1100),
                    dec!(1100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["transactions".to_string(), "holdings".to_string()];
        let flow_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let mut flows_by_date = HashMap::new();
        flows_by_date.insert(flow_date, (dec!(100), Decimal::ZERO));

        let aggregate = ValuationService::aggregate_scoped_valuations(
            "accounts:mixed",
            &account_ids,
            "USD",
            histories,
            Some(&flows_by_date),
        )
        .expect("mixed scoped histories should aggregate");

        assert_eq!(aggregate[1].net_contribution_base, dec!(1200));
        assert_eq!(aggregate[1].external_inflow_base, dec!(200));
        assert_eq!(aggregate[1].external_outflow_base, Decimal::ZERO);
    }

    #[test]
    fn scoped_aggregation_rejects_interior_account_history_gaps() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-03",
                    dec!(120),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(55),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-03",
                    dec!(60),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];

        let err = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
        )
        .expect_err("missing account valuation date should be rejected");

        assert!(err
            .to_string()
            .contains("Incomplete scoped valuation history for account 'a1'"));
        assert!(err.to_string().contains("2026-05-02"));
    }

    #[test]
    fn scoped_aggregation_rejects_stale_nonzero_account_tail() {
        let histories = vec![
            vec![
                valuation(
                    "a1",
                    "2026-05-01",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a1",
                    "2026-05-02",
                    dec!(100),
                    dec!(100),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
            vec![
                valuation(
                    "a2",
                    "2026-05-01",
                    dec!(50),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-02",
                    dec!(55),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
                valuation(
                    "a2",
                    "2026-05-03",
                    dec!(60),
                    dec!(50),
                    Decimal::ZERO,
                    Decimal::ZERO,
                ),
            ],
        ];
        let account_ids = vec!["a1".to_string(), "a2".to_string()];

        let err = ValuationService::aggregate_scoped_valuations(
            "accounts:test",
            &account_ids,
            "USD",
            histories,
            None,
        )
        .expect_err("stale nonzero account tail should be rejected");

        assert!(err.to_string().contains("latest valuation is 2026-05-02"));
    }

    #[test]
    fn incremental_anchor_preserves_next_day_external_flow_delta() {
        let anchor_date = NaiveDate::parse_from_str("2026-05-01", "%Y-%m-%d").unwrap();
        let mut values = vec![
            valuation(
                "a1",
                "2026-05-01",
                dec!(100),
                dec!(100),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            valuation(
                "a1",
                "2026-05-02",
                dec!(150),
                dec!(125),
                Decimal::ZERO,
                Decimal::ZERO,
            ),
        ];

        ValuationService::set_external_flows_from_net_contribution_base(&mut values);
        values.retain(|valuation| valuation.valuation_date != anchor_date);

        assert_eq!(values.len(), 1);
        assert_eq!(values[0].valuation_date.to_string(), "2026-05-02");
        assert_eq!(values[0].external_inflow_base, dec!(25));
        assert_eq!(values[0].external_outflow_base, Decimal::ZERO);
    }
}
