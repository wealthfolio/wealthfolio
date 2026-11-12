use crate::activities::{
    Activity, NewActivity, ACTIVITY_SUBTYPE_NOTIONAL_DISTRIBUTION,
    ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL, ACTIVITY_TYPE_ADJUSTMENT, ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_INTEREST,
};
#[cfg(test)]
use crate::activities::{
    ActivityRepositoryTrait, ACTIVITY_SUBTYPE_OPTION_EXPIRY, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_SELL,
    ACTIVITY_TYPE_TRANSFER_IN,
};
use crate::assets::{
    Asset, AssetClassificationService, AssetKind, AssetServiceTrait, InstrumentType,
};
use crate::constants::DECIMAL_PRECISION;
#[cfg(test)]
use crate::errors::CalculatorError;
use crate::errors::{Error as CoreError, Result};
use crate::fx::currency::{get_normalization_rule, normalize_currency_code};
use crate::fx::currency_converter::CurrencyConverter;
#[cfg(test)]
use crate::fx::FxServiceTrait;
use crate::lots::{AssetLotView, LotRepositoryTrait};
use crate::portfolio::coordinator::blocking;
use crate::portfolio::economic_events::ActivityEconomicsResolver;
use crate::portfolio::holdings::holdings_model::{Holding, HoldingType, Instrument, MonetaryValue};
use crate::portfolio::projection::ProjectionStoreTrait;
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

use super::holdings_accounting::{apply_history, snapshot_cost, translate};
use super::{
    HoldingsRead, HoldingsScope, HoldingsValuationServiceTrait, IncompleteHoldingsAccount,
};

#[async_trait]
pub trait HoldingsServiceTrait: Send + Sync {
    async fn get_holdings_scope(
        &self,
        account_ids: &[String],
        base_currency: &str,
        scope_id: &str,
        include_closed: bool,
    ) -> Result<HoldingsScope> {
        let holdings = if account_ids.len() == 1 {
            self.get_holdings_with_options(&account_ids[0], base_currency, include_closed)
                .await?
        } else {
            self.get_holdings_for_accounts_with_options(
                account_ids,
                base_currency,
                scope_id,
                include_closed,
            )
            .await?
        };
        Ok(HoldingsScope {
            holdings,
            incomplete_accounts: Vec::new(),
        })
    }

    async fn get_holdings(&self, account_id: &str, base_currency: &str) -> Result<Vec<Holding>>;

    /// Account rows and availability together, without merging accounts.
    async fn get_holdings_by_account_scope(
        &self,
        account_ids: &[String],
        base_currency: &str,
    ) -> Result<HoldingsScope> {
        let mut scope = HoldingsScope::default();
        for id in account_ids {
            let account = self
                .get_holdings_scope(std::slice::from_ref(id), base_currency, id, false)
                .await?;
            scope.holdings.extend(account.holdings);
            scope
                .incomplete_accounts
                .extend(account.incomplete_accounts);
        }
        Ok(scope)
    }

    /// Per-account rows for an asset, captured together without aggregating accounts.
    async fn get_asset_holdings_scope(
        &self,
        _account_ids: &[String],
        _asset_id: &str,
        _base_currency: &str,
    ) -> Result<HoldingsScope> {
        Err(CoreError::Unexpected(
            "asset holdings scope is not configured".into(),
        ))
    }

    /// An asset's lot view: its transaction lots and, when asked, each
    /// holdings account's latest snapshot position, read today (carried
    /// across the splits recorded since, engine rules R1.5). The one entry
    /// to the lot view: the lot repository returns positions as stored.
    async fn get_asset_lot_view(
        &self,
        asset_id: &str,
        include_snapshot_positions: bool,
    ) -> Result<Vec<AssetLotView>>;

    async fn get_holdings_with_options(
        &self,
        account_id: &str,
        base_currency: &str,
        _include_closed: bool,
    ) -> Result<Vec<Holding>> {
        self.get_holdings(account_id, base_currency).await
    }

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

    async fn get_holdings_for_accounts_with_options(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
        _include_closed: bool,
    ) -> Result<Vec<Holding>> {
        self.get_holdings_for_accounts(account_ids, base_currency, aggregated_account_id)
            .await
    }

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

#[derive(Clone)]
pub struct HoldingsService {
    asset_service: Arc<dyn AssetServiceTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    valuation_service: Arc<dyn HoldingsValuationServiceTrait>,
    classification_service: Arc<AssetClassificationService>,
    timezone: Arc<RwLock<String>>,
    lot_repository: Option<Arc<dyn LotRepositoryTrait>>,
    projection_store: Option<Arc<dyn ProjectionStoreTrait>>,
}

enum ReadView {
    Aggregate,
    Accounts,
    Asset(String),
}

#[cfg(test)]
trait HoldingIncomeServiceTrait: Send + Sync {
    fn get_asset_income(
        &self,
        account_ids: &[String],
        asset_currencies: &HashMap<String, String>,
        base_currency: &str,
    ) -> Result<HashMap<String, MonetaryValue>>;
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
            projection_store: None,
        }
    }

    pub fn with_projection_store(mut self, store: Arc<dyn ProjectionStoreTrait>) -> Self {
        self.projection_store = Some(store);
        self
    }

    pub fn with_lot_repository(mut self, lot_repository: Arc<dyn LotRepositoryTrait>) -> Self {
        self.lot_repository = Some(lot_repository);
        self
    }

    fn today_in_user_timezone(&self) -> chrono::NaiveDate {
        let tz = parse_user_timezone_or_default(
            &self
                .timezone
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        user_today(tz)
    }

    async fn read_scope(
        &self,
        account_ids: &[String],
        base_currency: &str,
        scope_id: &str,
        include_closed: bool,
        detail_asset: Option<&str>,
        view: ReadView,
    ) -> Result<HoldingsScope> {
        let store = self
            .projection_store
            .clone()
            .ok_or_else(|| CoreError::Repository("holdings read store is not configured".into()))?;
        let mut ids = account_ids.to_vec();
        let aggregate = matches!(&view, ReadView::Aggregate);
        let live_accounts_only = matches!(&view, ReadView::Asset(_));
        let asset_id = match view {
            ReadView::Asset(id) => Some(id),
            _ => None,
        };
        let day = self.today_in_user_timezone();
        let detail_asset = detail_asset.map(str::to_owned);
        let base = base_currency.to_string();
        let scoped_asset = asset_id.clone();
        let (read, converter, mut scope) = blocking(move || {
            let mut read = store.holdings_read(&ids, day, detail_asset.as_deref())?;
            if live_accounts_only {
                ids.retain(|id| {
                    read.accounts.iter().any(|account| {
                        account.id == *id
                            && crate::accounts::account_supports_portfolio_scope(
                                account,
                                crate::accounts::AccountPurpose::Holdings,
                            )
                    })
                });
            }
            if let Some(asset_id) = scoped_asset {
                ids.retain(|id| read.could_hold_asset(id, &asset_id));
            }
            read.carry_observed_splits()?;
            let converter = Arc::new(CurrencyConverter::new(read.fx_rates.clone())?);
            let mut scope = HoldingsScope::default();
            for id in &ids {
                if let Some(reason_code) = read.unavailable_reason(id) {
                    scope.incomplete_accounts.push(IncompleteHoldingsAccount {
                        account_id: id.clone(),
                        status: "unavailable",
                        reason_code,
                    });
                    continue;
                }
                match Self::prepare_read(
                    &read,
                    &converter,
                    id,
                    &base,
                    include_closed,
                    detail_asset.as_deref(),
                    aggregate,
                ) {
                    Ok(holdings) => scope.holdings.extend(holdings),
                    Err(CoreError::HoldingsPending(_)) => {
                        scope.incomplete_accounts.push(IncompleteHoldingsAccount {
                            account_id: id.clone(),
                            status: "pending",
                            reason_code: if read.day_advance_pending(id, read.day) {
                                "DAY_ADVANCE_PENDING"
                            } else {
                                "PROJECTION_PENDING"
                            },
                        })
                    }
                    Err(_) => scope.incomplete_accounts.push(IncompleteHoldingsAccount {
                        account_id: id.clone(),
                        status: "unavailable",
                        reason_code: "ACCOUNTING_UNAVAILABLE",
                    }),
                }
            }
            Ok((Arc::new(read), converter, scope))
        })
        .await?;
        self.value_holdings_best_effort(scope_id, &mut scope.holdings, converter.clone(), read.day)
            .await;
        let service = self.clone();
        let ids = account_ids.to_vec();
        let scope_id = scope_id.to_string();
        blocking(move || {
            let mut holdings = Vec::new();
            for id in &ids {
                let rows = scope
                    .holdings
                    .extract_if(.., |holding| holding.account_id == *id)
                    .collect();
                match service.finish_read(&read, &converter, id, rows) {
                    Ok(rows) => holdings.extend(rows),
                    Err(_) => scope.incomplete_accounts.push(IncompleteHoldingsAccount {
                        account_id: id.clone(),
                        status: "unavailable",
                        reason_code: "ACCOUNTING_UNAVAILABLE",
                    }),
                }
            }
            scope.holdings = if aggregate {
                merge_holdings(holdings, &scope_id)?
            } else {
                holdings
            };
            if !scope.incomplete_accounts.is_empty() {
                for holding in &mut scope.holdings {
                    holding.weight = None;
                }
            }
            if let Some(asset_id) = asset_id {
                scope.holdings.retain(|holding| {
                    holding
                        .instrument
                        .as_ref()
                        .is_some_and(|instrument| instrument.id == asset_id)
                });
            }
            Ok(scope)
        })
        .await
    }

    fn prepare_read(
        read: &HoldingsRead,
        converter: &CurrencyConverter,
        account_id: &str,
        base_currency: &str,
        include_closed: bool,
        lots_asset: Option<&str>,
        aggregate: bool,
    ) -> Result<Vec<Holding>> {
        if read.position_pending(account_id, read.day) {
            return Err(CoreError::HoldingsPending(vec![account_id.to_string()]));
        }
        if read.unavailable_accounts.contains(account_id) {
            return Err(CoreError::HoldingsUnavailable(
                "snapshot data is invalid".into(),
            ));
        }
        let Some(snapshot) = read.snapshots.get(account_id) else {
            if read.accounts.iter().any(|account| {
                account.id == account_id
                    && account.tracking_mode == crate::accounts::TrackingMode::Holdings
            }) {
                return Ok(Vec::new());
            }
            if read.has_effective_activities(account_id, read.day)
                || read.accounts_with_open_lots.contains(account_id)
            {
                return Err(CoreError::HoldingsUnavailable(
                    "snapshot data is missing".into(),
                ));
            }
            return Ok(Vec::new());
        };
        if snapshot.positions.values().any(|position| {
            (include_closed || !position.quantity.is_zero())
                && !read.assets.contains_key(&position.asset_id)
        }) {
            return Err(CoreError::HoldingsUnavailable(
                "asset metadata is missing".into(),
            ));
        }
        Ok(Self::build_live_holdings_from_snapshot(
            snapshot,
            base_currency,
            lots_asset,
            include_closed,
            read,
            aggregate,
            converter,
        ))
    }

    fn finish_read(
        &self,
        read: &HoldingsRead,
        converter: &CurrencyConverter,
        account_id: &str,
        mut holdings: Vec<Holding>,
    ) -> Result<Vec<Holding>> {
        apply_history(read, converter, account_id, &mut holdings)?;
        for holding in &mut holdings {
            normalize_holding_currency(holding);
        }
        apply_portfolio_weights(account_id, &mut holdings);
        let ids: Vec<String> = holdings
            .iter()
            .filter_map(|h| h.instrument.as_ref().map(|i| i.id.clone()))
            .collect();
        let classifications = self.classification_service.get_classifications_batch(&ids);
        for holding in &mut holdings {
            if let Some(instrument) = &mut holding.instrument {
                instrument.classifications = classifications.get(&instrument.id).cloned();
            }
        }
        Ok(holdings)
    }

    fn build_live_holdings_from_snapshot(
        latest_snapshot: &snapshot::AccountStateSnapshot,
        base_currency: &str,
        lots_asset_id: Option<&str>,
        include_closed: bool,
        captured: &HoldingsRead,
        aggregate: bool,
        converter: &CurrencyConverter,
    ) -> Vec<Holding> {
        let account_id = latest_snapshot.account_id.as_str();
        let today = captured.day;
        let snapshot_positions: Vec<snapshot::Position> = latest_snapshot
            .positions
            .values()
            .filter(|p| include_closed || p.quantity != Decimal::ZERO)
            .cloned()
            .collect();
        let cash_balances_map: &HashMap<String, Decimal> = &latest_snapshot.cash_balances;

        let asset_ids: Vec<String> = snapshot_positions
            .iter()
            .map(|p| p.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        let assets_info_map: HashMap<String, AssetInfo> = asset_ids
            .iter()
            .filter_map(|id| captured.assets.get(id).cloned())
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
                    instrument_type: asset.instrument_type.clone(),
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
            .collect();

        let mut holdings: Vec<Holding> = Vec::new();

        for snapshot_pos in &snapshot_positions {
            let Some(asset_info) = assets_info_map.get(&snapshot_pos.asset_id) else {
                warn!(
                    "Asset details not found for asset_id: {}. Skipping this holding view.",
                    snapshot_pos.asset_id
                );
                continue;
            };

            if snapshot_pos.quantity != Decimal::ZERO
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

            // STEP 2: newly written snapshots no longer embed lots, so source
            // the current open lots from the normalized `lots` table. Only
            // fetch when this holding's lots were requested.
            let lots =
                if include_lots && latest_snapshot.source == snapshot::SnapshotSource::Calculated {
                    super::holdings_accounting::display_lots(captured, account_id, snapshot_pos)
                } else {
                    None
                };

            let display_currency = if aggregate {
                asset_info.instrument.currency.as_str()
            } else {
                &snapshot_pos.currency
            };
            let local_cost = if latest_snapshot.source == snapshot::SnapshotSource::Calculated {
                snapshot_cost(snapshot_pos, latest_snapshot, display_currency)
            } else {
                translate(
                    converter,
                    snapshot_pos.total_cost_basis,
                    &snapshot_pos.currency,
                    display_currency,
                    captured.day,
                )
            };
            let base_cost = if latest_snapshot.source != snapshot::SnapshotSource::Calculated {
                translate(
                    converter,
                    snapshot_pos.total_cost_basis,
                    &snapshot_pos.currency,
                    base_currency,
                    captured.day,
                )
                .or_else(|| snapshot_cost(snapshot_pos, latest_snapshot, base_currency))
            } else {
                snapshot_cost(snapshot_pos, latest_snapshot, base_currency)
            };
            let basis = MonetaryValue::new(local_cost, base_cost);

            let holding_view = Holding {
                id: format!("{}-{}-{}", id_prefix, account_id, snapshot_pos.asset_id),
                account_id: account_id.to_string(),
                holding_type,
                is_closed: snapshot_pos.quantity == Decimal::ZERO,
                instrument: Some(asset_info.instrument.clone()),
                asset_kind: Some(asset_info.kind.clone()),
                quantity: snapshot_pos.quantity,
                open_date: Some(snapshot_pos.inception_date),
                lots,
                contract_multiplier: snapshot_pos.contract_multiplier,
                local_currency: display_currency.to_string(),
                base_currency: base_currency.to_string(),
                translate_observed_basis: latest_snapshot.source
                    != snapshot::SnapshotSource::Calculated,
                fx_rate: None,
                market_value: MonetaryValue::unavailable(),
                cost_basis: Some(basis),
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
                weight: Some(Decimal::ZERO),
                as_of_date: today,
                metadata: asset_info.metadata.clone(),
                source_account_ids: Vec::new(),
            };
            holdings.push(holding_view);
        }

        for (currency, &amount) in cash_balances_map {
            if is_cash_dust(amount) {
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
                instrument_type: None,
                classifications: None,
            };

            let holding_view = Holding {
                id: format!("CASH-{}-{}", account_id, currency),
                account_id: account_id.to_string(),
                holding_type: HoldingType::Cash,
                is_closed: false,
                instrument: Some(cash_instrument),
                asset_kind: None,
                quantity: amount,
                open_date: None,
                lots: None,
                contract_multiplier: Decimal::ONE,
                local_currency: currency.clone(),
                base_currency: base_currency.to_string(),
                translate_observed_basis: false,
                fx_rate: None,
                market_value: MonetaryValue::new(
                    Some(amount),
                    super::holdings_accounting::recorded(Some(amount), currency, base_currency),
                ),
                cost_basis: Some(MonetaryValue::new(
                    Some(amount),
                    super::holdings_accounting::recorded(Some(amount), currency, base_currency),
                )),
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
                return_basis: Some(MonetaryValue::new(
                    Some(amount),
                    super::holdings_accounting::recorded(Some(amount), currency, base_currency),
                )),
                day_change: Some(MonetaryValue::zero()),
                day_change_pct: Some(Decimal::ZERO),
                prev_close_value: Some(MonetaryValue::new(
                    Some(amount),
                    super::holdings_accounting::recorded(Some(amount), currency, base_currency),
                )),
                weight: Some(Decimal::ZERO),
                as_of_date: today,
                metadata: None,
                source_account_ids: Vec::new(),
            };
            holdings.push(holding_view);
        }

        holdings
    }

    async fn value_holdings_best_effort(
        &self,
        account_id: &str,
        holdings: &mut [Holding],
        converter: Arc<CurrencyConverter>,
        day: NaiveDate,
    ) {
        if holdings.is_empty() {
            debug!(
                "No holdings found for account {}. Skipping valuation.",
                account_id
            );
            return;
        }

        if let Err(e) = self
            .valuation_service
            .calculate_with_captured_fx(holdings, converter, day)
            .await
        {
            error!(
                "Live valuation calculation failed for account {}: {}. Returning partially valued holdings.",
                account_id, e
            );
        }
    }
}

/// Whether a snapshot cash balance is residual noise rather than money.
///
/// Snapshot `cash_balances` persist as serde-float JSON, and the incremental recalc
/// modes re-seed from that f64 round-trip, so long-settled accounts accumulate
/// balances around 1e-15. Those are non-zero, so an exact zero check emits a full
/// cash holding that only collapses to $0 at render time. Rounding first drops the
/// dust; genuine sub-cent balances survive, since DECIMAL_PRECISION is well below a
/// cent.
fn is_cash_dust(amount: Decimal) -> bool {
    amount.round_dp(DECIMAL_PRECISION).is_zero()
}

impl HoldingsService {}

fn merge_holdings(all_holdings: Vec<Holding>, aggregated_account_id: &str) -> Result<Vec<Holding>> {
    // Merge by key: securities/alternatives → lifecycle + asset id; cash → local_currency.
    // Open and closed positions for the same asset must remain distinct, and
    // open long/short positions across accounts may legitimately net to zero.
    let mut merged: HashMap<String, Holding> = HashMap::new();
    for holding in all_holdings {
        let key = match &holding.holding_type {
            HoldingType::Cash => format!("CASH-{}", holding.local_currency),
            _ => {
                let asset_id = holding
                    .instrument
                    .as_ref()
                    .map(|i| i.id.clone())
                    .unwrap_or_else(|| holding.id.clone());
                if holding.is_closed {
                    format!("CLOSED-{}", asset_id)
                } else {
                    asset_id
                }
            }
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
        let basis_local = h.return_basis.as_ref().and_then(|basis| basis.local);
        let open_cost_local = h
            .cost_basis
            .as_ref()
            .and_then(|cost_basis| cost_basis.local);
        h.unrealized_gain_pct = h
            .unrealized_gain
            .as_ref()
            .and_then(|value| gain_pct(value.local, open_cost_local));
        let disposed_cost_local = basis_local
            .zip(open_cost_local)
            .map(|(basis, cost)| basis - cost);
        h.realized_gain_pct = h
            .realized_gain
            .as_ref()
            .and_then(|value| gain_pct(value.local, disposed_cost_local));
        refresh_total_return(h);
        let prev_close_base = h.prev_close_value.as_ref().and_then(|p| p.base);
        let prev_close_exposure_base = prev_close_base.map(|amount| amount.abs());
        if let Some(exposure) = prev_close_exposure_base.filter(|amount| *amount > Decimal::ZERO) {
            h.day_change_pct = h
                .day_change
                .as_ref()
                .and_then(|v| v.base.map(|amount| amount / exposure));
        } else {
            h.day_change_pct = None;
        }
    }

    apply_portfolio_weights(aggregated_account_id, &mut result);
    Ok(result)
}

pub(super) fn gain_pct(
    amount: impl Into<Option<Decimal>>,
    basis: impl Into<Option<Decimal>>,
) -> Option<Decimal> {
    let amount = amount.into()?;
    let basis = basis.into()?;
    let exposure = basis.abs();
    if exposure > Decimal::ZERO {
        Some((amount / exposure).round_dp(DECIMAL_PRECISION))
    } else if amount.is_zero() {
        Some(Decimal::ZERO)
    } else {
        None
    }
}

pub(super) fn refresh_total_return(holding: &mut Holding) {
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

    let basis_local = holding.return_basis.as_ref().and_then(|basis| basis.local);
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

#[cfg(test)]
fn calculate_asset_income(
    activities: &[Activity],
    rejected: &HashSet<String>,
    asset_currencies: &HashMap<String, String>,
    base_currency: &str,
    fx_service: &dyn FxServiceTrait,
    timezone: chrono_tz::Tz,
) -> HashMap<String, MonetaryValue> {
    super::holdings_accounting::income_from_activities(
        activities,
        rejected,
        asset_currencies,
        base_currency,
        |amount, from, to, day| {
            fx_service
                .convert_currency_for_date(amount, from, to, day)
                .ok()
        },
        timezone,
        user_today(timezone),
    )
}

/// What an activity adds to its asset's income, as the portfolio engine counts
/// it (engine rules R7.4): a dividend's or interest's gross amount, except a
/// dividend of capital, which is none. A return of capital adjustment takes its
/// amount back out of dividends already counted; a notional distribution adds
/// it. Their cost basis changes are in the holding's gains, so the total return
/// counts each once.
pub(super) fn asset_income_amount(activity: &Activity) -> Option<Decimal> {
    let activity_type = activity.effective_type();
    let subtype = NewActivity::canonicalize_subtype(activity.subtype.as_deref());
    let return_of_capital = subtype.as_deref() == Some(ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL);
    let notional = subtype.as_deref() == Some(ACTIVITY_SUBTYPE_NOTIONAL_DISTRIBUTION);
    let adjusted = || activity.amount.unwrap_or_default().abs();
    if activity_type == ACTIVITY_TYPE_DIVIDEND && return_of_capital {
        None
    } else if activity_type == ACTIVITY_TYPE_DIVIDEND || activity_type == ACTIVITY_TYPE_INTEREST {
        Some(activity_income_amount(activity))
    } else if activity_type == ACTIVITY_TYPE_ADJUSTMENT && return_of_capital {
        Some(-adjusted())
    } else if activity_type == ACTIVITY_TYPE_ADJUSTMENT && notional {
        Some(adjusted())
    } else {
        None
    }
}

fn activity_income_amount(activity: &Activity) -> Decimal {
    ActivityEconomicsResolver::resolve_cash(activity, Decimal::ONE)
        .gross_amount
        .unwrap_or(Decimal::ZERO)
}

fn add_monetary(acc: &mut MonetaryValue, other: &MonetaryValue) {
    *acc = acc.add(other);
}

fn add_optional_monetary(acc: &mut Option<MonetaryValue>, other: &Option<MonetaryValue>) {
    match (acc.as_mut(), other) {
        (Some(a), Some(b)) => add_monetary(a, b),
        _ => *acc = Some(MonetaryValue::unavailable()),
    }
}

fn apply_factor_to_monetary_value(value: &mut MonetaryValue, factor: Decimal) {
    value.local = value.local.map(|amount| amount * factor);
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
                super::holdings_accounting::scale_lot(lot, factor);
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

fn apply_portfolio_weights(_account_id: &str, holdings: &mut [Holding]) {
    let total: Option<Decimal> = holdings
        .iter()
        .map(|h| h.market_value.base.map(|value| value.abs()))
        .sum();
    for holding in holdings {
        holding.weight = holding.market_value.base.zip(total).map(|(value, total)| {
            if total.is_zero() {
                Decimal::ZERO
            } else {
                (value / total).round_dp(DECIMAL_PRECISION)
            }
        });
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
    async fn get_holdings_by_account_scope(
        &self,
        account_ids: &[String],
        base_currency: &str,
    ) -> Result<HoldingsScope> {
        self.read_scope(
            account_ids,
            base_currency,
            "accounts",
            false,
            None,
            ReadView::Accounts,
        )
        .await
    }

    async fn get_holdings_scope(
        &self,
        account_ids: &[String],
        base_currency: &str,
        scope_id: &str,
        include_closed: bool,
    ) -> Result<HoldingsScope> {
        self.read_scope(
            account_ids,
            base_currency,
            scope_id,
            include_closed,
            None,
            if account_ids.len() > 1 {
                ReadView::Aggregate
            } else {
                ReadView::Accounts
            },
        )
        .await
    }

    async fn get_asset_holdings_scope(
        &self,
        account_ids: &[String],
        asset_id: &str,
        base_currency: &str,
    ) -> Result<HoldingsScope> {
        self.read_scope(
            account_ids,
            base_currency,
            asset_id,
            false,
            None,
            ReadView::Asset(asset_id.into()),
        )
        .await
    }

    async fn get_asset_lot_view(
        &self,
        asset_id: &str,
        include_snapshot_positions: bool,
    ) -> Result<Vec<AssetLotView>> {
        let Some(lot_repository) = &self.lot_repository else {
            return Err(CoreError::Unexpected(
                "the asset lot view needs the lot repository".to_string(),
            ));
        };
        let mut rows = lot_repository
            .get_asset_lot_view(asset_id, include_snapshot_positions)
            .await?;
        self.snapshot_service
            .carry_lot_view_rows(&mut rows, self.today_in_user_timezone())?;
        Ok(rows)
    }

    async fn get_holdings(&self, account_id: &str, base_currency: &str) -> Result<Vec<Holding>> {
        self.get_holdings_with_options(account_id, base_currency, false)
            .await
    }

    async fn get_holdings_with_options(
        &self,
        account_id: &str,
        base_currency: &str,
        include_closed: bool,
    ) -> Result<Vec<Holding>> {
        self.get_holdings_scope(
            &[account_id.to_string()],
            base_currency,
            account_id,
            include_closed,
        )
        .await?
        .require_complete()
    }

    async fn get_holdings_for_accounts(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
    ) -> Result<Vec<Holding>> {
        self.get_holdings_for_accounts_with_options(
            account_ids,
            base_currency,
            aggregated_account_id,
            false,
        )
        .await
    }

    async fn get_holdings_for_accounts_with_options(
        &self,
        account_ids: &[String],
        base_currency: &str,
        aggregated_account_id: &str,
        include_closed: bool,
    ) -> Result<Vec<Holding>> {
        self.get_holdings_scope(
            account_ids,
            base_currency,
            aggregated_account_id,
            include_closed,
        )
        .await?
        .require_complete()
    }

    async fn get_holding(
        &self,
        account_id: &str,
        asset_id: &str,
        base_currency: &str,
    ) -> Result<Option<Holding>> {
        let holdings = self
            .read_scope(
                &[account_id.to_string()],
                base_currency,
                account_id,
                false,
                Some(asset_id),
                ReadView::Accounts,
            )
            .await?
            .require_complete()?;
        Ok(holdings
            .into_iter()
            .find(|h| h.instrument.as_ref().is_some_and(|i| i.id == asset_id)))
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
                instrument_type: asset.instrument_type.clone(),
                classifications: None,
            };

            let holding = Holding {
                id: format!(
                    "{}-{}-{}",
                    id_prefix, snapshot.account_id, position.asset_id
                ),
                account_id: snapshot.account_id.clone(),
                holding_type,
                is_closed: false,
                instrument: Some(instrument),
                asset_kind: Some(asset.kind.clone()),
                quantity: position.quantity,
                open_date: Some(position.inception_date),
                lots: None,
                contract_multiplier: position.contract_multiplier,
                local_currency: position.currency.clone(),
                base_currency: base_currency.to_string(),
                translate_observed_basis: false,
                fx_rate: None,
                market_value: MonetaryValue::unavailable(),
                cost_basis: Some(MonetaryValue::new(
                    Some(position.total_cost_basis),
                    snapshot_cost(position, snapshot, base_currency),
                )),
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
                weight: Some(Decimal::ZERO),
                as_of_date: snapshot.snapshot_date,
                metadata: asset.metadata.clone(),
                source_account_ids: Vec::new(),
            };
            holdings.push(holding);
        }

        // Convert cash balances to holdings
        for (currency, &amount) in &snapshot.cash_balances {
            if is_cash_dust(amount) {
                continue;
            }

            let holding = Holding {
                id: format!("CASH-{}-{}", snapshot.account_id, currency),
                account_id: snapshot.account_id.clone(),
                holding_type: HoldingType::Cash,
                is_closed: false,
                instrument: None,
                asset_kind: None,
                quantity: amount,
                open_date: None,
                lots: None,
                contract_multiplier: Decimal::ONE,
                local_currency: currency.clone(),
                base_currency: base_currency.to_string(),
                translate_observed_basis: false,
                fx_rate: None,
                market_value: MonetaryValue::new(
                    Some(amount),
                    super::holdings_accounting::recorded(Some(amount), currency, base_currency),
                ),
                cost_basis: Some(MonetaryValue::new(
                    Some(amount),
                    super::holdings_accounting::recorded(Some(amount), currency, base_currency),
                )),
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
                weight: Some(Decimal::ZERO),
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
    use crate::lots::{AssetLotView, LotRecord};
    use crate::portfolio::snapshot::{AccountStateSnapshot, Position};
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
        snapshots_by_account: HashMap<String, AccountStateSnapshot>,
    }

    #[async_trait::async_trait]
    impl SnapshotServiceTrait for MockSnapshotService {
        fn get_holdings_keyframes(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<Vec<AccountStateSnapshot>> {
            unimplemented!("unused in holdings service tests")
        }

        fn get_holdings_timeline(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<crate::portfolio::snapshot::HoldingsTimeline> {
            unimplemented!("unused in holdings service tests")
        }

        fn get_latest_holdings_snapshot(
            &self,
            account_id: &str,
        ) -> Result<Option<AccountStateSnapshot>> {
            Ok(Some(
                self.snapshots_by_account
                    .get(account_id)
                    .unwrap_or(&self.snapshot)
                    .clone(),
            ))
        }

        fn get_latest_snapshots_as_of(
            &self,
            _account_ids: &[String],
            _day: NaiveDate,
        ) -> Result<HashMap<String, AccountStateSnapshot>> {
            Ok(HashMap::new())
        }

        fn carry_lot_view_rows(
            &self,
            _rows: &mut [crate::lots::AssetLotView],
            _day: NaiveDate,
        ) -> Result<()> {
            Ok(())
        }

        async fn save_manual_snapshot(
            &self,
            _account_id: &str,
            _snapshot: AccountStateSnapshot,
        ) -> Result<()> {
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
                        holding.market_value = MonetaryValue::new(*value, *value);
                        if let Some(cost_basis) = &holding.cost_basis {
                            let unrealized = MonetaryValue::new(
                                cost_basis.local.map(|cost| *value - cost),
                                cost_basis.base.map(|cost| *value - cost),
                            );
                            holding.unrealized_gain = Some(unrealized.clone());
                            holding.unrealized_gain_pct =
                                gain_pct(unrealized.local.unwrap(), cost_basis.local.unwrap());
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
        async_worker_thread: Option<std::thread::ThreadId>,
        income_by_account: HashMap<String, HashMap<String, MonetaryValue>>,
        scopes: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl MockHoldingIncomeService {
        fn new(income_by_account: HashMap<String, HashMap<String, MonetaryValue>>) -> Self {
            Self {
                async_worker_thread: None,
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
            if let Some(worker) = self.async_worker_thread {
                assert_ne!(
                    std::thread::current().id(),
                    worker,
                    "history work held the async worker"
                );
            }
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
        async_worker_thread: Option<std::thread::ThreadId>,
        fail_open_lot_reads: bool,
        open_lots: Vec<LotRecord>,
        disposals: Vec<crate::lots::LotDisposal>,
        open_lots_calls: Arc<AtomicUsize>,
        open_lots_for_asset_calls: Arc<AtomicUsize>,
    }

    impl MockLotRepository {
        fn new(open_lots: Vec<LotRecord>) -> Self {
            Self {
                async_worker_thread: None,
                fail_open_lot_reads: false,
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
        async_worker_thread: Option<std::thread::ThreadId>,
        activities: Vec<Activity>,
        fail_get_activities_by_account_id: bool,
    }

    impl MockActivityRepository {
        fn new(activities: Vec<Activity>) -> Self {
            Self {
                async_worker_thread: None,
                activities,
                fail_get_activities_by_account_id: false,
            }
        }

        fn failing_get_activities_by_account_id() -> Self {
            Self {
                async_worker_thread: None,
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

        fn get_activities(&self) -> Result<Vec<Activity>> {
            Ok(self.activities.clone())
        }

        fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>> {
            if let Some(worker) = self.async_worker_thread {
                assert_ne!(
                    std::thread::current().id(),
                    worker,
                    "history work held the async worker"
                );
            }
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
            if self.fail_open_lot_reads {
                return Err(Error::Unexpected("injected lot read failure".into()));
            }
            if let Some(worker) = self.async_worker_thread {
                assert_ne!(
                    std::thread::current().id(),
                    worker,
                    "history work held the async worker"
                );
            }
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
            if self.fail_open_lot_reads {
                return Err(Error::Unexpected("injected lot read failure".into()));
            }
            if let Some(worker) = self.async_worker_thread {
                assert_ne!(
                    std::thread::current().id(),
                    worker,
                    "history work held the async worker"
                );
            }
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
            if let Some(worker) = self.async_worker_thread {
                assert_ne!(
                    std::thread::current().id(),
                    worker,
                    "history work held the async worker"
                );
            }
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
        async fn update_category_reviewed(
            &self,
            _: crate::taxonomies::Category,
            _: crate::taxonomies::Category,
        ) -> crate::Result<crate::taxonomies::Category> {
            unimplemented!("reviewed categories are not used by this fixture")
        }
        async fn delete_category_reviewed(
            &self,
            _: crate::taxonomies::Category,
        ) -> crate::Result<usize> {
            unimplemented!("reviewed categories are not used by this fixture")
        }

        fn get_category_references(
            &self,
            _: &str,
            _: &str,
        ) -> crate::Result<crate::taxonomies::CategoryReferences> {
            unimplemented!("category references are not used by this fixture")
        }

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
            cost_basis_account: None,
            cost_basis_base: None,
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
            fx_rate_to_account: None,
            account_currency: None,
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
            proceeds_base_known: Some(true),
            cost_basis_base_known: Some(true),
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

    include!("holdings_test_support.rs");

    fn test_service(
        snapshot: AccountStateSnapshot,
        assets: Vec<Asset>,
        values: HashMap<String, Decimal>,
    ) -> TestHoldingsService {
        test_service_with_snapshots(
            Arc::new(MockSnapshotService {
                snapshot,
                snapshots_by_account: HashMap::new(),
            }),
            assets,
            values,
        )
    }

    mod issue_2487 {
        // End-to-end regressions over the real coordinator, manual snapshot
        // writer, captured holdings read and live valuation services.
        use super::*;
        use crate::accounts::{Account, TrackingMode};
        use crate::assets::AssetService;
        use crate::fx::FxService;
        use crate::portfolio::coordinator::{
            CoordinatorDeps, FactSources, PortfolioCoordinator, PortfolioJobRequest,
            SilentObserver, WindowCadence,
        };
        use crate::portfolio::holdings::HoldingsValuationService;
        use crate::portfolio::projection::{MarkerScope, ProjectionStoreTrait, GENESIS};
        use crate::portfolio::snapshot::{
            ManualHoldingInput, ManualSnapshotRequest, ManualSnapshotService, SnapshotService,
            SnapshotSource,
        };
        use crate::test_support::in_memory::*;

        const ASSET_ID: &str = "cad-stock";

        include!("holdings_health_tests.rs");

        struct Fixture {
            now: chrono::DateTime<Utc>,
            base_currency: Arc<RwLock<String>>,
            activities: Arc<InMemoryActivityRepository>,
            assets: Arc<InMemoryAssetRepository>,
            quotes: Arc<InMemoryQuoteService>,
            fx_repo: Arc<InMemoryFxRepository>,
            fx: Arc<FxService>,
            snapshots: Arc<InMemorySnapshotRepository>,
            lots: Arc<InMemoryLotRepository>,
            store: Arc<InMemoryProjectionStore>,
        }

        impl Fixture {
            fn new(activities: Vec<Activity>, rates: Vec<ExchangeRate>) -> Self {
                Self::with_quote(activities, rates, "CAD", dec!(110))
            }

            fn with_quote(
                activities: Vec<Activity>,
                rates: Vec<ExchangeRate>,
                currency: &str,
                price: Decimal,
            ) -> Self {
                let now = "2025-01-15T12:00:00Z".parse().unwrap();
                let mut asset = test_asset(ASSET_ID, "CAD", InstrumentType::Equity);
                asset.quote_ccy = currency.into();
                asset.is_active = true;
                let activity_ids = activities
                    .iter()
                    .map(|activity| activity.id.clone())
                    .collect();
                let activities =
                    Arc::new(InMemoryActivityRepository::new(activities, HashSet::new()));
                let assets = Arc::new(InMemoryAssetRepository::new(vec![asset.clone()]));
                let quotes = Arc::new(InMemoryQuoteService::new(
                    vec![crate::quotes::Quote {
                        id: "cad-close".into(),
                        asset_id: ASSET_ID.into(),
                        timestamp: now,
                        close: price,
                        currency: currency.into(),
                        ..Default::default()
                    }],
                    vec![asset],
                ));
                let fx_repo = Arc::new(InMemoryFxRepository::new(rates));
                let fx = Arc::new(FxService::new(fx_repo.clone()));
                fx.initialize().unwrap();
                let snapshots = Arc::new(InMemorySnapshotRepository::new(HashSet::new()));
                let lots = Arc::new(InMemoryLotRepository::new(
                    activity_ids,
                    HashSet::from([ASSET_ID.into()]),
                ));
                let store = Arc::new(InMemoryProjectionStore::new(
                    snapshots.clone(),
                    lots.clone(),
                    Arc::new(InMemoryValuationRepository::default()),
                ));
                Self {
                    now,
                    base_currency: Arc::new(RwLock::new("CAD".into())),
                    activities,
                    assets,
                    quotes,
                    fx_repo,
                    fx,
                    snapshots,
                    lots,
                    store,
                }
            }

            fn services(
                &self,
                accounts: Vec<Account>,
            ) -> (PortfolioCoordinator, HoldingsService, Arc<SnapshotService>) {
                let timezone = Arc::new(RwLock::new("UTC".into()));
                let accounts = Arc::new(InMemoryAccountRepository::new(accounts));
                self.store.set_holdings_sources(InMemoryHoldingsSources {
                    accounts: accounts.clone(),
                    activities: self.activities.clone(),
                    assets: self.assets.clone(),
                    fx: self.fx_repo.clone(),
                    base_currency: self.base_currency.clone(),
                    timezone: timezone.clone(),
                });
                let snapshots = Arc::new(SnapshotService::new(
                    timezone.clone(),
                    accounts.clone(),
                    self.snapshots.clone(),
                    self.activities.clone(),
                ));
                let coordinator = PortfolioCoordinator::new(CoordinatorDeps {
                    base_currency: self.base_currency.clone(),
                    timezone: timezone.clone(),
                    sources: FactSources {
                        accounts,
                        activities: self.activities.clone(),
                        assets: self.assets.clone(),
                        quotes: self.quotes.clone(),
                        fx_rates: self.fx_repo.clone(),
                        snapshots: self.snapshots.clone(),
                        projections: self.store.clone(),
                    },
                    fx_service: self.fx.clone(),
                    snapshot_service: snapshots.clone(),
                    projections: self.store.clone(),
                    lots: self.lots.clone(),
                    window_cadence: WindowCadence::Year,
                });
                let holdings = HoldingsService::new_with_timezone(
                    Arc::new(AssetService::new(self.assets.clone(), self.quotes.clone()).unwrap()),
                    snapshots.clone(),
                    Arc::new(HoldingsValuationService::new_with_timezone(
                        self.fx.clone(),
                        self.quotes.clone(),
                        timezone.clone(),
                    )),
                    Arc::new(AssetClassificationService::new(Arc::new(
                        EmptyTaxonomyService,
                    ))),
                    timezone,
                )
                .with_lot_repository(self.lots.clone())
                .with_projection_store(self.store.clone());
                (coordinator, holdings, snapshots)
            }

            async fn save_holding(
                &self,
                snapshots: &Arc<SnapshotService>,
                account: &Account,
                cost: Decimal,
            ) {
                ManualSnapshotService::new(
                    Arc::new(AssetService::new(self.assets.clone(), self.quotes.clone()).unwrap()),
                    self.fx.clone(),
                    snapshots.clone(),
                    self.quotes.clone(),
                )
                .with_timezone("UTC".into())
                .save_manual_snapshot(ManualSnapshotRequest {
                    account_id: account.id.clone(),
                    account_currency: account.currency.clone(),
                    snapshot_date: self.now.date_naive(),
                    positions: vec![ManualHoldingInput {
                        asset_id: Some(ASSET_ID.into()),
                        symbol: "CAD".into(),
                        exchange_mic: None,
                        quantity: dec!(1),
                        currency: account.currency.clone(),
                        average_cost: cost,
                        name: None,
                        data_source: None,
                        asset_kind: None,
                        quote_ccy: Some("CAD".into()),
                        instrument_type: Some("EQUITY".into()),
                        provider_id: None,
                        provider_symbol: None,
                    }],
                    cash_balances: Vec::new(),
                    base_currency: Some("CAD".into()),
                    source: SnapshotSource::ManualEntry,
                })
                .await
                .unwrap();
            }

            async fn lot_cost(&self, account: &str) -> Decimal {
                let lots = self.lots.get_open_lots_for_account(account).await.unwrap();
                assert_eq!(lots.len(), 1);
                lots[0].remaining_cost_basis_base.parse().unwrap()
            }
        }

        fn account(id: &str, currency: &str, mode: TrackingMode) -> Account {
            Account {
                id: id.into(),
                account_type: "SECURITIES".into(),
                currency: currency.into(),
                is_active: true,
                tracking_mode: mode,
                ..Default::default()
            }
        }

        fn buy(account: &str, currency: &str, cost: Decimal) -> Activity {
            let mut activity = test_income_activity(
                &format!("buy-{account}"),
                account,
                Some(ASSET_ID),
                ACTIVITY_TYPE_BUY,
                cost,
                currency,
                NaiveDate::from_ymd_opt(2025, 1, 2).unwrap(),
            );
            activity.quantity = Some(dec!(1));
            activity.unit_price = Some(cost);
            activity
        }

        fn usd_cad_rate() -> ExchangeRate {
            ExchangeRate {
                id: "USD-CAD".into(),
                from_currency: "USD".into(),
                to_currency: "CAD".into(),
                rate: dec!(2),
                source: "MANUAL".into(),
                timestamp: "2025-01-02T00:00:00Z".parse().unwrap(),
            }
        }

        async fn run(coordinator: &PortfolioCoordinator) {
            let report = coordinator
                .run_job(PortfolioJobRequest::default(), &SilentObserver)
                .await
                .unwrap();
            assert!(report.failures.is_empty(), "{:?}", report.failures);
        }

        async fn holding(holdings: &HoldingsService, account: &str) -> Holding {
            holdings
                .get_holdings(account, "CAD")
                .await
                .unwrap()
                .into_iter()
                .find(|holding| {
                    holding
                        .instrument
                        .as_ref()
                        .is_some_and(|instrument| instrument.id == ASSET_ID)
                })
                .unwrap()
        }

        fn money(local: Decimal, base: Decimal) -> MonetaryValue {
            MonetaryValue::new(local, base)
        }

        async fn assert_pending(holdings: &HoldingsService, account: &str, base: &str) {
            assert!(matches!(
                holdings.get_holdings(account, base).await,
                Err(CoreError::HoldingsPending(_))
            ));
            assert!(matches!(
                holdings.get_holding(account, ASSET_ID, base).await,
                Err(CoreError::HoldingsPending(_))
            ));
            let scope = holdings
                .get_holdings_scope(&[account.to_string()], base, account, false)
                .await
                .unwrap();
            assert!(scope.holdings.is_empty());
            assert_eq!(scope.incomplete_accounts.len(), 1);
            assert_eq!(scope.incomplete_accounts[0].status, "pending");
        }

        #[tokio::test]
        async fn issue_2487_cad_holdings_use_the_manual_basis_after_switching_tracking_mode() {
            let mut account = account("cad-account", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            // Generate matching snapshot and lot costs through the projection.
            run(&coordinator).await;
            let before = holding(&holdings, &account.id).await;
            assert_eq!(before.cost_basis, Some(money(dec!(100), dec!(100))));
            assert_eq!(before.unrealized_gain, Some(money(dec!(10), dec!(10))));

            account.tracking_mode = TrackingMode::Holdings;
            let (coordinator, holdings, snapshots) = fixture.services(vec![account.clone()]);
            fixture.save_holding(&snapshots, &account, dec!(120)).await;
            fixture
                .store
                .mark(MarkerScope::Account(account.id.clone()), GENESIS);
            run(&coordinator).await;
            assert_eq!(fixture.lot_cost(&account.id).await, dec!(100));

            let after = holding(&holdings, &account.id).await;
            assert_eq!(
                (&*after.local_currency, &*after.base_currency),
                ("CAD", "CAD")
            );
            assert_eq!(after.market_value, money(dec!(110), dec!(110)));
            assert_eq!(
                after.unrealized_gain,
                Some(money(dec!(-10), dec!(-10))),
                "the currency toggle must preserve the loss on this CAD holding"
            );
        }

        #[tokio::test]
        async fn issue_2487_transaction_edit_keeps_cad_values_consistent_until_commit() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let mut edited = buy(&account.id, "CAD", dec!(100));
            let fixture = Fixture::new(vec![edited.clone()], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, snapshots) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            assert_eq!(
                holding(&holdings, &account.id).await.unrealized_gain,
                Some(money(dec!(10), dec!(10)))
            );

            edited.unit_price = Some(dec!(120));
            edited.amount = Some(dec!(120));
            fixture.activities.apply(Vec::new(), vec![edited], &[]);
            fixture
                .store
                .mark(MarkerScope::Account(account.id.clone()), GENESIS);
            assert_pending(&holdings, &account.id, "CAD").await;

            // Save the real new snapshot, then fail before the real lot-book commit.
            fixture.store.fail_next_completion();
            let failed = coordinator
                .run_job(PortfolioJobRequest::default(), &SilentObserver)
                .await
                .unwrap();
            assert!(failed.failures.iter().any(|failure| failure
                .message
                .contains("injected projection completion failure")));
            let snapshot = snapshots
                .get_latest_holdings_snapshot(&account.id)
                .unwrap()
                .unwrap();
            assert_eq!(snapshot.source, SnapshotSource::Calculated);
            assert_eq!(snapshot.positions[ASSET_ID].total_cost_basis, dec!(120));
            assert_eq!(fixture.lot_cost(&account.id).await, dec!(100));
            assert!(!fixture.store.pending_markers().unwrap().is_empty());
            let failed_scope = holdings
                .get_holdings_scope(std::slice::from_ref(&account.id), "CAD", &account.id, false)
                .await
                .unwrap();
            assert_eq!(failed_scope.incomplete_accounts[0].status, "unavailable");
            assert_eq!(
                failed_scope.incomplete_accounts[0].reason_code,
                "PROJECTION_FAILED"
            );
            assert!(matches!(
                failed_scope.require_complete(),
                Err(CoreError::HoldingsUnavailable(_))
            ));

            // A successful retry repairs the mismatch; tracking mode never changed.
            run(&coordinator).await;
            assert!(fixture.store.pending_markers().unwrap().is_empty());
            assert_eq!(fixture.lot_cost(&account.id).await, dec!(120));
            assert_eq!(
                holding(&holdings, &account.id).await.unrealized_gain,
                Some(money(dec!(-10), dec!(-10)))
            );
        }

        #[tokio::test]
        async fn issue_2487_mixed_currency_holdings_aggregate_in_the_displayed_currency() {
            let cad = account("cad-account", "CAD", TrackingMode::Holdings);
            let usd = account("usd-account", "USD", TrackingMode::Holdings);
            let fixture = Fixture::new(Vec::new(), vec![usd_cad_rate()]);
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, snapshots) =
                fixture.services(vec![cad.clone(), usd.clone()]);
            fixture.save_holding(&snapshots, &cad, dec!(130)).await;
            fixture.save_holding(&snapshots, &usd, dec!(40)).await;
            run(&coordinator).await;

            // Both accounts have always tracked holdings and are correct alone.
            let cad_holding = holding(&holdings, &cad.id).await;
            assert_eq!(cad_holding.local_currency, "CAD");
            assert_eq!(
                cad_holding.unrealized_gain,
                Some(money(dec!(-20), dec!(-20)))
            );
            let usd_holding = holding(&holdings, &usd.id).await;
            assert_eq!(usd_holding.local_currency, "USD");
            assert_eq!(usd_holding.unrealized_gain, Some(money(dec!(15), dec!(30))));

            let mut converted_local_gains = Vec::new();
            let mut labelled_gains = Vec::new();
            for ids in [
                vec![cad.id.clone(), usd.id.clone()],
                vec![usd.id.clone(), cad.id.clone()],
            ] {
                let merged = holdings
                    .get_holdings_for_accounts(&ids, "CAD", "all")
                    .await
                    .unwrap();
                let merged = merged
                    .iter()
                    .find(|holding| {
                        holding
                            .instrument
                            .as_ref()
                            .is_some_and(|instrument| instrument.id == ASSET_ID)
                    })
                    .unwrap();
                assert_eq!(merged.base_currency, "CAD");
                let gain = merged.unrealized_gain.as_ref().unwrap();
                assert_eq!(gain.base.unwrap(), dec!(10));
                labelled_gains.push((merged.local_currency.clone(), gain.clone()));
                // Constant FX: a correctly labelled local sum must equal the
                // base total after conversion, regardless of account order.
                converted_local_gains.push(
                    fixture
                        .fx
                        .convert_currency(
                            gain.local.unwrap(),
                            &merged.local_currency,
                            &merged.base_currency,
                        )
                        .unwrap(),
                );
            }
            assert_eq!(
                converted_local_gains,
                vec![dec!(10), dec!(10)],
                "the combined local gain must use its displayed currency, not add CAD to USD: {labelled_gains:?}"
            );
        }

        #[tokio::test]
        async fn issue_2487_transaction_accounts_use_the_same_asset_currency_when_aggregated() {
            let cad = account("cad-account", "CAD", TrackingMode::Transactions);
            let usd = account("usd-account", "USD", TrackingMode::Transactions);
            let fixture = Fixture::new(
                vec![
                    buy(&cad.id, "CAD", dec!(130)),
                    buy(&usd.id, "USD", dec!(40)),
                ],
                vec![usd_cad_rate()],
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![cad.clone(), usd.clone()]);
            run(&coordinator).await;
            for account in [&cad, &usd] {
                let holding = holding(&holdings, &account.id).await;
                assert_eq!(
                    holding.local_currency, "CAD",
                    "the asset currency, not the account currency"
                );
            }
            for ids in [
                vec![cad.id.clone(), usd.id.clone()],
                vec![usd.id.clone(), cad.id.clone()],
            ] {
                let merged = holdings
                    .get_holdings_for_accounts(&ids, "CAD", "all")
                    .await
                    .unwrap();
                let merged = merged
                    .iter()
                    .find(|holding| {
                        holding
                            .instrument
                            .as_ref()
                            .is_some_and(|instrument| instrument.id == ASSET_ID)
                    })
                    .unwrap();
                assert_eq!(
                    (&*merged.local_currency, &*merged.base_currency),
                    ("CAD", "CAD")
                );
                assert_eq!(merged.unrealized_gain, Some(money(dec!(10), dec!(10))));
            }
        }

        fn rate(from: &str, to: &str, day: &str, value: Decimal) -> ExchangeRate {
            ExchangeRate {
                id: format!("{from}-{to}-{day}"),
                from_currency: from.into(),
                to_currency: to.into(),
                rate: value,
                source: "MANUAL".into(),
                timestamp: format!("{day}T00:00:00Z").parse().unwrap(),
            }
        }

        async fn both_reads(holdings: &HoldingsService, account: &str, base: &str) -> Vec<Holding> {
            vec![
                holdings
                    .get_holdings(account, base)
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|holding| {
                        holding
                            .instrument
                            .as_ref()
                            .is_some_and(|instrument| instrument.id == ASSET_ID)
                    })
                    .unwrap(),
                holdings
                    .get_holding(account, ASSET_ID, base)
                    .await
                    .unwrap()
                    .unwrap(),
            ]
        }

        #[tokio::test]
        async fn issue_2487_base_currency_changes_do_not_relabel_snapshot_costs() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(
                vec![buy(&account.id, "CAD", dec!(100))],
                vec![usd_cad_rate()],
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, snapshots) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            let old = snapshots
                .get_latest_holdings_snapshot(&account.id)
                .unwrap()
                .unwrap();
            assert_eq!(old.positions[ASSET_ID].cost_basis_base, Some(dec!(100)));
            // The runtime setting changes before its background rebuild.
            *fixture.base_currency.write().unwrap() = "USD".into();
            for holding in both_reads(&holdings, &account.id, "USD").await {
                assert_eq!(
                    holding.cost_basis,
                    Some(MonetaryValue::new(dec!(100), None))
                );
                assert_eq!(
                    holding.unrealized_gain,
                    Some(MonetaryValue::new(dec!(10), None))
                );
            }
            fixture.store.mark(MarkerScope::All, GENESIS);
            run(&coordinator).await;
            let rebuilt = snapshots
                .get_latest_holdings_snapshot(&account.id)
                .unwrap()
                .unwrap();
            assert_eq!(rebuilt.positions[ASSET_ID].cost_basis_base, Some(dec!(50)));
            for holding in both_reads(&holdings, &account.id, "USD").await {
                assert_eq!(holding.cost_basis, Some(money(dec!(100), dec!(50))));
            }
        }

        #[tokio::test]
        async fn issue_2487_base_currency_change_keeps_realized_gain_currency() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let mut purchase = buy(&account.id, "CAD", dec!(100));
            purchase.quantity = Some(dec!(2));
            purchase.amount = Some(dec!(200));
            let mut sale = test_income_activity(
                "sale",
                &account.id,
                Some(ASSET_ID),
                ACTIVITY_TYPE_SELL,
                dec!(110),
                "CAD",
                NaiveDate::from_ymd_opt(2025, 1, 3).unwrap(),
            );
            sale.quantity = Some(dec!(1));
            sale.unit_price = Some(dec!(110));
            let fixture = Fixture::new(vec![purchase, sale], vec![usd_cad_rate()]);
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            assert_eq!(
                holding(&holdings, &account.id).await.realized_gain,
                Some(money(dec!(10), dec!(10)))
            );
            *fixture.base_currency.write().unwrap() = "USD".into();
            let before = both_reads(&holdings, &account.id, "USD").await;
            let disposals = fixture
                .lots
                .get_lot_disposals_for_account(&account.id)
                .await
                .unwrap();
            assert_eq!(disposals[0].base_currency, "CAD");
            fixture.store.mark(MarkerScope::All, GENESIS);
            run(&coordinator).await;
            for holding in both_reads(&holdings, &account.id, "USD").await {
                assert_eq!(holding.realized_gain, Some(money(dec!(10), dec!(5))));
            }
            for holding in before {
                assert_eq!(
                    holding.realized_gain,
                    Some(MonetaryValue::new(dec!(10), None)),
                    "old CAD realized gains must not be labelled USD"
                );
            }
        }

        #[tokio::test]
        async fn issue_2487_zero_historical_base_cost_survives_return_of_capital() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let mut roc = test_income_activity(
                "roc",
                &account.id,
                Some(ASSET_ID),
                ACTIVITY_TYPE_ADJUSTMENT,
                dec!(50),
                "USD",
                NaiveDate::from_ymd_opt(2025, 1, 3).unwrap(),
            );
            roc.subtype = Some(ACTIVITY_SUBTYPE_RETURN_OF_CAPITAL.into());
            let fixture = Fixture::with_quote(
                vec![buy(&account.id, "USD", dec!(100)), roc],
                vec![
                    rate("USD", "CAD", "2025-01-02", dec!(1)),
                    rate("USD", "CAD", "2025-01-03", dec!(2)),
                ],
                "USD",
                dec!(40),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, snapshots) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            let snapshot = snapshots
                .get_latest_holdings_snapshot(&account.id)
                .unwrap()
                .unwrap();
            assert_eq!(snapshot.positions[ASSET_ID].total_cost_basis, dec!(50));
            assert_eq!(snapshot.positions[ASSET_ID].cost_basis_base, Some(dec!(0)));
            assert_eq!(fixture.lot_cost(&account.id).await, dec!(0));
            for holding in both_reads(&holdings, &account.id, "CAD").await {
                assert_eq!(holding.cost_basis, Some(money(dec!(50), dec!(0))));
                assert_eq!(holding.unrealized_gain, Some(money(dec!(-10), dec!(80))));
            }
        }

        #[tokio::test]
        async fn issue_2487_manual_zero_cost_is_not_missing_cost() {
            let mut account = account("cad-account", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, _, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            account.tracking_mode = TrackingMode::Holdings;
            let (_, holdings, snapshots) = fixture.services(vec![account.clone()]);
            fixture.save_holding(&snapshots, &account, dec!(0)).await;
            for holding in both_reads(&holdings, &account.id, "CAD").await {
                assert_eq!(holding.cost_basis, Some(money(dec!(0), dec!(0))));
                assert_eq!(holding.unrealized_gain, Some(money(dec!(110), dec!(110))));
            }
        }

        #[tokio::test]
        async fn issue_2487_legacy_snapshot_and_historical_fx_remain_supported() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::with_quote(
                vec![buy(&account.id, "USD", dec!(100))],
                vec![
                    rate("USD", "CAD", "2025-01-02", dec!(2)),
                    rate("USD", "CAD", "2025-01-03", dec!(1)),
                ],
                "USD",
                dec!(110),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, snapshots) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            let mut legacy = snapshots
                .get_latest_holdings_snapshot(&account.id)
                .unwrap()
                .unwrap();
            legacy.base_currency = None;
            for position in legacy.positions.values_mut() {
                position.cost_basis_base = None;
                position.cost_basis_account = None;
            }
            use crate::portfolio::snapshot::SnapshotRepositoryTrait;
            fixture.snapshots.save_snapshots(&[legacy]).await.unwrap();
            fixture.store.mark(MarkerScope::All, GENESIS);
            assert_pending(&holdings, &account.id, "CAD").await;
            run(&coordinator).await;
            for holding in both_reads(&holdings, &account.id, "CAD").await {
                assert_eq!(holding.cost_basis, Some(money(dec!(100), dec!(200))));
                // A legitimate local gain and base loss must remain possible.
                assert_eq!(holding.unrealized_gain, Some(money(dec!(10), dec!(-90))));
            }
        }

        #[tokio::test]
        async fn issue_2487_minor_units_are_scaled_before_display() {
            let account = account("gbp-account", "GBP", TrackingMode::Transactions);
            let fixture = Fixture::with_quote(
                vec![buy(&account.id, "GBP", dec!(10))],
                vec![rate("GBP", "CAD", "2025-01-02", dec!(2))],
                "GBp",
                dec!(1100),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            for holding in both_reads(&holdings, &account.id, "CAD").await {
                assert_eq!(holding.local_currency, "GBP");
                assert_eq!(holding.cost_basis, Some(money(dec!(10), dec!(20))));
                assert_eq!(holding.market_value, money(dec!(11), dec!(22)));
                assert_eq!(holding.unrealized_gain, Some(money(dec!(1), dec!(2))));
            }
        }

        #[tokio::test]
        async fn issue_2487_missing_fx_does_not_fabricate_a_base_return() {
            let account = account("usd-account", "USD", TrackingMode::Holdings);
            let fixture = Fixture::new(Vec::new(), vec![usd_cad_rate()]);
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (_, holdings, snapshots) = fixture.services(vec![account.clone()]);
            fixture.save_holding(&snapshots, &account, dec!(40)).await;
            // Remove the persisted FX observations without changing the holding.
            // A fresh service has no converter or rates to satisfy the request.
            fixture.fx_repo.clear_rates();
            let missing_fx = Arc::new(FxService::new(Arc::new(InMemoryFxRepository::new(
                Vec::new(),
            ))));
            missing_fx.initialize().unwrap();
            let holdings = HoldingsService {
                valuation_service: Arc::new(HoldingsValuationService::new(
                    missing_fx,
                    fixture.quotes.clone(),
                )),
                ..holdings
            };
            for holding in [
                holdings
                    .get_holdings(&account.id, "CAD")
                    .await
                    .map(|mut rows| rows.remove(0)),
                holdings
                    .get_holding(&account.id, ASSET_ID, "CAD")
                    .await
                    .map(|holding| holding.unwrap()),
            ]
            .into_iter()
            .flatten()
            {
                assert!(
                    holding.fx_rate.is_none()
                        && holding
                            .unrealized_gain
                            .as_ref()
                            .is_some_and(|gain| gain.base.is_none() && gain.local.is_none()),
                    "missing FX must be explicit, got rate {:?} and gain {:?}",
                    holding.fx_rate,
                    holding.unrealized_gain
                );
            }
        }

        #[tokio::test]
        async fn issue_2487_successful_recalculation_publishes_coherent_positions() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let mut edited = buy(&account.id, "CAD", dec!(100));
            let fixture = Fixture::new(vec![edited.clone()], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            edited.unit_price = Some(dec!(120));
            edited.quantity = Some(dec!(2));
            edited.amount = Some(dec!(240));
            fixture.activities.apply(Vec::new(), vec![edited], &[]);
            fixture
                .store
                .mark(MarkerScope::Account(account.id.clone()), GENESIS);
            let pause = fixture.store.pause_next_completion();
            let writer = tokio::spawn(async move {
                coordinator
                    .run_job(PortfolioJobRequest::default(), &SilentObserver)
                    .await
                    .unwrap()
            });
            pause.wait_until_entered().await;
            assert_pending(&holdings, &account.id, "CAD").await;
            pause.resume();
            let report = writer.await.unwrap();
            assert!(report.failures.is_empty(), "{:?}", report.failures);
            for after in both_reads(&holdings, &account.id, "CAD").await {
                assert_eq!(after.quantity, dec!(2));
                assert_eq!(after.cost_basis, Some(money(dec!(240), dec!(240))));
            }
        }

        #[tokio::test]
        async fn issue_2487_lot_read_failures_do_not_invent_historical_returns() {
            let mut violations = Vec::new();
            for fault in [
                "missing",
                "invalid",
                "mismatched currency",
                "mismatched quantity",
            ] {
                let account = account("cad-account", "CAD", TrackingMode::Transactions);
                let fixture = Fixture::with_quote(
                    vec![buy(&account.id, "USD", dec!(100))],
                    vec![
                        rate("USD", "CAD", "2025-01-02", dec!(2)),
                        rate("USD", "CAD", "2025-01-03", dec!(1)),
                    ],
                    "USD",
                    dec!(110),
                );
                let _clock = crate::utils::clock::freeze(fixture.now);
                let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
                run(&coordinator).await;
                let mut lots = fixture
                    .lots
                    .get_open_lots_for_account(&account.id)
                    .await
                    .unwrap();
                if fault == "invalid" {
                    lots[0].remaining_cost_basis_base = "not-a-decimal".into();
                } else if fault == "mismatched currency" {
                    lots[0].base_currency = "EUR".into();
                } else if fault == "mismatched quantity" {
                    lots[0].remaining_quantity = "2".into();
                } else {
                    lots.clear();
                }
                fixture
                    .lots
                    .replace_lots_for_account(&account.id, &lots)
                    .await
                    .unwrap();
                let detail = holdings
                    .get_holding(&account.id, ASSET_ID, "CAD")
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    detail.lots.is_none(),
                    "{fault}: invalid detail cannot override the snapshot summary"
                );
                for holding in [
                    holdings
                        .get_holdings(&account.id, "CAD")
                        .await
                        .map(|mut rows| rows.remove(0)),
                    holdings
                        .get_holding(&account.id, ASSET_ID, "CAD")
                        .await
                        .map(|holding| holding.unwrap()),
                ]
                .into_iter()
                .flatten()
                {
                    if let Some(gain) = holding.unrealized_gain {
                        if gain.base.unwrap() != dec!(-90) {
                            violations.push(format!(
                                "{fault}: reported {} instead of historical CAD -90 or unavailable",
                                gain.base.unwrap()
                            ));
                        }
                    }
                }
            }
            assert!(violations.is_empty(), "{violations:#?}");
        }

        #[tokio::test]
        async fn issue_2487_mixed_tracking_accounts_aggregate_in_one_currency() {
            let cad = account("cad-account", "CAD", TrackingMode::Transactions);
            let usd = account("usd-account", "USD", TrackingMode::Holdings);
            let fixture = Fixture::new(vec![buy(&cad.id, "CAD", dec!(130))], vec![usd_cad_rate()]);
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, snapshots) =
                fixture.services(vec![cad.clone(), usd.clone()]);
            fixture.save_holding(&snapshots, &usd, dec!(40)).await;
            run(&coordinator).await;
            assert_eq!(
                holding(&holdings, &cad.id).await.unrealized_gain,
                Some(money(dec!(-20), dec!(-20)))
            );
            assert_eq!(
                holding(&holdings, &usd.id).await.unrealized_gain,
                Some(money(dec!(15), dec!(30)))
            );
            let mut converted_gains = Vec::new();
            for ids in [
                vec![cad.id.clone(), usd.id.clone()],
                vec![usd.id.clone(), cad.id.clone()],
            ] {
                let combined = holdings
                    .get_holdings_for_accounts(&ids, "CAD", "all")
                    .await
                    .unwrap();
                let combined = combined
                    .iter()
                    .find(|holding| {
                        holding
                            .instrument
                            .as_ref()
                            .is_some_and(|instrument| instrument.id == ASSET_ID)
                    })
                    .unwrap();
                let gain = combined.unrealized_gain.as_ref().unwrap();
                assert_eq!(gain.base.unwrap(), dec!(10));
                converted_gains.push(
                    fixture
                        .fx
                        .convert_currency(gain.local.unwrap(), &combined.local_currency, "CAD")
                        .unwrap(),
                );
            }
            assert_eq!(converted_gains, vec![dec!(10), dec!(10)]);
        }

        #[tokio::test]
        async fn issue_2487_manual_position_does_not_claim_old_transaction_lots() {
            let mut account = account("cad-account", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, _, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            account.tracking_mode = TrackingMode::Holdings;
            let (_, holdings, snapshots) = fixture.services(vec![account.clone()]);
            fixture.save_holding(&snapshots, &account, dec!(120)).await;
            let mut snapshot = snapshots
                .get_latest_holdings_snapshot(&account.id)
                .unwrap()
                .unwrap();
            snapshot.positions.get_mut(ASSET_ID).unwrap().quantity = dec!(3);
            snapshot
                .positions
                .get_mut(ASSET_ID)
                .unwrap()
                .total_cost_basis = dec!(360);
            snapshots
                .save_manual_snapshot(&account.id, snapshot)
                .await
                .unwrap();
            let detail = holdings
                .get_holding(&account.id, ASSET_ID, "CAD")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(detail.quantity, dec!(3));
            assert!(detail.lots.as_ref().is_none_or(|lots| lots.is_empty()),
                "the retained one-share transaction lot is not the lot book for this manually entered three-share position");
        }

        #[tokio::test]
        async fn issue_2487_changing_historical_fx_is_not_a_spot_conversion() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let mut purchase = buy(&account.id, "EUR", dec!(100));
            purchase.quantity = Some(dec!(2));
            purchase.amount = Some(dec!(200));
            let mut sale = test_income_activity(
                "sale",
                &account.id,
                Some(ASSET_ID),
                ACTIVITY_TYPE_SELL,
                dec!(110),
                "EUR",
                NaiveDate::from_ymd_opt(2025, 1, 3).unwrap(),
            );
            sale.quantity = Some(dec!(1));
            sale.unit_price = Some(dec!(110));
            let fixture = Fixture::with_quote(
                vec![purchase, sale],
                vec![
                    rate("EUR", "CAD", "2025-01-02", dec!(2)),
                    rate("EUR", "CAD", "2025-01-03", dec!(3)),
                    rate("EUR", "USD", "2025-01-02", dec!(1)),
                    rate("EUR", "USD", "2025-01-03", dec!(2)),
                    rate("USD", "CAD", "2025-01-02", dec!(2)),
                    rate("USD", "CAD", "2025-01-03", dec!(1.5)),
                ],
                "EUR",
                dec!(110),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            let old = holding(&holdings, &account.id).await;
            assert_eq!(old.realized_gain, Some(money(dec!(10), dec!(130))));
            *fixture.base_currency.write().unwrap() = "USD".into();
            let before = both_reads(&holdings, &account.id, "USD").await;
            let spot_converted = fixture
                .fx
                .convert_currency(dec!(130), "CAD", "USD")
                .unwrap();
            fixture.store.mark(MarkerScope::All, GENESIS);
            run(&coordinator).await;
            for rebuilt in both_reads(&holdings, &account.id, "USD").await {
                assert_eq!(rebuilt.realized_gain, Some(money(dec!(10), dec!(120))));
                assert_eq!(rebuilt.unrealized_gain, Some(money(dec!(10), dec!(120))));
                assert_eq!(rebuilt.cost_basis, Some(money(dec!(100), dec!(100))));
            }
            assert!((spot_converted - dec!(120)).abs() > dec!(1),
                "historical proceeds minus historical cost differs from spot-converting a realized gain");
            for before in before {
                assert!(
                    before
                        .realized_gain
                        .is_none_or(|gain| gain.base.is_none_or(|value| value == dec!(120)))
                        && before
                            .unrealized_gain
                            .is_none_or(|gain| gain.base.is_none_or(|value| value == dec!(120))),
                    "incompatible historical base amounts must be unavailable until recalculated"
                );
            }
        }

        #[tokio::test]
        async fn issue_2487_removing_all_activities_clears_current_positions() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let purchase = buy(&account.id, "CAD", dec!(100));
            let fixture = Fixture::new(vec![purchase.clone()], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            assert_eq!(holding(&holdings, &account.id).await.quantity, dec!(1));
            fixture
                .activities
                .apply(Vec::new(), Vec::new(), &[purchase.id]);
            fixture
                .store
                .mark(MarkerScope::Account(account.id.clone()), GENESIS);
            run(&coordinator).await;
            assert!(holdings
                .get_holdings(&account.id, "CAD")
                .await
                .unwrap()
                .is_empty());
            assert!(holdings
                .get_holding(&account.id, ASSET_ID, "CAD")
                .await
                .unwrap()
                .is_none());
            assert!(fixture
                .lots
                .get_open_lots_for_account(&account.id)
                .await
                .unwrap()
                .is_empty());
        }

        #[tokio::test]
        async fn issue_2487_missing_disposal_fx_provenance_is_not_zero_profit() {
            let mut violations = Vec::new();
            for missing in ["acquisition", "disposal"] {
                let account = account("cad-account", "CAD", TrackingMode::Transactions);
                let mut purchase = buy(&account.id, "USD", dec!(100));
                purchase.quantity = Some(dec!(2));
                purchase.amount = Some(dec!(200));
                if missing != "acquisition" {
                    purchase.fx_rate = Some(dec!(2));
                }
                let mut sale = test_income_activity(
                    "sale",
                    &account.id,
                    Some(ASSET_ID),
                    ACTIVITY_TYPE_SELL,
                    dec!(110),
                    "USD",
                    NaiveDate::from_ymd_opt(2025, 1, 3).unwrap(),
                );
                sale.quantity = Some(dec!(1));
                sale.unit_price = Some(dec!(110));
                if missing != "disposal" {
                    sale.fx_rate = Some(dec!(2));
                }
                let fixture =
                    Fixture::with_quote(vec![purchase, sale], Vec::new(), "USD", dec!(110));
                let _clock = crate::utils::clock::freeze(fixture.now);
                let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
                run(&coordinator).await;
                let disposals = fixture
                    .lots
                    .get_lot_disposals_for_account(&account.id)
                    .await
                    .unwrap();
                assert_eq!(disposals.len(), 1);
                assert_eq!(
                    disposals[0].realized_pnl.parse::<Decimal>().unwrap(),
                    dec!(10)
                );
                // Current FX can become available after the captured calculation;
                // it does not turn its unknown historical basis/proceeds into 0.
                fixture.fx_repo.add_rates(vec![usd_cad_rate()]);
                fixture.fx.initialize().unwrap();
                for holding in both_reads(&holdings, &account.id, "CAD").await {
                    let realized = holding
                        .realized_gain
                        .expect("local realized gain remains available");
                    assert_eq!(realized.local, Some(dec!(10)));
                    if let Some(base) = realized.base {
                        violations.push(format!(
                            "missing {missing} FX was shown as known base profit {}",
                            base
                        ));
                    }
                }
            }
            assert!(violations.is_empty(), "{violations:#?}");
        }

        #[tokio::test]
        async fn issue_2487_genuine_zero_realized_gain_is_available() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let mut purchase = buy(&account.id, "USD", dec!(100));
            purchase.quantity = Some(dec!(2));
            purchase.amount = Some(dec!(200));
            let mut sale = test_income_activity(
                "sale",
                &account.id,
                Some(ASSET_ID),
                ACTIVITY_TYPE_SELL,
                dec!(100),
                "USD",
                NaiveDate::from_ymd_opt(2025, 1, 3).unwrap(),
            );
            sale.quantity = Some(dec!(1));
            sale.unit_price = Some(dec!(100));
            let fixture =
                Fixture::with_quote(vec![purchase, sale], vec![usd_cad_rate()], "USD", dec!(110));
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            for holding in both_reads(&holdings, &account.id, "CAD").await {
                assert_eq!(holding.realized_gain, Some(money(dec!(0), dec!(0))));
            }
        }

        #[tokio::test]
        async fn issue_2487_quote_currency_edit_preserves_accounting_basis() {
            let cad = account("cad-account", "CAD", TrackingMode::Transactions);
            let manual = account("manual-account", "CAD", TrackingMode::Holdings);
            let mut fixture = Fixture::with_quote(
                vec![buy(&cad.id, "USD", dec!(100))],
                vec![
                    rate("USD", "CAD", "2025-01-02", dec!(2)),
                    rate("USD", "CAD", "2025-01-03", dec!(1)),
                ],
                "USD",
                dec!(110),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, _, snapshots) = fixture.services(vec![cad.clone(), manual.clone()]);
            fixture.save_holding(&snapshots, &manual, dec!(130)).await;
            run(&coordinator).await;

            let mut updated_asset = test_asset(ASSET_ID, "CAD", InstrumentType::Equity);
            updated_asset.quote_ccy = "CAD".into();
            updated_asset.is_active = true;
            fixture.assets = Arc::new(InMemoryAssetRepository::new(vec![updated_asset.clone()]));
            fixture.quotes = Arc::new(InMemoryQuoteService::new(
                vec![crate::quotes::Quote {
                    id: "cad-close".into(),
                    asset_id: ASSET_ID.into(),
                    timestamp: fixture.now,
                    close: dec!(110),
                    currency: "CAD".into(),
                    ..Default::default()
                }],
                vec![updated_asset],
            ));
            let (coordinator, holdings, _) = fixture.services(vec![cad.clone(), manual.clone()]);
            let before = holdings
                .get_holdings_for_accounts(&[manual.id.clone(), cad.id.clone()], "CAD", "all")
                .await
                .unwrap();
            fixture
                .store
                .mark(MarkerScope::Asset(ASSET_ID.into()), GENESIS);
            run(&coordinator).await;
            let after = holdings
                .get_holdings_for_accounts(&[manual.id.clone(), cad.id.clone()], "CAD", "all")
                .await
                .unwrap();
            let security = |rows: Vec<Holding>| {
                rows.into_iter()
                    .find(|holding| {
                        holding
                            .instrument
                            .as_ref()
                            .is_some_and(|instrument| instrument.id == ASSET_ID)
                    })
                    .unwrap()
            };
            assert_eq!(
                security(after).unrealized_gain,
                Some(money(dec!(-110), dec!(-110)))
            );
            let before = security(before);
            assert_eq!(before.local_currency, "CAD");
            assert_eq!(before.unrealized_gain, Some(money(dec!(-110), dec!(-110))),
                "CAD history is recorded: 200 CAD transaction cost plus 130 CAD manual cost, against 220 CAD market value");
        }

        #[tokio::test]
        async fn issue_2487_pending_account_keeps_healthy_peers_without_complete_weights() {
            let first = account("first", "CAD", TrackingMode::Transactions);
            let second = account("second", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(
                vec![
                    buy(&first.id, "CAD", dec!(100)),
                    buy(&second.id, "CAD", dec!(80)),
                ],
                Vec::new(),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![first.clone(), second.clone()]);
            run(&coordinator).await;
            fixture
                .store
                .invalidate(MarkerScope::Account(first.id.clone()), GENESIS)
                .await
                .unwrap();
            let scope = holdings
                .get_holdings_scope(&[first.id.clone(), second.id.clone()], "CAD", "all", false)
                .await
                .unwrap();
            assert_eq!(scope.incomplete_accounts.len(), 1);
            assert_eq!(scope.incomplete_accounts[0].account_id, first.id);
            let security = scope
                .holdings
                .iter()
                .find(|holding| holding.holding_type == HoldingType::Security)
                .unwrap();
            assert_eq!(security.quantity, dec!(1));
            assert_eq!(security.cost_basis, Some(money(dec!(80), dec!(80))));
            assert!(scope
                .holdings
                .iter()
                .all(|holding| holding.weight.is_none()));
            assert!(matches!(
                scope.require_complete(),
                Err(CoreError::HoldingsPending(_))
            ));
        }

        #[tokio::test]
        async fn failed_calculation_is_unavailable_until_retry_or_new_inputs() {
            let account = account("account", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            fixture.store.fail_next_persists(1);
            let report = coordinator
                .run_job(PortfolioJobRequest::default(), &SilentObserver)
                .await
                .unwrap();
            assert!(!report.failures.is_empty());
            let scope = holdings
                .get_holdings_scope(std::slice::from_ref(&account.id), "CAD", &account.id, false)
                .await
                .unwrap();
            assert_eq!(
                scope.incomplete_accounts[0].reason_code,
                "PROJECTION_FAILED"
            );
            assert_eq!(scope.incomplete_accounts[0].status, "unavailable");
            fixture
                .store
                .invalidate(MarkerScope::Account(account.id.clone()), GENESIS)
                .await
                .unwrap();
            assert_pending(&holdings, &account.id, "CAD").await;
            run(&coordinator).await;
            assert_eq!(holding(&holdings, &account.id).await.quantity, dec!(1));
        }

        #[tokio::test]
        async fn unsupported_account_is_unavailable_across_runs_and_recovers_after_edit() {
            let mut account = account("unsupported", "CAD", TrackingMode::Transactions);
            account.meta = Some(
                r#"{"accounting":{"costBasisMethod":"FIFO","costBasisProfile":"CANADA_ACB"}}"#
                    .into(),
            );
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            for _ in 0..2 {
                let report = coordinator
                    .run_job(PortfolioJobRequest::default(), &SilentObserver)
                    .await
                    .unwrap();
                assert!(report
                    .failures
                    .iter()
                    .any(|failure| failure.code == "UNSUPPORTED_COST_BASIS"));
                let scope = holdings
                    .get_holdings_scope(
                        std::slice::from_ref(&account.id),
                        "CAD",
                        &account.id,
                        false,
                    )
                    .await
                    .unwrap();
                assert_eq!(scope.incomplete_accounts[0].status, "unavailable");
                assert_eq!(
                    scope.incomplete_accounts[0].reason_code,
                    "UNSUPPORTED_COST_BASIS"
                );
            }
            account.meta = None;
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            assert_eq!(holding(&holdings, &account.id).await.quantity, dec!(1));
        }

        #[tokio::test]
        async fn asset_scope_keeps_per_account_rows_and_reports_pending_peer() {
            let first = account("first", "CAD", TrackingMode::Transactions);
            let second = account("second", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(
                vec![
                    buy(&first.id, "CAD", dec!(100)),
                    buy(&second.id, "CAD", dec!(80)),
                ],
                Vec::new(),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![first.clone(), second.clone()]);
            run(&coordinator).await;
            let ids = [first.id.clone(), second.id.clone()];
            let scope = holdings
                .get_asset_holdings_scope(&ids, ASSET_ID, "CAD")
                .await
                .unwrap();
            assert_eq!(
                fixture.store.holdings_read_count(),
                1,
                "the asset scope captures every account in one read"
            );
            assert_eq!(scope.holdings.len(), 2);
            assert!(scope
                .holdings
                .iter()
                .all(|holding| holding.quantity == dec!(1) && ids.contains(&holding.account_id)));
            fixture
                .store
                .invalidate(MarkerScope::Account(first.id.clone()), GENESIS)
                .await
                .unwrap();
            let scope = holdings
                .get_asset_holdings_scope(&ids, ASSET_ID, "CAD")
                .await
                .unwrap();
            assert_eq!(scope.holdings.len(), 1);
            assert_eq!(scope.holdings[0].account_id, second.id);
            assert_eq!(scope.incomplete_accounts[0].account_id, first.id);
            assert_eq!(scope.incomplete_accounts[0].status, "pending");
        }

        #[tokio::test]
        async fn asset_scope_excludes_archived_active_accounts_inside_the_capture() {
            let healthy = account("healthy", "CAD", TrackingMode::Transactions);
            let mut archived = account("archived", "CAD", TrackingMode::Transactions);
            archived.is_archived = true;
            let fixture = Fixture::new(
                vec![
                    buy(&healthy.id, "CAD", dec!(100)),
                    buy(&archived.id, "CAD", dec!(80)),
                ],
                Vec::new(),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) =
                fixture.services(vec![healthy.clone(), archived.clone()]);
            run(&coordinator).await;
            fixture
                .store
                .invalidate(MarkerScope::Account(archived.id.clone()), GENESIS)
                .await
                .unwrap();
            let scope = holdings
                .get_asset_holdings_scope(
                    &[healthy.id.clone(), archived.id.clone()],
                    ASSET_ID,
                    "CAD",
                )
                .await
                .unwrap();
            assert!(scope.incomplete_accounts.is_empty());
            assert_eq!(scope.holdings.len(), 1);
            assert_eq!(scope.holdings[0].account_id, healthy.id);
        }

        #[tokio::test]
        async fn asset_scope_ignores_unrelated_unsupported_accounts() {
            let healthy = account("healthy", "CAD", TrackingMode::Transactions);
            let mut unrelated = account("unrelated", "CAD", TrackingMode::Transactions);
            unrelated.meta = Some(
                r#"{"accounting":{"costBasisMethod":"FIFO","costBasisProfile":"CANADA_ACB"}}"#
                    .into(),
            );
            let mut other_buy = buy(&unrelated.id, "CAD", dec!(80));
            other_buy.asset_id = Some("another-asset".into());
            let fixture = Fixture::new(
                vec![buy(&healthy.id, "CAD", dec!(100)), other_buy],
                Vec::new(),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) =
                fixture.services(vec![healthy.clone(), unrelated.clone()]);
            coordinator
                .run_job(PortfolioJobRequest::default(), &SilentObserver)
                .await
                .unwrap();
            let scope = holdings
                .get_asset_holdings_scope(
                    &[healthy.id.clone(), unrelated.id.clone()],
                    ASSET_ID,
                    "CAD",
                )
                .await
                .unwrap();
            assert!(scope.incomplete_accounts.is_empty());
            assert_eq!(scope.require_complete().unwrap()[0].account_id, healthy.id);
        }

        #[tokio::test]
        async fn asset_scope_includes_snapshot_only_positions_without_activities() {
            let account = account("observed", "CAD", TrackingMode::Holdings);
            let fixture = Fixture::new(Vec::new(), Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (_, holdings, snapshots) = fixture.services(vec![account.clone()]);
            fixture.save_holding(&snapshots, &account, dec!(100)).await;
            let scope = holdings
                .get_asset_holdings_scope(std::slice::from_ref(&account.id), ASSET_ID, "CAD")
                .await
                .unwrap();
            assert_eq!(scope.require_complete().unwrap()[0].quantity, dec!(1));
        }

        #[tokio::test]
        async fn quote_updates_and_failed_revaluation_preserve_current_accounting() {
            let account = account("transaction", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            fixture.quotes.add_quotes(vec![crate::quotes::Quote {
                id: "updated-close".into(),
                asset_id: ASSET_ID.into(),
                timestamp: fixture.now,
                close: dec!(120),
                currency: "CAD".into(),
                ..Default::default()
            }]);
            fixture
                .store
                .invalidate(
                    MarkerScope::Prices(ASSET_ID.into()),
                    fixture.now.date_naive(),
                )
                .await
                .unwrap();
            for failed in [false, true] {
                if failed {
                    fixture.store.fail_next_completion();
                    coordinator
                        .run_job(PortfolioJobRequest::default(), &SilentObserver)
                        .await
                        .unwrap();
                }
                let scope = holdings
                    .get_holdings_scope(
                        std::slice::from_ref(&account.id),
                        "CAD",
                        &account.id,
                        false,
                    )
                    .await
                    .unwrap();
                assert!(
                    scope.incomplete_accounts.is_empty(),
                    "quote-only changes do not invalidate accounting: {failed}"
                );
                let row = scope
                    .require_complete()
                    .unwrap()
                    .into_iter()
                    .find(|row| row.instrument.is_some())
                    .unwrap();
                assert_eq!(row.quantity, dec!(1));
                assert_eq!(row.cost_basis, Some(money(dec!(100), dec!(100))));
                assert_eq!(row.market_value, money(dec!(120), dec!(120)));
                assert!(fixture
                    .store
                    .pending_markers()
                    .unwrap()
                    .iter()
                    .all(|marker| !matches!(marker.scope, MarkerScope::Account(_))));
            }
        }

        #[test]
        fn asset_scope_does_not_certify_unknown_positions_as_unrelated() {
            let read = HoldingsRead {
                unavailable_accounts: HashSet::from(["corrupt".into()]),
                accounts_with_open_lots: HashSet::from(["missing-snapshot".into()]),
                ..Default::default()
            };
            assert!(read.could_hold_asset("corrupt", ASSET_ID));
            assert!(read.could_hold_asset("missing-snapshot", ASSET_ID));
            assert!(!read.could_hold_asset("unrelated", ASSET_ID));
        }

        #[test]
        fn issue_2487_readiness_tracks_transfers_closed_assets_and_global_dependencies() {
            let day = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
            let mut rows = Vec::new();
            for (account, group) in [
                ("first", "transfer-1"),
                ("second", "transfer-1"),
                ("second", "transfer-2"),
                ("third", "transfer-2"),
            ] {
                let mut activity = buy(account, "CAD", dec!(1));
                activity.source_group_id = Some(group.into());
                rows.push(activity);
            }
            let mut read = HoldingsRead {
                day,
                activities: rows,
                ..Default::default()
            };
            assert!(read.could_hold_asset("third", ASSET_ID));
            assert!(!read.could_hold_asset("third", "unrelated"));
            for scope in [
                MarkerScope::All,
                MarkerScope::Fx("USD/CAD".into()),
                MarkerScope::Account("third".into()),
                MarkerScope::Asset(ASSET_ID.into()),
            ] {
                read.markers = vec![crate::portfolio::projection::ProjectionMarker {
                    scope,
                    dirty_from: day,
                    version: 1,
                }];
                assert!(read.history_pending("first", day));
            }
            read.markers = vec![crate::portfolio::projection::ProjectionMarker {
                scope: MarkerScope::Prices(ASSET_ID.into()),
                dirty_from: day,
                version: 1,
            }];
            assert!(!read.history_pending("first", day));
            read.markers = vec![crate::portfolio::projection::ProjectionMarker {
                scope: MarkerScope::Account("unrelated".into()),
                dirty_from: day,
                version: 1,
            }];
            assert!(!read.history_pending("first", day));
            read.accounts
                .push(account("first", "CAD", TrackingMode::Holdings));
            read.markers[0].scope = MarkerScope::All;
            assert!(
                !read.position_pending("first", day),
                "observed positions remain immediately readable"
            );
            assert!(
                read.history_pending("first", day),
                "realized history must wait for the same dependencies"
            );
        }

        #[tokio::test]
        async fn issue_2487_day_advance_without_markers_refolds_future_buy_and_income() {
            let account = account("cad-account", "CAD", TrackingMode::Transactions);
            let mut future_buy = buy(&account.id, "CAD", dec!(40));
            future_buy.id = "future-buy".into();
            future_buy.activity_date = "2025-01-16T12:00:00Z".parse().unwrap();
            let future_income = test_income_activity(
                "future-income",
                &account.id,
                Some(ASSET_ID),
                ACTIVITY_TYPE_DIVIDEND,
                dec!(7),
                "CAD",
                future_buy.activity_date.date_naive(),
            );
            let fixture = Fixture::new(
                vec![
                    buy(&account.id, "CAD", dec!(100)),
                    future_buy,
                    future_income,
                ],
                Vec::new(),
            );
            let clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            assert_eq!(holding(&holdings, &account.id).await.quantity, dec!(1));
            assert!(fixture.store.pending_markers().unwrap().is_empty());
            drop(clock);
            let _clock = crate::utils::clock::freeze(fixture.now + chrono::Duration::days(1));
            assert!(matches!(
                holdings.get_holdings(&account.id, "CAD").await,
                Err(CoreError::HoldingsPending(_))
            ));
            run(&coordinator).await;
            let result = holding(&holdings, &account.id).await;
            assert_eq!(result.quantity, dec!(2));
            assert_eq!(result.cost_basis, Some(money(dec!(140), dec!(140))));
            assert_eq!(result.income, Some(money(dec!(7), dec!(7))));
            assert!(fixture.store.pending_markers().unwrap().is_empty());
        }

        #[tokio::test]
        async fn unchanged_transaction_accounts_remain_readable_across_midnight() {
            let account = account("unchanged", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            drop(clock);
            let _clock = crate::utils::clock::freeze(fixture.now + chrono::Duration::days(1));
            let rows = holdings.get_holdings(&account.id, "CAD").await.unwrap();
            let row = rows.iter().find(|row| row.instrument.is_some()).unwrap();
            assert_eq!(row.quantity, dec!(1));
            assert_eq!(row.cost_basis, Some(money(dec!(100), dec!(100))));
            assert!(fixture.store.pending_markers().unwrap().is_empty());
        }

        async fn assert_non_effective_account_does_not_block_holdings(future: bool) {
            let healthy = account("healthy", "CAD", TrackingMode::Transactions);
            let empty = account("not-effective", "CAD", TrackingMode::Transactions);
            let mut activity = buy(&empty.id, "CAD", dec!(100));
            if future {
                activity.activity_date = "2025-01-16T12:00:00Z".parse().unwrap();
            } else {
                activity.status = crate::activities::ActivityStatus::Draft;
            }
            let fixture = Fixture::new(
                vec![buy(&healthy.id, "CAD", dec!(100)), activity],
                Vec::new(),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(vec![healthy.clone(), empty.clone()]);
            run(&coordinator).await;
            let scope = holdings
                .get_holdings_scope(&[healthy.id.clone(), empty.id.clone()], "CAD", "all", false)
                .await
                .unwrap();
            assert!(
                scope.incomplete_accounts.is_empty(),
                "non-effective activity is not pending accounting"
            );
            assert!(!scope.holdings.is_empty());
            assert!(scope
                .holdings
                .iter()
                .all(|holding| holding.weight.is_some()));
            assert!(holdings
                .get_holdings(&empty.id, "CAD")
                .await
                .unwrap()
                .iter()
                .all(|holding| holding.quantity.is_zero()));
        }

        #[tokio::test]
        async fn draft_only_transaction_account_does_not_block_healthy_holdings() {
            assert_non_effective_account_does_not_block_holdings(false).await;
        }

        #[tokio::test]
        async fn future_only_transaction_account_does_not_block_healthy_holdings() {
            assert_non_effective_account_does_not_block_holdings(true).await;
        }

        #[test]
        fn never_valued_read_requires_effective_accounting_inputs_to_be_pending() {
            let day = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
            let account = account("never-valued", "CAD", TrackingMode::Transactions);
            let mut activity = buy(&account.id, "CAD", dec!(100));
            activity.status = crate::activities::ActivityStatus::Draft;
            let mut read = HoldingsRead {
                day,
                timezone: "UTC".into(),
                accounts: vec![account.clone()],
                activities: vec![activity],
                ..Default::default()
            };
            assert!(!read.position_pending(&account.id, day));
            read.activities[0].status = crate::activities::ActivityStatus::Posted;
            read.activities[0].activity_date = "2025-01-16T12:00:00Z".parse().unwrap();
            assert!(!read.position_pending(&account.id, day));
            read.activities[0].activity_date = "2025-01-15T12:00:00Z".parse().unwrap();
            assert!(read.position_pending(&account.id, day));
            read.issues
                .push(crate::portfolio::projection::ActivityIssue {
                    activity_id: read.activities[0].id.clone(),
                    kind: crate::portfolio::projection::ActivityIssueKind::Rejected,
                    message: "Rejected input".into(),
                    reason: None,
                });
            assert!(!read.position_pending(&account.id, day));
        }

        #[test]
        fn day_readiness_uses_posted_local_dates_and_shared_splits() {
            let day = NaiveDate::from_ymd_opt(2025, 1, 16).unwrap();
            let mut due = buy("first", "CAD", dec!(100));
            due.activity_date = "2025-01-17T00:30:00Z".parse().unwrap();
            let mut read = HoldingsRead {
                timezone: "America/New_York".into(),
                last_valued: HashMap::from([("first".into(), day.pred_opt().unwrap())]),
                activities: vec![buy("first", "CAD", dec!(100)), due],
                ..Default::default()
            };
            assert!(read.day_advance_pending("first", day));
            read.activities[1].status = crate::activities::ActivityStatus::Draft;
            assert!(!read.day_advance_pending("first", day));
            read.activities[1].status = crate::activities::ActivityStatus::Posted;
            read.activities[1].account_id = "another-account".into();
            assert!(!read.day_advance_pending("first", day));
            read.activities[1].activity_type = crate::activities::ACTIVITY_TYPE_SPLIT.into();
            assert!(read.day_advance_pending("first", day));
            read.activities[1].asset_id = Some("unrelated".into());
            assert!(!read.day_advance_pending("first", day));
        }

        #[tokio::test]
        async fn issue_2487_observed_account_without_observation_ignores_retained_lots() {
            let mut account = account("cad-account", "CAD", TrackingMode::Transactions);
            let fixture = Fixture::new(vec![buy(&account.id, "CAD", dec!(100))], Vec::new());
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, _, _) = fixture.services(vec![account.clone()]);
            run(&coordinator).await;
            assert!(!fixture
                .lots
                .get_open_lots_for_account(&account.id)
                .await
                .unwrap()
                .is_empty());
            account.tracking_mode = TrackingMode::Holdings;
            let (_, holdings, _) = fixture.services(vec![account.clone()]);
            let scope = holdings
                .get_holdings_scope(&[account.id.clone()], "CAD", &account.id, false)
                .await
                .unwrap();
            assert!(scope.incomplete_accounts.is_empty());
            assert!(scope.holdings.is_empty());
        }

        #[tokio::test]
        async fn issue_2487_live_fx_keeps_direct_observation_precedence() {
            let mut outcomes = Vec::new();
            for reverse in [false, true] {
                let account = account("cad-account", "CAD", TrackingMode::Transactions);
                let mut rates = vec![
                    rate("USD", "CAD", "2025-01-02", dec!(2)),
                    rate("CAD", "USD", "2025-01-02", dec!(0.4)),
                ];
                if reverse {
                    rates.reverse();
                }
                let fixture = Fixture::with_quote(
                    vec![buy(&account.id, "USD", dec!(100))],
                    rates,
                    "USD",
                    dec!(110),
                );
                let _clock = crate::utils::clock::freeze(fixture.now);
                let (coordinator, holdings, _) = fixture.services(vec![account.clone()]);
                run(&coordinator).await;
                assert_eq!(
                    fixture.lot_cost(&account.id).await,
                    dec!(200),
                    "the captured fold prefers the direct USD/CAD row"
                );
                for holding in both_reads(&holdings, &account.id, "CAD").await {
                    outcomes.push(holding.unrealized_gain.unwrap().base.unwrap());
                }
            }
            assert_eq!(outcomes, vec![dec!(20); 4],
                "live valuation must apply the same direct-over-derived rate rule as its historical calculation");
        }
    }

    #[tokio::test]
    async fn holdings_history_reads_run_off_the_async_worker() {
        let worker = std::thread::current().id();
        let frozen = "2025-01-15T12:00:00Z".parse().unwrap();
        let _clock = crate::utils::clock::freeze(frozen);
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let disposal = test_lot_disposal(
            account_id,
            asset_id,
            dec!(100),
            dec!(100),
            dec!(20),
            dec!(20),
        );
        let activity = test_income_activity(
            &disposal.disposal_activity_id,
            account_id,
            Some(asset_id),
            ACTIVITY_TYPE_SELL,
            dec!(120),
            "USD",
            frozen.date_naive(),
        );
        let mut activities = MockActivityRepository::new(vec![activity]);
        activities.async_worker_thread = Some(worker);
        let mut lots = MockLotRepository::new(vec![test_lot_record(
            account_id,
            asset_id,
            "USD",
            dec!(100),
        )])
        .with_disposals(vec![disposal]);
        lots.async_worker_thread = Some(worker);
        let mut income = MockHoldingIncomeService::new(HashMap::from([(
            account_id.to_string(),
            HashMap::from([(asset_id.to_string(), MonetaryValue::new(dec!(5), dec!(5)))]),
        )]));
        income.async_worker_thread = Some(worker);
        let scopes = income.scopes();
        let service = test_service(
            AccountStateSnapshot {
                account_id: account_id.into(),
                currency: "USD".into(),
                positions: HashMap::from([(asset_id.into(), test_position(account_id, asset_id))]),
                ..Default::default()
            },
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.into(), dec!(130))]),
        )
        .with_lot_repository(Arc::new(lots))
        .with_income_service(Arc::new(income));
        // The production wiring installs this alongside the income service.
        let mut service = service;
        service.activity_repository = Some(Arc::new(activities));
        let holdings = service.get_holdings(account_id, "USD").await.unwrap();
        let holding = service
            .get_holding(account_id, asset_id, "USD")
            .await
            .unwrap()
            .unwrap();
        for holding in [&holdings[0], &holding] {
            assert_eq!(holding.as_of_date, frozen.date_naive());
            assert_eq!(holding.income.as_ref().unwrap().base.unwrap(), dec!(5));
            assert_eq!(
                holding.realized_gain.as_ref().unwrap().base.unwrap(),
                dec!(20)
            );
            assert_eq!(
                holding.cost_basis.as_ref().unwrap().base.unwrap(),
                dec!(100)
            );
        }
        assert_eq!(scopes.lock().unwrap().len(), 2);
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
        assert_eq!(holdings[0].weight, Some(dec!(1)));

        let holding = service
            .get_holding(account_id, active_asset_id, "USD")
            .await
            .unwrap()
            .expect("active holding should exist");
        assert_eq!(holding.weight, Some(dec!(1)));
    }

    #[tokio::test]
    async fn get_holdings_includes_closed_positions_only_when_requested() {
        let account_id = "acc-1";
        let active_asset_id = "AAPL";
        let closed_asset_id = "MSFT";
        let mut closed_position = test_position(account_id, closed_asset_id);
        closed_position.quantity = Decimal::ZERO;
        closed_position.average_cost = Decimal::ZERO;
        closed_position.total_cost_basis = Decimal::ZERO;

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([
                (
                    active_asset_id.to_string(),
                    test_position(account_id, active_asset_id),
                ),
                (closed_asset_id.to_string(), closed_position),
            ]),
            ..Default::default()
        };
        let service = test_service(
            snapshot,
            vec![
                test_asset(active_asset_id, active_asset_id, InstrumentType::Equity),
                test_asset(closed_asset_id, closed_asset_id, InstrumentType::Equity),
            ],
            HashMap::from([
                (active_asset_id.to_string(), dec!(100)),
                (closed_asset_id.to_string(), Decimal::ZERO),
            ]),
        )
        .with_lot_repository(Arc::new(MockLotRepository::new(Vec::new()).with_disposals(
            vec![test_lot_disposal(
                account_id,
                closed_asset_id,
                dec!(100),
                dec!(100),
                dec!(25),
                dec!(25),
            )],
        )));

        let current_holdings = service.get_holdings(account_id, "USD").await.unwrap();
        assert_eq!(current_holdings.len(), 1);
        assert_eq!(
            current_holdings[0].instrument.as_ref().unwrap().id,
            active_asset_id
        );

        let holdings_with_closed = service
            .get_holdings_with_options(account_id, "USD", true)
            .await
            .unwrap();
        assert_eq!(holdings_with_closed.len(), 2);
        let closed_holding = holdings_with_closed
            .iter()
            .find(|holding| holding.instrument.as_ref().unwrap().id == closed_asset_id)
            .expect("closed holding should be included");
        assert!(closed_holding.is_closed);
        assert_eq!(closed_holding.quantity, Decimal::ZERO);
        assert_eq!(closed_holding.market_value.base.unwrap(), Decimal::ZERO);
        assert_eq!(closed_holding.weight, Some(Decimal::ZERO));
        assert_eq!(
            closed_holding.realized_gain.as_ref().unwrap().base.unwrap(),
            dec!(25)
        );
        assert_eq!(
            closed_holding.total_gain.as_ref().unwrap().base.unwrap(),
            dec!(25)
        );
        assert_eq!(closed_holding.total_gain_pct, Some(dec!(0.25)));
        assert_eq!(
            closed_holding.total_return.as_ref().unwrap().base.unwrap(),
            dec!(25)
        );
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

        assert_eq!(long.weight, Some(dec!(0.5)));
        assert_eq!(short.weight, Some(dec!(-0.5)));
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
    async fn get_holdings_uses_snapshot_base_cost_without_loading_lots() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.average_cost = dec!(1000);
        position.total_cost_basis = dec!(1000);
        position.cost_basis_base = Some(dec!(900));

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            base_currency: Some("EUR".into()),
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

        assert_eq!(open_lots_calls.load(Ordering::SeqCst), 0);
        assert_eq!(holdings.len(), 1);
        assert_eq!(
            holdings[0].cost_basis.as_ref().unwrap().base.unwrap(),
            dec!(900)
        );
    }

    #[tokio::test]
    async fn get_holdings_keeps_snapshot_basis_when_lot_currencies_disagree() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.average_cost = dec!(1000);
        position.total_cost_basis = dec!(1000);
        position.cost_basis_base = Some(dec!(900));

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            base_currency: Some("EUR".into()),
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
        assert_eq!(
            holdings[0].cost_basis.as_ref().unwrap().base.unwrap(),
            dec!(900)
        );
    }

    #[tokio::test]
    async fn get_holdings_keeps_snapshot_basis_when_lot_cost_is_invalid() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.average_cost = dec!(1000);
        position.total_cost_basis = dec!(1000);
        position.cost_basis_base = Some(dec!(900));

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            base_currency: Some("EUR".into()),
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
        assert_eq!(
            holdings[0].cost_basis.as_ref().unwrap().base.unwrap(),
            dec!(900)
        );
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

        positions.get_mut(asset_id).unwrap().cost_basis_base = Some(dec!(1000));
        positions.get_mut(other_asset_id).unwrap().cost_basis_base = Some(dec!(2000));
        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            base_currency: Some("EUR".into()),
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
        // Only requested detail reads lots. Summary basis comes from its snapshot.
        assert_eq!(open_lots_for_asset_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            holding.cost_basis.as_ref().unwrap().base.unwrap(),
            dec!(1000)
        );
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
        assert_eq!(holdings[0].cost_basis.as_ref().unwrap().base, None);
        assert_eq!(
            holdings[0].cost_basis.as_ref().unwrap().local,
            Some(dec!(1000))
        );
        assert_eq!(open_lots_calls.load(Ordering::SeqCst), 0);
        assert_eq!(open_lots_for_asset_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn get_holding_sources_display_lots_from_lots_table_when_snapshot_has_no_embedded_lots() {
        let account_id = "acc-1";
        let asset_id = "AAPL";

        // STEP 2 shape: the snapshot position carries NO embedded lots.
        let position = test_position(account_id, asset_id);
        assert!(
            position.lots.is_empty(),
            "precondition: snapshot position must have no embedded lots"
        );

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };

        // The normalized lots table holds the current open lot.
        let lot_repository = MockLotRepository::new(vec![test_lot_record(
            account_id,
            asset_id,
            "USD",
            dec!(100),
        )]);
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(150))]),
        )
        .with_lot_repository(Arc::new(lot_repository));

        let holding = service
            .get_holding(account_id, asset_id, "USD")
            .await
            .unwrap()
            .expect("holding should exist");

        let lots = holding
            .lots
            .expect("display lots should be sourced from the lots table");
        assert_eq!(lots.len(), 1);
        assert_eq!(lots[0].id, format!("LOT-{asset_id}-USD"));
        assert_eq!(lots[0].quantity, dec!(1));
        assert_eq!(lots[0].cost_basis, dec!(100));
        assert_eq!(lots[0].acquisition_price, dec!(100));
        assert_eq!(lots[0].source_activity_id.as_deref(), Some("ACT-AAPL"));
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
            &HashSet::new(),
            &asset_currencies,
            "USD",
            &fx_service,
            chrono_tz::UTC,
        );

        assert_eq!(income_by_asset.len(), 1);
        let income = income_by_asset.get("AAPL").unwrap();
        assert_eq!(income.local.unwrap(), dec!(15));
        assert_eq!(income.base.unwrap(), dec!(11));
    }

    #[test]
    fn asset_income_counts_returns_of_capital_and_notional_distributions_as_the_engine_does() {
        // Engine rules R7.4: a dividend of capital is no income; a return of
        // capital adjustment takes dividends back out; a notional distribution
        // is income.
        let date = NaiveDate::from_ymd_opt(2025, 2, 3).unwrap();
        let fx_service = MockFxService::new(vec![]);
        let asset_currencies = HashMap::from([("XEQT".to_string(), "CAD".to_string())]);
        let activity = |id: &str, activity_type: &str, subtype: Option<&str>, amount| {
            let mut activity = test_income_activity(
                id,
                "acc-1",
                Some("XEQT"),
                activity_type,
                amount,
                "CAD",
                date,
            );
            activity.subtype = subtype.map(str::to_string);
            activity
        };
        let activities = vec![
            activity("dividend", ACTIVITY_TYPE_DIVIDEND, None, dec!(100)),
            activity(
                "capital",
                ACTIVITY_TYPE_DIVIDEND,
                Some("Return of Capital"),
                dec!(40),
            ),
            activity(
                "reclassified",
                ACTIVITY_TYPE_ADJUSTMENT,
                Some("return-of-capital"),
                dec!(25),
            ),
            activity(
                "notional",
                ACTIVITY_TYPE_ADJUSTMENT,
                Some("Notional Distribution"),
                dec!(10),
            ),
            activity(
                "expiry",
                ACTIVITY_TYPE_ADJUSTMENT,
                Some("OPTION_EXPIRY"),
                dec!(7),
            ),
        ];

        let income_by_asset = calculate_asset_income(
            &activities,
            &HashSet::new(),
            &asset_currencies,
            "CAD",
            &fx_service,
            chrono_tz::UTC,
        );

        let income = income_by_asset.get("XEQT").unwrap();
        assert_eq!(income.local.unwrap(), dec!(85));
        assert_eq!(income.base.unwrap(), dec!(85));
    }

    #[test]
    fn asset_income_leaves_out_what_the_engine_rejected() {
        // A notional distribution dated before the first purchase finds no
        // units: the engine rejects it, so it is no income.
        let date = NaiveDate::from_ymd_opt(2025, 2, 3).unwrap();
        let fx_service = MockFxService::new(vec![]);
        let asset_currencies = HashMap::from([("XEQT".to_string(), "CAD".to_string())]);
        let mut notional = test_income_activity(
            "notional",
            "acc-1",
            Some("XEQT"),
            ACTIVITY_TYPE_ADJUSTMENT,
            dec!(10),
            "CAD",
            date,
        );
        notional.subtype = Some(ACTIVITY_SUBTYPE_NOTIONAL_DISTRIBUTION.to_string());
        let activities = vec![
            notional,
            test_income_activity(
                "dividend",
                "acc-1",
                Some("XEQT"),
                ACTIVITY_TYPE_DIVIDEND,
                dec!(100),
                "CAD",
                date,
            ),
        ];

        let income_by_asset = calculate_asset_income(
            &activities,
            &HashSet::from(["notional".to_string()]),
            &asset_currencies,
            "CAD",
            &fx_service,
            chrono_tz::UTC,
        );

        let income = income_by_asset.get("XEQT").unwrap();
        assert_eq!(income.local.unwrap(), dec!(100));
        assert_eq!(income.base.unwrap(), dec!(100));
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
            &HashSet::new(),
            &asset_currencies,
            "USD",
            &fx_service,
            chrono_tz::America::Toronto,
        );

        let income = income_by_asset.get("AAPL").unwrap();
        assert_eq!(income.local.unwrap(), dec!(15));
        assert_eq!(income.base.unwrap(), dec!(11));
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
            &HashSet::new(),
            &asset_currencies,
            "GBP",
            &fx_service,
            chrono_tz::UTC,
        );

        let income = income_by_asset.get("LSE").unwrap();
        assert_eq!(income.local.unwrap(), dec!(1000));
        assert_eq!(income.base.unwrap(), dec!(10));
    }

    #[tokio::test]
    async fn single_holding_percentages_use_local_values_when_fx_changes() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.total_cost_basis = dec!(100);
        position.cost_basis_base = Some(dec!(50));

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            base_currency: Some("EUR".into()),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let mut lot_repository =
            MockLotRepository::new(vec![test_lot_record(account_id, asset_id, "USD", dec!(50))])
                .with_disposals(vec![test_lot_disposal(
                    account_id,
                    asset_id,
                    dec!(50),
                    dec!(20),
                    dec!(20),
                    dec!(10),
                )]);
        for disposal in &mut lot_repository.disposals {
            disposal.base_currency = "EUR".into();
        }
        let income_service = MockHoldingIncomeService::new(HashMap::from([(
            account_id.to_string(),
            HashMap::from([(asset_id.to_string(), MonetaryValue::new(dec!(5), dec!(2)))]),
        )]));
        let scopes = income_service.scopes();
        let service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), dec!(130))]),
        )
        .with_lot_repository(Arc::new(lot_repository))
        .with_income_service(Arc::new(income_service));

        let holdings = service.get_holdings(account_id, "EUR").await.unwrap();

        assert_eq!(*scopes.lock().unwrap(), vec![vec![account_id.to_string()]]);
        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert_eq!(
            holding.unrealized_gain.as_ref().unwrap().local.unwrap(),
            dec!(30)
        );
        assert_eq!(
            holding.unrealized_gain.as_ref().unwrap().base.unwrap(),
            dec!(80)
        );
        assert_eq!(holding.unrealized_gain_pct, Some(dec!(0.3)));
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().local.unwrap(),
            dec!(20)
        );
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().base.unwrap(),
            dec!(10)
        );
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.4)));
        assert_eq!(
            holding.total_gain.as_ref().unwrap().local.unwrap(),
            dec!(50)
        );
        assert_eq!(holding.total_gain.as_ref().unwrap().base.unwrap(), dec!(90));
        assert_eq!(holding.income.as_ref().unwrap().local.unwrap(), dec!(5));
        assert_eq!(holding.income.as_ref().unwrap().base.unwrap(), dec!(2));
        assert_eq!(
            holding.total_return.as_ref().unwrap().local.unwrap(),
            dec!(55)
        );
        assert_eq!(
            holding.total_return.as_ref().unwrap().base.unwrap(),
            dec!(92)
        );
        assert_eq!(
            holding.return_basis.as_ref().unwrap().local.unwrap(),
            dec!(150)
        );
        assert_eq!(
            holding.return_basis.as_ref().unwrap().base.unwrap(),
            dec!(70)
        );
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
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().base.unwrap(),
            dec!(30)
        );
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.4)));
        assert_eq!(
            holding.return_basis.as_ref().unwrap().base.unwrap(),
            dec!(175)
        );
        assert_eq!(holding.total_gain.as_ref().unwrap().base.unwrap(), dec!(60));
        assert_eq!(holding.total_gain_pct, Some(dec!(0.34285714)));
    }

    #[tokio::test]
    async fn closed_option_realized_gain_includes_option_expiry_disposal() {
        let account_id = "acc-1";
        let asset_id = "AAPL260821C00200000";
        let mut position = test_position(account_id, asset_id);
        position.quantity = Decimal::ZERO;
        position.average_cost = Decimal::ZERO;
        position.total_cost_basis = Decimal::ZERO;

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };

        let mut expiry_disposal = test_lot_disposal(
            account_id,
            asset_id,
            dec!(100),
            dec!(100),
            dec!(-100),
            dec!(-100),
        );
        expiry_disposal.id = "expiry-disposal".to_string();
        expiry_disposal.disposal_activity_id = "expiry-1".to_string();

        let activity_date = NaiveDate::from_ymd_opt(2026, 8, 21).unwrap();
        let mut expiry_activity = test_income_activity(
            "expiry-1",
            account_id,
            Some(asset_id),
            ACTIVITY_TYPE_ADJUSTMENT,
            Decimal::ZERO,
            "USD",
            activity_date,
        );
        expiry_activity.subtype = Some(ACTIVITY_SUBTYPE_OPTION_EXPIRY.to_string());

        let mut service = test_service(
            snapshot,
            vec![test_asset(asset_id, asset_id, InstrumentType::Option)],
            HashMap::from([(asset_id.to_string(), Decimal::ZERO)]),
        )
        .with_lot_repository(Arc::new(
            MockLotRepository::new(Vec::new()).with_disposals(vec![expiry_disposal]),
        ));
        service.activity_repository =
            Some(Arc::new(MockActivityRepository::new(vec![expiry_activity])));

        let holdings = service
            .get_holdings_with_options(account_id, "USD", true)
            .await
            .unwrap();

        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert!(holding.is_closed);
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().base.unwrap(),
            dec!(-100)
        );
        assert_eq!(holding.realized_gain_pct, Some(dec!(-1)));
        assert_eq!(
            holding.total_gain.as_ref().unwrap().base.unwrap(),
            dec!(-100)
        );
    }

    #[tokio::test]
    async fn closed_short_realized_gain_includes_transfer_in_cover_disposal() {
        let account_id = "acc-1";
        let asset_id = "AAPL";
        let mut position = test_position(account_id, asset_id);
        position.quantity = Decimal::ZERO;
        position.average_cost = Decimal::ZERO;
        position.total_cost_basis = Decimal::ZERO;

        let snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };

        // A short of 10 sold at 150, covered by 10 units transferred in at
        // their cost of 100: the engine realizes 500 on the transfer.
        let mut cover_disposal = test_lot_disposal(
            account_id,
            asset_id,
            dec!(-1500),
            dec!(-1500),
            dec!(500),
            dec!(500),
        );
        cover_disposal.id = "cover-disposal".to_string();
        cover_disposal.disposal_activity_id = "transfer-in-1".to_string();

        let transfer_in_activity = test_income_activity(
            "transfer-in-1",
            account_id,
            Some(asset_id),
            ACTIVITY_TYPE_TRANSFER_IN,
            Decimal::ZERO,
            "USD",
            NaiveDate::from_ymd_opt(2025, 2, 3).unwrap(),
        );

        let mut service = test_service(
            snapshot,
            vec![test_asset(asset_id, "AAPL", InstrumentType::Equity)],
            HashMap::from([(asset_id.to_string(), Decimal::ZERO)]),
        )
        .with_lot_repository(Arc::new(
            MockLotRepository::new(Vec::new()).with_disposals(vec![cover_disposal]),
        ));
        service.activity_repository = Some(Arc::new(MockActivityRepository::new(vec![
            transfer_in_activity,
        ])));

        let holdings = service
            .get_holdings_with_options(account_id, "USD", true)
            .await
            .unwrap();

        assert_eq!(holdings.len(), 1);
        let holding = &holdings[0];
        assert!(holding.is_closed);
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().local.unwrap(),
            dec!(500)
        );
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().base.unwrap(),
            dec!(500)
        );
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.33333333)));
        assert_eq!(
            holding.return_basis.as_ref().unwrap().local.unwrap(),
            dec!(-1500)
        );
        assert_eq!(
            holding.total_gain.as_ref().unwrap().base.unwrap(),
            dec!(500)
        );
        assert_eq!(holding.total_gain_pct, Some(dec!(0.33333333)));
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
        assert_eq!(
            holding.cost_basis.as_ref().unwrap().base.unwrap(),
            dec!(-500)
        );
        assert_eq!(
            holding.unrealized_gain.as_ref().unwrap().base.unwrap(),
            dec!(50)
        );
        assert_eq!(holding.unrealized_gain_pct, Some(dec!(0.1)));
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().base.unwrap(),
            dec!(100)
        );
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.2)));
        assert_eq!(
            holding.return_basis.as_ref().unwrap().base.unwrap(),
            dec!(-1000)
        );
        assert_eq!(
            holding.total_gain.as_ref().unwrap().base.unwrap(),
            dec!(150)
        );
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

        assert!(
            service.get_holdings(account_id, "USD").await.is_err(),
            "unreadable history must not become a successful zero-gain response"
        );
    }

    #[tokio::test]
    async fn multi_account_aggregation_sums_income_and_recomputes_return_percentages() {
        let asset_id = "AAPL";
        let account_one = "acc-1";
        let account_two = "acc-2";
        let mut position = test_position(account_one, asset_id);
        position.total_cost_basis = dec!(100);
        position.cost_basis_base = Some(dec!(50));

        let snapshot = AccountStateSnapshot {
            account_id: account_one.to_string(),
            currency: "USD".to_string(),
            base_currency: Some("EUR".into()),
            positions: HashMap::from([(asset_id.to_string(), position)]),
            ..Default::default()
        };
        let mut lot_repository = MockLotRepository::new(vec![
            test_lot_record(account_one, asset_id, "USD", dec!(50)),
            test_lot_record(account_two, asset_id, "USD", dec!(50)),
        ])
        .with_disposals(vec![
            test_lot_disposal(account_one, asset_id, dec!(40), dec!(20), dec!(4), dec!(2)),
            test_lot_disposal(account_two, asset_id, dec!(60), dec!(30), dec!(18), dec!(9)),
        ]);
        for disposal in &mut lot_repository.disposals {
            disposal.base_currency = "EUR".into();
        }
        let income_service = MockHoldingIncomeService::new(HashMap::from([
            (
                account_one.to_string(),
                HashMap::from([(asset_id.to_string(), MonetaryValue::new(dec!(5), dec!(2)))]),
            ),
            (
                account_two.to_string(),
                HashMap::from([(asset_id.to_string(), MonetaryValue::new(dec!(7), dec!(3)))]),
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
                "EUR",
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
        assert_eq!(holding.income.as_ref().unwrap().local.unwrap(), dec!(12));
        assert!(
            (holding.income.as_ref().unwrap().base.unwrap() - dec!(5)).abs() < dec!(0.00000001)
        );
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().local.unwrap(),
            dec!(22)
        );
        assert_eq!(
            holding.realized_gain.as_ref().unwrap().base.unwrap(),
            dec!(11)
        );
        assert_eq!(holding.realized_gain_pct, Some(dec!(0.22)));
        assert_eq!(
            holding.total_gain.as_ref().unwrap().local.unwrap(),
            dec!(42)
        );
        assert_eq!(
            holding.total_gain.as_ref().unwrap().base.unwrap(),
            dec!(131)
        );
        assert_eq!(
            holding.total_return.as_ref().unwrap().local.unwrap(),
            dec!(54)
        );
        assert!(
            (holding.total_return.as_ref().unwrap().base.unwrap() - dec!(136)).abs()
                < dec!(0.00000001)
        );
        assert_eq!(
            holding.return_basis.as_ref().unwrap().local.unwrap(),
            dec!(300)
        );
        assert_eq!(
            holding.return_basis.as_ref().unwrap().base.unwrap(),
            dec!(150)
        );
        assert_eq!(holding.total_gain_pct, Some(dec!(0.14)));
        assert_eq!(holding.total_return_pct, Some(dec!(0.18)));
    }

    #[tokio::test]
    async fn multi_account_aggregation_keeps_open_and_closed_positions_separate() {
        let asset_id = "AAPL";
        let long_account = "long";
        let short_account = "short";
        let closed_account = "closed";

        let mut long_position = test_position(long_account, asset_id);
        long_position.quantity = dec!(5);
        let mut short_position = test_position(short_account, asset_id);
        short_position.quantity = dec!(-5);
        let mut closed_position = test_position(closed_account, asset_id);
        closed_position.quantity = Decimal::ZERO;
        closed_position.average_cost = Decimal::ZERO;
        closed_position.total_cost_basis = Decimal::ZERO;

        let snapshots_by_account = HashMap::from([
            (
                long_account.to_string(),
                AccountStateSnapshot {
                    account_id: long_account.to_string(),
                    currency: "USD".to_string(),
                    positions: HashMap::from([(asset_id.to_string(), long_position)]),
                    ..Default::default()
                },
            ),
            (
                short_account.to_string(),
                AccountStateSnapshot {
                    account_id: short_account.to_string(),
                    currency: "USD".to_string(),
                    positions: HashMap::from([(asset_id.to_string(), short_position)]),
                    ..Default::default()
                },
            ),
            (
                closed_account.to_string(),
                AccountStateSnapshot {
                    account_id: closed_account.to_string(),
                    currency: "USD".to_string(),
                    positions: HashMap::from([(asset_id.to_string(), closed_position)]),
                    ..Default::default()
                },
            ),
        ]);
        let service = test_service_with_snapshots(
            Arc::new(MockSnapshotService {
                snapshot: snapshots_by_account[long_account].clone(),
                snapshots_by_account,
            }),
            vec![test_asset(asset_id, asset_id, InstrumentType::Equity)],
            HashMap::new(),
        );

        let holdings = service
            .get_holdings_for_accounts_with_options(
                &[
                    long_account.to_string(),
                    short_account.to_string(),
                    closed_account.to_string(),
                ],
                "USD",
                "portfolio",
                true,
            )
            .await
            .unwrap();

        assert_eq!(holdings.len(), 2);
        let open = holdings
            .iter()
            .find(|holding| !holding.is_closed)
            .expect("open aggregate should remain visible");
        let closed = holdings
            .iter()
            .find(|holding| holding.is_closed)
            .expect("closed aggregate should remain separate");
        assert_eq!(open.quantity, Decimal::ZERO);
        assert_eq!(open.source_account_ids.len(), 2);
        assert_eq!(closed.quantity, Decimal::ZERO);
        assert_eq!(closed.source_account_ids, vec![closed_account.to_string()]);
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
            is_closed: false,
            instrument: Some(Instrument {
                id: "TEST".to_string(),
                symbol: "TEST".to_string(),
                name: Some("Test".to_string()),
                currency: "GBp".to_string(),
                notes: None,
                pricing_mode: "MARKET".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                instrument_type: None,
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
            translate_observed_basis: false,
            fx_rate: Some(dec!(0.01)),
            market_value: MonetaryValue::new(dec!(3090), dec!(30.9)),
            cost_basis: Some(MonetaryValue::new(dec!(3000), dec!(30))),
            price: Some(dec!(3090)),
            purchase_price: None,
            unrealized_gain: Some(MonetaryValue::new(dec!(90), dec!(0.9))),
            unrealized_gain_pct: Some(dec!(0.03)),
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: Some(MonetaryValue::new(dec!(90), dec!(0.9))),
            total_gain_pct: Some(dec!(0.03)),
            income: Some(MonetaryValue::new(dec!(10), dec!(0.1))),
            total_return: Some(MonetaryValue::new(dec!(100), dec!(1))),
            total_return_pct: Some(dec!(0.033333333333333333)),
            return_basis: Some(MonetaryValue::new(dec!(3000), dec!(30))),
            day_change: Some(MonetaryValue::new(dec!(-44), dec!(-0.44))),
            day_change_pct: Some(dec!(-0.014)),
            prev_close_value: Some(MonetaryValue::new(dec!(3134), dec!(31.34))),
            weight: Some(dec!(0.1)),
            as_of_date: as_of,
            source_account_ids: vec![],
            metadata: None,
        };

        normalize_holding_currency(&mut holding);

        assert_eq!(holding.local_currency, "GBP");
        assert_eq!(holding.instrument.as_ref().unwrap().currency, "GBP");
        assert_eq!(holding.fx_rate, Some(dec!(1)));
        assert_eq!(holding.price, Some(dec!(30.9)));
        assert_eq!(holding.market_value.local.unwrap(), dec!(30.9));
        assert_eq!(holding.market_value.base.unwrap(), dec!(30.9));
        assert_eq!(
            holding.cost_basis.as_ref().unwrap().local.unwrap(),
            dec!(30)
        );
        assert_eq!(holding.cost_basis.as_ref().unwrap().base.unwrap(), dec!(30));
        assert_eq!(
            holding.unrealized_gain.as_ref().unwrap().local.unwrap(),
            dec!(0.9)
        );
        assert_eq!(
            holding.unrealized_gain.as_ref().unwrap().base.unwrap(),
            dec!(0.9)
        );
        assert_eq!(holding.income.as_ref().unwrap().local.unwrap(), dec!(0.1));
        assert_eq!(holding.income.as_ref().unwrap().base.unwrap(), dec!(0.1));
        assert_eq!(
            holding.total_return.as_ref().unwrap().local.unwrap(),
            dec!(1)
        );
        assert_eq!(
            holding.total_return.as_ref().unwrap().base.unwrap(),
            dec!(1)
        );
        assert_eq!(
            holding.return_basis.as_ref().unwrap().local.unwrap(),
            dec!(30)
        );
        assert_eq!(
            holding.return_basis.as_ref().unwrap().base.unwrap(),
            dec!(30)
        );
        assert_eq!(
            holding.day_change.as_ref().unwrap().local.unwrap(),
            dec!(-0.44)
        );
        assert_eq!(
            holding.day_change.as_ref().unwrap().base.unwrap(),
            dec!(-0.44)
        );
        assert_eq!(
            holding.prev_close_value.as_ref().unwrap().local.unwrap(),
            dec!(31.34)
        );
        assert_eq!(
            holding.prev_close_value.as_ref().unwrap().base.unwrap(),
            dec!(31.34)
        );
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
            is_closed: false,
            instrument: None,
            asset_kind: None,
            quantity: dec!(1000),
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: "GBp".to_string(),
            base_currency: "GBP".to_string(),
            translate_observed_basis: false,
            fx_rate: Some(dec!(0.01)),
            market_value: MonetaryValue::new(dec!(1000), dec!(10)),
            cost_basis: Some(MonetaryValue::new(dec!(1000), dec!(10))),
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
            return_basis: Some(MonetaryValue::new(dec!(1000), dec!(10))),
            day_change: Some(MonetaryValue::new(dec!(0), dec!(0))),
            day_change_pct: Some(Decimal::ZERO),
            prev_close_value: Some(MonetaryValue::new(dec!(1000), dec!(10))),
            weight: Some(dec!(1)),
            as_of_date: valuation_date_today(),
            source_account_ids: vec![],
            metadata: None,
        };

        normalize_holding_currency(&mut holding);

        assert_eq!(holding.local_currency, "GBP");
        assert_eq!(holding.fx_rate, Some(dec!(1)));
        assert_eq!(holding.market_value.local.unwrap(), dec!(10));
        assert_eq!(holding.market_value.base.unwrap(), dec!(10));
        assert_eq!(
            holding.cost_basis.as_ref().unwrap().local.unwrap(),
            dec!(10)
        );
        assert_eq!(holding.price, Some(Decimal::ONE));
        assert_eq!(
            holding.prev_close_value.as_ref().unwrap().local.unwrap(),
            dec!(10)
        );
        assert_eq!(
            holding.prev_close_value.as_ref().unwrap().base.unwrap(),
            dec!(10)
        );
    }

    // Snapshot cash balances round-trip through f64, so long-settled accounts keep
    // residual balances around 1e-15. The tests below pin that such balances never
    // become cash holdings — each one renders as a `$0` row in the Cash drill-down.

    fn cash_snapshot(account_id: &str, balances: Vec<(&str, Decimal)>) -> AccountStateSnapshot {
        AccountStateSnapshot {
            account_id: account_id.to_string(),
            currency: "USD".to_string(),
            cash_balances: balances
                .into_iter()
                .map(|(currency, amount)| (currency.to_string(), amount))
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn cash_dust_is_detected_below_decimal_precision() {
        assert!(is_cash_dust(Decimal::ZERO));
        assert!(is_cash_dust(dec!(0.000000000000001)));
        assert!(is_cash_dust(dec!(-0.000000000000001)));
        assert!(!is_cash_dust(dec!(0.01)));
        assert!(!is_cash_dust(dec!(-0.01)));
        // DECIMAL_PRECISION is 8, well below a cent, so real sub-cent balances survive.
        assert!(!is_cash_dust(dec!(0.00000001)));
    }

    #[tokio::test]
    async fn failed_live_valuation_does_not_publish_foreign_cash_as_zero_base_value() {
        struct FailedValuation;
        #[async_trait]
        impl HoldingsValuationServiceTrait for FailedValuation {
            async fn calculate_holdings_live_valuation(&self, _: &mut [Holding]) -> Result<()> {
                Err(CoreError::Unexpected("injected quote read failure".into()))
            }
        }
        let mut service = test_service(
            cash_snapshot("account", vec![("USD", dec!(100))]),
            Vec::new(),
            HashMap::new(),
        );
        service.inner.valuation_service = Arc::new(FailedValuation);
        let holdings = service.get_holdings("account", "CAD").await.unwrap();
        assert_eq!(holdings.len(), 1);
        assert_eq!(holdings[0].market_value.local, Some(dec!(100)));
        assert_eq!(holdings[0].market_value.base, None);
        assert_eq!(holdings[0].cost_basis.as_ref().unwrap().base, None);
        assert_eq!(holdings[0].weight, None);
    }

    #[tokio::test]
    async fn unpriced_security_stays_visible_without_fabricating_portfolio_weights() {
        let snapshot = AccountStateSnapshot {
            account_id: "account".into(),
            currency: "USD".into(),
            positions: HashMap::from([
                ("priced".into(), test_position("account", "priced")),
                ("unpriced".into(), test_position("account", "unpriced")),
            ]),
            ..Default::default()
        };
        let service = test_service(
            snapshot,
            vec![
                test_asset("priced", "USD", InstrumentType::Equity),
                test_asset("unpriced", "USD", InstrumentType::Equity),
            ],
            HashMap::from([("priced".into(), dec!(110))]),
        );
        let holdings = service.get_holdings("account", "USD").await.unwrap();
        assert_eq!(holdings.len(), 2);
        assert_eq!(
            holdings
                .iter()
                .find(|holding| holding.instrument.as_ref().unwrap().id == "priced")
                .unwrap()
                .market_value
                .base,
            Some(dec!(110))
        );
        assert_eq!(
            holdings
                .iter()
                .find(|holding| holding.instrument.as_ref().unwrap().id == "unpriced")
                .unwrap()
                .market_value
                .base,
            None
        );
        assert!(holdings.iter().all(|holding| holding.weight.is_none()));
    }

    #[test]
    fn cash_dust_boundary_sits_just_above_half_of_decimal_precision() {
        // `round_dp` uses banker's rounding, so the exact midpoint goes to even (zero)
        // and the largest discarded balance is 5e-9 — half a nanodollar, either sign.
        assert!(is_cash_dust(dec!(0.000000005)));
        assert!(is_cash_dust(dec!(-0.000000005)));
        assert!(!is_cash_dust(dec!(0.0000000051)));
        assert!(!is_cash_dust(dec!(-0.0000000051)));
    }

    #[tokio::test]
    async fn get_holdings_does_not_round_the_cash_balance_it_emits() {
        // Only the dust *test* rounds; the balance written into the holding keeps full
        // precision. Rounding the emitted value would be a behavior change, not a fix.
        let account_id = "acc-1";
        let precise = dec!(1234.567890123456789);
        let snapshot = cash_snapshot(account_id, vec![("USD", precise)]);
        let service = test_service(snapshot, Vec::new(), HashMap::new());

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();

        let cash = holdings
            .iter()
            .find(|holding| holding.holding_type == HoldingType::Cash)
            .expect("real balance should survive");
        assert_eq!(cash.quantity, precise);
        assert_eq!(cash.market_value.local.unwrap(), precise);
        assert_eq!(cash.cost_basis.as_ref().unwrap().local.unwrap(), precise);
    }

    #[tokio::test]
    async fn get_holdings_skips_dust_cash_balances() {
        let account_id = "acc-1";
        let snapshot = cash_snapshot(
            account_id,
            vec![
                ("USD", dec!(0.000000000000001)),
                ("EUR", dec!(-0.0000000000000023679074)),
            ],
        );
        let service = test_service(snapshot, Vec::new(), HashMap::new());

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();

        assert!(holdings.is_empty());
    }

    #[tokio::test]
    async fn get_holdings_keeps_real_cash_balances_alongside_dust() {
        let account_id = "acc-1";
        let snapshot = cash_snapshot(
            account_id,
            vec![
                ("USD", dec!(2500)),
                ("EUR", dec!(0.0000000000000092751693)),
                // A genuine sub-cent balance is money, not noise.
                ("GBP", dec!(0.001)),
            ],
        );
        let service = test_service(snapshot, Vec::new(), HashMap::new());

        let holdings = service.get_holdings(account_id, "USD").await.unwrap();

        let mut cash: Vec<(String, Decimal)> = holdings
            .iter()
            .filter(|holding| holding.holding_type == HoldingType::Cash)
            .map(|holding| (holding.local_currency.clone(), holding.quantity))
            .collect();
        cash.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(
            cash,
            vec![
                ("GBP".to_string(), dec!(0.001)),
                ("USD".to_string(), dec!(2500)),
            ]
        );
    }

    #[tokio::test]
    async fn holdings_from_snapshot_skips_dust_cash_balances() {
        let snapshot = cash_snapshot(
            "acc-1",
            vec![
                ("USD", dec!(2500)),
                ("EUR", dec!(0.000000000000001)),
                ("CAD", dec!(-0.000000000000001)),
            ],
        );
        let service = test_service(snapshot.clone(), Vec::new(), HashMap::new());

        let holdings = service
            .holdings_from_snapshot(&snapshot, "USD")
            .await
            .unwrap();

        let cash: Vec<&Holding> = holdings
            .iter()
            .filter(|holding| holding.holding_type == HoldingType::Cash)
            .collect();
        assert_eq!(cash.len(), 1);
        assert_eq!(cash[0].local_currency, "USD");
        assert_eq!(cash[0].quantity, dec!(2500));
    }
}
