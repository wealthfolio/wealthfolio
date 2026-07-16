use crate::activities::{
    Activity, ActivityRepositoryTrait, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL,
};
use crate::assets::{
    Asset, AssetClassificationService, AssetKind, AssetServiceTrait, InstrumentType,
};
use crate::constants::DECIMAL_PRECISION;
use crate::errors::{CalculatorError, Error as CoreError, Result};
use crate::fx::currency::{get_normalization_rule, normalize_currency_code};
use crate::fx::FxServiceTrait;
use crate::lots::LotRepositoryTrait;
use crate::portfolio::holdings::holdings_model::{Holding, HoldingType, Instrument, MonetaryValue};
use crate::portfolio::snapshot::{self, SnapshotServiceTrait};
use crate::utils::time_utils::{activity_date_in_tz, parse_user_timezone_or_default, user_today};
use async_trait::async_trait;
use chrono::NaiveDate;
use log::{debug, error, warn};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use super::HoldingsValuationServiceTrait;

#[async_trait]
pub trait HoldingsServiceTrait: Send + Sync {
    async fn get_holdings(&self, account_id: &str, base_currency: &str) -> Result<Vec<Holding>>;

    /// Aggregates holdings from multiple accounts into a single merged list.
    /// Holdings with the same asset are merged by summing MonetaryValue fields.
    /// Lots are concatenated. Weights are recomputed over the full merged set.
    /// `aggregated_account_id` is stored on each resulting Holding (use `""` for ad-hoc filters).
    async fn get_holdings_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> Result<Vec<Holding>>;

    /// Retrieves a specific holding for an account, calculates its valuation, and includes lot details.
    async fn get_holding(
        &self,
        account_id: &str,
        asset_id: &str,
        base_currency: &str,
    ) -> Result<Option<Holding>>;

    /// Converts a snapshot to holdings for display.
    /// This is a lightweight conversion without live valuation - used for viewing historical snapshots.
    async fn holdings_from_snapshot(
        &self,
        snapshot: &snapshot::AccountStateSnapshot,
        base_currency: &str,
    ) -> Result<Vec<Holding>>;
}

pub struct HoldingsService {
    asset_service: Arc<dyn AssetServiceTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    valuation_service: Arc<dyn HoldingsValuationServiceTrait>,
    classification_service: Arc<AssetClassificationService>,
    timezone: Arc<RwLock<String>>,
    lot_repository: Option<Arc<dyn LotRepositoryTrait>>,
    activity_repository: Option<Arc<dyn ActivityRepositoryTrait>>,
    income_service: Option<Arc<dyn HoldingIncomeServiceTrait>>,
}

pub trait HoldingIncomeServiceTrait: Send + Sync {
    fn get_asset_income(
        &self,
        account_ids: &[String],
        asset_currencies: &HashMap<String, String>,
        base_currency: &str,
    ) -> Result<HashMap<String, MonetaryValue>>;
}

pub struct HoldingIncomeService {
    activity_repository: Arc<dyn ActivityRepositoryTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    timezone: Arc<RwLock<String>>,
}

impl HoldingIncomeService {
    pub fn new(
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        Self {
            activity_repository,
            fx_service,
            timezone,
        }
    }
}

impl HoldingIncomeServiceTrait for HoldingIncomeService {
    fn get_asset_income(
        &self,
        account_ids: &[String],
        asset_currencies: &HashMap<String, String>,
        base_currency: &str,
    ) -> Result<HashMap<String, MonetaryValue>> {
        let activities = self
            .activity_repository
            .get_activities_by_account_ids(account_ids)?;
        let timezone = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        Ok(calculate_asset_income(
            &activities,
            asset_currencies,
            base_currency,
            self.fx_service.as_ref(),
            timezone,
        ))
    }
}

struct AssetInfo {
    instrument: Instrument,
    instrument_symbol: Option<String>,
    is_option: bool,
    kind: AssetKind,
    metadata: Option<Value>,
    purchase_price: Option<Decimal>,
}

fn is_expired_option(
    is_option: bool,
    metadata: Option<&Value>,
    symbols: &[&str],
    today: NaiveDate,
) -> bool {
    if !is_option {
        return false;
    }

    let expiration = metadata
        .and_then(|m| m.get("option"))
        .and_then(|o| o.get("expiration"))
        .and_then(|v| v.as_str())
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .or_else(|| {
            symbols.iter().find_map(|symbol| {
                crate::utils::occ_symbol::parse_occ_symbol(symbol)
                    .ok()
                    .map(|parsed| parsed.expiration)
            })
        });
    matches!(expiration, Some(exp) if exp < today)
}

fn is_expired_option_asset(asset: &Asset, today: NaiveDate) -> bool {
    is_expired_option(
        asset.instrument_type.as_ref() == Some(&InstrumentType::Option),
        asset.metadata.as_ref(),
        &[
            asset.instrument_symbol.as_deref().unwrap_or_default(),
            asset.display_code.as_deref().unwrap_or_default(),
        ],
        today,
    )
}

impl HoldingsService {
    pub fn new(
        asset_service: Arc<dyn AssetServiceTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        valuation_service: Arc<dyn HoldingsValuationServiceTrait>,
        classification_service: Arc<AssetClassificationService>,
    ) -> Self {
        Self::new_with_timezone(
            asset_service,
            snapshot_service,
            valuation_service,
            classification_service,
            Arc::new(RwLock::new(String::new())),
        )
    }

    pub fn new_with_timezone(
        asset_service: Arc<dyn AssetServiceTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        valuation_service: Arc<dyn HoldingsValuationServiceTrait>,
        classification_service: Arc<AssetClassificationService>,
        timezone: Arc<RwLock<String>>,
    ) -> Self {
        Self {
            asset_service,
            snapshot_service,
            valuation_service,
            classification_service,
            timezone,
            lot_repository: None,
            activity_repository: None,
            income_service: None,
        }
    }

    pub fn with_lot_repository(mut self, lot_repository: Arc<dyn LotRepositoryTrait>) -> Self {
        self.lot_repository = Some(lot_repository);
        self
    }

    pub fn with_income_service(
        mut self,
        income_service: Arc<dyn HoldingIncomeServiceTrait>,
    ) -> Self {
        self.income_service = Some(income_service);
        self
    }

    pub fn with_income_dependencies(
        mut self,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
    ) -> Self {
        let timezone = self.timezone.clone();
        self.activity_repository = Some(activity_repository.clone());
        self.with_income_service(Arc::new(HoldingIncomeService::new(
            activity_repository,
            fx_service,
            timezone,
        )))
    }

    fn today_in_user_timezone(&self) -> chrono::NaiveDate {
        let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        user_today(tz)
    }

    async fn build_live_holdings_from_snapshot(
        &self,
        account_id: &str,
        latest_snapshot: &snapshot::AccountStateSnapshot,
        base_currency: &str,
        lots_asset_id: Option<&str>,
        skip_expired_options: bool,
    ) -> Vec<Holding> {
        let today = self.today_in_user_timezone();
        let snapshot_positions: Vec<snapshot::Position> = latest_snapshot
            .positions
            .values()
            .filter(|p| p.quantity != Decimal::ZERO)
            .cloned()
            .collect();
        let cash_balances_map: &HashMap<String, Decimal> = &latest_snapshot.cash_balances;

        let asset_ids: Vec<String> = snapshot_positions
            .iter()
            .map(|p| p.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        let assets_info_map: HashMap<String, AssetInfo> = if !asset_ids.is_empty() {
            match self.asset_service.get_assets_by_asset_ids(&asset_ids).await {
                Ok(assets) => assets
                    .into_iter()
                    .map(|asset: Asset| {
                        let metadata: Option<Value> = asset.metadata.clone();
                        let purchase_price: Option<Decimal> =
                            metadata.as_ref().and_then(extract_purchase_price);

                        let instrument = Instrument {
                            id: asset.id.clone(),
                            symbol: asset.display_code.clone().unwrap_or_default(),
                            name: asset.name.clone(),
                            currency: asset.quote_ccy.clone(),
                            notes: asset.notes.clone(),
                            pricing_mode: asset.quote_mode.as_db_str().to_string(),
                            preferred_provider: asset.preferred_provider(),
                            exchange_mic: asset.instrument_exchange_mic.clone(),
                            classifications: None,
                        };

                        let asset_info = AssetInfo {
                            instrument,
                            instrument_symbol: asset.instrument_symbol.clone(),
                            is_option: asset.instrument_type == Some(InstrumentType::Option),
                            kind: asset.kind,
                            metadata,
                            purchase_price,
                        };
                        (asset.id, asset_info)
                    })
                    .collect(),
                Err(e) => {
                    error!(
                        "Failed to get asset details for account {}: {}. Asset info will be missing.",
                        account_id, e
                    );
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };

        let mut holdings: Vec<Holding> = Vec::new();

        for snapshot_pos in &snapshot_positions {
            let Some(asset_info) = assets_info_map.get(&snapshot_pos.asset_id) else {
                warn!(
                    "Asset details not found for asset_id: {}. Skipping this holding view.",
                    snapshot_pos.asset_id
                );
                continue;
            };

            if skip_expired_options
                && is_expired_option(
                    asset_info.is_option,
                    asset_info.metadata.as_ref(),
                    &[
                        asset_info.instrument_symbol.as_deref().unwrap_or_default(),
                        &asset_info.instrument.symbol,
                    ],
                    today,
                )
            {
                debug!(
                    "Skipping expired option holding {} for account {}.",
                    snapshot_pos.asset_id, account_id
                );
                continue;
            }

            let (holding_type, id_prefix) = if asset_info.kind.is_alternative() {
                (HoldingType::AlternativeAsset, "ALT")
            } else {
                (HoldingType::Security, "SEC")
            };

            let include_lots = lots_asset_id
                .map(|id| id == snapshot_pos.asset_id)
                .unwrap_or(false);

            let holding_view = Holding {
                id: format!("{}-{}-{}", id_prefix, account_id, snapshot_pos.asset_id),
                account_id: account_id.to_string(),
                holding_type,
                instrument: Some(asset_info.instrument.clone()),
                asset_kind: Some(asset_info.kind.clone()),
                quantity: snapshot_pos.quantity,
                open_date: Some(snapshot_pos.inception_date),
                lots: include_lots.then(|| snapshot_pos.lots.clone()),
                contract_multiplier: snapshot_pos.contract_multiplier,
                local_currency: snapshot_pos.currency.clone(),
                base_currency: base_currency.to_string(),
                fx_rate: None,
                market_value: MonetaryValue::zero(),
                cost_basis: Some(MonetaryValue {
                    local: snapshot_pos.total_cost_basis,
                    base: Decimal::ZERO,
                }),
                price: None,
                purchase_price: asset_info.purchase_price,
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
                as_of_date: today,
                metadata: asset_info.metadata.clone(),
                source_account_ids: Vec::new(),
            };
            holdings.push(holding_view);
        }

        for (currency, &amount) in cash_balances_map {
            if amount == Decimal::ZERO {
                continue;
            }

            let cash_instrument = Instrument {
                id: format!("cash:{}", currency),
                symbol: currency.clone(),
                name: Some(format!("Cash ({})", currency)),
                currency: currency.clone(),
                notes: None,
                pricing_mode: "MANUAL".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                classifications: None,
            };

            let holding_view = Holding {
                id: format!("CASH-{}-{}", account_id, currency),
                account_id: account_id.to_string(),
                holding_type: HoldingType::Cash,
                instrument: Some(cash_instrument),
                asset_kind: None,
                quantity: amount,
                open_date: None,
                lots: None,
                contract_multiplier: Decimal::ONE,
                local_currency: currency.clone(),
                base_currency: base_currency.to_string(),
                fx_rate: None,
                market_value: MonetaryValue {
                    local: amount,
                    base: Decimal::ZERO,
                },
                cost_basis: Some(MonetaryValue {
                    local: amount,
                    base: Decimal::ZERO,
                }),
                price: Some(dec!(1.0)),
                purchase_price: None,
                unrealized_gain: Some(MonetaryValue::zero()),
                unrealized_gain_pct: Some(Decimal::ZERO),
                realized_gain: Some(MonetaryValue::zero()),
                realized_gain_pct: Some(Decimal::ZERO),
                total_gain: Some(MonetaryValue::zero()),
                total_gain_pct: Some(Decimal::ZERO),
                income: Some(MonetaryValue::zero()),
                total_return: Some(MonetaryValue::zero()),
                total_return_pct: Some(Decimal::ZERO),
                return_basis: Some(MonetaryValue {
                    local: amount,
                    base: Decimal::ZERO,
                }),
                day_change: Some(MonetaryValue::zero()),
                day_change_pct: Some(Decimal::ZERO),
                prev_close_value: Some(MonetaryValue {
                    local: amount,
                    base: Decimal::ZERO,
                }),
                weight: Decimal::ZERO,
                as_of_date: today,
                metadata: None,
                source_account_ids: Vec::new(),
            };
            holdings.push(holding_view);
        }

        holdings
    }

    async fn apply_historical_cost_basis_best_effort(
        &self,
        account_id: &str,
        base_currency: &str,
        holdings: &mut [Holding],
        asset_id_filter: Option<&str>,
    ) {
        if holdings.is_empty() {
            return;
        }

        let Some(lot_repository) = &self.lot_repository else {
            return;
        };

        let security_asset_ids: HashSet<String> = holdings
            .iter()
            .filter(|holding| holding.holding_type == HoldingType::Security)
            .filter_map(|holding| holding.instrument.as_ref().map(|instrument| &instrument.id))
            .filter(|asset_id| asset_id_filter.is_none_or(|filter| asset_id.as_str() == filter))
            .cloned()
            .collect();

        if security_asset_ids.is_empty() {
            return;
        }

        let open_lots_result = if let Some(asset_id) = asset_id_filter {
            lot_repository
                .get_open_lots_for_account_asset(account_id, asset_id)
                .await
        } else {
            lot_repository.get_open_lots_for_account(account_id).await
        };

        let open_lots = match open_lots_result {
            Ok(lots) => lots,
            Err(e) => {
                warn!(
                    "Failed to load open lots for account {} while applying historical cost basis: {}",
                    account_id, e
                );
                return;
            }
        };
        if open_lots.is_empty() {
            return;
        }

        let requested_base_currency = normalize_currency_code(base_currency);
        let mut cost_basis_base_by_asset: HashMap<String, Decimal> = HashMap::new();
        let mut mismatched_base_assets: HashSet<String> = HashSet::new();
        let mut invalid_base_cost_assets: HashSet<String> = HashSet::new();

        for lot in open_lots {
            if !security_asset_ids.contains(&lot.asset_id) {
                continue;
            }

            let lot_base_currency = normalize_currency_code(&lot.base_currency);
            if lot_base_currency != requested_base_currency {
                mismatched_base_assets.insert(lot.asset_id.clone());
                continue;
            }

            let remaining_cost_basis_base = match lot.remaining_cost_basis_base.parse::<Decimal>() {
                Ok(value) => value,
                Err(e) => {
                    invalid_base_cost_assets.insert(lot.asset_id.clone());
                    warn!(
                        "Skipping historical cost basis seeding for asset {} in account {} because an open lot has invalid base cost basis: {}",
                        lot.asset_id, account_id, e
                    );
                    continue;
                }
            };
            cost_basis_base_by_asset
                .entry(lot.asset_id)
                .and_modify(|total| *total += remaining_cost_basis_base)
                .or_insert(remaining_cost_basis_base);
        }

        for asset_id in invalid_base_cost_assets {
            cost_basis_base_by_asset.remove(&asset_id);
        }

        for asset_id in mismatched_base_assets {
            cost_basis_base_by_asset.remove(&asset_id);
            warn!(
                "Skipping historical cost basis seeding for asset {} in account {} because lot base currency does not match requested base currency {}.",
                asset_id, account_id, base_currency
            );
        }

        if cost_basis_base_by_asset.is_empty() {
            return;
        }

        for holding in holdings {
            if holding.holding_type != HoldingType::Security {
                continue;
            }

            let Some(asset_id) = holding.instrument.as_ref().map(|instrument| &instrument.id)
            else {
                continue;
            };
            let Some(cost_basis_base) = cost_basis_base_by_asset.get(asset_id) else {
                continue;
            };
            let Some(cost_basis) = &mut holding.cost_basis else {
                continue;
            };

            cost_basis.base = *cost_basis_base;
        }
    }

    async fn value_holdings_best_effort(&self, account_id: &str, holdings: &mut [Holding]) {
        if holdings.is_empty() {
            debug!(
                "No holdings found for account {}. Skipping valuation.",
                account_id
            );
            return;
        }

        if let Err(e) = self
            .valuation_service
            .calculate_holdings_live_valuation(holdings)
            .await
        {
            error!(
                "Live valuation calculation failed for account {}: {}. Returning partially valued holdings.",
                account_id, e
            );
        }
    }

    async fn apply_realized_gains_best_effort(&self, account_id: &str, holdings: &mut [Holding]) {
        let Some(lot_repository) = &self.lot_repository else {
            return;
        };
        let disposals = match lot_repository
            .get_lot_disposals_for_account(account_id)
            .await
        {
            Ok(disposals) => disposals,
            Err(e) => {
                warn!(
                    "Failed to load lot disposals for account {} while calculating realized gains: {}",
                    account_id, e
                );
                return;
            }
        };
        if disposals.is_empty() {
            return;
        }
        let disposal_trade_activity_ids = self.disposal_trade_activity_ids_for_account(account_id);

        #[derive(Default)]
        struct Totals {
            realized_local: Decimal,
            realized_base: Decimal,
            disposed_cost_local: Decimal,
            disposed_cost_base: Decimal,
        }

        let mut totals_by_asset: HashMap<String, Totals> = HashMap::new();
        for disposal in disposals {
            if let Some(disposal_trade_activity_ids) = &disposal_trade_activity_ids {
                if !disposal_trade_activity_ids.contains(&disposal.disposal_activity_id) {
                    continue;
                }
            }
            let totals = totals_by_asset.entry(disposal.asset_id).or_default();
            totals.realized_local += parse_decimal_lossy(&disposal.realized_pnl);
            totals.realized_base += parse_decimal_lossy(&disposal.realized_pnl_base);
            totals.disposed_cost_local += parse_decimal_lossy(&disposal.cost_basis);
            totals.disposed_cost_base += parse_decimal_lossy(&disposal.cost_basis_base);
        }

        for holding in holdings {
            if !matches!(
                holding.holding_type,
                HoldingType::Security | HoldingType::AlternativeAsset
            ) {
                continue;
            }
            let Some(asset_id) = holding
                .instrument
                .as_ref()
                .map(|instrument| instrument.id.clone())
            else {
                continue;
            };
            let Some(totals) = totals_by_asset.get(&asset_id) else {
                continue;
            };

            let realized = MonetaryValue {
                local: totals.realized_local,
                base: totals.realized_base,
            };
            holding.realized_gain = Some(realized.clone());
            holding.realized_gain_pct = gain_pct(realized.local, totals.disposed_cost_local);

            let mut total_gain = realized;
            if let Some(unrealized) = &holding.unrealized_gain {
                total_gain.local += unrealized.local;
                total_gain.base += unrealized.base;
            }
            holding.total_gain = Some(total_gain.clone());

            let open_cost_base = holding
                .cost_basis
                .as_ref()
                .map(|cost_basis| cost_basis.base)
                .unwrap_or(Decimal::ZERO);
            let open_cost_local = holding
                .cost_basis
                .as_ref()
                .map(|cost_basis| cost_basis.local)
                .unwrap_or(Decimal::ZERO);
            let return_basis = MonetaryValue {
                local: open_cost_local + totals.disposed_cost_local,
                base: open_cost_base + totals.disposed_cost_base,
            };
            holding.return_basis = Some(return_basis.clone());
            holding.total_gain_pct = gain_pct(total_gain.local, return_basis.local);
        }
    }

    fn disposal_trade_activity_ids_for_account(&self, account_id: &str) -> Option<HashSet<String>> {
        let activity_repository = self.activity_repository.as_ref()?;
        match activity_repository.get_activities_by_account_id(account_id) {
            Ok(activities) => Some(
                activities
                    .into_iter()
                    .filter(|activity| activity.is_posted())
                    .filter(|activity| {
                        let activity_type = activity.effective_type();
                        activity_type == ACTIVITY_TYPE_SELL || activity_type == ACTIVITY_TYPE_BUY
                    })
                    .map(|activity| activity.id)
                    .collect(),
            ),
            Err(e) => {
                warn!(
                    "Failed to load activities for holdings realized-gain disposal filtering on account {}: {}. Disposals will be ignored.",
                    account_id, e
                );
                Some(HashSet::new())
            }
        }
    }

    fn apply_return_basis_defaults(&self, holdings: &mut [Holding]) {
        for holding in holdings {
            if holding.return_basis.is_none() {
                holding.return_basis = holding.cost_basis.clone();
            }

            let Some(total_gain) = holding.total_gain.clone() else {
                continue;
            };
            let basis_local = holding
                .return_basis
                .as_ref()
                .map(|basis| basis.local)
                .unwrap_or(Decimal::ZERO);
            holding.total_gain_pct = gain_pct(total_gain.local, basis_local);
        }
    }

    fn apply_income_and_total_return_best_effort(
        &self,
        account_ids: &[String],
        base_currency: &str,
        holdings: &mut [Holding],
    ) {
        let mut asset_currencies: HashMap<String, String> = HashMap::new();
        for holding in holdings.iter() {
            if matches!(
                holding.holding_type,
                HoldingType::Security | HoldingType::AlternativeAsset
            ) {
                if let Some(instrument) = &holding.instrument {
                    asset_currencies.insert(instrument.id.clone(), holding.local_currency.clone());
                }
            }
        }

        let income_by_asset = if asset_currencies.is_empty() {
            HashMap::new()
        } else {
            match &self.income_service {
                Some(income_service) => {
                    match income_service.get_asset_income(
                        account_ids,
                        &asset_currencies,
                        base_currency,
                    ) {
                        Ok(income) => income,
                        Err(e) => {
                            warn!(
                                "Failed to load asset-linked income for holdings scope {:?}: {}",
                                account_ids, e
                            );
                            HashMap::new()
                        }
                    }
                }
                None => HashMap::new(),
            }
        };

        for holding in holdings {
            if !matches!(
                holding.holding_type,
                HoldingType::Security | HoldingType::AlternativeAsset
            ) {
                holding.income = holding
                    .income
                    .clone()
                    .or_else(|| Some(MonetaryValue::zero()));
                refresh_total_return(holding);
                continue;
            }

            let income = holding
                .instrument
                .as_ref()
                .and_then(|instrument| income_by_asset.get(&instrument.id))
                .cloned()
                .unwrap_or_else(MonetaryValue::zero);
            holding.income = Some(income);
            refresh_total_return(holding);
        }
    }
}

fn gain_pct(amount: Decimal, basis: Decimal) -> Option<Decimal> {
    let exposure = basis.abs();
    if exposure > Decimal::ZERO {
        Some((amount / exposure).round_dp(DECIMAL_PRECISION))
    } else if amount.is_zero() {
        Some(Decimal::ZERO)
    } else {
        None
    }
}

fn refresh_total_return(holding: &mut Holding) {
    if holding.total_gain.is_none() {
        let mut total_gain = MonetaryValue::zero();
        let mut has_gain = false;
        if let Some(realized) = &holding.realized_gain {
            add_monetary(&mut total_gain, realized);
            has_gain = true;
        }
        if let Some(unrealized) = &holding.unrealized_gain {
            add_monetary(&mut total_gain, unrealized);
            has_gain = true;
        }
        if has_gain {
            holding.total_gain = Some(total_gain);
        }
    }

    let basis_local = holding
        .return_basis
        .as_ref()
        .map(|basis| basis.local)
        .unwrap_or(Decimal::ZERO);
    if let Some(total_gain) = &holding.total_gain {
        holding.total_gain_pct = gain_pct(total_gain.local, basis_local);
    }

    let mut total_return = holding
        .total_gain
        .clone()
        .unwrap_or_else(MonetaryValue::zero);
    if let Some(income) = &holding.income {
        add_monetary(&mut total_return, income);
    }
    holding.total_return = Some(total_return.clone());
    holding.total_return_pct = gain_pct(total_return.local, basis_local);
}

fn calculate_asset_income(
    activities: &[Activity],
    asset_currencies: &HashMap<String, String>,
    base_currency: &str,
    fx_service: &dyn FxServiceTrait,
    timezone: chrono_tz::Tz,
) -> HashMap<String, MonetaryValue> {
    let mut income_by_asset: HashMap<String, MonetaryValue> = HashMap::new();

    for activity in activities {
        if !activity.is_posted() {
            continue;
        }

        let activity_type = activity.effective_type();
        if activity_type != ACTIVITY_TYPE_DIVIDEND && activity_type != ACTIVITY_TYPE_INTEREST {
            continue;
        }

        let Some(asset_id) = activity.asset_id.as_ref() else {
            continue;
        };
        let Some(local_currency) = asset_currencies.get(asset_id) else {
            continue;
        };

        let amount = activity_income_amount(activity);
        if amount.is_zero() {
            continue;
        }

        let activity_date = activity_date_in_tz(activity.activity_date, timezone);
        let Some(local_income) = convert_income_amount(
            fx_service,
            amount,
            &activity.currency,
            local_currency,
            activity_date,
            &activity.id,
        ) else {
            continue;
        };
        let Some(base_income) = convert_income_amount(
            fx_service,
            amount,
            &activity.currency,
            base_currency,
            activity_date,
            &activity.id,
        ) else {
            continue;
        };

        let income = MonetaryValue {
            local: local_income,
            base: base_income,
        };
        income_by_asset
            .entry(asset_id.clone())
            .and_modify(|existing| add_monetary(existing, &income))
            .or_insert(income);
    }

    income_by_asset
}

fn activity_income_amount(activity: &Activity) -> Decimal {
    let amount = activity.amt();
    if amount > Decimal::ZERO {
        amount
    } else {
        activity.qty() * activity.price()
    }
}

fn convert_income_amount(
    fx_service: &dyn FxServiceTrait,
    amount: Decimal,
    from_currency: &str,
    to_currency: &str,
    date: NaiveDate,
    activity_id: &str,
) -> Option<Decimal> {
    if from_currency == to_currency {
        return Some(amount);
    }

    match fx_service.convert_currency_for_date(amount, from_currency, to_currency, date) {
        Ok(converted) => Some(converted),
        Err(e) => {
            warn!(
                "Skipping income conversion for activity {}: {} {} -> {} on {} failed: {}",
                activity_id, amount, from_currency, to_currency, date, e
            );
            None
        }
    }
}

fn parse_decimal_lossy(value: &str) -> Decimal {
    value.parse::<Decimal>().unwrap_or(Decimal::ZERO)
}

fn add_monetary(acc: &mut MonetaryValue, other: &MonetaryValue) {
    acc.local += other.local;
    acc.base += other.base;
}

fn add_optional_monetary(acc: &mut Option<MonetaryValue>, other: &Option<MonetaryValue>) {
    match (acc.as_mut(), other) {
        (Some(a), Some(b)) => add_monetary(a, b),
        (None, Some(b)) => *acc = Some(b.clone()),
        _ => {}
    }
}

fn apply_factor_to_monetary_value(value: &mut MonetaryValue, factor: Decimal) {
    value.local *= factor;
}

fn apply_factor_to_optional_monetary_value(value: &mut Option<MonetaryValue>, factor: Decimal) {
    if let Some(v) = value {
        apply_factor_to_monetary_value(v, factor);
    }
}

fn normalize_holding_currency(holding: &mut Holding) {
    if let Some(instrument) = holding.instrument.as_mut() {
        let normalized_currency = normalize_currency_code(&instrument.currency);
        instrument.currency = normalized_currency.to_string();
    }

    if let Some(rule) = get_normalization_rule(&holding.local_currency) {
        let factor = rule.factor;
        holding.local_currency = rule.major_code.to_string();

        if let Some(rate) = holding.fx_rate {
            holding.fx_rate = Some(rate / factor);
        }

        if holding.holding_type == HoldingType::Security
            || holding.holding_type == HoldingType::AlternativeAsset
        {
            if let Some(price) = holding.price {
                holding.price = Some(price * factor);
            }
            // Also normalize purchase_price for alternative assets
            if let Some(purchase_price) = holding.purchase_price {
                holding.purchase_price = Some(purchase_price * factor);
            }
        } else if holding.holding_type == HoldingType::Cash {
            holding.price = Some(Decimal::ONE);
        }

        apply_factor_to_monetary_value(&mut holding.market_value, factor);
        apply_factor_to_optional_monetary_value(&mut holding.cost_basis, factor);
        apply_factor_to_optional_monetary_value(&mut holding.unrealized_gain, factor);
        apply_factor_to_optional_monetary_value(&mut holding.realized_gain, factor);
        apply_factor_to_optional_monetary_value(&mut holding.total_gain, factor);
        apply_factor_to_optional_monetary_value(&mut holding.income, factor);
        apply_factor_to_optional_monetary_value(&mut holding.total_return, factor);
        apply_factor_to_optional_monetary_value(&mut holding.return_basis, factor);
        apply_factor_to_optional_monetary_value(&mut holding.day_change, factor);
        apply_factor_to_optional_monetary_value(&mut holding.prev_close_value, factor);

        if let Some(lots) = holding.lots.as_mut() {
            for lot in lots {
                lot.cost_basis *= factor;
                lot.acquisition_price *= factor;
                lot.acquisition_fees *= factor;
            }
        }
    }
}

fn extract_purchase_price(metadata: &Value) -> Option<Decimal> {
    metadata.get("purchase_price").and_then(|v| {
        if let Some(s) = v.as_str() {
            s.parse::<Decimal>().ok()
        } else if let Some(n) = v.as_f64() {
            Decimal::try_from(n).ok()
        } else {
            None
        }
    })
}

fn apply_portfolio_weights(account_id: &str, holdings: &mut [Holding]) {
    let total_portfolio_exposure_base: Decimal = holdings
        .iter()
        .map(|holding| holding.market_value.base.abs())
        .sum();

    if total_portfolio_exposure_base > dec!(0) {
        for holding in holdings {
            holding.weight = (holding.market_value.base / total_portfolio_exposure_base)
                .round_dp(DECIMAL_PRECISION);
        }
    } else {
        debug!(
            "Total portfolio base exposure is zero for account {}. Allocations set to 0.",
            account_id
        );
        for holding in holdings {
            holding.weight = Decimal::ZERO;
        }
    }
}

#[cfg(test)]
mod expired_option_metadata_tests {
    use super::is_expired_option;
    use chrono::NaiveDate;
    use serde_json::json;

    #[test]
    fn detects_expired_option_metadata() {
        let metadata = json!({
            "option": {
                "expiration": "2026-03-06"
            }
        });
        let today = NaiveDate::from_ymd_opt(2026, 4, 27).unwrap();

        assert!(is_expired_option(true, Some(&metadata), &[""], today));
    }

    #[test]
    fn detects_expired_occ_symbol_without_metadata() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 27).unwrap();

        assert!(is_expired_option(
            true,
            None,
            &["TSLA260306C00397500"],
            today
        ));
    }

    #[test]
    fn detects_expired_canonical_symbol_when_display_symbol_is_custom() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 27).unwrap();

        assert!(is_expired_option(
            true,
            None,
            &["Custom Label", "TSLA260306C00397500"],
            today
        ));
    }

    #[test]
    fn requires_option_instrument_type() {
        let metadata = json!({
            "option": {
                "expiration": "2026-03-06"
            }
        });
        let today = NaiveDate::from_ymd_opt(2026, 4, 27).unwrap();

        assert!(!is_expired_option(
            false,
            Some(&metadata),
            &["TSLA260306C00397500"],
            today
        ));
    }

    #[test]
    fn keeps_active_and_same_day_option_metadata() {
        let same_day = json!({
            "option": {
                "expiration": "2026-04-27"
            }
        });
        let future = json!({
            "option": {
                "expiration": "2026-05-15"
            }
        });
        let today = NaiveDate::from_ymd_opt(2026, 4, 27).unwrap();

        assert!(!is_expired_option(true, Some(&same_day), &[""], today));
        assert!(!is_expired_option(true, Some(&future), &[""], today));
        assert!(!is_expired_option(
            true,
            None,
            &["TSLA260427C00397500"],
            today
        ));
    }

    #[test]
    fn ignores_non_option_or_invalid_metadata() {
        let non_option = json!({ "bond": { "maturityDate": "2026-03-06" } });
        let invalid_option = json!({ "option": { "expiration": "not-a-date" } });
        let today = NaiveDate::from_ymd_opt(2026, 4, 27).unwrap();

        assert!(!is_expired_option(
            true,
            Some(&non_option),
            &["AAPL"],
            today
        ));
        assert!(!is_expired_option(
            true,
            Some(&invalid_option),
            &["AAPL"],
            today
        ));
        assert!(!is_expired_option(true, None, &["AAPL"], today));
    }
}

#[async_trait]
impl HoldingsServiceTrait for HoldingsService {
    async fn get_holdings(&self, account_id: &str, base_currency: &str) -> Result<Vec<Holding>> {
        debug!(
            "Getting holdings for account {} in base currency {}",
            account_id, base_currency
        );

        let latest_snapshot = match self
            .snapshot_service
            .get_latest_holdings_snapshot(account_id)
        {
            Ok(Some(snap)) => snap,
            Ok(None) => {
                debug!(
                    "No calculated holdings found for account {}. Returning empty holdings list.",
                    account_id
                );
                return Ok(Vec::new());
            }
            Err(core_error) => {
                error!(
                    "Failed to get latest snapshot for account {}: {}",
                    account_id, core_error
                );
                return Err(core_error);
            }
        };

        let mut holdings = self
            .build_live_holdings_from_snapshot(
                account_id,
                &latest_snapshot,
                base_currency,
                None,
                true,
            )
            .await;
        self.apply_historical_cost_basis_best_effort(
            account_id,
            base_currency,
            &mut holdings,
            None,
        )
        .await;
        self.value_holdings_best_effort(account_id, &mut holdings)
            .await;
        self.apply_realized_gains_best_effort(account_id, &mut holdings)
            .await;
        self.apply_return_basis_defaults(&mut holdings);
        self.apply_income_and_total_return_best_effort(
            &[account_id.to_string()],
            base_currency,
            &mut holdings,
        );
        apply_portfolio_weights(account_id, &mut holdings);

        // Load taxonomy classifications for all holdings
        let asset_ids: Vec<String> = holdings
            .iter()
            .filter_map(|h| h.instrument.as_ref().map(|i| i.id.clone()))
            .collect();
        if !asset_ids.is_empty() {
            let classifications_map = self
                .classification_service
                .get_classifications_batch(&asset_ids);
            for holding in &mut holdings {
                if let Some(ref mut instrument) = holding.instrument {
                    if let Some(classifications) = classifications_map.get(&instrument.id) {
                        instrument.classifications = Some(classifications.clone());
                    }
                }
            }
        }

        for holding_view in &mut holdings {
            normalize_holding_currency(holding_view);
        }

        Ok(holdings)
    }

    async fn get_holdings_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> Result<Vec<Holding>> {
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }

        // Collect all holdings from each member account.
        let mut all_holdings: Vec<Holding> = Vec::new();
        for account_id in account_ids {
            let holdings = self.get_holdings(account_id, base_currency).await?;
            all_holdings.extend(holdings);
        }

        // Merge by key: securities/alternatives → asset id; cash → local_currency.
        let mut merged: HashMap<String, Holding> = HashMap::new();
        for holding in all_holdings {
            let key = match &holding.holding_type {
                HoldingType::Cash => format!("CASH-{}", holding.local_currency),
                _ => holding
                    .instrument
                    .as_ref()
                    .map(|i| i.id.clone())
                    .unwrap_or_else(|| holding.id.clone()),
            };

            match merged.entry(key.clone()) {
                std::collections::hash_map::Entry::Occupied(mut occ) => {
                    let acc = occ.get_mut();
                    if !acc.source_account_ids.contains(&holding.account_id) {
                        acc.source_account_ids.push(holding.account_id.clone());
                    }
                    acc.quantity += holding.quantity;
                    add_monetary(&mut acc.market_value, &holding.market_value);
                    add_optional_monetary(&mut acc.cost_basis, &holding.cost_basis);
                    add_optional_monetary(&mut acc.unrealized_gain, &holding.unrealized_gain);
                    add_optional_monetary(&mut acc.realized_gain, &holding.realized_gain);
                    add_optional_monetary(&mut acc.total_gain, &holding.total_gain);
                    add_optional_monetary(&mut acc.income, &holding.income);
                    add_optional_monetary(&mut acc.total_return, &holding.total_return);
                    add_optional_monetary(&mut acc.return_basis, &holding.return_basis);
                    add_optional_monetary(&mut acc.day_change, &holding.day_change);
                    add_optional_monetary(&mut acc.prev_close_value, &holding.prev_close_value);
                    if let Some(date) = holding.open_date {
                        acc.open_date = Some(match acc.open_date {
                            Some(existing) => existing.min(date),
                            None => date,
                        });
                    }
                    if let Some(lots) = holding.lots {
                        acc.lots
                            .get_or_insert_with(std::collections::VecDeque::new)
                            .extend(lots);
                    }
                }
                std::collections::hash_map::Entry::Vacant(vac) => {
                    let original_account_id = holding.account_id.clone();
                    let mut h = holding;
                    h.id = format!("AGG-{}", key);
                    h.account_id = aggregated_account_id.to_string();
                    h.source_account_ids = vec![original_account_id];
                    vac.insert(h);
                }
            }
        }

        let mut result: Vec<Holding> = merged.into_values().collect();
        // Sort for deterministic output: cash last, then by id.
        result.sort_by(|a, b| {
            let a_cash = matches!(a.holding_type, HoldingType::Cash);
            let b_cash = matches!(b.holding_type, HoldingType::Cash);
            a_cash.cmp(&b_cash).then_with(|| a.id.cmp(&b.id))
        });

        // Recompute percentage fields from the summed local values.
        // The merge loop accumulates monetary values but percentages from the first
        // account seen are no longer correct for the aggregated position.
        for h in result.iter_mut() {
            let basis_local = h
                .return_basis
                .as_ref()
                .map(|basis| basis.local)
                .unwrap_or(Decimal::ZERO);
            let open_cost_local = h
                .cost_basis
                .as_ref()
                .map(|cost_basis| cost_basis.local)
                .unwrap_or(Decimal::ZERO);
            h.unrealized_gain_pct = h
                .unrealized_gain
                .as_ref()
                .and_then(|value| gain_pct(value.local, open_cost_local));
            let disposed_cost_local = basis_local - open_cost_local;
            h.realized_gain_pct = h
                .realized_gain
                .as_ref()
                .and_then(|value| gain_pct(value.local, disposed_cost_local));
            refresh_total_return(h);
            let prev_close_base = h
                .prev_close_value
                .as_ref()
                .map(|p| p.base)
                .unwrap_or(Decimal::ZERO);
            let prev_close_exposure_base = prev_close_base.abs();
            if prev_close_exposure_base > Decimal::ZERO {
                h.day_change_pct = h
                    .day_change
                    .as_ref()
                    .map(|v| v.base / prev_close_exposure_base);
            } else {
                h.day_change_pct = None;
            }
        }

        apply_portfolio_weights(aggregated_account_id, &mut result);
        Ok(result)
    }

    async fn get_holding(
        &self,
        account_id: &str,
        asset_id: &str,
        base_currency: &str,
    ) -> Result<Option<Holding>> {
        debug!(
            "Getting specific holding for asset {} in account {} (base currency: {})",
            asset_id, account_id, base_currency
        );

        let latest_snapshot = match self
            .snapshot_service
            .get_latest_holdings_snapshot(account_id)
        {
            Ok(Some(snap)) => snap,
            Ok(None) => {
                debug!(
                    "No snapshot found for account {}. Cannot get holding for asset {}.",
                    account_id, asset_id
                );
                return Ok(None);
            }
            Err(e) => {
                error!(
                    "Failed to get latest snapshot for account {} while getting holding {}: {}",
                    account_id, asset_id, e
                );
                return Err(e);
            }
        };

        let Some(position) = latest_snapshot.positions.get(asset_id).cloned() else {
            debug!(
                "Asset {} not found in holdings snapshot for account {}.",
                asset_id, account_id
            );
            return Ok(None);
        };

        if position.quantity == Decimal::ZERO {
            debug!(
                "Asset {} found but quantity is zero in snapshot for account {}.",
                asset_id, account_id
            );
            return Ok(None);
        }

        let mut holdings = self
            .build_live_holdings_from_snapshot(
                account_id,
                &latest_snapshot,
                base_currency,
                Some(asset_id),
                true,
            )
            .await;
        self.apply_historical_cost_basis_best_effort(
            account_id,
            base_currency,
            &mut holdings,
            Some(asset_id),
        )
        .await;
        self.value_holdings_best_effort(account_id, &mut holdings)
            .await;
        self.apply_realized_gains_best_effort(account_id, &mut holdings)
            .await;
        self.apply_return_basis_defaults(&mut holdings);
        self.apply_income_and_total_return_best_effort(
            &[account_id.to_string()],
            base_currency,
            &mut holdings,
        );
        apply_portfolio_weights(account_id, &mut holdings);
        for holding in &mut holdings {
            normalize_holding_currency(holding);
        }

        let holding_index = holdings.iter().position(|h| {
            h.instrument
                .as_ref()
                .map(|i| i.id == asset_id)
                .unwrap_or(false)
        });

        let Some(index) = holding_index else {
            if let Ok(asset) = self.asset_service.get_asset_by_id(asset_id) {
                if is_expired_option_asset(&asset, self.today_in_user_timezone()) {
                    debug!(
                        "Asset {} exists in snapshot for account {} but is an expired option hidden from live holdings.",
                        asset_id, account_id
                    );
                    return Ok(None);
                }
            }

            error!(
                "Asset {} exists in snapshot for account {} but holding view could not be built.",
                asset_id, account_id
            );
            return Err(CoreError::Calculation(CalculatorError::Calculation(
                format!("Failed to build holding view for {}", asset_id),
            )));
        };

        let mut valued_holding = holdings.swap_remove(index);

        if let Some(ref mut instrument) = valued_holding.instrument {
            if let Ok(classifications) = self
                .classification_service
                .get_classifications(&instrument.id)
            {
                instrument.classifications = Some(classifications);
            }
        }

        Ok(Some(valued_holding))
    }

    async fn holdings_from_snapshot(
        &self,
        snapshot: &snapshot::AccountStateSnapshot,
        base_currency: &str,
    ) -> Result<Vec<Holding>> {
        let mut holdings: Vec<Holding> = Vec::new();

        // Get all asset IDs from positions
        let asset_ids: Vec<String> = snapshot
            .positions
            .values()
            .map(|p| p.asset_id.clone())
            .collect();

        // Fetch asset details if we have positions
        let assets_map: HashMap<String, Asset> = if !asset_ids.is_empty() {
            self.asset_service
                .get_assets_by_asset_ids(&asset_ids)
                .await?
                .into_iter()
                .map(|a| (a.id.clone(), a))
                .collect()
        } else {
            HashMap::new()
        };

        // Convert positions to holdings
        for position in snapshot.positions.values() {
            if position.quantity == Decimal::ZERO {
                continue;
            }

            let Some(asset) = assets_map.get(&position.asset_id) else {
                warn!(
                    "Asset {} not found for position in snapshot",
                    position.asset_id
                );
                continue;
            };

            let (holding_type, id_prefix) = if asset.kind.is_alternative() {
                (HoldingType::AlternativeAsset, "ALT")
            } else {
                (HoldingType::Security, "SEC")
            };

            // Extract purchase_price from metadata for alternative assets
            let purchase_price: Option<Decimal> =
                asset.metadata.as_ref().and_then(extract_purchase_price);

            let instrument = Instrument {
                id: asset.id.clone(),
                symbol: asset.display_code.clone().unwrap_or_default(),
                name: asset.name.clone(),
                currency: asset.quote_ccy.clone(),
                notes: asset.notes.clone(),
                pricing_mode: asset.quote_mode.as_db_str().to_string(),
                preferred_provider: asset.preferred_provider(),
                exchange_mic: asset.instrument_exchange_mic.clone(),
                classifications: None,
            };

            let holding = Holding {
                id: format!(
                    "{}-{}-{}",
                    id_prefix, snapshot.account_id, position.asset_id
                ),
                account_id: snapshot.account_id.clone(),
                holding_type,
                instrument: Some(instrument),
                asset_kind: Some(asset.kind.clone()),
                quantity: position.quantity,
                open_date: Some(position.inception_date),
                lots: None,
                contract_multiplier: position.contract_multiplier,
                local_currency: position.currency.clone(),
                base_currency: base_currency.to_string(),
                fx_rate: None,
                market_value: MonetaryValue::zero(),
                cost_basis: Some(MonetaryValue {
                    local: position.total_cost_basis,
                    base: Decimal::ZERO,
                }),
                price: None,
                purchase_price,
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
                as_of_date: snapshot.snapshot_date,
                metadata: asset.metadata.clone(),
                source_account_ids: Vec::new(),
            };
            holdings.push(holding);
        }

        // Convert cash balances to holdings
        for (currency, &amount) in &snapshot.cash_balances {
            if amount == Decimal::ZERO {
                continue;
            }

            let holding = Holding {
                id: format!("CASH-{}-{}", snapshot.account_id, currency),
                account_id: snapshot.account_id.clone(),
                holding_type: HoldingType::Cash,
                instrument: None,
                asset_kind: None,
                quantity: amount,
                open_date: None,
                lots: None,
                contract_multiplier: Decimal::ONE,
                local_currency: currency.clone(),
                base_currency: base_currency.to_string(),
                fx_rate: None,
                market_value: MonetaryValue {
                    local: amount,
                    base: Decimal::ZERO,
                },
                cost_basis: Some(MonetaryValue {
                    local: amount,
                    base: Decimal::ZERO,
                }),
                price: Some(Decimal::ONE),
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
                as_of_date: snapshot.snapshot_date,
                metadata: None,
                source_account_ids: Vec::new(),
            };
            holdings.push(holding);
        }

        Ok(holdings)
    }
}

#[cfg(test)]
mod tests {
    use crate::activities::ActivityStatus;
    use crate::assets::{
        AssetMetadata, AssetResolutionInput, AssetResolutionOutput, AssetSpec, EnsureAssetsResult,
        NewAsset, QuoteMode, UpdateAssetProfile,
    };
    use crate::errors::Error;
    use crate::fx::{denormalization_multiplier, ExchangeRate, FxServiceTrait, NewExchangeRate};
    use crate::lots::{AssetLotView, LotClosure, LotRecord};
    use crate::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotRecalcMode};
    use crate::snapshot::Lot;
    use crate::taxonomies::{
        AssetTaxonomyAssignment, Category, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy,
        Taxonomy, TaxonomyServiceTrait, TaxonomyWithCategories,
    };
    use crate::utils::time_utils::valuation_date_today;

    use super::*;
    use chrono::{NaiveDate, Utc};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    use serde_json::json;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    struct MockAssetService {
        assets: HashMap<String, Asset>,
    }

    #[test]
    fn gain_pct_is_unavailable_when_basis_is_zero_and_gain_is_nonzero() {
        assert_eq!(gain_pct(dec!(10), Decimal::ZERO), None);
        assert_eq!(gain_pct(Decimal::ZERO, Decimal::ZERO), Some(Decimal::ZERO));
        assert_eq!(gain_pct(dec!(10), dec!(100)), Some(dec!(0.1)));
    }

    impl MockAssetService {
        fn new(assets: Vec<Asset>) -> Self {
            Self {
                assets: assets
                    .into_iter()
                    .map(|asset| (asset.id.clone(), asset))
                    .collect(),
            }
        }
    }

    #[async_trait::async_trait]
    impl AssetServiceTrait for MockAssetService {
        fn get_assets(&self) -> Result<Vec<Asset>> {
            Ok(self.assets.values().cloned().collect())
        }

        fn get_asset_by_id(&self, asset_id: &str) -> Result<Asset> {
            self.assets
                .get(asset_id)
                .cloned()
                .ok_or_else(|| Error::Asset(format!("Asset not found: {asset_id}")))
        }

        async fn delete_asset(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }

        async fn update_asset_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            unimplemented!("unused in holdings service tests")
        }

        async fn create_asset(&self, _new_asset: NewAsset) -> Result<Asset> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_or_create_minimal_asset(
            &self,
            _asset_id: &str,
            _context_currency: Option<String>,
            _metadata: Option<AssetMetadata>,
            _quote_mode: Option<String>,
        ) -> Result<Asset> {
            unimplemented!("unused in holdings service tests")
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_assets_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
            Ok(asset_ids
                .iter()
                .filter_map(|asset_id| self.assets.get(asset_id).cloned())
                .collect())
        }

        async fn enrich_asset_profile(&self, _asset_id: &str) -> Result<Asset> {
            unimplemented!("unused in holdings service tests")
        }

        async fn enrich_assets(&self, _asset_ids: Vec<String>) -> Result<(usize, usize, usize)> {
            unimplemented!("unused in holdings service tests")
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }

        async fn merge_unknown_asset(
            &self,
            _resolved_asset_id: &str,
            _unknown_asset_id: &str,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<u32> {
            unimplemented!("unused in holdings service tests")
        }

        async fn ensure_assets(
            &self,
            _specs: Vec<AssetSpec>,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<EnsureAssetsResult> {
            unimplemented!("unused in holdings service tests")
        }

        async fn resolve_import_asset_inputs(
            &self,
            _inputs: Vec<AssetResolutionInput>,
        ) -> Result<Vec<AssetResolutionOutput>> {
            unimplemented!("unused in holdings service tests")
        }
    }

    struct MockSnapshotService {
        snapshot: AccountStateSnapshot,
    }

    #[async_trait::async_trait]
    impl SnapshotServiceTrait for MockSnapshotService {
        async fn recalculate_holdings_snapshots(
            &self,
            _account_ids: Option<&[String]>,
            _mode: SnapshotRecalcMode,
        ) -> Result<usize> {
            unimplemented!("unused in holdings service tests")
        }

        fn get_holdings_keyframes(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<Vec<AccountStateSnapshot>> {
            unimplemented!("unused in holdings service tests")
        }

        fn get_daily_holdings_snapshots(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<Vec<AccountStateSnapshot>> {
            unimplemented!("unused in holdings service tests")
        }

        fn get_latest_holdings_snapshot(
            &self,
            _account_id: &str,
        ) -> Result<Option<AccountStateSnapshot>> {
            Ok(Some(self.snapshot.clone()))
        }

        async fn save_manual_snapshot(
            &self,
            _account_id: &str,
            _snapshot: AccountStateSnapshot,
        ) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }

        async fn update_snapshots_source(
            &self,
            _account_id: &str,
            _new_source: &str,
        ) -> Result<usize> {
            unimplemented!("unused in holdings service tests")
        }

        async fn ensure_holdings_history(&self, _account_id: &str) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }

        async fn delete_snapshot_for_account(
            &self,
            _account_id: &str,
            _dates: &[chrono::NaiveDate],
        ) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }
    }

    struct MockValuationService {
        values: HashMap<String, Decimal>,
    }

    #[async_trait::async_trait]
    impl HoldingsValuationServiceTrait for MockValuationService {
        async fn calculate_holdings_live_valuation(&self, holdings: &mut [Holding]) -> Result<()> {
            for holding in holdings {
                if let Some(asset_id) = holding.instrument.as_ref().map(|instrument| &instrument.id)
                {
                    if let Some(value) = self.values.get(asset_id) {
                        holding.market_value = MonetaryValue {
                            local: *value,
                            base: *value,
                        };
                        if let Some(cost_basis) = &holding.cost_basis {
                            let unrealized = MonetaryValue {
                                local: *value - cost_basis.local,
                                base: *value - cost_basis.base,
                            };
                            holding.unrealized_gain = Some(unrealized.clone());
                            holding.unrealized_gain_pct =
                                gain_pct(unrealized.local, cost_basis.local);
                            holding.total_gain = Some(unrealized.clone());
                            holding.total_gain_pct = holding.unrealized_gain_pct;
                        }
                    }
                }
            }
            Ok(())
        }
    }

    struct MockFxService {
        rates: HashMap<(String, String, NaiveDate), Decimal>,
    }

    impl MockFxService {
        fn new(rates: Vec<(&str, &str, NaiveDate, Decimal)>) -> Self {
            Self {
                rates: rates
                    .into_iter()
                    .map(|(from, to, date, rate)| {
                        (
                            (
                                normalize_currency_code(from).to_string(),
                                normalize_currency_code(to).to_string(),
                                date,
                            ),
                            rate,
                        )
                    })
                    .collect(),
            }
        }
    }

    #[async_trait::async_trait]
    impl FxServiceTrait for MockFxService {
        fn initialize(&self) -> Result<()> {
            Ok(())
        }

        fn get_historical_rates(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _days: i64,
        ) -> Result<Vec<ExchangeRate>> {
            Ok(Vec::new())
        }

        fn get_latest_exchange_rate(
            &self,
            from_currency: &str,
            to_currency: &str,
        ) -> Result<Decimal> {
            self.get_exchange_rate_for_date(from_currency, to_currency, valuation_date_today())
        }

        fn get_exchange_rate_for_date(
            &self,
            from_currency: &str,
            to_currency: &str,
            date: NaiveDate,
        ) -> Result<Decimal> {
            let from = normalize_currency_code(from_currency).to_string();
            let to = normalize_currency_code(to_currency).to_string();
            let source_multiplier = if from == from_currency {
                Decimal::ONE
            } else {
                Decimal::ONE / denormalization_multiplier(from_currency)
            };
            let target_multiplier = denormalization_multiplier(to_currency);
            if from == to {
                return Ok(source_multiplier * target_multiplier);
            }
            self.rates
                .get(&(from.clone(), to.clone(), date))
                .map(|rate| source_multiplier * *rate * target_multiplier)
                .ok_or_else(|| {
                    Error::Calculation(CalculatorError::Calculation(format!(
                        "Missing FX rate {from}->{to} on {date}"
                    )))
                })
        }

        fn convert_currency(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
        ) -> Result<Decimal> {
            Ok(amount * self.get_latest_exchange_rate(from_currency, to_currency)?)
        }

        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            from_currency: &str,
            to_currency: &str,
            date: NaiveDate,
        ) -> Result<Decimal> {
            Ok(amount * self.get_exchange_rate_for_date(from_currency, to_currency, date)?)
        }

        fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
            Ok(Vec::new())
        }

        async fn add_exchange_rate(&self, _new_rate: NewExchangeRate) -> Result<ExchangeRate> {
            unimplemented!("unused in holdings service tests")
        }

        async fn update_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _rate: Decimal,
        ) -> Result<ExchangeRate> {
            unimplemented!("unused in holdings service tests")
        }

        async fn delete_exchange_rate(&self, _rate_id: &str) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }

        async fn register_currency_pair(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            Ok(())
        }

        async fn register_currency_pair_manual(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            Ok(())
        }

        async fn ensure_fx_pairs(&self, _pairs: Vec<(String, String)>) -> Result<()> {
            Ok(())
        }
    }

    struct MockHoldingIncomeService {
        income_by_account: HashMap<String, HashMap<String, MonetaryValue>>,
        scopes: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl MockHoldingIncomeService {
        fn new(income_by_account: HashMap<String, HashMap<String, MonetaryValue>>) -> Self {
            Self {
                income_by_account,
                scopes: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn scopes(&self) -> Arc<Mutex<Vec<Vec<String>>>> {
            self.scopes.clone()
        }
    }

    impl HoldingIncomeServiceTrait for MockHoldingIncomeService {
        fn get_asset_income(
            &self,
            account_ids: &[String],
            _asset_currencies: &HashMap<String, String>,
            _base_currency: &str,
        ) -> Result<HashMap<String, MonetaryValue>> {
            self.scopes.lock().unwrap().push(account_ids.to_vec());
            let mut result = HashMap::new();
            for account_id in account_ids {
                if let Some(income_by_asset) = self.income_by_account.get(account_id) {
                    for (asset_id, income) in income_by_asset {
                        result
                            .entry(asset_id.clone())
                            .and_modify(|existing| add_monetary(existing, income))
                            .or_insert_with(|| income.clone());
                    }
                }
            }
            Ok(result)
        }
    }

    struct MockLotRepository {
        open_lots: Vec<LotRecord>,
        disposals: Vec<crate::lots::LotDisposal>,
        open_lots_calls: Arc<AtomicUsize>,
        open_lots_for_asset_calls: Arc<AtomicUsize>,
    }

    impl MockLotRepository {
        fn new(open_lots: Vec<LotRecord>) -> Self {
            Self {
                open_lots,
                disposals: Vec::new(),
                open_lots_calls: Arc::new(AtomicUsize::new(0)),
                open_lots_for_asset_calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn with_disposals(mut self, disposals: Vec<crate::lots::LotDisposal>) -> Self {
            self.disposals = disposals;
            self
        }

        fn open_lots_calls(&self) -> Arc<AtomicUsize> {
            self.open_lots_calls.clone()
        }

        fn open_lots_for_asset_calls(&self) -> Arc<AtomicUsize> {
            self.open_lots_for_asset_calls.clone()
        }
    }

    struct MockActivityRepository {
        activities: Vec<Activity>,
        fail_get_activities_by_account_id: bool,
    }

    impl MockActivityRepository {
        fn new(activities: Vec<Activity>) -> Self {
            Self {
                activities,
                fail_get_activities_by_account_id: false,
            }
        }

        fn failing_get_activities_by_account_id() -> Self {
            Self {
                activities: Vec::new(),
                fail_get_activities_by_account_id: true,
            }
        }
    }

    #[async_trait::async_trait]
    impl ActivityRepositoryTrait for MockActivityRepository {
        fn get_activity(&self, activity_id: &str) -> Result<Activity> {
            self.activities
                .iter()
                .find(|activity| activity.id == activity_id)
                .cloned()
                .ok_or_else(|| CoreError::Repository(format!("Activity not found: {activity_id}")))
        }

        fn find_transfer_counterpart(
            &self,
            group_id: &str,
            exclude_id: &str,
        ) -> Result<Option<Activity>> {
            Ok(self
                .activities
                .iter()
                .find(|activity| {
                    activity.source_group_id.as_deref() == Some(group_id)
                        && activity.id != exclude_id
                })
                .cloned())
        }

        fn get_activities(&self) -> Result<Vec<Activity>> {
            Ok(self.activities.clone())
        }

        fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>> {
            if self.fail_get_activities_by_account_id {
                return Err(CoreError::Repository(
                    "failed to load account activities".to_string(),
                ));
            }

            Ok(self
                .activities
                .iter()
                .filter(|activity| activity.account_id == account_id)
                .cloned()
                .collect())
        }

        fn get_activities_by_account_ids(&self, account_ids: &[String]) -> Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| account_ids.contains(&activity.account_id))
                .cloned()
                .collect())
        }

        fn get_trading_activities(&self) -> Result<Vec<Activity>> {
            self.get_activities()
        }

        fn get_income_activities(&self) -> Result<Vec<Activity>> {
            Ok(Vec::new())
        }

        fn get_contribution_activities(
            &self,
            _account_ids: &[String],
            _start_utc: chrono::DateTime<Utc>,
            _end_exclusive_utc: chrono::DateTime<Utc>,
        ) -> Result<Vec<crate::limits::ContributionActivity>> {
            Ok(Vec::new())
        }

        fn search_activities(
            &self,
            _page: i64,
            _page_size: i64,
            _account_id_filter: Option<Vec<String>>,
            _activity_type_filter: Option<Vec<String>>,
            _asset_id_keyword: Option<String>,
            _sort: Option<crate::activities::Sort>,
            _needs_review_filter: Option<bool>,
            _date_from: Option<NaiveDate>,
            _date_to: Option<NaiveDate>,
            _instrument_type_filter: Option<Vec<String>>,
            _activity_id_filter: Option<Vec<String>>,
        ) -> Result<crate::activities::ActivitySearchResponse> {
            unimplemented!("unused in holdings service tests")
        }

        async fn create_activity(
            &self,
            _new_activity: crate::activities::NewActivity,
        ) -> Result<Activity> {
            unimplemented!("unused in holdings service tests")
        }

        async fn update_activity(
            &self,
            _activity_update: crate::activities::ActivityUpdate,
        ) -> Result<Activity> {
            unimplemented!("unused in holdings service tests")
        }

        async fn delete_activity(&self, _activity_id: String) -> Result<Activity> {
            unimplemented!("unused in holdings service tests")
        }

        async fn link_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            unimplemented!("unused in holdings service tests")
        }

        async fn unlink_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            unimplemented!("unused in holdings service tests")
        }

        async fn bulk_mutate_activities(
            &self,
            _creates: Vec<crate::activities::NewActivity>,
            _updates: Vec<crate::activities::ActivityUpdate>,
            _delete_ids: Vec<String>,
        ) -> Result<crate::activities::ActivityBulkMutationResult> {
            unimplemented!("unused in holdings service tests")
        }

        async fn create_activities(
            &self,
            _activities: Vec<crate::activities::NewActivity>,
        ) -> Result<usize> {
            unimplemented!("unused in holdings service tests")
        }

        fn get_first_activity_date(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Option<chrono::DateTime<Utc>>> {
            Ok(self
                .activities
                .iter()
                .map(|activity| activity.activity_date)
                .min())
        }

        fn get_import_mapping(
            &self,
            _account_id: &str,
            _context_kind: &str,
        ) -> Result<Option<crate::activities::ImportMapping>> {
            Ok(None)
        }

        async fn save_import_mapping(
            &self,
            _mapping: &crate::activities::ImportMapping,
        ) -> Result<()> {
            Ok(())
        }

        async fn link_account_template(
            &self,
            _account_id: &str,
            _template_id: &str,
            _context_kind: &str,
        ) -> Result<()> {
            Ok(())
        }

        fn list_import_templates(&self) -> Result<Vec<crate::activities::ImportTemplate>> {
            Ok(Vec::new())
        }

        fn get_import_template(
            &self,
            _template_id: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }

        async fn save_import_template(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            Ok(())
        }

        async fn delete_import_template(&self, _template_id: &str) -> Result<()> {
            Ok(())
        }

        fn get_broker_sync_profile(
            &self,
            _account_id: &str,
            _source_system: &str,
        ) -> Result<Option<crate::activities::ImportTemplate>> {
            Ok(None)
        }

        async fn save_broker_sync_profile(
            &self,
            _template: &crate::activities::ImportTemplate,
        ) -> Result<()> {
            Ok(())
        }

        async fn link_broker_sync_profile(
            &self,
            _account_id: &str,
            _template_id: &str,
            _source_system: &str,
        ) -> Result<()> {
            Ok(())
        }

        fn calculate_average_cost(&self, _account_id: &str, _asset_id: &str) -> Result<Decimal> {
            Ok(Decimal::ZERO)
        }

        fn get_income_activities_data(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Vec<crate::activities::IncomeData>> {
            Ok(Vec::new())
        }

        fn get_first_activity_date_overall(&self) -> Result<chrono::DateTime<Utc>> {
            Ok(self
                .activities
                .iter()
                .map(|activity| activity.activity_date)
                .min()
                .unwrap_or_else(Utc::now))
        }

        fn get_activity_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            Ok(HashMap::new())
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
            Ok(HashMap::new())
        }

        fn check_existing_duplicates(
            &self,
            _idempotency_keys: &[String],
        ) -> Result<HashMap<String, String>> {
            Ok(HashMap::new())
        }

        async fn bulk_upsert(
            &self,
            _activities: Vec<crate::activities::ActivityUpsert>,
        ) -> Result<crate::activities::BulkUpsertResult> {
            unimplemented!("unused in holdings service tests")
        }

        async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> Result<u32> {
            Ok(0)
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _asset_id: &str,
        ) -> Result<(Vec<String>, Vec<String>)> {
            Ok((Vec::new(), Vec::new()))
        }
    }

    #[async_trait::async_trait]
    impl LotRepositoryTrait for MockLotRepository {
        async fn replace_lots_for_account(
            &self,
            _account_id: &str,
            _lots: &[LotRecord],
        ) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_open_lots_for_account(&self, _account_id: &str) -> Result<Vec<LotRecord>> {
            self.open_lots_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .open_lots
                .iter()
                .filter(|lot| lot.account_id == _account_id)
                .cloned()
                .collect())
        }

        async fn get_open_lots_for_account_asset(
            &self,
            _account_id: &str,
            asset_id: &str,
        ) -> Result<Vec<LotRecord>> {
            self.open_lots_for_asset_calls
                .fetch_add(1, Ordering::SeqCst);
            Ok(self
                .open_lots
                .iter()
                .filter(|lot| lot.account_id == _account_id && lot.asset_id == asset_id)
                .cloned()
                .collect())
        }

        async fn get_lot_disposals_for_account(
            &self,
            account_id: &str,
        ) -> Result<Vec<crate::lots::LotDisposal>> {
            Ok(self
                .disposals
                .iter()
                .filter(|disposal| disposal.account_id == account_id)
                .cloned()
                .collect())
        }

        fn get_lot_disposals_for_accounts_in_date_range_sync(
            &self,
            account_ids: &[String],
            start_date_exclusive: NaiveDate,
            end_date_inclusive: NaiveDate,
        ) -> Result<Vec<crate::lots::LotDisposal>> {
            Ok(self
                .disposals
                .iter()
                .filter(|disposal| account_ids.contains(&disposal.account_id))
                .filter(|disposal| {
                    NaiveDate::parse_from_str(&disposal.disposal_date, "%Y-%m-%d")
                        .is_ok_and(|date| date > start_date_exclusive && date <= end_date_inclusive)
                })
                .cloned()
                .collect())
        }

        async fn get_all_open_lots(&self) -> Result<Vec<LotRecord>> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_lots_as_of_date(
            &self,
            _account_ids: &[String],
            _date: NaiveDate,
        ) -> Result<Vec<LotRecord>> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_all_lots_for_account(&self, _account_id: &str) -> Result<Vec<LotRecord>> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_lots_for_asset(&self, _asset_id: &str) -> Result<Vec<LotRecord>> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_asset_lot_view(
            &self,
            _asset_id: &str,
            _include_snapshot_positions: bool,
        ) -> Result<Vec<AssetLotView>> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_all_lots(&self) -> Result<Vec<LotRecord>> {
            unimplemented!("unused in holdings service tests")
        }

        async fn sync_lots_for_account(
            &self,
            _account_id: &str,
            _open_lots: &[LotRecord],
            _closures: &[LotClosure],
        ) -> Result<()> {
            unimplemented!("unused in holdings service tests")
        }

        async fn get_open_position_quantities(&self) -> Result<HashMap<String, Decimal>> {
            unimplemented!("unused in holdings service tests")
        }

        fn count_lots(&self) -> Result<i64> {
            unimplemented!("unused in holdings service tests")
        }
    }

    struct EmptyTaxonomyService;

    #[async_trait::async_trait]
    impl TaxonomyServiceTrait for EmptyTaxonomyService {
        fn get_taxonomies(&self) -> Result<Vec<Taxonomy>> {
            Ok(Vec::new())
        }

        fn get_taxonomy(&self, _id: &str) -> Result<Option<TaxonomyWithCategories>> {
            Ok(None)
        }

        fn get_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>> {
            Ok(Vec::new())
        }

        async fn create_taxonomy(&self, _taxonomy: NewTaxonomy) -> Result<Taxonomy> {
            unimplemented!("unused in holdings service tests")
        }

        async fn update_taxonomy(&self, _taxonomy: Taxonomy) -> Result<Taxonomy> {
            unimplemented!("unused in holdings service tests")
        }

        async fn delete_taxonomy(&self, _id: &str) -> Result<usize> {
            unimplemented!("unused in holdings service tests")
        }

        async fn create_category(&self, _category: NewCategory) -> Result<Category> {
            unimplemented!("unused in holdings service tests")
        }

        async fn update_category(&self, _category: Category) -> Result<Category> {
            unimplemented!("unused in holdings service tests")
        }

        async fn delete_category(&self, _taxonomy_id: &str, _category_id: &str) -> Result<usize> {
            unimplemented!("unused in holdings service tests")
        }

        async fn move_category(
            &self,
            _taxonomy_id: &str,
            _category_id: &str,
            _new_parent_id: Option<String>,
            _position: i32,
        ) -> Result<Category> {
            unimplemented!("unused in holdings service tests")
        }

        async fn import_taxonomy_json(&self, _json_str: &str) -> Result<Taxonomy> {
            unimplemented!("unused in holdings service tests")
        }

        fn export_taxonomy_json(&self, _id: &str) -> Result<String> {
            unimplemented!("unused in holdings service tests")
        }

        fn get_asset_assignments(&self, _asset_id: &str) -> Result<Vec<AssetTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        fn get_category_assignments(
            &self,
            _taxonomy_id: &str,
            _category_id: &str,
        ) -> Result<Vec<AssetTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        async fn assign_asset_to_category(
            &self,
            _assignment: NewAssetTaxonomyAssignment,
        ) -> Result<AssetTaxonomyAssignment> {
            unimplemented!("unused in holdings service tests")
        }

        async fn replace_asset_taxonomy_assignments(
            &self,
            _asset_id: &str,
            _taxonomy_id: &str,
            _assignments: Vec<NewAssetTaxonomyAssignment>,
        ) -> Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!("unused in holdings service tests")
        }

        async fn remove_asset_assignment(&self, _id: &str) -> Result<usize> {
            unimplemented!("unused in holdings service tests")
        }
    }

    fn test_asset(id: &str, symbol: &str, instrument_type: InstrumentType) -> Asset {
        let now = Utc::now().naive_utc();
        Asset {
            id: id.to_string(),
            kind: AssetKind::Investment,
            name: Some(symbol.to_string()),
            display_code: Some(symbol.to_string()),
            quote_mode: QuoteMode::Market,
            quote_ccy: "USD".to_string(),
            instrument_type: Some(instrument_type),
            instrument_symbol: Some(symbol.to_string()),
            created_at: now,
            updated_at: now,
            ..Default::default()
        }
    }

    fn test_position(account_id: &str, asset_id: &str) -> Position {
        let now = Utc::now();
        Position {
            id: format!("POS-{asset_id}-{account_id}"),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            quantity: dec!(1),
            average_cost: dec!(100),
            total_cost_basis: dec!(100),
            currency: "USD".to_string(),
            inception_date: now,
            lots: VecDeque::new(),
            created_at: now,
            last_updated: now,
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
        }
    }

    fn test_lot_record(
        account_id: &str,
        asset_id: &str,
        base_currency: &str,
        remaining_cost_basis_base: Decimal,
    ) -> LotRecord {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        LotRecord {
            id: format!("LOT-{asset_id}-{base_currency}"),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            open_date: "2024-01-01".to_string(),
            open_activity_id: Some(format!("ACT-{asset_id}")),
            original_quantity: "1".to_string(),
            remaining_quantity: "1".to_string(),
            cost_per_unit: "100".to_string(),
            original_cost_basis: "100".to_string(),
            remaining_cost_basis: "100".to_string(),
            original_cost_basis_base: remaining_cost_basis_base.to_string(),
            remaining_cost_basis_base: remaining_cost_basis_base.to_string(),
            fee_allocated: "0".to_string(),
            fee_allocated_base: "0".to_string(),
            tax_allocated: "0".to_string(),
            tax_allocated_base: "0".to_string(),
            currency: "USD".to_string(),
            base_currency: base_currency.to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
            split_ratio: "1".to_string(),
            is_closed: false,
            close_date: None,
            close_activity_id: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn test_lot_disposal(
        account_id: &str,
        asset_id: &str,
        cost_basis: Decimal,
        cost_basis_base: Decimal,
        realized_pnl: Decimal,
        realized_pnl_base: Decimal,
    ) -> crate::lots::LotDisposal {
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        crate::lots::LotDisposal {
            id: format!("DISP-{account_id}-{asset_id}"),
            lot_id: format!("LOT-{account_id}-{asset_id}"),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            disposal_activity_id: format!("SELL-{account_id}-{asset_id}"),
            disposal_date: "2025-01-02".to_string(),
            quantity: "1".to_string(),
            proceeds: (cost_basis + realized_pnl).to_string(),
            cost_basis: cost_basis.to_string(),
            realized_pnl: realized_pnl.to_string(),
            proceeds_base: (cost_basis_base + realized_pnl_base).to_string(),
            cost_basis_base: cost_basis_base.to_string(),
            realized_pnl_base: realized_pnl_base.to_string(),
            currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: "1".to_string(),
            cost_basis_method: "FIFO".to_string(),
            created_at: now,
        }
    }

    fn test_income_activity(
        id: &str,
        account_id: &str,
        asset_id: Option<&str>,
        activity_type: &str,
        amount: Decimal,
        currency: &str,
        date: NaiveDate,
    ) -> Activity {
        let now = Utc::now();
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.map(str::to_string),
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: date.and_hms_opt(12, 0, 0).unwrap().and_utc(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(amount),
            fee: None,
            tax: None,
            currency: currency.to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: now,
            updated_at: now,
        }
    }

    fn test_service(
        snapshot: AccountStateSnapshot,
        assets: Vec<Asset>,
        values: HashMap<String, Decimal>,
    ) -> HoldingsService {
        HoldingsService::new(
            Arc::new(MockAssetService::new(assets)),
            Arc::new(MockSnapshotService { snapshot }),
            Arc::new(MockValuationService { values }),
            Arc::new(AssetClassificationService::new(Arc::new(
                EmptyTaxonomyService,
            ))),
        )
    }

    #[tokio::test]
    async fn get_holding_uses_filtered_universe_for_weight() {
        let account_id = "acc-1";
        let active_asset_id = "AAPL";
        let expired_asset_id = "TSLA200117C00397500";

        let active_asset = test_asset(active_asset_id, "AAPL", InstrumentType::Equity);
        let mut expired_asset =
            test_asset(expired_asset_id, expired_asset_id, InstrumentType::Option);
        expired_asset.metadata = Some(json!({
            "option": {
                "expiration": "2020-01-17"
            }
        }));

        let mut positions = HashMap::new();
        positions.insert(
            active_asset_id.to_string(),
            test_position(account_id, active_asset_id),
        );
        positions.insert(
            expired_asset_id.to_string(),
            test_position(account_id, expired_asset_id),
        );

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions,
            ..Default::default()
        };
        let service = test_service(
            snapshot,
            vec![active_asset, expired_asset],
            HashMap::from([
                (active_asset_id.to_string(), dec!(100)),
                (expired_asset_id.to_string(), dec!(100)),
            ]),
        );

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();
        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].weight, dec!(1));

        let holding = service
            .get_holding(account_id, active_asset_id, "USD")
            .await
            .unwrap()
            .expect("active holding should exist");
        assert_eq!(holding.weight, dec!(1));
    }

    #[tokio::test]
    async fn get_holdings_uses_gross_exposure_for_signed_weights() {
        let account_id = "acc-1";
        let long_asset_id = "AAPL";
        let short_asset_id = "MSFT";
        let mut short_position = test_position(account_id, short_asset_id);
        short_position.quantity = dec!(-1);
        short_position.total_cost_basis = dec!(-100);
        short_position.average_cost = dec!(100);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([
                (
                    long_asset_id.to_string(),
                    test_position(account_id, long_asset_id),
                ),
                (short_asset_id.to_string(), short_position),
            ]),
            ..Default::default()
        };
        let service = test_service(
            snapshot,
            vec![
                test_asset(long_asset_id, "AAPL", InstrumentType::Equity),
                test_asset(short_asset_id, "MSFT", InstrumentType::Equity),
            ],
            HashMap::from([
                (long_asset_id.to_string(), dec!(100)),
                (short_asset_id.to_string(), dec!(-100)),
            ]),
        );

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();
        let long = holdings
            .iter()
            .find(|holding| holding.instrument.as_ref().unwrap().id == long_asset_id)
            .expect("long holding");
        let short = holdings
            .iter()
            .find(|holding| holding.instrument.as_ref().unwrap().id == short_asset_id)
            .expect("short holding");

        assert_eq!(long.weight, dec!(0.5));
        assert_eq!(short.weight, dec!(-0.5));
    }

    #[tokio::test]
    async fn get_holding_returns_none_for_expired_option_position() {
        let account_id = "acc-1";
        let expired_asset_id = "TSLA200117C00397500";

        let mut expired_asset =
            test_asset(expired_asset_id, expired_asset_id, InstrumentType::Option);
        expired_asset.metadata = Some(json!({
            "option": {
                "expiration": "2020-01-17"
            }
        }));

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(
                expired_asset_id.to_string(),
                test_position(account_id, expired_asset_id),
            )]),
            ..Default::default()
        };
        let service = test_service(
            snapshot,
            vec![expired_asset],
            HashMap::from([(expired_asset_id.to_string(), dec!(100))]),
        );

        let holding = service
            .get_holding(account_id, expired_asset_id, "USD")
            .await
            .unwrap();
        assert!(holding.is_none());
    }

    #[tokio::test]
    async fn get_holdings_seeds_historical_base_cost_basis_from_open_lots_once() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.average_cost = dec!(1000);
        position.total_cost_basis = dec!(1000);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let lot_repository = MockLotRepository::new(vec![
            test_lot_record(account_id, asset_id, "EUR", dec!(600)),
            test_lot_record(account_id, asset_id, "EUR", dec!(400)),
        ]);
        let open_lots_calls = lot_repository.open_lots_calls();
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(1100))]),
        )
        .with_lot_repository(Arc::new(lot_repository));

        let holdings = service.get_holdings(account_id, "EUR").await.unwrap();

        assert_eq!(open_lots_calls.load(Ordering::SeqCst), 1);
        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].cost_basis.as_ref().unwrap().base, dec!(1000));
    }

    #[tokio::test]
    async fn get_holdings_skips_historical_base_cost_basis_on_lot_base_currency_mismatch() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.average_cost = dec!(1000);
        position.total_cost_basis = dec!(1000);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let lot_repository = MockLotRepository::new(vec![
            test_lot_record(account_id, asset_id, "EUR", dec!(600)),
            test_lot_record(account_id, asset_id, "CAD", dec!(400)),
        ]);
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(1100))]),
        )
        .with_lot_repository(Arc::new(lot_repository));

        let holdings = service.get_holdings(account_id, "EUR").await.unwrap();

        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].cost_basis.as_ref().unwrap().base, Decimal::ZERO);
    }

    #[tokio::test]
    async fn get_holdings_skips_historical_base_cost_basis_on_invalid_lot_basis() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.average_cost = dec!(1000);
        position.total_cost_basis = dec!(1000);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let mut invalid_lot = test_lot_record(account_id, asset_id, "EUR", dec!(600));
        invalid_lot.remaining_cost_basis_base = "not-a-decimal".to_string();
        let lot_repository = MockLotRepository::new(vec![
            test_lot_record(account_id, asset_id, "EUR", dec!(400)),
            invalid_lot,
        ]);
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(1100))]),
        )
        .with_lot_repository(Arc::new(lot_repository));

        let holdings = service.get_holdings(account_id, "EUR").await.unwrap();

        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].cost_basis.as_ref().unwrap().base, Decimal::ZERO);
    }

    #[tokio::test]
    async fn get_holding_loads_open_lots_for_requested_asset_only() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let other_asset_id = "MSFT";
        let mut positions = HashMap::new();
        positions.insert(asset_id.to_string(), test_position(account_id, asset_id));
        positions.insert(
            other_asset_id.to_string(),
            test_position(account_id, other_asset_id),
        );

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions,
            ..Default::default()
        };
        let lot_repository = MockLotRepository::new(vec![
            test_lot_record(account_id, asset_id, "EUR", dec!(1000)),
            test_lot_record(account_id, other_asset_id, "EUR", dec!(2000)),
        ]);
        let open_lots_calls = lot_repository.open_lots_calls();
        let open_lots_for_asset_calls = lot_repository.open_lots_for_asset_calls();
        let service = test_service(
            snapshot,
            vec![
                test_asset(asset_id, "AAPL", InstrumentType::Equity),
                test_asset(other_asset_id, "MSFT", InstrumentType::Equity),
            ],
            HashMap::from([
                (asset_id.to_string(), dec!(1100)),
                (other_asset_id.to_string(), dec!(2200)),
            ]),
        )
        .with_lot_repository(Arc::new(lot_repository));

        let holding = service
            .get_holding(account_id, asset_id, "EUR")
            .await
            .unwrap()
            .expect("holding should exist");

        assert_eq!(open_lots_calls.load(Ordering::SeqCst), 0);
        assert_eq!(open_lots_for_asset_calls.load(Ordering::SeqCst), 1);
        assert_eq!(holding.cost_basis.as_ref().unwrap().base, dec!(1000));
    }

    #[tokio::test]
    async fn get_holdings_does_not_seed_historical_base_cost_basis_for_alternative_assets() {
        let account_id = "acc-1";
        let asset_id = "PROPERTY-1";
        let mut asset = test_asset(asset_id, "Property", InstrumentType::Equity);
        asset.kind = AssetKind::Property;

        let mut position = test_position(account_id, asset_id);
        position.total_cost_basis = dec!(1000);
        position.is_alternative = true;

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let lot_repository = MockLotRepository::new(vec![test_lot_record(
            account_id,
            asset_id,
            "EUR",
            dec!(1000),
        )]);
        let open_lots_calls = lot_repository.open_lots_calls();
        let open_lots_for_asset_calls = lot_repository.open_lots_for_asset_calls();
        let service = test_service(
            snapshot,
            vec![asset],
            HashMap::from([(asset_id.to_string(), dec!(1100))]),
        )
        .with_lot_repository(Arc::new(lot_repository));

        let holdings = service.get_holdings(account_id, "EUR").await.unwrap();

        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].holding_type, HoldingType::AlternativeAsset);
        assert_eq!(holdings[0].cost_basis.as_ref().unwrap().base, Decimal::ZERO);
        assert_eq!(open_lots_calls.load(Ordering::SeqCst), 0);
        assert_eq!(open_lots_for_asset_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn asset_income_uses_flow_date_fx_and_requires_matching_asset_id() {
        let date = NaiveDate::from_ymd_opt(2025, 2, 3).unwrap();
        let fx_service = MockFxService::new(vec![
            ("EUR", "CAD", date, dec!(1.5)),
            ("EUR", "USD", date, dec!(1.1)),
        ]);
        let asset_currencies = HashMap::from([("AAPL".to_string(), "CAD".to_string())]);
        let mut pending = test_income_activity(
            "pending",
            "acc-1",
            Some("AAPL"),
            ACTIVITY_TYPE_DIVIDEND,
            dec!(10),
            "EUR",
            date,
        );
        pending.status = ActivityStatus::Pending;

        let activities = vec![
            test_income_activity(
                "dividend",
                "acc-1",
                Some("AAPL"),
                ACTIVITY_TYPE_DIVIDEND,
                dec!(10),
                "EUR",
                date,
            ),
            test_income_activity(
                "cash-interest",
                "acc-1",
                None,
                ACTIVITY_TYPE_INTEREST,
                dec!(99),
                "EUR",
                date,
            ),
            test_income_activity(
                "other-asset",
                "acc-1",
                Some("MSFT"),
                ACTIVITY_TYPE_DIVIDEND,
                dec!(99),
                "EUR",
                date,
            ),
            test_income_activity("buy", "acc-1", Some("AAPL"), "BUY", dec!(99), "EUR", date),
            pending,
        ];

        let income_by_asset = calculate_asset_income(
            &activities,
            &asset_currencies,
            "USD",
            &fx_service,
            chrono_tz::UTC,
        );

        assert_eq!(income_by_asset.len(), 1);
        let income = income_by_asset.get("AAPL").unwrap();
        assert_eq!(income.local, dec!(15));
        assert_eq!(income.base, dec!(11));
    }

    #[test]
    fn asset_income_uses_user_timezone_for_flow_date_fx() {
        let local_date = NaiveDate::from_ymd_opt(2025, 2, 3).unwrap();
        let utc_date = NaiveDate::from_ymd_opt(2025, 2, 4).unwrap();
        let fx_service = MockFxService::new(vec![
            ("EUR", "CAD", local_date, dec!(1.5)),
            ("EUR", "USD", local_date, dec!(1.1)),
            ("EUR", "CAD", utc_date, dec!(9)),
            ("EUR", "USD", utc_date, dec!(9)),
        ]);
        let asset_currencies = HashMap::from([("AAPL".to_string(), "CAD".to_string())]);
        let mut activity = test_income_activity(
            "dividend",
            "acc-1",
            Some("AAPL"),
            ACTIVITY_TYPE_DIVIDEND,
            dec!(10),
            "EUR",
            utc_date,
        );
        activity.activity_date = utc_date.and_hms_opt(2, 0, 0).unwrap().and_utc();

        let income_by_asset = calculate_asset_income(
            &[activity],
            &asset_currencies,
            "USD",
            &fx_service,
            chrono_tz::America::Toronto,
        );

        let income = income_by_asset.get("AAPL").unwrap();
        assert_eq!(income.local, dec!(15));
        assert_eq!(income.base, dec!(11));
    }

    #[test]
    fn asset_income_denormalizes_to_minor_holding_currency() {
        let date = NaiveDate::from_ymd_opt(2025, 2, 3).unwrap();
        let fx_service = MockFxService::new(Vec::new());
        let asset_currencies = HashMap::from([("LSE".to_string(), "GBp".to_string())]);
        let activities = vec![test_income_activity(
            "dividend",
            "acc-1",
            Some("LSE"),
            ACTIVITY_TYPE_DIVIDEND,
            dec!(10),
            "GBP",
            date,
        )];

        let income_by_asset = calculate_asset_income(
            &activities,
            &asset_currencies,
            "GBP",
            &fx_service,
            chrono_tz::UTC,
        );

        let income = income_by_asset.get("LSE").unwrap();
        assert_eq!(income.local, dec!(1000));
        assert_eq!(income.base, dec!(10));
    }

    #[tokio::test]
    async fn single_holding_percentages_use_local_values_when_fx_changes() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.total_cost_basis = dec!(100);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let lot_repository =
            MockLotRepository::new(vec![test_lot_record(account_id, asset_id, "USD", dec!(50))])
                .with_disposals(vec![test_lot_disposal(
                    account_id,
                    asset_id,
                    dec!(50),
                    dec!(20),
                    dec!(20),
                    dec!(10),
                )]);
        let income_service = MockHoldingIncomeService::new(HashMap::from([(
            account_id.to_string(),
            HashMap::from([(
                asset_id.to_string(),
                MonetaryValue {
                    local: dec!(5),
                    base: dec!(2),
                },
            )]),
        )]));
        let scopes = income_service.scopes();
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(130))]),
        )
        .with_lot_repository(Arc::new(lot_repository))
        .with_income_service(Arc::new(income_service));

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();

        assert_eq!(*scopes.lock().unwrap(), vec![vec![account_id.to_string()]]);
        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert_eq!(holding.unrealized_gain.as_ref().unwrap().local, dec!(30));
        assert_eq!(holding.unrealized_gain.as_ref().unwrap().base, dec!(80));
        assert_eq!(holding.unrealized_gain_pct, Some(dec!(0.3)));
        assert_eq!(holding.realized_gain.as_ref().unwrap().local, dec!(20));
        assert_eq!(holding.realized_gain.as_ref().unwrap().base, dec!(10));
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.4)));
        assert_eq!(holding.total_gain.as_ref().unwrap().local, dec!(50));
        assert_eq!(holding.total_gain.as_ref().unwrap().base, dec!(90));
        assert_eq!(holding.income.as_ref().unwrap().local, dec!(5));
        assert_eq!(holding.income.as_ref().unwrap().base, dec!(2));
        assert_eq!(holding.total_return.as_ref().unwrap().local, dec!(55));
        assert_eq!(holding.total_return.as_ref().unwrap().base, dec!(92));
        assert_eq!(holding.return_basis.as_ref().unwrap().local, dec!(150));
        assert_eq!(holding.return_basis.as_ref().unwrap().base, dec!(70));
        assert_eq!(holding.total_gain_pct, Some(dec!(0.33333333)));
        assert_eq!(holding.total_return_pct, Some(dec!(0.36666667)));
    }

    #[tokio::test]
    async fn holdings_realized_gain_includes_buy_and_sell_but_ignores_transfer_out_disposals() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.total_cost_basis = dec!(100);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };

        let mut sell_disposal =
            test_lot_disposal(account_id, asset_id, dec!(50), dec!(50), dec!(20), dec!(20));
        sell_disposal.id = "sell-disposal".to_string();
        sell_disposal.disposal_activity_id = "sell-1".to_string();
        let mut buy_disposal =
            test_lot_disposal(account_id, asset_id, dec!(25), dec!(25), dec!(10), dec!(10));
        buy_disposal.id = "buy-disposal".to_string();
        buy_disposal.disposal_activity_id = "buy-1".to_string();
        let mut transfer_disposal =
            test_lot_disposal(account_id, asset_id, dec!(40), dec!(40), dec!(15), dec!(15));
        transfer_disposal.id = "transfer-disposal".to_string();
        transfer_disposal.disposal_activity_id = "transfer-out-1".to_string();

        let lot_repository = MockLotRepository::new(vec![test_lot_record(
            account_id,
            asset_id,
            "USD",
            dec!(100),
        )])
        .with_disposals(vec![sell_disposal, buy_disposal, transfer_disposal]);
        let activity_date = NaiveDate::from_ymd_opt(2025, 1, 2).unwrap();
        let sell_activity = test_income_activity(
            "sell-1",
            account_id,
            Some(asset_id),
            ACTIVITY_TYPE_SELL,
            Decimal::ZERO,
            "USD",
            activity_date,
        );
        let buy_activity = test_income_activity(
            "buy-1",
            account_id,
            Some(asset_id),
            ACTIVITY_TYPE_BUY,
            Decimal::ZERO,
            "USD",
            activity_date,
        );
        let transfer_out_activity = test_income_activity(
            "transfer-out-1",
            account_id,
            Some(asset_id),
            crate::activities::ACTIVITY_TYPE_TRANSFER_OUT,
            Decimal::ZERO,
            "USD",
            activity_date,
        );
        let mut service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(130))]),
        )
        .with_lot_repository(Arc::new(lot_repository));
        service.activity_repository = Some(Arc::new(MockActivityRepository::new(vec![
            sell_activity,
            buy_activity,
            transfer_out_activity,
        ])));

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();

        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert_eq!(holding.realized_gain.as_ref().unwrap().base, dec!(30));
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.4)));
        assert_eq!(holding.return_basis.as_ref().unwrap().base, dec!(175));
        assert_eq!(holding.total_gain.as_ref().unwrap().base, dec!(60));
        assert_eq!(holding.total_gain_pct, Some(dec!(0.34285714)));
    }

    #[tokio::test]
    async fn short_holding_percentages_use_absolute_signed_basis() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.quantity = dec!(-5);
        position.average_cost = dec!(-100);
        position.total_cost_basis = dec!(-500);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };

        let mut cover_disposal = test_lot_disposal(
            account_id,
            asset_id,
            dec!(-500),
            dec!(-500),
            dec!(100),
            dec!(100),
        );
        cover_disposal.id = "cover-disposal".to_string();
        cover_disposal.disposal_activity_id = "cover-1".to_string();

        let lot_repository = MockLotRepository::new(vec![test_lot_record(
            account_id,
            asset_id,
            "USD",
            dec!(-500),
        )])
        .with_disposals(vec![cover_disposal]);
        let cover_activity = test_income_activity(
            "cover-1",
            account_id,
            Some(asset_id),
            ACTIVITY_TYPE_BUY,
            Decimal::ZERO,
            "USD",
            NaiveDate::from_ymd_opt(2025, 1, 2).unwrap(),
        );
        let mut service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(-450))]),
        )
        .with_lot_repository(Arc::new(lot_repository));
        service.activity_repository =
            Some(Arc::new(MockActivityRepository::new(vec![cover_activity])));

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();

        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert_eq!(holding.cost_basis.as_ref().unwrap().base, dec!(-500));
        assert_eq!(holding.unrealized_gain.as_ref().unwrap().base, dec!(50));
        assert_eq!(holding.unrealized_gain_pct, Some(dec!(0.1)));
        assert_eq!(holding.realized_gain.as_ref().unwrap().base, dec!(100));
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.2)));
        assert_eq!(holding.return_basis.as_ref().unwrap().base, dec!(-1000));
        assert_eq!(holding.total_gain.as_ref().unwrap().base, dec!(150));
        assert_eq!(holding.total_gain_pct, Some(dec!(0.15)));
    }

    #[tokio::test]
    async fn holdings_realized_gain_skips_disposals_when_activity_lookup_fails() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.total_cost_basis = dec!(100);

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };

        let mut sell_disposal =
            test_lot_disposal(account_id, asset_id, dec!(50), dec!(50), dec!(20), dec!(20));
        sell_disposal.id = "sell-disposal".to_string();
        sell_disposal.disposal_activity_id = "sell-1".to_string();
        let mut transfer_disposal =
            test_lot_disposal(account_id, asset_id, dec!(40), dec!(40), dec!(15), dec!(15));
        transfer_disposal.id = "transfer-disposal".to_string();
        transfer_disposal.disposal_activity_id = "transfer-out-1".to_string();

        let lot_repository = MockLotRepository::new(vec![test_lot_record(
            account_id,
            asset_id,
            "USD",
            dec!(100),
        )])
        .with_disposals(vec![sell_disposal, transfer_disposal]);
        let mut service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(130))]),
        )
        .with_lot_repository(Arc::new(lot_repository));
        service.activity_repository = Some(Arc::new(
            MockActivityRepository::failing_get_activities_by_account_id(),
        ));

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();

        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert!(holding.realized_gain.is_none());
        assert_eq!(holding.return_basis.as_ref().unwrap().base, dec!(100));
        assert_eq!(holding.total_gain.as_ref().unwrap().base, dec!(30));
        assert_eq!(holding.total_gain_pct, Some(dec!(0.3)));
    }

    #[tokio::test]
    async fn multi_account_aggregation_sums_income_and_recomputes_return_percentages() {
        let asset_id = "AAPL";
        let account_one = "acc-1";
        let account_two = "acc-2";
        let mut position = test_position(account_one, asset_id);
        position.total_cost_basis = dec!(100);

        let snapshot = AccountStateSnapshot {
            account_id: account_one.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let lot_repository = MockLotRepository::new(vec![
            test_lot_record(account_one, asset_id, "USD", dec!(50)),
            test_lot_record(account_two, asset_id, "USD", dec!(50)),
        ])
        .with_disposals(vec![
            test_lot_disposal(account_one, asset_id, dec!(40), dec!(20), dec!(4), dec!(2)),
            test_lot_disposal(account_two, asset_id, dec!(60), dec!(30), dec!(18), dec!(9)),
        ]);
        let income_service = MockHoldingIncomeService::new(HashMap::from([
            (
                account_one.to_string(),
                HashMap::from([(
                    asset_id.to_string(),
                    MonetaryValue {
                        local: dec!(5),
                        base: dec!(2),
                    },
                )]),
            ),
            (
                account_two.to_string(),
                HashMap::from([(
                    asset_id.to_string(),
                    MonetaryValue {
                        local: dec!(7),
                        base: dec!(3),
                    },
                )]),
            ),
        ]));
        let scopes = income_service.scopes();
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(110))]),
        )
        .with_lot_repository(Arc::new(lot_repository))
        .with_income_service(Arc::new(income_service));

        let holdings = service
            .get_holdings_for_accounts(
                &[account_one.to_string(), account_two.to_string()],
                "USD",
                "portfolio",
            )
            .await
            .unwrap();

        assert_eq!(
            *scopes.lock().unwrap(),
            vec![vec![account_one.to_string()], vec![account_two.to_string()]]
        );
        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert_eq!(holding.income.as_ref().unwrap().local, dec!(12));
        assert_eq!(holding.income.as_ref().unwrap().base, dec!(5));
        assert_eq!(holding.realized_gain.as_ref().unwrap().local, dec!(22));
        assert_eq!(holding.realized_gain.as_ref().unwrap().base, dec!(11));
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.22)));
        assert_eq!(holding.total_gain.as_ref().unwrap().local, dec!(42));
        assert_eq!(holding.total_gain.as_ref().unwrap().base, dec!(131));
        assert_eq!(holding.total_return.as_ref().unwrap().local, dec!(54));
        assert_eq!(holding.total_return.as_ref().unwrap().base, dec!(136));
        assert_eq!(holding.return_basis.as_ref().unwrap().local, dec!(300));
        assert_eq!(holding.return_basis.as_ref().unwrap().base, dec!(150));
        assert_eq!(holding.total_gain_pct, Some(dec!(0.14)));
        assert_eq!(holding.total_return_pct, Some(dec!(0.18)));
    }

    #[tokio::test]
    async fn multi_account_aggregation_reports_zero_percent_for_zero_basis_and_gain() {
        let account_one = "acc-1";
        let account_two = "acc-2";
        let asset_id = "AAPL";
        let mut position = test_position(account_one, asset_id);
        position.total_cost_basis = Decimal::ZERO;

        let snapshot = AccountStateSnapshot {
            account_id: account_one.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), Decimal::ZERO)]),
        );

        let holdings = service
            .get_holdings_for_accounts(
                &[account_one.to_string(), account_two.to_string()],
                "USD",
                "portfolio",
            )
            .await
            .unwrap();

        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].unrealized_gain_pct, Some(Decimal::ZERO));
        assert_eq!(holdings[0].total_gain_pct, Some(Decimal::ZERO));
        assert_eq!(holdings[0].total_return_pct, Some(Decimal::ZERO));
    }

    #[test]
    fn normalize_holding_currency_converts_minor_security_units() {
        let as_of = valuation_date_today();
        let mut holding = Holding {
            id: "SEC-TEST-GBp".to_string(),
            account_id: "TEST".to_string(),
            holding_type: HoldingType::Security,
            instrument: Some(Instrument {
                id: "TEST".to_string(),
                symbol: "TEST".to_string(),
                name: Some("Test".to_string()),
                currency: "GBp".to_string(),
                notes: None,
                pricing_mode: "MARKET".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                classifications: None,
            }),
            asset_kind: None,
            quantity: dec!(1),
            open_date: None,
            lots: Some(VecDeque::from(vec![Lot {
                id: "LOT1".to_string(),
                position_id: "POS-TEST".to_string(),
                acquisition_date: Utc::now(),
                acquisition_local_date: None,
                quantity: dec!(1),
                original_quantity: dec!(1),
                cost_basis: dec!(3000),
                acquisition_price: dec!(3000),
                acquisition_fees: dec!(0),
                original_acquisition_fees: dec!(0),
                acquisition_taxes: Decimal::ZERO,
                original_acquisition_taxes: Decimal::ZERO,
                fx_rate_to_position: None,
                fx_rate_to_account: None,
                account_currency: None,
                fx_rate_to_base: None,
                base_currency: None,
                source_activity_id: None,
                split_ratio: Decimal::ONE,
            }])),
            contract_multiplier: Decimal::ONE,
            local_currency: "GBp".to_string(),
            base_currency: "GBP".to_string(),
            fx_rate: Some(dec!(0.01)),
            market_value: MonetaryValue {
                local: dec!(3090),
                base: dec!(30.9),
            },
            cost_basis: Some(MonetaryValue {
                local: dec!(3000),
                base: dec!(30),
            }),
            price: Some(dec!(3090)),
            purchase_price: None,
            unrealized_gain: Some(MonetaryValue {
                local: dec!(90),
                base: dec!(0.9),
            }),
            unrealized_gain_pct: Some(dec!(0.03)),
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: Some(MonetaryValue {
                local: dec!(90),
                base: dec!(0.9),
            }),
            total_gain_pct: Some(dec!(0.03)),
            income: Some(MonetaryValue {
                local: dec!(10),
                base: dec!(0.1),
            }),
            total_return: Some(MonetaryValue {
                local: dec!(100),
                base: dec!(1),
            }),
            total_return_pct: Some(dec!(0.033333333333333333)),
            return_basis: Some(MonetaryValue {
                local: dec!(3000),
                base: dec!(30),
            }),
            day_change: Some(MonetaryValue {
                local: dec!(-44),
                base: dec!(-0.44),
            }),
            day_change_pct: Some(dec!(-0.014)),
            prev_close_value: Some(MonetaryValue {
                local: dec!(3134),
                base: dec!(31.34),
            }),
            weight: dec!(0.1),
            as_of_date: as_of,
            source_account_ids: vec![],
            metadata: None,
        };

        normalize_holding_currency(&mut holding);

        assert_eq!(holding.local_currency, "GBP");
        assert_eq!(holding.instrument.as_ref().unwrap().currency, "GBP");
        assert_eq!(holding.fx_rate, Some(dec!(1)));
        assert_eq!(holding.price, Some(dec!(30.9)));
        assert_eq!(holding.market_value.local, dec!(30.9));
        assert_eq!(holding.market_value.base, dec!(30.9));
        assert_eq!(holding.cost_basis.as_ref().unwrap().local, dec!(30));
        assert_eq!(holding.cost_basis.as_ref().unwrap().base, dec!(30));
        assert_eq!(holding.unrealized_gain.as_ref().unwrap().local, dec!(0.9));
        assert_eq!(holding.unrealized_gain.as_ref().unwrap().base, dec!(0.9));
        assert_eq!(holding.income.as_ref().unwrap().local, dec!(0.1));
        assert_eq!(holding.income.as_ref().unwrap().base, dec!(0.1));
        assert_eq!(holding.total_return.as_ref().unwrap().local, dec!(1));
        assert_eq!(holding.total_return.as_ref().unwrap().base, dec!(1));
        assert_eq!(holding.return_basis.as_ref().unwrap().local, dec!(30));
        assert_eq!(holding.return_basis.as_ref().unwrap().base, dec!(30));
        assert_eq!(holding.day_change.as_ref().unwrap().local, dec!(-0.44));
        assert_eq!(holding.day_change.as_ref().unwrap().base, dec!(-0.44));
        assert_eq!(
            holding.prev_close_value.as_ref().unwrap().local,
            dec!(31.34)
        );
        assert_eq!(holding.prev_close_value.as_ref().unwrap().base, dec!(31.34));
        let lot = holding.lots.as_ref().unwrap().front().unwrap();
        assert_eq!(lot.cost_basis, dec!(30));
        assert_eq!(lot.acquisition_price, dec!(30));
    }

    #[test]
    fn normalize_holding_currency_keeps_cash_price_at_one() {
        let mut holding = Holding {
            id: "CASH-TEST-GBp".to_string(),
            account_id: "TEST".to_string(),
            holding_type: HoldingType::Cash,
            instrument: None,
            asset_kind: None,
            quantity: dec!(1000),
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: "GBp".to_string(),
            base_currency: "GBP".to_string(),
            fx_rate: Some(dec!(0.01)),
            market_value: MonetaryValue {
                local: dec!(1000),
                base: dec!(10),
            },
            cost_basis: Some(MonetaryValue {
                local: dec!(1000),
                base: dec!(10),
            }),
            price: Some(dec!(1)),
            purchase_price: None,
            unrealized_gain: Some(MonetaryValue::zero()),
            unrealized_gain_pct: Some(Decimal::ZERO),
            realized_gain: Some(MonetaryValue::zero()),
            realized_gain_pct: Some(Decimal::ZERO),
            total_gain: Some(MonetaryValue::zero()),
            total_gain_pct: Some(Decimal::ZERO),
            income: Some(MonetaryValue::zero()),
            total_return: Some(MonetaryValue::zero()),
            total_return_pct: Some(Decimal::ZERO),
            return_basis: Some(MonetaryValue {
                local: dec!(1000),
                base: dec!(10),
            }),
            day_change: Some(MonetaryValue {
                local: dec!(0),
                base: dec!(0),
            }),
            day_change_pct: Some(Decimal::ZERO),
            prev_close_value: Some(MonetaryValue {
                local: dec!(1000),
                base: dec!(10),
            }),
            weight: dec!(1),
            as_of_date: valuation_date_today(),
            source_account_ids: vec![],
            metadata: None,
        };

        normalize_holding_currency(&mut holding);

        assert_eq!(holding.local_currency, "GBP");
        assert_eq!(holding.fx_rate, Some(dec!(1)));
        assert_eq!(holding.market_value.local, dec!(10));
        assert_eq!(holding.market_value.base, dec!(10));
        assert_eq!(holding.cost_basis.as_ref().unwrap().local, dec!(10));
        assert_eq!(holding.price, Some(Decimal::ONE));
        assert_eq!(holding.prev_close_value.as_ref().unwrap().local, dec!(10));
        assert_eq!(holding.prev_close_value.as_ref().unwrap().base, dec!(10));
    }
}
