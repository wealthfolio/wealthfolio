use std::collections::HashMap;
use std::sync::Arc;

use chrono::{NaiveDate, TimeZone, Utc};
use log::debug;
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::assets::{AssetKind, AssetMetadata, AssetServiceTrait, InstrumentType, QuoteMode};
use crate::errors::Result;
use crate::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use crate::fx::FxServiceTrait;
use crate::portfolio::snapshot::{
    AccountStateSnapshot, Position, SnapshotServiceTrait, SnapshotSource,
};
use crate::quotes::constants::DATA_SOURCE_MANUAL;
use crate::quotes::{Quote, QuoteServiceTrait};

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

pub struct ManualSnapshotService {
    asset_service: Arc<dyn AssetServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    snapshot_service: Arc<dyn SnapshotServiceTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    event_sink: Arc<dyn DomainEventSink>,
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
            event_sink: Arc::new(NoOpDomainEventSink),
        }
    }

    /// Sets the domain event sink for emitting ManualSnapshotSaved events.
    pub fn with_event_sink(mut self, event_sink: Arc<dyn DomainEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    pub async fn save_manual_snapshot(
        &self,
        request: ManualSnapshotRequest,
    ) -> Result<Vec<String>> {
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

            let kind = match holding.asset_kind.as_deref() {
                Some("OTHER") => Some(AssetKind::Other),
                Some("INVESTMENT") => Some(AssetKind::Investment),
                _ => None,
            };

            let metadata = AssetMetadata {
                instrument_symbol: Some(holding.symbol.clone()),
                instrument_exchange_mic: holding.exchange_mic.clone(),
                display_code: Some(holding.symbol.clone()),
                name: holding.name.clone(),
                kind,
                instrument_type: holding
                    .instrument_type
                    .as_deref()
                    .and_then(InstrumentType::from_external_str),
                requested_quote_ccy: holding.quote_ccy.clone(),
                provider_config: None,
                provider_id: holding.provider_id.clone(),
                provider_symbol: holding.provider_symbol.clone(),
                ..Default::default()
            };

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

            // Create a quote from the snapshot price as a fallback.
            // Only for MANUAL-mode assets: average cost is a cost basis, not a market
            // price, and writing it for MARKET-mode assets would overwrite provider
            // quotes for the snapshot date.
            let is_manual_mode = asset.quote_mode == QuoteMode::Manual
                || matches!(quote_mode.as_deref(), Some(DATA_SOURCE_MANUAL));
            if is_manual_mode && !holding.average_cost.is_zero() {
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
                inception_date: Utc::now(),
                lots: std::collections::VecDeque::new(),
                created_at: Utc::now(),
                last_updated: Utc::now(),
                is_alternative: false,
                contract_multiplier: Decimal::ONE,
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
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: Utc::now().naive_utc(),
            source: request.source,
        };

        self.snapshot_service
            .save_manual_snapshot(&request.account_id, snapshot)
            .await?;

        // Emit domain event to trigger portfolio recalculation
        self.event_sink
            .emit(DomainEvent::manual_snapshot_saved(request.account_id));

        asset_ids.sort();
        asset_ids.dedup();

        Ok(asset_ids)
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
        let timestamp = Utc.from_utc_datetime(&date.and_hms_opt(12, 0, 0).unwrap());

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
