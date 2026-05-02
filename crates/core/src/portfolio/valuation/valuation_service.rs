use crate::accounts::AccountRepositoryTrait;
use crate::activities::ActivityRepositoryTrait;
use crate::assets::AssetRepositoryTrait;
use crate::errors::{CalculatorError, Error as CoreError, Result as CoreResult};
use crate::fx::currency::normalize_currency_code;
use crate::fx::FxServiceTrait;
use crate::lots::LotRepositoryTrait;
use crate::portfolio::snapshot::{Position, SnapshotServiceTrait};
use crate::portfolio::transfers;
use crate::portfolio::valuation::valuation_calculator::calculate_valuation;
use crate::portfolio::valuation::valuation_model::{DailyAccountValuation, NegativeBalanceInfo};
use crate::portfolio::valuation::ValuationRepositoryTrait;
use crate::quotes::QuoteServiceTrait;
use crate::utils::time_utils;
use async_trait::async_trait;
use chrono::NaiveDate;
use log::{debug, error, warn};
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use super::DailyFxRateMap;
use crate::constants::PORTFOLIO_TOTAL_ACCOUNT_ID;

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
    ///     account_id: The ID of the account ("TOTAL" for portfolio aggregate).
    ///     mode: Controls the recalculation scope.
    async fn calculate_valuation_history(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()>;

    /// Loads the valuation data for the account within the specified date range.
    ///
    /// Args:
    ///     account_id: The ID of the account ("TOTAL" for portfolio aggregate).
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
    timezone: Arc<RwLock<String>>,
    valuation_repository: Arc<dyn ValuationRepositoryTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    lot_repository: Arc<dyn LotRepositoryTrait>,
    asset_repository: Arc<dyn AssetRepositoryTrait>,
    account_repository: Arc<dyn AccountRepositoryTrait>,
    activity_repository: Arc<dyn ActivityRepositoryTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
}

impl ValuationService {
    pub fn new(
        base_currency: Arc<RwLock<String>>,
        valuation_repository: Arc<dyn ValuationRepositoryTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        lot_repository: Arc<dyn LotRepositoryTrait>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        account_repository: Arc<dyn AccountRepositoryTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self::new_with_timezone(
            base_currency,
            Arc::new(RwLock::new(String::new())),
            valuation_repository,
            snapshot_service,
            lot_repository,
            asset_repository,
            account_repository,
            activity_repository,
            quote_service,
            fx_service,
        )
    }

    pub fn new_with_timezone(
        base_currency: Arc<RwLock<String>>,
        timezone: Arc<RwLock<String>>,
        valuation_repository: Arc<dyn ValuationRepositoryTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        lot_repository: Arc<dyn LotRepositoryTrait>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        account_repository: Arc<dyn AccountRepositoryTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self {
            base_currency,
            timezone,
            valuation_repository,
            snapshot_service,
            lot_repository,
            asset_repository,
            account_repository,
            activity_repository,
            quote_service,
            fx_service,
        }
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

    /// Aggregate per-account valuations into TOTAL rows in `daily_account_valuation`.
    ///
    /// Sums existing per-account rows (converted to base currency via
    /// fx_rate_to_base) and writes the portfolio total back into the same
    /// table with `account_id = PORTFOLIO_TOTAL_ACCOUNT_ID`.
    async fn aggregate_portfolio_valuations(&self, mode: ValuationRecalcMode) -> CoreResult<()> {
        let start_time = Instant::now();
        let base_currency = self.base_currency.read().unwrap().clone();

        let mut start_date: Option<NaiveDate> = None;

        match &mode {
            ValuationRecalcMode::Full => {
                self.valuation_repository
                    .delete_valuations_for_account(PORTFOLIO_TOTAL_ACCOUNT_ID, None)
                    .await?;
            }
            ValuationRecalcMode::SinceDate(date) => {
                self.valuation_repository
                    .delete_valuations_for_account(PORTFOLIO_TOTAL_ACCOUNT_ID, Some(*date))
                    .await?;
                start_date = Some(*date);
            }
            ValuationRecalcMode::IncrementalFromLast => {
                let last = self
                    .valuation_repository
                    .load_latest_valuation_date(PORTFOLIO_TOTAL_ACCOUNT_ID)?;
                if let Some(d) = last {
                    start_date = Some(d);
                }
            }
        }

        // Load all per-account valuations and group by date.
        let all_vals = self
            .valuation_repository
            .get_all_account_valuations(start_date, None)?;

        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        for v in all_vals {
            by_date.entry(v.valuation_date).or_default().push(v);
        }

        // Per-account net_contribution treats paired internal transfers as
        // external (deposit on TRANSFER_IN, withdrawal on TRANSFER_OUT).
        // At the portfolio level those legs must cancel; compute the per-date
        // adjustments and accumulate them into a running total so the
        // cumulative amount can be subtracted from each date's contribution.
        let timezone = self.timezone.read().unwrap().clone();
        let non_archived_accounts = self.account_repository.list(None, Some(false), None)?;
        let account_ids: Vec<String> = non_archived_accounts
            .iter()
            .filter(|a| a.id != PORTFOLIO_TOTAL_ACCOUNT_ID)
            .map(|a| a.id.clone())
            .collect();
        let transfer_adjustments_by_date = transfers::internal_transfer_adjustments_by_date_base(
            self.activity_repository.as_ref(),
            self.fx_service.as_ref(),
            &account_ids,
            &base_currency,
            &timezone,
        )?;

        // Seed cumulative adjustment with all transfers strictly before the
        // first date being processed (incremental modes only).
        let mut cumulative_transfer_adjustment = Decimal::ZERO;
        if let Some(start) = start_date {
            for (date, adj) in &transfer_adjustments_by_date {
                if *date < start {
                    cumulative_transfer_adjustment += *adj;
                }
            }
        }

        let portfolio_rows = aggregate_rows_with_transfer_netting(
            by_date,
            &transfer_adjustments_by_date,
            cumulative_transfer_adjustment,
            &base_currency,
            chrono::Utc::now(),
        );

        if !portfolio_rows.is_empty() {
            self.valuation_repository
                .save_valuations(&portfolio_rows)
                .await?;
        }

        debug!(
            "Aggregated {} portfolio valuation rows in {:?}",
            portfolio_rows.len(),
            start_time.elapsed()
        );

        Ok(())
    }
}

/// Sums per-account valuations into portfolio rows, subtracting the cumulative
/// internal-transfer adjustment from each date's net_contribution.
///
/// `seed_cumulative` is the running adjustment total from all transfer dates
/// strictly before the first date in `by_date` (non-zero only in incremental
/// modes). Within the loop the cumulative is advanced **before** subtracting
/// so a transfer on date D is netted out of date D's contribution — matching
/// the merged-snapshot pipeline's semantics.
pub(crate) fn aggregate_rows_with_transfer_netting(
    by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>>,
    transfer_adjustments_by_date: &HashMap<NaiveDate, Decimal>,
    seed_cumulative: Decimal,
    base_currency: &str,
    calculated_at: chrono::DateTime<chrono::Utc>,
) -> Vec<DailyAccountValuation> {
    let mut sorted_dates: Vec<NaiveDate> = by_date.keys().copied().collect();
    sorted_dates.sort();

    let mut portfolio_rows: Vec<DailyAccountValuation> = Vec::with_capacity(sorted_dates.len());
    let mut cumulative_transfer_adjustment = seed_cumulative;

    for date in sorted_dates {
        if let Some(adj) = transfer_adjustments_by_date.get(&date) {
            cumulative_transfer_adjustment += *adj;
        }

        let vals = &by_date[&date];
        let mut cash = Decimal::ZERO;
        let mut inv = Decimal::ZERO;
        let mut alt = Decimal::ZERO;
        let mut cost = Decimal::ZERO;
        let mut contrib = Decimal::ZERO;

        for v in vals {
            let fx = v.fx_rate_to_base;
            cash += v.cash_balance * fx;
            inv += v.investment_market_value * fx;
            alt += v.alternative_market_value * fx;
            cost += v.cost_basis * fx;
            contrib += v.net_contribution * fx;
        }

        contrib -= cumulative_transfer_adjustment;

        let total_value = cash + inv + alt;

        portfolio_rows.push(DailyAccountValuation {
            id: format!("{}_{}", PORTFOLIO_TOTAL_ACCOUNT_ID, date),
            account_id: PORTFOLIO_TOTAL_ACCOUNT_ID.to_string(),
            valuation_date: date,
            account_currency: base_currency.to_string(),
            base_currency: base_currency.to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: cash,
            investment_market_value: inv,
            total_value,
            cost_basis: cost,
            net_contribution: contrib,
            calculated_at,
            alternative_market_value: alt,
        });
    }

    portfolio_rows
}

#[async_trait]
impl ValuationServiceTrait for ValuationService {
    async fn calculate_valuation_history(
        &self,
        account_id: &str,
        mode: ValuationRecalcMode,
    ) -> CoreResult<()> {
        // Portfolio-level: aggregate from per-account rows instead of recalculating.
        if account_id == PORTFOLIO_TOTAL_ACCOUNT_ID {
            return self.aggregate_portfolio_valuations(mode).await;
        }

        let total_start_time = Instant::now();
        debug!(
            "Starting valuation data update/recalculation for account '{}', mode: {:?}",
            account_id, mode
        );

        let mut calculation_start_date: Option<NaiveDate> = None;

        match &mode {
            ValuationRecalcMode::Full => {
                self.valuation_repository
                    .delete_valuations_for_account(account_id, None)
                    .await?;
            }
            ValuationRecalcMode::SinceDate(date) => {
                self.valuation_repository
                    .delete_valuations_for_account(account_id, Some(*date))
                    .await?;
                calculation_start_date = Some(*date);
            }
            ValuationRecalcMode::IncrementalFromLast => {
                let last_saved_date_opt = self
                    .valuation_repository
                    .load_latest_valuation_date(account_id)?;

                if let Some(last_saved) = last_saved_date_opt {
                    calculation_start_date = Some(last_saved);
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
            return Ok(());
        }

        let actual_calculation_start_date = snapshots_to_process.first().unwrap().snapshot_date;
        let calculation_end_date = snapshots_to_process.last().unwrap().snapshot_date;

        // Security positions: fetch all lots for this account once so we can filter per date
        // in memory rather than issuing one query per day in the range.
        // For the TOTAL pseudo-account, aggregate lots across all accounts.
        let all_lots = if account_id == PORTFOLIO_TOTAL_ACCOUNT_ID {
            self.lot_repository.get_all_lots().await?
        } else {
            self.lot_repository
                .get_all_lots_for_account(account_id)
                .await?
        };

        // Pre-fetch asset metadata for all assets referenced by lots.
        let lot_asset_ids: Vec<String> = all_lots
            .iter()
            .map(|l| l.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let assets = self.asset_repository.list_by_asset_ids(&lot_asset_ids)?;
        let asset_map: HashMap<String, _> = assets
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();

        let mut required_asset_ids: HashSet<String> = lot_asset_ids.into_iter().collect();
        let mut required_fx_pairs = HashSet::new();
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
            // Gather FX pairs for position currencies from asset metadata.
            for (asset_id, asset) in &asset_map {
                required_asset_ids.insert(asset_id.clone());
                let position_currency = normalize_currency_code(&asset.quote_ccy);
                if position_currency != account_curr {
                    required_fx_pairs
                        .insert((position_currency.to_string(), account_curr.to_string()));
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

        let fx_rates_by_date = self
            .fetch_fx_rates_for_range(
                &required_fx_pairs,
                actual_calculation_start_date,
                calculation_end_date,
            )
            .await?;

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

        // Security positions: fetch all lots for this account once so we can filter per date
        // in memory rather than issuing one query per day in the range.
        // For the TOTAL pseudo-account, aggregate lots across all accounts.
        let all_lots = if account_id == PORTFOLIO_TOTAL_ACCOUNT_ID {
            self.lot_repository.get_all_lots().await?
        } else {
            self.lot_repository
                .get_all_lots_for_account(account_id)
                .await?
        };

        // Pre-fetch asset metadata for all assets referenced by lots.
        let lot_asset_ids: Vec<String> = all_lots
            .iter()
            .map(|l| l.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let assets = self.asset_repository.list_by_asset_ids(&lot_asset_ids)?;
        let asset_map: HashMap<String, _> = assets
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();

        let newly_calculated_valuations: Vec<DailyAccountValuation> = snapshots_to_process
            .into_iter()
            .filter_map(|holdings_snapshot| {
                let current_date = holdings_snapshot.snapshot_date;
                let account_id_clone = account_id.to_string();
                let base_curr_clone = base_curr.clone();
                let date_str = current_date.format("%Y-%m-%d").to_string();

                // Build security positions from lots active on current_date.
                let mut aggregated: HashMap<String, (Decimal, Decimal)> = HashMap::new();
                for lot in &all_lots {
                    if lot.open_date.as_str() > date_str.as_str() {
                        continue;
                    }
                    if lot.is_closed {
                        let closed_before_or_on_date = lot
                            .close_date
                            .as_deref()
                            .is_none_or(|d| d <= date_str.as_str());
                        if closed_before_or_on_date {
                            continue;
                        }
                    }
                    let qty = lot.remaining_quantity.parse::<Decimal>().unwrap_or_else(|e| {
                        log::error!("Lot {} has malformed remaining_quantity '{}': {}", lot.id, lot.remaining_quantity, e);
                        Decimal::ZERO
                    });
                    let split_ratio = lot
                        .split_ratio
                        .parse::<Decimal>()
                        .ok()
                        .filter(|r| !r.is_zero())
                        .unwrap_or(Decimal::ONE);
                    // Effective shares = as-acquired remaining * cumulative split factor.
                    let effective_qty = qty * split_ratio;
                    let cost = lot.total_cost_basis.parse::<Decimal>().unwrap_or_else(|e| {
                        log::error!("Lot {} has malformed total_cost_basis '{}': {}", lot.id, lot.total_cost_basis, e);
                        Decimal::ZERO
                    });
                    aggregated
                        .entry(lot.asset_id.clone())
                        .and_modify(|(q, c)| {
                            *q += effective_qty;
                            *c += cost;
                        })
                        .or_insert((effective_qty, cost));
                }

                let positions_from_lots: HashMap<String, Position> = aggregated
                    .into_iter()
                    .filter(|(_, (qty, _))| !qty.is_zero())
                    .map(|(asset_id, (quantity, total_cost_basis))| {
                        let (currency, is_alternative, contract_multiplier) =
                            asset_map.get(&asset_id).map_or(
                                (String::new(), false, Decimal::ONE),
                                |a| (a.quote_ccy.clone(), a.is_alternative(), a.contract_multiplier()),
                            );
                        let average_cost = if quantity > Decimal::ZERO {
                            total_cost_basis / quantity
                        } else {
                            Decimal::ZERO
                        };
                        let mut pos = Position::new(
                            holdings_snapshot.account_id.clone(),
                            asset_id.clone(),
                            currency,
                            chrono::Utc::now(),
                        );
                        pos.quantity = quantity;
                        pos.total_cost_basis = total_cost_basis;
                        pos.average_cost = average_cost;
                        pos.is_alternative = is_alternative;
                        pos.contract_multiplier = contract_multiplier;
                        (asset_id, pos)
                    })
                    .collect();

                // Clone snapshot and replace positions with lot-derived data.
                let mut snapshot_with_lot_positions = holdings_snapshot;
                snapshot_with_lot_positions.positions = positions_from_lots;

                let quotes_for_current_date =
                    quotes_by_date.get(&current_date).cloned().unwrap_or_default();

                let fx_for_current_date = fx_rates_by_date
                    .get(&current_date)
                    .cloned()
                    .unwrap_or_default();

                // Count quotable positions (those with quotes somewhere in the range)
                // and how many are missing a quote on this specific date.
                let quotable_positions: Vec<_> = snapshot_with_lot_positions
                    .positions
                    .iter()
                    .filter(|(_, position)| !position.quantity.is_zero())
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

                let account_curr = &snapshot_with_lot_positions.currency;
                if account_curr != &base_curr_clone
                    && !fx_for_current_date
                        .contains_key(&(account_curr.clone(), base_curr_clone.clone()))
                {
                    warn!(
                        "Base currency FX rate ({}->{}) missing for {} (account '{}'). Skipping day.",
                        account_curr, base_curr_clone, current_date, account_id_clone
                    );
                    return None;
                }

                match calculate_valuation(
                    &snapshot_with_lot_positions,
                    &quotes_for_current_date,
                    &fx_for_current_date,
                    current_date,
                    &base_curr_clone,
                ) {
                    Ok(valuation_result) => Some(valuation_result),
                    Err(e) => {
                        error!(
                            "Failed to calculate valuation for account {} on date {}: {}. Skipping this date.",
                            account_id, current_date, e
                        );
                        None
                    }
                }
            })
            .collect();

        if !newly_calculated_valuations.is_empty() {
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
mod aggregator_tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use rust_decimal_macros::dec;

    fn val(account_id: &str, date: NaiveDate, contrib: Decimal, fx: Decimal) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("{}_{}", account_id, date),
            account_id: account_id.to_string(),
            valuation_date: date,
            account_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: fx,
            cash_balance: Decimal::ZERO,
            investment_market_value: Decimal::ZERO,
            total_value: Decimal::ZERO,
            cost_basis: Decimal::ZERO,
            net_contribution: contrib,
            calculated_at: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
            alternative_market_value: Decimal::ZERO,
        }
    }

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn no_transfers_means_naive_sum() {
        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        by_date.insert(d(2026, 1, 10), vec![
            val("A", d(2026, 1, 10), dec!(1000), Decimal::ONE),
            val("B", d(2026, 1, 10), dec!(500), Decimal::ONE),
        ]);
        let adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();

        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, Decimal::ZERO, "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].net_contribution, dec!(1500));
    }

    #[test]
    fn paired_transfer_on_same_day_nets_to_zero() {
        // Same-currency, same-day paired transfer: helper emits 0 net for that
        // date, aggregator should match the naive sum (no over-correction).
        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        by_date.insert(d(2026, 1, 1), vec![
            val("A", d(2026, 1, 1), dec!(1000), Decimal::ONE),
            val("B", d(2026, 1, 1), dec!(0), Decimal::ONE),
        ]);
        by_date.insert(d(2026, 1, 2), vec![
            val("A", d(2026, 1, 2), dec!(700), Decimal::ONE),
            val("B", d(2026, 1, 2), dec!(300), Decimal::ONE),
        ]);

        // Helper output for a paired same-day transfer: net 0 on that date.
        let mut adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();
        adjustments.insert(d(2026, 1, 2), Decimal::ZERO);

        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, Decimal::ZERO, "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].net_contribution, dec!(1000));
        assert_eq!(rows[1].net_contribution, dec!(1000));
    }

    #[test]
    fn unpaired_transfer_is_not_netted() {
        // Helper only emits adjustments for paired source_group_id entries,
        // so an unpaired TRANSFER_IN (e.g. from an archived counterparty) is
        // treated as a genuine external contribution.
        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        by_date.insert(d(2026, 1, 1), vec![
            val("A", d(2026, 1, 1), dec!(500), Decimal::ONE),
        ]);
        let adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();

        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, Decimal::ZERO, "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );

        assert_eq!(rows[0].net_contribution, dec!(500));
    }

    #[test]
    fn cumulative_advances_across_dates() {
        // Day 2 adjustment +50, day 4 adjustment -20. Cumulative subtracted
        // each day: 0, 50, 50, 30.
        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        for (day, c) in [(1, dec!(100)), (2, dec!(200)), (3, dec!(300)), (4, dec!(400))] {
            by_date.insert(d(2026, 1, day), vec![
                val("A", d(2026, 1, day), c, Decimal::ONE),
            ]);
        }
        let mut adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();
        adjustments.insert(d(2026, 1, 2), dec!(50));
        adjustments.insert(d(2026, 1, 4), dec!(-20));

        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, Decimal::ZERO, "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );

        assert_eq!(rows[0].net_contribution, dec!(100));
        assert_eq!(rows[1].net_contribution, dec!(150));
        assert_eq!(rows[2].net_contribution, dec!(250));
        assert_eq!(rows[3].net_contribution, dec!(370));
    }

    #[test]
    fn seed_cumulative_applied_in_incremental_mode() {
        // Caller seeds cumulative=80 (from pre-start_date transfers).
        // Day 5: no new adjustment, cumulative stays 80.
        // Day 6: +25 adjustment, cumulative becomes 105.
        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        by_date.insert(d(2026, 2, 5), vec![
            val("A", d(2026, 2, 5), dec!(1000), Decimal::ONE),
        ]);
        by_date.insert(d(2026, 2, 6), vec![
            val("A", d(2026, 2, 6), dec!(1100), Decimal::ONE),
        ]);
        let mut adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();
        adjustments.insert(d(2026, 2, 6), dec!(25));

        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, dec!(80), "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );

        assert_eq!(rows[0].net_contribution, dec!(920));
        assert_eq!(rows[1].net_contribution, dec!(995));
    }

    #[test]
    fn fx_applied_to_per_account_contribution() {
        // A is a EUR account with contrib 1000 EUR and fx_rate_to_base = 1.10.
        // Naive base sum = 1100.
        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        by_date.insert(d(2026, 3, 1), vec![
            val("A", d(2026, 3, 1), dec!(1000), dec!(1.10)),
        ]);
        let adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();

        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, Decimal::ZERO, "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );

        assert_eq!(rows[0].net_contribution, dec!(1100.00));
    }

    #[test]
    fn empty_input_yields_empty_output() {
        let by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        let adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();
        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, Decimal::ZERO, "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );
        assert!(rows.is_empty());
    }

    #[test]
    fn rows_sorted_by_date() {
        let mut by_date: HashMap<NaiveDate, Vec<DailyAccountValuation>> = HashMap::new();
        by_date.insert(d(2026, 1, 3), vec![val("A", d(2026, 1, 3), dec!(3), Decimal::ONE)]);
        by_date.insert(d(2026, 1, 1), vec![val("A", d(2026, 1, 1), dec!(1), Decimal::ONE)]);
        by_date.insert(d(2026, 1, 2), vec![val("A", d(2026, 1, 2), dec!(2), Decimal::ONE)]);
        let adjustments: HashMap<NaiveDate, Decimal> = HashMap::new();

        let rows = aggregate_rows_with_transfer_netting(
            by_date, &adjustments, Decimal::ZERO, "USD",
            Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        );

        assert_eq!(rows[0].valuation_date, d(2026, 1, 1));
        assert_eq!(rows[1].valuation_date, d(2026, 1, 2));
        assert_eq!(rows[2].valuation_date, d(2026, 1, 3));
    }
}
