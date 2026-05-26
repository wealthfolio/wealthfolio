//! Net worth calculation service implementation.

use async_trait::async_trait;
use chrono::NaiveDate;
use log::{debug, warn};
use rust_decimal::Decimal;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, RwLock};

use super::net_worth_model::{
    AssetCategory, AssetsSection, BreakdownItem, LiabilitiesSection, NetWorthHistoryPoint,
    NetWorthResponse, StaleAssetInfo, ValuationInfo,
};
use super::net_worth_traits::NetWorthServiceTrait;
use crate::accounts::{account_types, is_liability_account_type, AccountRepositoryTrait};
use crate::assets::{AssetKind, AssetRepositoryTrait};
use crate::constants::DECIMAL_PRECISION;
use crate::errors::Result;
use crate::fx::currency::normalize_amount;
use crate::fx::FxServiceTrait;
use crate::portfolio::snapshot::SnapshotRepositoryTrait;
use crate::portfolio::valuation::{DailyAccountValuation, ValuationRepositoryTrait};
use crate::quotes::QuoteServiceTrait;

/// Number of days after which a valuation is considered stale.
const STALENESS_THRESHOLD_DAYS: i64 = 90;

/// Service for calculating net worth.
pub struct NetWorthService {
    base_currency: Arc<RwLock<String>>,
    account_repository: Arc<dyn AccountRepositoryTrait>,
    asset_repository: Arc<dyn AssetRepositoryTrait>,
    snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    valuation_repository: Arc<dyn ValuationRepositoryTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
}

impl NetWorthService {
    /// Creates a new NetWorthService instance.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        base_currency: Arc<RwLock<String>>,
        account_repository: Arc<dyn AccountRepositoryTrait>,
        asset_repository: Arc<dyn AssetRepositoryTrait>,
        snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        valuation_repository: Arc<dyn ValuationRepositoryTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        Self {
            base_currency,
            account_repository,
            asset_repository,
            snapshot_repository,
            quote_service,
            valuation_repository,
            fx_service,
        }
    }

    /// Determine the asset category based on account type.
    fn categorize_by_account_type(account_type: &str) -> AssetCategory {
        match account_type {
            account_types::SECURITIES | account_types::CRYPTOCURRENCY => AssetCategory::Investment,
            account_types::CASH => AssetCategory::Cash,
            account_types::CREDIT_CARD => AssetCategory::Liability,
            _ => AssetCategory::Investment,
        }
    }

    /// Determine the asset category based on AssetKind.
    fn categorize_by_asset_kind(kind: &AssetKind) -> AssetCategory {
        match kind {
            AssetKind::Investment | AssetKind::PrivateEquity => AssetCategory::Investment,
            AssetKind::Property => AssetCategory::Property,
            AssetKind::Vehicle => AssetCategory::Vehicle,
            AssetKind::Collectible => AssetCategory::Collectible,
            AssetKind::PreciousMetal => AssetCategory::PreciousMetal,
            AssetKind::Liability => AssetCategory::Liability,
            AssetKind::Fx => AssetCategory::Other, // Fx is not holdable
            AssetKind::Other => AssetCategory::Other,
        }
    }

    /// Get the latest quote for an asset on or before the given date.
    /// Returns (close_price, quote_currency, valuation_date) if found.
    fn get_latest_quote_as_of(
        &self,
        asset_id: &str,
        date: NaiveDate,
    ) -> Option<(Decimal, String, NaiveDate)> {
        // Get all quotes for this symbol and find the latest one <= date
        let quotes = self.quote_service.get_historical_quotes(asset_id).ok()?;

        quotes
            .iter()
            .filter(|q| q.timestamp.date_naive() <= date)
            .max_by_key(|q| q.timestamp.date_naive())
            .map(|q| (q.close, q.currency.clone(), q.timestamp.date_naive()))
    }

    /// Calculate market value for a position, converting to base currency.
    fn calculate_market_value(
        &self,
        quantity: Decimal,
        price: Decimal,
        contract_multiplier: Decimal,
        asset_currency: &str,
        base_currency: &str,
        date: NaiveDate,
    ) -> Result<Decimal> {
        let local_value = quantity * price * contract_multiplier;

        if asset_currency == base_currency {
            return Ok(local_value.round_dp(DECIMAL_PRECISION));
        }

        // Convert to base currency
        let converted = self.fx_service.convert_currency_for_date(
            local_value,
            asset_currency,
            base_currency,
            date,
        )?;

        Ok(converted.round_dp(DECIMAL_PRECISION))
    }

    fn convert_cash_balance_to_base(
        &self,
        amount: Decimal,
        currency: &str,
        base_currency: &str,
        date: NaiveDate,
    ) -> Decimal {
        if currency == base_currency {
            return amount;
        }

        match self
            .fx_service
            .convert_currency_for_date(amount, currency, base_currency, date)
        {
            Ok(value) => value,
            Err(error) => {
                warn!(
                    "Failed to convert cash {} {} to {}: {}. Using unconverted.",
                    amount, currency, base_currency, error
                );
                amount
            }
        }
    }

    /// Get display name for asset category.
    fn category_display_name(category: AssetCategory) -> &'static str {
        match category {
            AssetCategory::Cash => "Cash",
            AssetCategory::Investment => "Investments",
            AssetCategory::Property => "Properties",
            AssetCategory::Vehicle => "Vehicles",
            AssetCategory::Collectible => "Collectibles",
            AssetCategory::PreciousMetal => "Precious Metals",
            AssetCategory::Liability => "Liabilities",
            AssetCategory::Other => "Other Assets",
        }
    }

    /// Get category key string for serialization.
    fn category_key(category: AssetCategory) -> &'static str {
        match category {
            AssetCategory::Cash => "cash",
            AssetCategory::Investment => "investments",
            AssetCategory::Property => "properties",
            AssetCategory::Vehicle => "vehicles",
            AssetCategory::Collectible => "collectibles",
            AssetCategory::PreciousMetal => "preciousMetals",
            AssetCategory::Liability => "liabilities",
            AssetCategory::Other => "otherAssets",
        }
    }

    /// Build assets section from valuations.
    fn build_assets_section(valuations: &[ValuationInfo]) -> AssetsSection {
        // Aggregate by category
        let mut category_totals: HashMap<AssetCategory, Decimal> = HashMap::new();

        for val in valuations {
            if val.category != AssetCategory::Liability {
                *category_totals.entry(val.category).or_insert(Decimal::ZERO) +=
                    val.market_value_base;
            }
        }

        // Build breakdown items - only include categories with non-zero values
        let mut breakdown: Vec<BreakdownItem> = category_totals
            .into_iter()
            .filter(|(_, value)| *value > Decimal::ZERO)
            .map(|(category, value)| BreakdownItem {
                category: Self::category_key(category).to_string(),
                name: Self::category_display_name(category).to_string(),
                value,
                asset_id: None,
            })
            .collect();

        // Sort by value descending for better display
        breakdown.sort_by_key(|b| std::cmp::Reverse(b.value));

        // Calculate total
        let total = breakdown.iter().map(|item| item.value).sum();

        AssetsSection { total, breakdown }
    }

    /// Build liabilities section from valuations - includes individual liability items.
    fn build_liabilities_section(valuations: &[ValuationInfo]) -> LiabilitiesSection {
        // Get individual liabilities
        let mut breakdown: Vec<BreakdownItem> = valuations
            .iter()
            .filter(|v| v.category == AssetCategory::Liability)
            .map(|v| BreakdownItem {
                category: "liability".to_string(),
                name: v.name.clone().unwrap_or_else(|| v.asset_id.clone()),
                value: v.market_value_base,
                asset_id: Some(v.asset_id.clone()),
            })
            .collect();

        // Sort by value descending
        breakdown.sort_by_key(|b| std::cmp::Reverse(b.value));

        // Calculate total
        let total = breakdown.iter().map(|item| item.value).sum();

        LiabilitiesSection { total, breakdown }
    }

    /// Calculate staleness info for valuations.
    /// Cash-like balances are excluded since they don't need market data updates.
    fn calculate_staleness(
        valuations: &[ValuationInfo],
        reference_date: NaiveDate,
    ) -> (Option<NaiveDate>, Vec<StaleAssetInfo>) {
        // Exclude cash-like balances from staleness calculations.
        let non_cash_valuations: Vec<_> = valuations.iter().filter(|v| !v.is_cash_like).collect();

        let oldest_date = non_cash_valuations.iter().map(|v| v.valuation_date).min();

        let stale_assets: Vec<StaleAssetInfo> = non_cash_valuations
            .iter()
            .filter_map(|v| {
                let days_stale = (reference_date - v.valuation_date).num_days();
                if days_stale > STALENESS_THRESHOLD_DAYS {
                    Some(StaleAssetInfo {
                        asset_id: v.asset_id.clone(),
                        name: v.name.clone(),
                        valuation_date: v.valuation_date,
                        days_stale,
                    })
                } else {
                    None
                }
            })
            .collect();

        (oldest_date, stale_assets)
    }

    fn credit_card_liability_value(valuation: &DailyAccountValuation) -> Decimal {
        let value = valuation.cash_balance_base.round_dp(DECIMAL_PRECISION);
        if value < Decimal::ZERO {
            value.abs()
        } else {
            Decimal::ZERO
        }
    }

    fn credit_card_asset_value(valuation: &DailyAccountValuation) -> Decimal {
        let value = valuation.cash_balance_base.round_dp(DECIMAL_PRECISION);
        if value > Decimal::ZERO {
            value
        } else {
            Decimal::ZERO
        }
    }
}

#[async_trait]
impl NetWorthServiceTrait for NetWorthService {
    async fn get_net_worth(&self, date: NaiveDate) -> Result<NetWorthResponse> {
        let base_currency = self.base_currency.read().unwrap().clone();

        debug!("Calculating net worth as of {} in {}", date, base_currency);

        // Get all non-archived accounts (includes closed accounts for historical net worth)
        let accounts = self.account_repository.list(None, Some(false), None)?;

        if accounts.is_empty() {
            debug!("No non-archived accounts found. Returning empty net worth.");
            return Ok(NetWorthResponse::empty(date, base_currency));
        }

        // Get account IDs
        let account_ids: Vec<String> = accounts.iter().map(|a| a.id.clone()).collect();

        // Get latest snapshots for all accounts as of the target date
        let snapshots = self
            .snapshot_repository
            .get_latest_snapshots_before_date(&account_ids, date)?;

        // Build a map of account_id -> account for easy lookup
        let account_map: HashMap<String, _> = accounts.iter().map(|a| (a.id.clone(), a)).collect();

        // Get all assets for lookup
        let all_assets = self.asset_repository.list()?;
        let asset_map: HashMap<String, _> = all_assets.iter().map(|a| (a.id.clone(), a)).collect();

        let mut valuations: Vec<ValuationInfo> = Vec::new();

        // Process each account's snapshot
        for (account_id, snapshot) in &snapshots {
            let account = match account_map.get(account_id) {
                Some(acc) => acc,
                None => {
                    warn!("Account {} not found in account map", account_id);
                    continue;
                }
            };

            let account_category = Self::categorize_by_account_type(&account.account_type);
            let is_liability_account = is_liability_account_type(&account.account_type);

            // Process positions (securities, alternative assets)
            if is_liability_account {
                if !snapshot.positions.is_empty() {
                    warn!(
                        "Ignoring {} position(s) on liability account {} while calculating net worth",
                        snapshot.positions.len(),
                        account.id
                    );
                }
            } else {
                for (asset_id, position) in &snapshot.positions {
                    if position.quantity.is_zero() {
                        continue;
                    }

                    // Get asset info to determine category more precisely
                    let asset = asset_map.get(asset_id);
                    let asset_name = asset.and_then(|a| {
                        a.name
                            .clone()
                            .filter(|n| !n.is_empty())
                            .or_else(|| a.display_code.clone())
                    });

                    // Determine category: prefer asset kind if available, fallback to account type
                    let category = if let Some(asset) = asset {
                        Self::categorize_by_asset_kind(&asset.kind)
                    } else {
                        account_category
                    };

                    // Get the latest quote for this asset as of the date
                    let (price, quote_currency, valuation_date) = match self
                        .get_latest_quote_as_of(asset_id, date)
                    {
                        Some((p, c, d)) => (p, c, d),
                        None => {
                            // No quote found, use cost basis as fallback
                            if position.quantity > Decimal::ZERO {
                                let implied_price = position.total_cost_basis / position.quantity;
                                // Use snapshot date as valuation date; cost basis is in position.currency (major unit)
                                (
                                    implied_price,
                                    position.currency.clone(),
                                    snapshot.snapshot_date,
                                )
                            } else {
                                warn!(
                                    "No quote found for {} and cannot derive from cost basis",
                                    asset_id
                                );
                                continue;
                            }
                        }
                    };

                    // Normalize minor-currency quotes (e.g. GBp → GBP, ZAc → ZAR) before valuation.
                    let (normalized_price, normalized_currency) =
                        normalize_amount(price, &quote_currency);

                    // Calculate market value in base currency
                    let market_value_base = match self.calculate_market_value(
                        position.quantity,
                        normalized_price,
                        position.contract_multiplier,
                        normalized_currency,
                        &base_currency,
                        date,
                    ) {
                        Ok(v) => v,
                        Err(e) => {
                            warn!(
                                "Failed to calculate market value for {}: {}. Using local value.",
                                asset_id, e
                            );
                            position.quantity * price * position.contract_multiplier
                        }
                    };

                    valuations.push(ValuationInfo {
                        asset_id: asset_id.clone(),
                        name: asset_name,
                        market_value_base,
                        valuation_date,
                        category,
                        is_cash_like: false,
                    });
                }
            }

            if is_liability_account {
                let cash_base_total = snapshot.cash_balances.iter().fold(
                    Decimal::ZERO,
                    |acc, (currency, &amount)| {
                        if amount.is_zero() {
                            acc
                        } else {
                            acc + self.convert_cash_balance_to_base(
                                amount,
                                currency,
                                &base_currency,
                                date,
                            )
                        }
                    },
                );

                if cash_base_total < Decimal::ZERO {
                    valuations.push(ValuationInfo {
                        asset_id: format!("CREDIT_CARD:{}", account.id),
                        name: Some(account.name.clone()),
                        market_value_base: cash_base_total.abs().round_dp(DECIMAL_PRECISION),
                        valuation_date: snapshot.snapshot_date,
                        category: AssetCategory::Liability,
                        is_cash_like: true,
                    });
                } else if cash_base_total > Decimal::ZERO {
                    valuations.push(ValuationInfo {
                        asset_id: format!("CASH:{}", account.id),
                        name: Some(account.name.clone()),
                        market_value_base: cash_base_total.round_dp(DECIMAL_PRECISION),
                        valuation_date: snapshot.snapshot_date,
                        category: AssetCategory::Cash,
                        is_cash_like: true,
                    });
                }
                continue;
            }

            // Process cash balances
            for (currency, &amount) in &snapshot.cash_balances {
                if amount.is_zero() {
                    continue;
                }

                let cash_base =
                    self.convert_cash_balance_to_base(amount, currency, &base_currency, date);

                let (asset_id, name, market_value_base, category) = (
                    format!("CASH:{}:{}", account.id, currency),
                    Some(format!("Cash ({})", currency)),
                    cash_base.round_dp(DECIMAL_PRECISION),
                    AssetCategory::Cash,
                );

                valuations.push(ValuationInfo {
                    asset_id,
                    name,
                    market_value_base,
                    valuation_date: snapshot.snapshot_date,
                    category,
                    is_cash_like: true,
                });
            }
        }

        // =====================================================================
        // Process standalone alternative assets (not tied to accounts/snapshots)
        // These are assets with is_alternative() kind that have direct quotes
        // =====================================================================
        let alternative_assets: Vec<_> = all_assets
            .iter()
            .filter(|a| a.kind.is_alternative())
            .collect();

        for asset in alternative_assets {
            // Skip if this asset was already processed via a snapshot position
            // (in case there's overlap)
            if valuations.iter().any(|v| v.asset_id == asset.id) {
                continue;
            }

            // Get the latest quote for this alternative asset
            let (price, quote_currency, valuation_date) =
                match self.get_latest_quote_as_of(&asset.id, date) {
                    Some((p, c, d)) => (p, c, d),
                    None => {
                        debug!(
                            "No quote found for alternative asset {}, skipping",
                            asset.id
                        );
                        continue;
                    }
                };

            // For alternative assets, quantity is always 1 (value-based model)
            let quantity = Decimal::ONE;

            // Normalize minor-currency quotes before valuation.
            let (normalized_price, normalized_currency) = normalize_amount(price, &quote_currency);

            // Calculate market value in base currency
            let market_value_base = match self.calculate_market_value(
                quantity,
                normalized_price,
                Decimal::ONE,
                normalized_currency,
                &base_currency,
                date,
            ) {
                Ok(v) => v,
                Err(e) => {
                    warn!(
                        "Failed to convert alternative asset {} value to base currency: {}. Using local value.",
                        asset.id, e
                    );
                    price
                }
            };

            let category = Self::categorize_by_asset_kind(&asset.kind);

            valuations.push(ValuationInfo {
                asset_id: asset.id.clone(),
                name: asset
                    .name
                    .clone()
                    .filter(|n| !n.is_empty())
                    .or_else(|| asset.display_code.clone()),
                market_value_base,
                valuation_date,
                category,
                is_cash_like: false,
            });
        }

        // Build assets and liabilities sections
        let assets = Self::build_assets_section(&valuations);
        let liabilities = Self::build_liabilities_section(&valuations);

        // Calculate net worth
        let net_worth = assets.total - liabilities.total;

        // Calculate staleness
        let (oldest_valuation_date, stale_assets) = Self::calculate_staleness(&valuations, date);

        debug!(
            "Net worth calculation complete: assets={}, liabilities={}, net_worth={}",
            assets.total, liabilities.total, net_worth
        );

        Ok(NetWorthResponse {
            date,
            assets,
            liabilities,
            net_worth: net_worth.round_dp(DECIMAL_PRECISION),
            currency: base_currency,
            oldest_valuation_date,
            stale_assets,
        })
    }

    fn get_net_worth_history(
        &self,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<Vec<NetWorthHistoryPoint>> {
        let base_currency = self.base_currency.read().unwrap().clone();

        debug!(
            "Calculating net worth history from {} to {} in {}",
            start_date, end_date, base_currency
        );

        // =====================================================================
        // 1. Load real-account valuations and aggregate base-currency portfolio state
        // =====================================================================
        #[derive(Clone)]
        struct PortfolioState {
            value: Decimal,
            net_contribution: Decimal,
        }

        let mut portfolio_by_date: BTreeMap<NaiveDate, PortfolioState> = BTreeMap::new();
        let accounts = self.account_repository.list(None, Some(false), None)?;
        for account in accounts {
            // Liability accounts (e.g. credit cards) are tracked separately as
            // liabilities/cash assets below; excluding them here avoids double-counting.
            if is_liability_account_type(&account.account_type) {
                continue;
            }
            let valuations = self.valuation_repository.get_historical_valuations(
                &account.id,
                Some(start_date),
                Some(end_date),
            )?;
            for val in valuations {
                let entry = portfolio_by_date
                    .entry(val.valuation_date)
                    .or_insert_with(|| PortfolioState {
                        value: Decimal::ZERO,
                        net_contribution: Decimal::ZERO,
                    });
                entry.value += val.total_value_base;
                entry.net_contribution += val.net_contribution_base;
            }
        }
        let first_portfolio_date = portfolio_by_date.keys().next().copied();
        let history_seed_date = first_portfolio_date.unwrap_or(start_date);

        // =====================================================================
        // 2. Load alternative assets and organize by type
        // =====================================================================
        let all_assets = self.asset_repository.list()?;
        let alternative_assets: Vec<_> = all_assets
            .iter()
            .filter(|a| a.kind.is_alternative())
            .collect();

        // Separate assets from liabilities
        let asset_symbols: HashSet<String> = alternative_assets
            .iter()
            .filter(|a| a.kind != AssetKind::Liability)
            .map(|a| a.id.clone())
            .collect();

        let liability_symbols: HashSet<String> = alternative_assets
            .iter()
            .filter(|a| a.kind == AssetKind::Liability)
            .map(|a| a.id.clone())
            .collect();

        // Build currency lookup for FX conversion
        let asset_currency_map: HashMap<String, String> = alternative_assets
            .iter()
            .map(|a| (a.id.clone(), a.quote_ccy.clone()))
            .collect();

        // =====================================================================
        // 3. Load quotes for alternative assets
        // =====================================================================
        let all_alt_symbols: HashSet<String> =
            alternative_assets.iter().map(|a| a.id.clone()).collect();

        // Get quotes in the date range
        let quotes_vec = self.quote_service.get_quotes_in_range_filled(
            &all_alt_symbols,
            start_date,
            end_date,
        )?;

        // Organize quotes by date -> asset_id -> value (converted to base currency)
        let mut quotes_by_date: BTreeMap<NaiveDate, HashMap<String, Decimal>> = BTreeMap::new();
        for quote in &quotes_vec {
            let date = quote.timestamp.date_naive();
            let asset_currency = asset_currency_map
                .get(&quote.asset_id)
                .cloned()
                .unwrap_or_else(|| base_currency.clone());

            // Convert to base currency
            let value_base = if asset_currency == base_currency {
                quote.close
            } else {
                self.fx_service
                    .convert_currency_for_date(quote.close, &asset_currency, &base_currency, date)
                    .unwrap_or(quote.close)
            };

            quotes_by_date
                .entry(date)
                .or_default()
                .insert(quote.asset_id.clone(), value_base);
        }

        // =====================================================================
        // 4. Get initial values for forward-fill (quotes before the first emitted point)
        // =====================================================================
        let mut initial_asset_values: HashMap<String, Decimal> = HashMap::new();

        for asset in &alternative_assets {
            if let Some((price, quote_currency, _)) =
                self.get_latest_quote_as_of(&asset.id, history_seed_date)
            {
                let (normalized_price, normalized_currency) =
                    normalize_amount(price, &quote_currency);
                let value_base = if normalized_currency == base_currency {
                    normalized_price
                } else {
                    self.fx_service
                        .convert_currency_for_date(
                            normalized_price,
                            normalized_currency,
                            &base_currency,
                            history_seed_date,
                        )
                        .unwrap_or(normalized_price)
                };
                initial_asset_values.insert(asset.id.clone(), value_base);
            }
        }

        // =====================================================================
        // 5. Load credit card liability valuations
        // =====================================================================
        let accounts = self.account_repository.list(None, Some(false), None)?;
        let credit_card_account_ids: Vec<String> = accounts
            .iter()
            .filter(|account| is_liability_account_type(&account.account_type))
            .map(|account| account.id.clone())
            .collect();

        let mut initial_credit_card_assets: HashMap<String, Decimal> = HashMap::new();
        let mut initial_credit_card_liabilities: HashMap<String, Decimal> = HashMap::new();
        let mut credit_card_assets_by_date: BTreeMap<NaiveDate, HashMap<String, Decimal>> =
            BTreeMap::new();
        let mut credit_card_liabilities_by_date: BTreeMap<NaiveDate, HashMap<String, Decimal>> =
            BTreeMap::new();

        for account_id in &credit_card_account_ids {
            if let Some(initial_valuation) = self
                .valuation_repository
                .get_historical_valuations(account_id, None, Some(history_seed_date))?
                .into_iter()
                .max_by_key(|valuation| valuation.valuation_date)
            {
                initial_credit_card_assets.insert(
                    account_id.clone(),
                    Self::credit_card_asset_value(&initial_valuation),
                );
                initial_credit_card_liabilities.insert(
                    account_id.clone(),
                    Self::credit_card_liability_value(&initial_valuation),
                );
            }

            for valuation in self.valuation_repository.get_historical_valuations(
                account_id,
                Some(start_date),
                Some(end_date),
            )? {
                credit_card_assets_by_date
                    .entry(valuation.valuation_date)
                    .or_default()
                    .insert(
                        account_id.clone(),
                        Self::credit_card_asset_value(&valuation),
                    );
                credit_card_liabilities_by_date
                    .entry(valuation.valuation_date)
                    .or_default()
                    .insert(
                        account_id.clone(),
                        Self::credit_card_liability_value(&valuation),
                    );
            }
        }

        // =====================================================================
        // 6. Determine date range (Rule 1: start from first portfolio date)
        // =====================================================================
        // Collect all dates with data
        let mut all_dates: Vec<NaiveDate> = Vec::new();

        if let Some(first_pf_date) = first_portfolio_date {
            // Normal case: include portfolio dates
            all_dates.extend(portfolio_by_date.keys().cloned());

            // Add quote dates that are >= first portfolio date
            for date in quotes_by_date.keys() {
                if *date >= first_pf_date && !all_dates.contains(date) {
                    all_dates.push(*date);
                }
            }

            for date in credit_card_liabilities_by_date.keys() {
                if *date >= first_pf_date && !all_dates.contains(date) {
                    all_dates.push(*date);
                }
            }

            for date in credit_card_assets_by_date.keys() {
                if *date >= first_pf_date && !all_dates.contains(date) {
                    all_dates.push(*date);
                }
            }
        } else {
            // Edge case: no portfolio data, only alternative assets/liabilities.
            all_dates.extend(quotes_by_date.keys().cloned());
            all_dates.extend(credit_card_assets_by_date.keys().cloned());
            all_dates.extend(credit_card_liabilities_by_date.keys().cloned());

            // Also add start_date if we have initial values but no quotes in range
            if all_dates.is_empty()
                && (!initial_asset_values.is_empty()
                    || !initial_credit_card_assets.is_empty()
                    || !initial_credit_card_liabilities.is_empty())
            {
                all_dates.push(start_date);
            }
        }

        all_dates.sort();
        all_dates.dedup();

        // =====================================================================
        // 7. Build history with forward-fill (Rule 2)
        // =====================================================================
        // Current state for forward-fill
        let mut current_portfolio = PortfolioState {
            value: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
        };
        let mut portfolio_initialized = false;

        let mut current_asset_values = initial_asset_values.clone();
        let mut current_credit_card_assets = initial_credit_card_assets.clone();
        let mut current_credit_card_liabilities = initial_credit_card_liabilities.clone();

        let mut history: Vec<NetWorthHistoryPoint> = Vec::new();

        for date in all_dates {
            // Update portfolio state if we have data for this date
            if let Some(pf) = portfolio_by_date.get(&date) {
                current_portfolio = pf.clone();
                portfolio_initialized = true;
            }

            // Update alternative asset values if we have quotes for this date
            if let Some(quotes_on_date) = quotes_by_date.get(&date) {
                for (symbol, value) in quotes_on_date {
                    current_asset_values.insert(symbol.clone(), *value);
                }
            }

            if let Some(liabilities_on_date) = credit_card_liabilities_by_date.get(&date) {
                for (account_id, value) in liabilities_on_date {
                    current_credit_card_liabilities.insert(account_id.clone(), *value);
                }
            }

            if let Some(assets_on_date) = credit_card_assets_by_date.get(&date) {
                for (account_id, value) in assets_on_date {
                    current_credit_card_assets.insert(account_id.clone(), *value);
                }
            }

            // Skip if portfolio not yet initialized (Rule 1)
            // Exception: if there's no portfolio data at all, include dates with alt assets
            if !portfolio_initialized && first_portfolio_date.is_some() {
                continue;
            }

            // Calculate totals
            let mut alt_assets_value = Decimal::ZERO;
            let mut liabilities_value = Decimal::ZERO;

            for (symbol, value) in &current_asset_values {
                if liability_symbols.contains(symbol) {
                    liabilities_value += *value;
                } else if asset_symbols.contains(symbol) {
                    alt_assets_value += *value;
                }
            }

            let credit_card_liabilities_value: Decimal =
                current_credit_card_liabilities.values().sum();
            let credit_card_assets_value: Decimal = current_credit_card_assets.values().sum();
            let total_assets =
                current_portfolio.value + alt_assets_value + credit_card_assets_value;
            let total_liabilities = liabilities_value + credit_card_liabilities_value;
            let net_worth = total_assets - total_liabilities;

            history.push(NetWorthHistoryPoint {
                date,
                portfolio_value: current_portfolio.value.round_dp(DECIMAL_PRECISION),
                alternative_assets_value: alt_assets_value.round_dp(DECIMAL_PRECISION),
                total_liabilities: total_liabilities.round_dp(DECIMAL_PRECISION),
                total_assets: total_assets.round_dp(DECIMAL_PRECISION),
                net_worth: net_worth.round_dp(DECIMAL_PRECISION),
                net_contribution: current_portfolio
                    .net_contribution
                    .round_dp(DECIMAL_PRECISION),
                currency: base_currency.clone(),
            });
        }

        debug!(
            "Net worth history calculated: {} data points",
            history.len()
        );

        Ok(history)
    }
}
