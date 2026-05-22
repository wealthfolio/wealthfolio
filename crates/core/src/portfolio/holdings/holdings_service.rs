use crate::assets::{
    Asset, AssetClassificationService, AssetKind, AssetServiceTrait, InstrumentType,
};
use crate::constants::DECIMAL_PRECISION;
use crate::errors::{CalculatorError, Error as CoreError, Result};
use crate::fx::currency::{get_normalization_rule, normalize_currency_code};
use crate::portfolio::holdings::holdings_model::{Holding, HoldingType, Instrument, MonetaryValue};
use crate::portfolio::snapshot::{self, SnapshotServiceTrait};
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};
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
        }
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
    let total_portfolio_value_base: Decimal = holdings
        .iter()
        .map(|holding| holding.market_value.base)
        .sum();

    if total_portfolio_value_base > dec!(0) {
        for holding in holdings {
            holding.weight = (holding.market_value.base / total_portfolio_value_base)
                .round_dp(DECIMAL_PRECISION);
        }
    } else {
        debug!(
            "Total portfolio base value is zero or negative for account {}. Allocations set to 0.",
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
        self.value_holdings_best_effort(account_id, &mut holdings)
            .await;
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

        // Recompute percentage fields from the summed base values.
        // The merge loop accumulates monetary values but percentages from the first
        // account seen are no longer correct for the aggregated position.
        for h in result.iter_mut() {
            let cost_base = h
                .cost_basis
                .as_ref()
                .map(|c| c.base)
                .unwrap_or(Decimal::ZERO);
            if cost_base > Decimal::ZERO {
                h.unrealized_gain_pct = h.unrealized_gain.as_ref().map(|v| v.base / cost_base);
                h.total_gain_pct = h.total_gain.as_ref().map(|v| v.base / cost_base);
            } else {
                h.unrealized_gain_pct = None;
                h.total_gain_pct = None;
            }
            let prev_close_base = h
                .prev_close_value
                .as_ref()
                .map(|p| p.base)
                .unwrap_or(Decimal::ZERO);
            if prev_close_base > Decimal::ZERO {
                h.day_change_pct = h.day_change.as_ref().map(|v| v.base / prev_close_base);
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
        self.value_holdings_best_effort(account_id, &mut holdings)
            .await;
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
    use crate::assets::{
        AssetMetadata, AssetResolutionInput, AssetResolutionOutput, AssetSpec, EnsureAssetsResult,
        NewAsset, QuoteMode, UpdateAssetProfile,
    };
    use crate::errors::Error;
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
    use std::sync::Arc;

    struct MockAssetService {
        assets: HashMap<String, Asset>,
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

        async fn recalculate_total_portfolio_snapshots(
            &self,
            _mode: SnapshotRecalcMode,
        ) -> Result<usize> {
            unimplemented!("unused in holdings service tests")
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
                    }
                }
            }
            Ok(())
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
                quantity: dec!(1),
                original_quantity: dec!(1),
                cost_basis: dec!(3000),
                acquisition_price: dec!(3000),
                acquisition_fees: dec!(0),
                original_acquisition_fees: dec!(0),
                fx_rate_to_position: None,
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
