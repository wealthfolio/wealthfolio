use std::collections::HashMap;
use std::sync::Arc;

use chrono::{NaiveDate, TimeZone, Utc};
use log::{debug, warn};
use rust_decimal::Decimal;
use serde::Deserialize;
use uuid::Uuid;

use crate::accounts::Account;
use crate::assets::{AssetKind, AssetMetadata, AssetServiceTrait, InstrumentType, QuoteMode};
use crate::errors::{Error, Result};
use crate::fx::FxServiceTrait;
use crate::portfolio::snapshot::{
    validate_snapshot_write_date, AccountStateSnapshot, Position, SnapshotServiceTrait,
    SnapshotSource,
};
use crate::quotes::constants::DATA_SOURCE_MANUAL;
use crate::quotes::{Quote, QuoteServiceTrait};
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};

#[derive(Debug, Clone)]
pub struct ManualHoldingInput {
    pub asset_id: Option<String>,
    pub symbol: String,
    pub exchange_mic: Option<String>,
    pub quantity: Decimal,
    pub currency: String,
    pub average_cost: Decimal,
    /// Asset name for custom assets
    pub name: Option<String>,
    /// Data source (e.g., "MANUAL") — when "MANUAL", quote mode is set to manual
    pub data_source: Option<String>,
    /// Asset kind string (e.g., "INVESTMENT", "OTHER")
    pub asset_kind: Option<String>,
    /// Quote currency resolved during search/review (e.g., GBp)
    pub quote_ccy: Option<String>,
    /// Instrument type resolved during search/review (e.g., EQUITY, CRYPTO)
    pub instrument_type: Option<String>,
    /// Market data provider that resolved this holding, if selected.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
}

impl ManualHoldingInput {
    /// The asset metadata saving this holding resolves or creates its asset
    /// with.
    pub fn asset_metadata(&self) -> AssetMetadata {
        // A custom "Other" holding sits in the account: an investment, not
        // the alternative kind net worth adds on its own.
        let kind = match self.asset_kind.as_deref() {
            Some("OTHER") | Some("INVESTMENT") => Some(AssetKind::Investment),
            _ => None,
        };

        AssetMetadata {
            instrument_symbol: Some(self.symbol.clone()),
            instrument_exchange_mic: self.exchange_mic.clone(),
            display_code: Some(self.symbol.clone()),
            name: self.name.clone(),
            kind,
            instrument_type: self
                .instrument_type
                .as_deref()
                .and_then(InstrumentType::from_external_str),
            instrument_type_label: self.instrument_type.clone(),
            requested_quote_ccy: self.quote_ccy.clone(),
            provider_config: None,
            provider_id: self.provider_id.clone(),
            provider_symbol: self.provider_symbol.clone(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone)]
pub struct CashBalanceInput {
    pub currency: String,
    pub amount: Decimal,
}

#[derive(Debug, Clone)]
pub struct ManualSnapshotRequest {
    pub account_id: String,
    pub account_currency: String,
    pub snapshot_date: NaiveDate,
    pub positions: Vec<ManualHoldingInput>,
    pub cash_balances: Vec<CashBalanceInput>,
    pub base_currency: Option<String>,
    pub source: SnapshotSource,
}

/// A holding as the app's holdings form sends it, with its decimals as text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualHoldingEntry {
    /// For existing holdings, pass the known asset ID directly (preferred)
    pub asset_id: Option<String>,
    /// Symbol (e.g., "AAPL", "META.TO") - used when asset_id is not provided
    pub symbol: String,
    pub quantity: String,
    pub currency: String,
    pub average_cost: Option<String>,
    /// Exchange MIC code for new holdings (e.g., "XNAS", "XTSE"). Used when asset_id is not provided.
    pub exchange_mic: Option<String>,
    /// Quote currency resolved during search/review (e.g., GBp)
    pub quote_ccy: Option<String>,
    /// Instrument type resolved during search/review (e.g., EQUITY, CRYPTO)
    pub instrument_type: Option<String>,
    /// Market data provider that resolved this holding, if selected.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
    /// Asset name for new custom assets
    pub name: Option<String>,
    /// Data source (e.g., "MANUAL" for custom assets) — sets quote mode to manual
    pub data_source: Option<String>,
    /// Asset kind (e.g., "INVESTMENT", "OTHER")
    pub asset_kind: Option<String>,
}

/// One date's manual holdings and cash as the hosts receive them.
#[derive(Debug, Clone, Default)]
pub struct ManualHoldingsEntry {
    pub holdings: Vec<ManualHoldingEntry>,
    /// Cash amount per currency, as text.
    pub cash_balances: HashMap<String, String>,
    /// `YYYY-MM-DD`; today in the user's timezone when left out.
    pub snapshot_date: Option<String>,
}

/// What [`ManualSnapshotService::save_manual_holdings`] saved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedManualHoldings {
    pub snapshot_date: NaiveDate,
    /// The snapshot's assets, sorted, without duplicates.
    pub asset_ids: Vec<String>,
}

/// Why manual holdings were not saved. The texts are the ones the hosts
/// have always returned.
#[derive(Debug, thiserror::Error)]
pub enum ManualHoldingsSaveError {
    /// A date or number that does not parse.
    #[error("{0}")]
    Invalid(String),
    #[error("Failed to save manual snapshot: {0}")]
    Save(#[source] Error),
}

pub struct ManualSnapshotService {
    asset_service: Arc<dyn AssetServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    timezone: String,
}

impl ManualSnapshotService {
    pub fn new(
        asset_service: Arc<dyn AssetServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
    ) -> Self {
        Self {
            asset_service,
            fx_service,
            snapshot_service,
            quote_service,
            timezone: String::new(),
        }
    }

    pub fn with_timezone(mut self, timezone: String) -> Self {
        self.timezone = timezone;
        self
    }

    /// Saves manual holdings, as the app's holdings form sends them, as the
    /// account's snapshot for their date: today in the user's timezone when
    /// the entry has none. Parses every number before anything is written.
    pub async fn save_manual_holdings(
        &self,
        account: &Account,
        base_currency: &str,
        entry: ManualHoldingsEntry,
    ) -> std::result::Result<SavedManualHoldings, ManualHoldingsSaveError> {
        let request = self.manual_holdings_request(account, base_currency, entry)?;
        let snapshot_date = request.snapshot_date;
        let asset_ids = self
            .save_manual_snapshot(request)
            .await
            .map_err(ManualHoldingsSaveError::Save)?;
        Ok(SavedManualHoldings {
            snapshot_date,
            asset_ids,
        })
    }

    fn manual_holdings_request(
        &self,
        account: &Account,
        base_currency: &str,
        entry: ManualHoldingsEntry,
    ) -> std::result::Result<ManualSnapshotRequest, ManualHoldingsSaveError> {
        let invalid = ManualHoldingsSaveError::Invalid;
        let snapshot_date = match entry.snapshot_date {
            Some(date) => NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                .map_err(|e| invalid(format!("Invalid date format: {}", e)))?,
            None => user_today(parse_user_timezone_or_default(&self.timezone)),
        };

        let mut positions = Vec::with_capacity(entry.holdings.len());
        for holding in entry.holdings {
            let quantity = holding
                .quantity
                .parse::<Decimal>()
                .map_err(|e| invalid(format!("Invalid quantity for {}: {}", holding.symbol, e)))?;
            let average_cost = match &holding.average_cost {
                Some(cost) if !cost.is_empty() => cost.parse::<Decimal>().map_err(|e| {
                    invalid(format!(
                        "Invalid average cost for {}: {}",
                        holding.symbol, e
                    ))
                })?,
                _ => Decimal::ZERO,
            };
            positions.push(ManualHoldingInput {
                asset_id: holding.asset_id,
                symbol: holding.symbol,
                exchange_mic: holding.exchange_mic,
                quantity,
                currency: holding.currency,
                average_cost,
                name: holding.name,
                data_source: holding.data_source,
                asset_kind: holding.asset_kind,
                quote_ccy: holding.quote_ccy,
                instrument_type: holding.instrument_type,
                provider_id: holding.provider_id,
                provider_symbol: holding.provider_symbol,
            });
        }

        let mut cash_balances = Vec::with_capacity(entry.cash_balances.len());
        for (currency, amount) in entry.cash_balances {
            let amount = amount
                .parse::<Decimal>()
                .map_err(|e| invalid(format!("Invalid cash amount for {}: {}", currency, e)))?;
            cash_balances.push(CashBalanceInput { currency, amount });
        }

        Ok(ManualSnapshotRequest {
            account_id: account.id.clone(),
            account_currency: account.currency.clone(),
            snapshot_date,
            positions,
            cash_balances,
            base_currency: Some(base_currency.to_string()),
            source: SnapshotSource::ManualEntry,
        })
    }

    pub async fn save_manual_snapshot(
        &self,
        request: ManualSnapshotRequest,
    ) -> Result<Vec<String>> {
        validate_snapshot_write_date(
            &request.account_id,
            request.snapshot_date,
            request.source.as_str(),
            user_today(parse_user_timezone_or_default(&self.timezone)),
        )?;

        let mut positions: HashMap<String, Position> = HashMap::new();
        let mut asset_ids: Vec<String> = Vec::new();

        for holding in request.positions {
            if holding.quantity.is_zero() {
                continue;
            }

            let asset_id = match holding.asset_id.as_deref() {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => Uuid::new_v4().to_string(),
            };

            let metadata = holding.asset_metadata();

            let quote_mode = match holding.data_source.as_deref() {
                Some(DATA_SOURCE_MANUAL) => Some(DATA_SOURCE_MANUAL.to_string()),
                _ => None,
            };

            let asset = self
                .asset_service
                .get_or_create_minimal_asset(
                    &asset_id,
                    Some(holding.currency.clone()),
                    Some(metadata),
                    quote_mode.clone(),
                )
                .await?;

            // Update quote mode on existing assets if MANUAL data source specified
            if let Some(ref mode) = quote_mode {
                let requested_mode = mode.to_uppercase();
                let current_mode = asset.quote_mode.as_db_str();
                if requested_mode != current_mode {
                    self.asset_service
                        .update_quote_mode_silent(&asset.id, &requested_mode)
                        .await?;
                }
            }

            // Give a MANUAL-mode asset without a price its first one from the
            // average cost. The average cost is a cost basis, not a price: it
            // must not replace a provider quote or a price the user entered, so
            // only write it when the asset has no quote on or before this date.
            let is_manual_mode = asset.quote_mode == QuoteMode::Manual
                || matches!(quote_mode.as_deref(), Some(DATA_SOURCE_MANUAL));
            if is_manual_mode
                && !holding.average_cost.is_zero()
                && !self.has_quote_on_or_before(&asset.id, request.snapshot_date)
            {
                let source = DATA_SOURCE_MANUAL.to_string();
                self.create_quote_from_snapshot(
                    &asset.id,
                    holding.average_cost,
                    &holding.currency,
                    request.snapshot_date,
                    source,
                )
                .await;
            }

            asset_ids.push(asset.id.clone());

            if holding.currency != request.account_currency {
                self.fx_service
                    .register_currency_pair(&holding.currency, &request.account_currency)
                    .await?;
            }

            if asset.quote_ccy != request.account_currency && asset.quote_ccy != holding.currency {
                self.fx_service
                    .register_currency_pair(&asset.quote_ccy, &request.account_currency)
                    .await?;
            }

            let total_cost_basis = holding.quantity * holding.average_cost;

            let position = Position {
                id: format!("POS-{}-{}", asset.id, request.account_id),
                account_id: request.account_id.clone(),
                asset_id: asset.id.clone(),
                quantity: holding.quantity,
                average_cost: holding.average_cost,
                total_cost_basis,
                currency: holding.currency,
                inception_date: crate::utils::clock::now(),
                lots: std::collections::VecDeque::new(),
                created_at: Utc::now(),
                last_updated: Utc::now(),
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
                cost_basis_account: None,
                cost_basis_base: None,
            };
            positions.insert(asset.id, position);
        }

        let mut cash_balances: HashMap<String, Decimal> = HashMap::new();
        for cash in request.cash_balances {
            if cash.amount.is_zero() {
                continue;
            }

            if cash.currency != request.account_currency {
                self.fx_service
                    .register_currency_pair(&cash.currency, &request.account_currency)
                    .await?;
            }

            cash_balances.insert(cash.currency, cash.amount);
        }

        if let Some(base_currency) = request.base_currency.as_deref() {
            if base_currency != request.account_currency {
                self.fx_service
                    .register_currency_pair(&request.account_currency, base_currency)
                    .await?;
            }
        }

        let total_cost_basis: Decimal = positions.values().map(|p| p.total_cost_basis).sum();

        // Cache the cash totals on the keyframe: the daily holdings calculator
        // only fills them on CALCULATED snapshots, and the snapshot history UI
        // reads them straight off the keyframe.
        let cash_total_account_currency = self.sum_cash_in_currency(
            &cash_balances,
            &request.account_currency,
            request.snapshot_date,
        );
        let cash_total_base_currency = match request.base_currency.as_deref() {
            Some(base_currency) => {
                self.sum_cash_in_currency(&cash_balances, base_currency, request.snapshot_date)
            }
            None => Decimal::ZERO,
        };

        let snapshot = AccountStateSnapshot {
            id: format!(
                "{}_{}",
                request.account_id,
                request.snapshot_date.format("%Y-%m-%d")
            ),
            account_id: request.account_id.clone(),
            snapshot_date: request.snapshot_date,
            currency: request.account_currency.clone(),
            positions,
            cash_balances,
            cost_basis: total_cost_basis,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency,
            cash_total_base_currency,
            calculated_at: Utc::now().naive_utc(),
            base_currency: None,
            source: request.source,
        };

        self.snapshot_service
            .save_manual_snapshot(&request.account_id, snapshot)
            .await?;

        asset_ids.sort();
        asset_ids.dedup();

        Ok(asset_ids)
    }

    /// Sums cash balances converted into `target_currency` at `date`.
    /// Falls back to the unconverted amount when no FX rate is available,
    /// matching the holdings calculator's cash-total semantics.
    fn sum_cash_in_currency(
        &self,
        cash_balances: &HashMap<String, Decimal>,
        target_currency: &str,
        date: NaiveDate,
    ) -> Decimal {
        let mut total = Decimal::ZERO;
        for (currency, &amount) in cash_balances {
            if currency == target_currency {
                total += amount;
            } else {
                match self.fx_service.convert_currency_for_date(
                    amount,
                    currency,
                    target_currency,
                    date,
                ) {
                    Ok(converted) => total += converted,
                    Err(e) => {
                        warn!(
                            "Failed to convert cash balance {} to {}: {}. Using unconverted amount.",
                            currency, target_currency, e
                        );
                        total += amount;
                    }
                }
            }
        }
        total
    }

    /// Whether the asset has a quote on or before `date`. A failed lookup
    /// counts as yes, so a price the lookup missed is never replaced.
    fn has_quote_on_or_before(&self, asset_id: &str, date: NaiveDate) -> bool {
        match self
            .quote_service
            .get_latest_quotes_as_of(&[asset_id.to_string()], date)
        {
            Ok(quotes) => quotes.contains_key(asset_id),
            Err(e) => {
                warn!(
                    "Failed to look up quotes for asset {} on {}: {}. Skipping the snapshot price.",
                    asset_id, date, e
                );
                true
            }
        }
    }

    /// Creates a quote from snapshot data to serve as a price fallback.
    /// Uses `DataSource::Manual` for MANUAL-mode assets, `DataSource::Broker` for others.
    async fn create_quote_from_snapshot(
        &self,
        asset_id: &str,
        price: Decimal,
        currency: &str,
        date: NaiveDate,
        data_source: String,
    ) {
        let timestamp = Utc.from_utc_datetime(
            &date
                .and_hms_opt(12, 0, 0)
                .expect("12:00:00 is a valid time"),
        );

        let quote_id = if data_source == DATA_SOURCE_MANUAL {
            let date_part = timestamp.format("%Y%m%d").to_string();
            format!("{}_{}", date_part, asset_id.to_uppercase())
        } else {
            let date_str = timestamp.format("%Y-%m-%d").to_string();
            format!("{}_{}_{}", asset_id, date_str, data_source)
        };

        let quote = Quote {
            id: quote_id,
            asset_id: asset_id.to_string(),
            timestamp,
            open: price,
            high: price,
            low: price,
            close: price,
            adjclose: price,
            volume: Decimal::ZERO,
            currency: currency.to_string(),
            data_source,
            created_at: Utc::now(),
            notes: None,
        };

        match self.quote_service.update_quote(quote).await {
            Ok(_) => {
                debug!(
                    "Created quote for asset {} on {} at price {}",
                    asset_id, date, price
                );
            }
            Err(e) => {
                debug!("Failed to create quote for asset {}: {}", asset_id, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use rust_decimal_macros::dec;

    use super::*;
    use crate::accounts::{Account, AccountRepositoryTrait};
    use crate::activities::ActivityRepositoryTrait;
    use crate::assets::{Asset, AssetRepositoryTrait, AssetService};
    use crate::fx::FxService;
    use crate::portfolio::snapshot::{SnapshotRepositoryTrait, SnapshotService};
    use crate::test_support::in_memory::{
        InMemoryAccountRepository, InMemoryActivityRepository, InMemoryAssetRepository,
        InMemoryFxRepository, InMemoryQuoteService, InMemorySnapshotRepository,
    };

    const ACCOUNT_ID: &str = "acc-1";
    const ASSET_ID: &str = "manual-asset";

    fn day(raw: &str) -> NaiveDate {
        NaiveDate::parse_from_str(raw, "%Y-%m-%d").expect("valid test date")
    }

    fn manual_quote(date: NaiveDate, price: Decimal) -> Quote {
        Quote {
            id: format!("{}_{}", date.format("%Y%m%d"), ASSET_ID.to_uppercase()),
            asset_id: ASSET_ID.to_string(),
            timestamp: Utc.from_utc_datetime(&date.and_hms_opt(12, 0, 0).expect("valid time")),
            open: price,
            high: price,
            low: price,
            close: price,
            adjclose: price,
            currency: "USD".to_string(),
            data_source: DATA_SOURCE_MANUAL.to_string(),
            ..Default::default()
        }
    }

    fn service(quotes: Vec<Quote>) -> (ManualSnapshotService, Arc<InMemoryQuoteService>) {
        let (service, quotes, _) = service_and_snapshots(quotes);
        (service, quotes)
    }

    fn service_and_snapshots(
        quotes: Vec<Quote>,
    ) -> (
        ManualSnapshotService,
        Arc<InMemoryQuoteService>,
        Arc<InMemorySnapshotRepository>,
    ) {
        let asset = Asset {
            id: ASSET_ID.to_string(),
            display_code: Some("MANUAL".to_string()),
            quote_mode: QuoteMode::Manual,
            quote_ccy: "USD".to_string(),
            is_active: true,
            ..Default::default()
        };
        let account = Account {
            id: ACCOUNT_ID.to_string(),
            currency: "USD".to_string(),
            is_active: true,
            ..Default::default()
        };
        let quote_service = Arc::new(InMemoryQuoteService::new(quotes, vec![asset.clone()]));
        let asset_repo: Arc<dyn AssetRepositoryTrait> =
            Arc::new(InMemoryAssetRepository::new(vec![asset]));
        let asset_service = Arc::new(
            AssetService::new(asset_repo, quote_service.clone()).expect("asset service builds"),
        );
        let fx_service = Arc::new(FxService::new(Arc::new(InMemoryFxRepository::new(
            Vec::new(),
        ))));
        let account_repo: Arc<dyn AccountRepositoryTrait> =
            Arc::new(InMemoryAccountRepository::new(vec![account]));
        let snapshots = Arc::new(InMemorySnapshotRepository::new(HashSet::new()));
        let snapshot_repo: Arc<dyn SnapshotRepositoryTrait> = snapshots.clone();
        let activity_repo: Arc<dyn ActivityRepositoryTrait> =
            Arc::new(InMemoryActivityRepository::new(Vec::new(), HashSet::new()));
        let snapshot_service = Arc::new(SnapshotService::new(
            Arc::new(std::sync::RwLock::new("UTC".to_string())),
            account_repo,
            snapshot_repo,
            activity_repo,
        ));
        let service = ManualSnapshotService::new(
            asset_service,
            fx_service,
            snapshot_service,
            quote_service.clone(),
        )
        .with_timezone("UTC".to_string());
        (service, quote_service, snapshots)
    }

    fn request(date: NaiveDate) -> ManualSnapshotRequest {
        ManualSnapshotRequest {
            account_id: ACCOUNT_ID.to_string(),
            account_currency: "USD".to_string(),
            snapshot_date: date,
            positions: vec![ManualHoldingInput {
                asset_id: Some(ASSET_ID.to_string()),
                symbol: "MANUAL".to_string(),
                exchange_mic: None,
                quantity: dec!(10),
                currency: "USD".to_string(),
                average_cost: dec!(100),
                name: None,
                data_source: None,
                asset_kind: None,
                quote_ccy: None,
                instrument_type: None,
                provider_id: None,
                provider_symbol: None,
            }],
            cash_balances: Vec::new(),
            base_currency: None,
            source: SnapshotSource::ManualEntry,
        }
    }

    fn closes(quotes: &InMemoryQuoteService) -> Vec<(NaiveDate, Decimal)> {
        let mut closes: Vec<_> = quotes
            .all_quotes()
            .into_iter()
            .map(|quote| (quote.timestamp.date_naive(), quote.close))
            .collect();
        closes.sort();
        closes
    }

    #[tokio::test]
    async fn keeps_a_manual_price_entered_for_the_snapshot_date() {
        let date = day("2026-01-15");
        let (service, quotes) = service(vec![manual_quote(date, dec!(150))]);

        service
            .save_manual_snapshot(request(date))
            .await
            .expect("snapshot saves");

        assert_eq!(closes(&quotes), vec![(date, dec!(150))]);
    }

    #[tokio::test]
    async fn keeps_an_earlier_manual_price_as_the_latest() {
        let earlier = day("2026-01-10");
        let date = day("2026-01-15");
        let (service, quotes) = service(vec![manual_quote(earlier, dec!(150))]);

        service
            .save_manual_snapshot(request(date))
            .await
            .expect("snapshot saves");

        assert_eq!(closes(&quotes), vec![(earlier, dec!(150))]);
    }

    #[tokio::test]
    async fn prices_an_unpriced_manual_asset_at_its_average_cost() {
        let date = day("2026-01-15");
        let later = day("2026-01-20");
        let (service, quotes) = service(vec![manual_quote(later, dec!(150))]);

        service
            .save_manual_snapshot(request(date))
            .await
            .expect("snapshot saves");

        assert_eq!(closes(&quotes), vec![(date, dec!(100)), (later, dec!(150))]);
    }

    fn account() -> Account {
        Account {
            id: ACCOUNT_ID.to_string(),
            currency: "USD".to_string(),
            is_active: true,
            ..Default::default()
        }
    }

    fn entry(quantity: &str, average_cost: Option<&str>) -> ManualHoldingEntry {
        ManualHoldingEntry {
            asset_id: Some(ASSET_ID.to_string()),
            symbol: "MANUAL".to_string(),
            quantity: quantity.to_string(),
            currency: "USD".to_string(),
            average_cost: average_cost.map(str::to_string),
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            provider_id: None,
            provider_symbol: None,
            name: None,
            data_source: None,
            asset_kind: None,
        }
    }

    fn stored(snapshots: &InMemorySnapshotRepository) -> Vec<AccountStateSnapshot> {
        snapshots
            .get_snapshots_by_account(ACCOUNT_ID, None, None)
            .expect("snapshots read")
    }

    #[tokio::test]
    async fn saves_manual_holdings_as_the_dated_snapshot() {
        let date = day("2026-01-15");
        let (service, _, snapshots) = service_and_snapshots(vec![manual_quote(date, dec!(150))]);

        let saved = service
            .save_manual_holdings(
                &account(),
                "USD",
                ManualHoldingsEntry {
                    holdings: vec![entry("10", Some("12.5"))],
                    cash_balances: HashMap::from([
                        ("USD".to_string(), "250.75".to_string()),
                        ("EUR".to_string(), "0".to_string()),
                    ]),
                    snapshot_date: Some("2026-01-15".to_string()),
                },
            )
            .await
            .expect("holdings save");

        assert_eq!(
            saved,
            SavedManualHoldings {
                snapshot_date: date,
                asset_ids: vec![ASSET_ID.to_string()],
            }
        );
        let stored = stored(&snapshots);
        assert_eq!(stored.len(), 1);
        let snapshot = &stored[0];
        assert_eq!(snapshot.snapshot_date, date);
        assert_eq!(snapshot.source, SnapshotSource::ManualEntry);
        assert_eq!(snapshot.currency, "USD");
        let position = &snapshot.positions[ASSET_ID];
        assert_eq!(position.quantity, dec!(10));
        assert_eq!(position.average_cost, dec!(12.5));
        assert_eq!(position.total_cost_basis, dec!(125));
        // A zero balance is left out.
        assert_eq!(
            snapshot.cash_balances,
            HashMap::from([("USD".to_string(), dec!(250.75))])
        );
    }

    #[tokio::test]
    async fn a_missing_or_blank_average_cost_is_zero_and_the_date_defaults_to_today() {
        for average_cost in [None, Some("")] {
            let (service, _, snapshots) = service_and_snapshots(Vec::new());
            let saved = service
                .save_manual_holdings(
                    &account(),
                    "USD",
                    ManualHoldingsEntry {
                        holdings: vec![entry("3", average_cost)],
                        ..Default::default()
                    },
                )
                .await
                .expect("holdings save");

            assert_eq!(
                saved.snapshot_date,
                user_today(parse_user_timezone_or_default("UTC"))
            );
            let stored = stored(&snapshots);
            assert_eq!(stored[0].positions[ASSET_ID].average_cost, Decimal::ZERO);
        }
    }

    #[tokio::test]
    async fn text_that_does_not_parse_saves_nothing() {
        let cases = [
            (
                ManualHoldingsEntry {
                    holdings: vec![entry("ten", None)],
                    ..Default::default()
                },
                "Invalid quantity for MANUAL: ",
            ),
            (
                ManualHoldingsEntry {
                    holdings: vec![entry("10", Some("x"))],
                    ..Default::default()
                },
                "Invalid average cost for MANUAL: ",
            ),
            (
                ManualHoldingsEntry {
                    cash_balances: HashMap::from([("USD".to_string(), "lots".to_string())]),
                    ..Default::default()
                },
                "Invalid cash amount for USD: ",
            ),
            (
                ManualHoldingsEntry {
                    snapshot_date: Some("15/01/2026".to_string()),
                    ..Default::default()
                },
                "Invalid date format: ",
            ),
        ];
        for (entry, message) in cases {
            let (service, _, snapshots) = service_and_snapshots(Vec::new());
            let error = service
                .save_manual_holdings(&account(), "USD", entry)
                .await
                .expect_err("invalid text is refused");
            assert!(
                matches!(error, ManualHoldingsSaveError::Invalid(_)),
                "{error}"
            );
            assert!(error.to_string().starts_with(message), "{error}");
            assert!(stored(&snapshots).is_empty());
        }
    }

    #[tokio::test]
    async fn a_refused_snapshot_reports_the_save_failure() {
        let (service, _, snapshots) = service_and_snapshots(Vec::new());
        let error = service
            .save_manual_holdings(
                &account(),
                "USD",
                ManualHoldingsEntry {
                    holdings: vec![entry("1", None)],
                    snapshot_date: Some("2999-01-01".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("a future date is refused");
        assert!(matches!(error, ManualHoldingsSaveError::Save(_)), "{error}");
        assert!(error
            .to_string()
            .starts_with("Failed to save manual snapshot: "));
        assert!(stored(&snapshots).is_empty());
    }

    #[tokio::test]
    async fn the_latest_keyframe_is_read_from_the_accounts_own_mode() {
        let day = |d| day(&format!("2026-01-{d:02}"));
        let account = |id: &str, mode| Account {
            id: id.to_string(),
            currency: "USD".to_string(),
            is_active: true,
            tracking_mode: mode,
            ..Default::default()
        };
        let snapshot = |account_id: &str, date, source| AccountStateSnapshot {
            id: format!("{account_id}_{date}"),
            account_id: account_id.to_string(),
            snapshot_date: date,
            currency: "USD".to_string(),
            source,
            ..Default::default()
        };
        let snapshots = Arc::new(InMemorySnapshotRepository::new(HashSet::new()));
        let mut rows = Vec::new();
        for id in ["holdings", "transactions"] {
            rows.push(snapshot(id, day(5), SnapshotSource::ManualEntry));
            rows.push(snapshot(id, day(20), SnapshotSource::Calculated));
        }
        snapshots
            .save_snapshots(&rows)
            .await
            .expect("snapshots save");
        let service = SnapshotService::new(
            Arc::new(std::sync::RwLock::new("UTC".to_string())),
            Arc::new(InMemoryAccountRepository::new(vec![
                account("holdings", crate::accounts::TrackingMode::Holdings),
                account("transactions", crate::accounts::TrackingMode::Transactions),
            ])),
            snapshots,
            Arc::new(InMemoryActivityRepository::new(Vec::new(), HashSet::new())),
        );

        let latest = |id| {
            service
                .get_latest_holdings_keyframe(id, day(25))
                .expect("keyframe reads")
                .map(|snapshot| snapshot.snapshot_date)
        };
        // A holdings account's calculated rows (kept from the other mode) are
        // not its holdings; a transactions account reads only calculated ones.
        assert_eq!(latest("holdings"), Some(day(5)));
        assert_eq!(latest("transactions"), Some(day(20)));
    }
}
