use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use futures::StreamExt;
use log::debug;
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::accounts::{Account, AccountServiceTrait};
use crate::activities::activities_constants::{
    classify_import_activity, is_cash_symbol, is_garbage_symbol, requires_symbol,
    ImportSymbolDisposition, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_SPLIT, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT, PRICE_BEARING_ACTIVITY_TYPES,
};
use crate::activities::activities_errors::ActivityError;
use crate::activities::activities_model::*;
use crate::activities::csv_parser::{self, ParseConfig, ParsedCsvResult};
use crate::activities::idempotency::compute_idempotency_key;
use crate::activities::{ActivityRepositoryTrait, ActivityServiceTrait};
use crate::activities::{
    ImportRun, ImportRunMode, ImportRunRepositoryTrait, ImportRunSummary, ImportRunType, ReviewMode,
};
use crate::assets::{
    canonicalize_market_identity, normalize_quote_ccy_code, parse_crypto_pair_symbol,
    parse_symbol_with_exchange_suffix, resolve_quote_ccy_precedence, symbol_resolution_candidates,
    AssetKind, AssetServiceTrait, InstrumentType, QuoteCcyResolutionSource, QuoteMode,
};
use crate::errors::{DatabaseError, Error};
use crate::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use crate::fx::currency::{get_normalization_rule, normalize_amount, resolve_currency};
use crate::fx::FxServiceTrait;
use crate::quotes::constants::DATA_SOURCE_MANUAL;
use crate::quotes::{Quote, QuoteServiceTrait};
use crate::Result;
use log::warn;

/// Cache key: (symbol, exchange_mic, instrument_type) → provider quote currency
type QuoteCcyCache = HashMap<(String, Option<String>, Option<String>), Option<String>>;
/// Cache key: (symbol, activity currency, ISIN) → symbol resolution result
type SymbolResolutionKey = (String, String, Option<String>);
use uuid::Uuid;
use wealthfolio_market_data::{
    exchanges_for_currency, mic_to_currency, yahoo_exchange_suffixes, yahoo_suffix_to_mic,
};

/// Return the Yahoo Finance ticker suffix (e.g., ".L") for a given MIC,
/// or `None` if the exchange uses no suffix (US exchanges) or is unknown.
fn yahoo_suffix_for_mic(mic: &str) -> Option<&'static str> {
    let mic_upper = mic.to_uppercase();
    // yahoo_exchange_suffixes() returns suffixes WITH leading dot (e.g., ".L", ".TO")
    // yahoo_suffix_to_mic() expects the key WITHOUT dot, uppercased
    for &suffix in yahoo_exchange_suffixes() {
        let key = suffix.trim_start_matches('.');
        if yahoo_suffix_to_mic(key)
            .map(|m| m.to_uppercase() == mic_upper)
            .unwrap_or(false)
        {
            return Some(suffix);
        }
    }
    None
}

/// A TRANSFER_IN/TRANSFER_OUT that moves a security (not cash). The monetary
/// value of such an activity is always `quantity × unit_price`; the DB column
/// `amount` must remain NULL so there is a single source of truth and we cannot
/// drift into storing e.g. `qty² × unit_price`.
fn is_securities_transfer(activity_type: &str, resolved_asset_id: Option<&str>) -> bool {
    if activity_type != ACTIVITY_TYPE_TRANSFER_IN && activity_type != ACTIVITY_TYPE_TRANSFER_OUT {
        return false;
    }
    match resolved_asset_id {
        None => false,
        Some(id) => !is_cash_symbol(id),
    }
}

fn normalize_isin_key(isin: Option<&str>) -> Option<String> {
    isin.map(str::trim)
        .filter(|isin| !isin.is_empty())
        .map(|isin| isin.to_uppercase())
}

fn find_unique_existing_symbol_match(
    symbol: &str,
    existing_map: &HashMap<String, Option<String>>,
    existing_symbol_counts: &HashMap<String, usize>,
) -> Option<ResolvedSymbolInfo> {
    for candidate in symbol_resolution_candidates(symbol) {
        let normalized = candidate.to_lowercase();
        if existing_symbol_counts.get(&normalized).copied() != Some(1) {
            continue;
        }
        if let Some(exchange_mic) = existing_map.get(&normalized) {
            return Some(ResolvedSymbolInfo {
                exchange_mic: exchange_mic.clone(),
                name: None,
            });
        }
    }
    None
}

/// Resolved symbol information from a market data provider or asset DB lookup.
#[derive(Debug, Default)]
struct ResolvedSymbolInfo {
    exchange_mic: Option<String>,
    name: Option<String>,
}

/// Service for managing activities
pub struct ActivityService {
    activity_repository: Arc<dyn ActivityRepositoryTrait>,
    account_service: Arc<dyn AccountServiceTrait>,
    asset_service: Arc<dyn AssetServiceTrait>,
    fx_service: Arc<dyn FxServiceTrait>,
    quote_service: Arc<dyn QuoteServiceTrait>,
    import_run_repository: Option<Arc<dyn ImportRunRepositoryTrait>>,
    event_sink: Arc<dyn DomainEventSink>,
}

#[derive(Clone, Copy)]
enum PreparationMode {
    Save,
    ImportApply,
    Sync,
}

impl PreparationMode {
    fn allows_live_resolution(self) -> bool {
        matches!(self, Self::Sync)
    }

    fn is_sync(self) -> bool {
        matches!(self, Self::Sync)
    }
}

impl ActivityService {
    fn normalize_new_activity_economic_signs(activity: &mut NewActivity) {
        activity.quantity = activity.quantity.map(|v| v.abs());
        activity.unit_price = activity.unit_price.map(|v| v.abs());
        activity.amount = activity.amount.map(|v| v.abs());
        activity.fee = activity.fee.map(|v| v.abs());
    }

    fn hydrate_and_validate_update_against_existing(
        activity: &mut ActivityUpdate,
        existing: &Activity,
    ) -> Result<()> {
        if activity
            .subtype
            .as_deref()
            .map(str::trim)
            .is_some_and(|subtype| !subtype.is_empty())
        {
            activity.subtype = NewActivity::canonicalize_subtype(activity.subtype.as_deref());
        }

        let effective_subtype = match activity.subtype.as_deref().map(str::trim) {
            Some("") => None,
            Some(subtype) => Some(subtype),
            None => existing.subtype.as_deref(),
        };
        let quantity = activity
            .quantity
            .unwrap_or(existing.quantity)
            .map(|value| value.abs());
        let unit_price = activity
            .unit_price
            .unwrap_or(existing.unit_price)
            .map(|value| value.abs());
        let amount = activity
            .amount
            .unwrap_or(existing.amount)
            .map(|value| value.abs());

        NewActivity::validate_asset_backed_income_values(
            &activity.activity_type,
            effective_subtype,
            quantity,
            unit_price,
            amount,
        )?;

        Ok(())
    }

    fn validate_new_activity_income_values(activity: &NewActivity) -> Result<()> {
        NewActivity::validate_asset_backed_income_values(
            &activity.activity_type,
            activity.subtype.as_deref(),
            activity.quantity,
            activity.unit_price,
            activity.amount,
        )?;

        Ok(())
    }

    fn normalize_activity_for_preparation(mut activity: NewActivity) -> NewActivity {
        activity.subtype = NewActivity::canonicalize_subtype(activity.subtype.as_deref());
        Self::normalize_new_activity_economic_signs(&mut activity);
        activity
    }

    fn downgrade_unresolvable_sync_asset_income(activity: &mut NewActivity) {
        let should_derive_amount = activity.amount.is_none_or(|amount| amount.is_zero())
            && activity
                .quantity
                .is_some_and(|quantity| quantity.is_sign_positive() && !quantity.is_zero())
            && activity
                .unit_price
                .is_some_and(|unit_price| unit_price.is_sign_positive() && !unit_price.is_zero());

        if should_derive_amount {
            if let (Some(quantity), Some(unit_price)) = (activity.quantity, activity.unit_price) {
                activity.amount = Some(quantity * unit_price);
            }
        }

        activity.subtype = None;
    }

    fn sync_asset_income_needs_downgrade(
        activity: &NewActivity,
        resolved_asset_id: Option<&str>,
    ) -> bool {
        if !NewActivity::is_asset_backed_income_subtype(
            &activity.activity_type,
            activity.subtype.as_deref(),
        ) {
            return false;
        }

        resolved_asset_id.is_none()
            || NewActivity::validate_asset_backed_income_values(
                &activity.activity_type,
                activity.subtype.as_deref(),
                activity.quantity,
                activity.unit_price,
                activity.amount,
            )
            .is_err()
    }

    fn classify_import_symbol_disposition(
        activity_type: &str,
        subtype: Option<&str>,
        symbol: &str,
        quantity: Option<Decimal>,
        unit_price: Option<Decimal>,
    ) -> ImportSymbolDisposition {
        if NewActivity::is_asset_backed_income_subtype(activity_type, subtype) {
            ImportSymbolDisposition::ResolveAsset
        } else {
            classify_import_activity(activity_type, symbol, quantity, unit_price)
        }
    }

    fn requires_asset_identity(activity_type: &str, subtype: Option<&str>) -> bool {
        requires_symbol(activity_type)
            || NewActivity::is_asset_backed_income_subtype(activity_type, subtype)
    }

    fn has_valid_split_ratio(amount: Option<Decimal>) -> bool {
        amount.is_some_and(|amount| amount.is_sign_positive() && !amount.is_zero())
    }

    fn split_ratio_error() -> crate::errors::Error {
        ActivityError::InvalidData("Split activities require a positive amount ratio".to_string())
            .into()
    }

    fn validate_split_ratio(activity_type: &str, amount: Option<Decimal>) -> Result<()> {
        if activity_type == ACTIVITY_TYPE_SPLIT && !Self::has_valid_split_ratio(amount) {
            return Err(Self::split_ratio_error());
        }
        Ok(())
    }

    fn validate_split_ratio_update(
        &self,
        activity_id: &str,
        activity_type: &str,
        amount: Option<Option<Decimal>>,
    ) -> Result<()> {
        if activity_type != ACTIVITY_TYPE_SPLIT {
            return Ok(());
        }

        match amount {
            Some(Some(amount)) if Self::has_valid_split_ratio(Some(amount)) => Ok(()),
            Some(_) => Err(Self::split_ratio_error()),
            None => {
                let existing = self.activity_repository.get_activity(activity_id)?;
                if existing.activity_type == ACTIVITY_TYPE_SPLIT
                    && Self::has_valid_split_ratio(existing.amount)
                {
                    Ok(())
                } else {
                    Err(Self::split_ratio_error())
                }
            }
        }
    }

    fn duplicate_activity_error(existing_activity_id: Option<&str>) -> crate::errors::Error {
        let message = if let Some(activity_id) = existing_activity_id {
            format!(
                "Duplicate activity detected. A matching activity already exists (id: {}).",
                activity_id
            )
        } else {
            "Duplicate activity detected. A matching activity already exists.".to_string()
        };
        ActivityError::InvalidData(message).into()
    }

    fn map_duplicate_idempotency_violation(err: crate::errors::Error) -> crate::errors::Error {
        match err {
            crate::errors::Error::Database(crate::errors::DatabaseError::UniqueViolation(
                message,
            )) if message.contains("activities.idempotency_key") => {
                Self::duplicate_activity_error(None)
            }
            crate::errors::Error::Database(crate::errors::DatabaseError::Internal(message))
                if message.contains("activities.idempotency_key")
                    || message.contains("UNIQUE constraint failed: activities.idempotency_key") =>
            {
                Self::duplicate_activity_error(None)
            }
            other => other,
        }
    }

    fn parse_instrument_type(value: Option<&str>) -> Option<InstrumentType> {
        match value?.trim().to_uppercase().as_str() {
            "EQUITY" | "STOCK" | "ETF" | "MUTUALFUND" | "MUTUAL_FUND" | "INDEX" | "FUTURE"
            | "FUTURES" => Some(InstrumentType::Equity),
            "CRYPTO" | "CRYPTOCURRENCY" => Some(InstrumentType::Crypto),
            "FX" | "FOREX" | "CURRENCY" => Some(InstrumentType::Fx),
            "OPTION" => Some(InstrumentType::Option),
            "METAL" | "COMMODITY" => Some(InstrumentType::Metal),
            "BOND" | "FIXEDINCOME" | "FIXED_INCOME" | "DEBT" | "MONEYMARKET" => {
                Some(InstrumentType::Bond)
            }
            _ => None,
        }
    }

    fn normalize_quote_ccy(value: Option<&str>) -> Option<String> {
        let trimmed = value.map(str::trim).filter(|s| !s.is_empty())?;
        if trimmed.eq_ignore_ascii_case("GBP") {
            return Some("GBP".to_string());
        }
        if trimmed == "GBp" {
            return Some("GBp".to_string());
        }
        if trimmed.eq_ignore_ascii_case("GBX") {
            return Some("GBX".to_string());
        }
        if trimmed == "ZAc" || trimmed.eq_ignore_ascii_case("ZAC") {
            return Some("ZAc".to_string());
        }
        if !trimmed.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        if !(3..=5).contains(&trimmed.len()) {
            return None;
        }
        Some(trimmed.to_uppercase())
    }

    fn kind_from_instrument_type(instrument_type: &InstrumentType) -> AssetKind {
        match instrument_type {
            InstrumentType::Fx => AssetKind::Fx,
            _ => AssetKind::Investment,
        }
    }

    fn existing_asset_quote_ccy_by_id(&self, asset_id: Option<&str>) -> Option<String> {
        let id = asset_id?.trim();
        if id.is_empty() {
            return None;
        }
        self.asset_service
            .get_asset_by_id(id)
            .ok()
            .and_then(|asset| normalize_quote_ccy_code(Some(asset.quote_ccy.as_str())))
    }

    #[allow(clippy::too_many_arguments)]
    async fn resolve_quote_ccy(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        explicit_quote_ccy: Option<&str>,
        existing_asset_quote_ccy: Option<&str>,
        terminal_fallback: &str,
        allow_provider_lookup: bool,
    ) -> (String, QuoteCcyResolutionSource) {
        let has_deterministic_precedence = normalize_quote_ccy_code(explicit_quote_ccy).is_some()
            || normalize_quote_ccy_code(existing_asset_quote_ccy).is_some();
        let provider_quote_ccy = if allow_provider_lookup && !has_deterministic_precedence {
            self.quote_service
                .resolve_symbol_quote(symbol, exchange_mic, instrument_type, None, None)
                .await
                .ok()
                .and_then(|q| q.currency)
        } else {
            None
        };

        resolve_quote_ccy_precedence(
            explicit_quote_ccy,
            existing_asset_quote_ccy,
            provider_quote_ccy.as_deref(),
            exchange_mic.and_then(mic_to_currency),
            Some(terminal_fallback),
        )
        .unwrap_or_else(|| {
            (
                terminal_fallback.to_string(),
                QuoteCcyResolutionSource::TerminalFallback,
            )
        })
    }

    /// Fetches the provider's quote currency for a symbol, caching the raw result by
    /// (symbol, mic, instrument_type) so we only hit the provider once per unique symbol
    /// within a batch operation (validation run or sync pass).
    async fn fetch_provider_quote_ccy(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        cache: &mut QuoteCcyCache,
    ) -> Option<String> {
        let key = (
            symbol.to_string(),
            exchange_mic.map(str::to_string),
            instrument_type.map(|t| t.as_db_str().to_string()),
        );
        if let Some(cached) = cache.get(&key) {
            return cached.clone();
        }
        let result = self
            .quote_service
            .resolve_symbol_quote(symbol, exchange_mic, instrument_type, None, None)
            .await
            .ok()
            .and_then(|q| q.currency);
        cache.insert(key, result.clone());
        result
    }

    /// Creates a new ActivityService instance with injected dependencies
    pub fn new(
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        account_service: Arc<dyn AccountServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
    ) -> Self {
        Self {
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
            import_run_repository: None,
            event_sink: Arc::new(NoOpDomainEventSink),
        }
    }

    /// Creates a new ActivityService instance with import run tracking support
    pub fn with_import_run_repository(
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        account_service: Arc<dyn AccountServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        fx_service: Arc<dyn FxServiceTrait>,
        quote_service: Arc<dyn QuoteServiceTrait>,
        import_run_repository: Arc<dyn ImportRunRepositoryTrait>,
    ) -> Self {
        Self {
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
            import_run_repository: Some(import_run_repository),
            event_sink: Arc::new(NoOpDomainEventSink),
        }
    }

    fn parse_activity_timestamp_utc(activity_date: &str) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(activity_date)
            .map(|dt| dt.with_timezone(&Utc))
            .or_else(|_| {
                NaiveDate::parse_from_str(activity_date, "%Y-%m-%d")
                    .map(|date| Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap()))
            })
            .ok()
    }

    fn earliest_activity_at_utc<'a>(
        activities: impl IntoIterator<Item = &'a Activity>,
    ) -> Option<DateTime<Utc>> {
        activities
            .into_iter()
            .map(|activity| activity.activity_date)
            .min()
    }

    fn earliest_new_activity_at_utc<'a>(
        activities: impl IntoIterator<Item = &'a NewActivity>,
    ) -> Option<DateTime<Utc>> {
        activities
            .into_iter()
            .filter_map(|activity| Self::parse_activity_timestamp_utc(&activity.activity_date))
            .min()
    }

    fn earliest_upsert_activity_at_utc<'a>(
        activities: impl IntoIterator<Item = &'a ActivityUpsert>,
    ) -> Option<DateTime<Utc>> {
        activities
            .into_iter()
            .filter_map(|activity| Self::parse_activity_timestamp_utc(&activity.activity_date))
            .min()
    }

    fn emit_activities_changed(
        &self,
        account_ids: Vec<String>,
        asset_ids: Vec<String>,
        currencies: Vec<String>,
        earliest_activity_at_utc: Option<DateTime<Utc>>,
    ) {
        self.event_sink.emit(DomainEvent::activities_changed(
            account_ids,
            asset_ids,
            currencies,
            earliest_activity_at_utc,
        ));
    }

    /// Sets the domain event sink for this service.
    ///
    /// Events are emitted after successful mutations (create, update, delete).
    pub fn with_event_sink(mut self, event_sink: Arc<dyn DomainEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    fn resolve_activity_currency(
        &self,
        activity_currency: &str,
        asset_currency: Option<&str>,
        account_currency: &str,
    ) -> String {
        resolve_currency(&[
            activity_currency,
            asset_currency.unwrap_or(""),
            account_currency,
            self.account_service
                .get_base_currency()
                .as_deref()
                .unwrap_or(""),
        ])
    }

    fn parse_import_date_for_idempotency(date: &str) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(date)
            .map(|dt| dt.with_timezone(&Utc))
            .or_else(|_| {
                NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map(|d| Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default()))
            })
            .ok()
    }

    fn build_import_idempotency_key(
        activity: &ActivityImport,
        default_account_id: &str,
    ) -> Option<String> {
        let date = Self::parse_import_date_for_idempotency(&activity.date)?;
        let account_id = activity.account_id.as_deref().unwrap_or(default_account_id);

        // Use UUID when the asset already exists in the DB (set during validation).
        // Falls back to symbol@mic for new assets, matching the apply-step convention.
        let symbol = activity.symbol.trim();
        let asset_id = if let Some(id) = activity.asset_id.as_deref() {
            Some(id.to_string())
        } else if symbol.is_empty() {
            None
        } else if let Some(exchange_mic) = activity.exchange_mic.as_deref() {
            Some(format!("{}@{}", symbol, exchange_mic))
        } else {
            Some(symbol.to_string())
        };

        // Normalize to absolute values and major currencies, matching what
        // prepare_activities_internal does before the apply-step key computation.
        let quantity = activity.quantity.map(|v| v.abs());
        let (unit_price, amount, currency) =
            if let Some(rule) = get_normalization_rule(activity.currency.as_str()) {
                let unit_price = activity
                    .unit_price
                    .map(|v| normalize_amount(v.abs(), activity.currency.as_str()).0);
                let amount = activity
                    .amount
                    .map(|v| normalize_amount(v.abs(), activity.currency.as_str()).0);
                (unit_price, amount, rule.major_code)
            } else {
                let ccy = if activity.currency.trim().is_empty() {
                    "USD"
                } else {
                    activity.currency.as_str()
                };
                (
                    activity.unit_price.map(|v| v.abs()),
                    activity.amount.map(|v| v.abs()),
                    ccy,
                )
            };

        Some(compute_idempotency_key(
            account_id,
            &activity.activity_type,
            &date,
            asset_id.as_deref(),
            quantity,
            unit_price,
            amount,
            currency,
            None,
            activity.comment.as_deref(),
        ))
    }

    fn add_activity_warning(activity: &mut ActivityImport, key: &str, message: &str) {
        let warnings = activity.warnings.get_or_insert_with(HashMap::new);
        let entry = warnings.entry(key.to_string()).or_default();
        if !entry.iter().any(|m| m == message) {
            entry.push(message.to_string());
        }
    }

    fn add_activity_error(activity: &mut ActivityImport, key: &str, message: &str) {
        let errors = activity.errors.get_or_insert_with(HashMap::new);
        let entry = errors.entry(key.to_string()).or_default();
        if !entry.iter().any(|m| m == message) {
            entry.push(message.to_string());
        }
        activity.is_valid = false;
    }

    fn hydrate_import_activity_from_asset_id(&self, activity: &mut ActivityImport) {
        let Some(asset_id) = activity.asset_id.as_deref().map(str::trim) else {
            return;
        };
        if asset_id.is_empty() {
            return;
        }

        let Ok(asset) = self.asset_service.get_asset_by_id(asset_id) else {
            return;
        };

        if activity.symbol.trim().is_empty() {
            activity.symbol = asset
                .display_code
                .clone()
                .or(asset.instrument_symbol.clone())
                .unwrap_or_default();
        }
        if activity.symbol_name.is_none() {
            activity.symbol_name = asset.name.clone();
        }
        if activity.exchange_mic.is_none() {
            activity.exchange_mic = asset.instrument_exchange_mic.clone();
        }
        if activity.quote_ccy.is_none() {
            activity.quote_ccy = Some(asset.quote_ccy.clone());
        }
        if activity.instrument_type.is_none() {
            activity.instrument_type = asset
                .instrument_type
                .as_ref()
                .map(|instrument_type| instrument_type.as_db_str().to_string());
        }
        if activity.quote_mode.is_none() {
            activity.quote_mode = Some(match asset.quote_mode {
                QuoteMode::Manual => "MANUAL".to_string(),
                QuoteMode::Market => "MARKET".to_string(),
            });
        }
        if activity.currency.trim().is_empty() {
            activity.currency = asset.quote_ccy.clone();
        }
    }

    fn asset_to_new_asset_draft(asset: &crate::assets::Asset) -> crate::assets::NewAsset {
        crate::assets::NewAsset {
            id: Some(asset.id.clone()),
            kind: asset.kind.clone(),
            name: asset.name.clone(),
            display_code: asset.display_code.clone(),
            is_active: asset.is_active,
            quote_mode: asset.quote_mode,
            quote_ccy: asset.quote_ccy.clone(),
            instrument_type: asset.instrument_type.clone(),
            instrument_symbol: asset.instrument_symbol.clone(),
            instrument_exchange_mic: asset.instrument_exchange_mic.clone(),
            provider_config: asset.provider_config.clone(),
            notes: asset.notes.clone(),
            metadata: asset.metadata.clone(),
        }
    }

    fn build_new_asset_draft_from_import(
        &self,
        activity: &ActivityImport,
    ) -> Option<crate::assets::NewAsset> {
        let instrument_type = Self::parse_instrument_type(activity.instrument_type.as_deref())?;
        let quote_ccy = Self::normalize_quote_ccy(activity.quote_ccy.as_deref())?;
        let symbol = activity.symbol.trim();
        if symbol.is_empty() {
            return None;
        }

        let kind = Self::kind_from_instrument_type(&instrument_type);
        let quote_mode = match activity.quote_mode.as_deref() {
            Some("MANUAL") => QuoteMode::Manual,
            _ => QuoteMode::Market,
        };

        Some(crate::assets::NewAsset {
            id: None,
            kind,
            name: activity.symbol_name.clone(),
            display_code: Some(symbol.to_string()),
            is_active: true,
            quote_mode,
            quote_ccy,
            instrument_type: Some(instrument_type),
            instrument_symbol: Some(symbol.to_string()),
            instrument_exchange_mic: activity.exchange_mic.clone(),
            provider_config: None,
            notes: None,
            metadata: None,
        })
    }

    /// Resolves (symbol, currency, optional ISIN) keys to exchange MICs in batch.
    /// Uses the activity-level currency to rank exchange results correctly.
    /// First checks existing assets in the database, then falls back to quote service.
    /// Returns a `ResolvedSymbolInfo` for each resolution key.
    async fn resolve_symbols_batch(
        &self,
        resolution_keys: HashSet<SymbolResolutionKey>,
    ) -> HashMap<SymbolResolutionKey, ResolvedSymbolInfo> {
        let mut cache: HashMap<SymbolResolutionKey, ResolvedSymbolInfo> = HashMap::new();

        if resolution_keys.is_empty() {
            return cache;
        }

        // 1. Build a lookup map from existing assets (case-insensitive symbol and ISIN)
        let existing_assets = self.asset_service.get_assets().unwrap_or_default();
        let existing_map: HashMap<String, Option<String>> = existing_assets
            .iter()
            .filter_map(|a| {
                let symbol = a.display_code.as_ref().or(a.instrument_symbol.as_ref())?;
                Some((symbol.to_lowercase(), a.instrument_exchange_mic.clone()))
            })
            .collect();
        let existing_symbol_counts: HashMap<String, usize> = existing_assets
            .iter()
            .filter_map(|a| a.display_code.as_ref().or(a.instrument_symbol.as_ref()))
            .fold(HashMap::new(), |mut counts, symbol| {
                *counts.entry(symbol.to_lowercase()).or_insert(0) += 1;
                counts
            });

        // Build ISIN → exchange_mic from existing asset metadata
        let existing_isin_map: HashMap<String, Option<String>> = existing_assets
            .iter()
            .filter_map(|a| {
                let isin = a
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("identifiers"))
                    .and_then(|i| i.get("isin"))
                    .and_then(|v| v.as_str())?;
                Some((isin.to_uppercase(), a.instrument_exchange_mic.clone()))
            })
            .collect();

        // 2. Check each key against existing assets first
        let mut missing: Vec<SymbolResolutionKey> = Vec::new();

        for (symbol, currency, isin) in &resolution_keys {
            let resolution_key = (symbol.clone(), currency.clone(), isin.clone());
            if symbol.trim().is_empty() {
                cache.insert(resolution_key, ResolvedSymbolInfo::default());
                continue;
            }

            if let Some(isin) = isin {
                if let Some(exchange_mic) = existing_isin_map.get(isin) {
                    cache.insert(
                        resolution_key,
                        ResolvedSymbolInfo {
                            exchange_mic: exchange_mic.clone(),
                            name: None,
                        },
                    );
                } else {
                    missing.push((symbol.clone(), currency.clone(), Some(isin.clone())));
                }
                continue;
            }

            let mut existing_match = None;
            for candidate in symbol_resolution_candidates(symbol) {
                if let Some(exchange_mic) = existing_map.get(&candidate.to_lowercase()) {
                    existing_match = Some(exchange_mic.clone());
                    break;
                }
            }

            if let Some(exchange_mic) = existing_match {
                // For existing DB assets, name comes from get_asset_by_id — not needed here
                cache.insert(
                    resolution_key,
                    ResolvedSymbolInfo {
                        exchange_mic,
                        name: None,
                    },
                );
            } else {
                missing.push((symbol.clone(), currency.clone(), None));
            }
        }

        // 3. Resolve missing symbols concurrently: ISIN-first, then ticker fallback
        const SYMBOL_RESOLVE_CONCURRENCY: usize = 10;
        debug!(
            "resolve_symbols_batch: resolving {} missing symbols (concurrency={})",
            missing.len(),
            SYMBOL_RESOLVE_CONCURRENCY
        );

        let resolved: Vec<(SymbolResolutionKey, ResolvedSymbolInfo)> =
            futures::stream::iter(missing)
                .map(|(symbol, currency, isin)| {
                    let existing_isin_map = &existing_isin_map;
                    let existing_map = &existing_map;
                    let existing_symbol_counts = &existing_symbol_counts;
                    async move {
                        let info = if let Some(isin) = isin.as_deref() {
                            debug!(
                                "resolve_symbols_batch: resolving symbol={} via ISIN={}",
                                symbol, isin
                            );
                            // ① existing asset by ISIN (zero network)
                            if let Some(exchange_mic) = existing_isin_map.get(isin) {
                                ResolvedSymbolInfo {
                                    exchange_mic: exchange_mic.clone(),
                                    name: None,
                                }
                            } else {
                                // ② provider search by ISIN
                                match self
                                    .quote_service
                                    .search_symbol_with_currency(isin, None)
                                    .await
                                {
                                    Err(e) => {
                                        warn!(
                                    "resolve_symbols_batch: ISIN search failed isin={} err={}",
                                    isin, e
                                );
                                        if let Some(existing_match) =
                                            find_unique_existing_symbol_match(
                                                &symbol,
                                                existing_map,
                                                existing_symbol_counts,
                                            )
                                        {
                                            existing_match
                                        } else {
                                            self.resolve_symbol_exchange_mic(&symbol, &currency)
                                                .await
                                        }
                                    }
                                    Ok(results) => {
                                        if let Some(r) =
                                            results.into_iter().find(|r| r.exchange_mic.is_some())
                                        {
                                            ResolvedSymbolInfo {
                                                exchange_mic: r.exchange_mic,
                                                name: Some(r.long_name).filter(|n| !n.is_empty()),
                                            }
                                        } else if let Some(existing_match) =
                                            find_unique_existing_symbol_match(
                                                &symbol,
                                                existing_map,
                                                existing_symbol_counts,
                                            )
                                        {
                                            existing_match
                                        } else {
                                            self.resolve_symbol_exchange_mic(&symbol, &currency)
                                                .await
                                        }
                                    }
                                }
                            }
                        } else {
                            // ③ ticker fallback
                            self.resolve_symbol_exchange_mic(&symbol, &currency).await
                        };
                        ((symbol, currency, isin), info)
                    }
                })
                .buffer_unordered(SYMBOL_RESOLVE_CONCURRENCY)
                .collect()
                .await;

        for (key, info) in resolved {
            cache.insert(key, info);
        }

        cache
    }

    /// Convenience wrapper: resolves symbols using a single currency for all.
    /// Used by callers where per-activity currency isn't available (broker sync, prepare).
    /// Returns only exchange MIC (name not needed for those callers).
    async fn resolve_symbols_batch_single_currency(
        &self,
        symbols: HashSet<String>,
        currency: &str,
    ) -> HashMap<String, Option<String>> {
        let pairs: HashSet<(String, String)> = symbols
            .into_iter()
            .map(|s| (s, currency.to_string()))
            .collect();
        let resolution_keys: HashSet<SymbolResolutionKey> = pairs
            .into_iter()
            .map(|(symbol, currency)| (symbol, currency, None))
            .collect();
        self.resolve_symbols_batch(resolution_keys)
            .await
            .into_iter()
            .map(|((sym, _, _), info)| (sym, info.exchange_mic))
            .collect()
    }

    /// Resolve a single symbol via market data provider, returning MIC and name.
    ///
    /// Candidate ordering:
    /// 1. Exchange-suffix-qualified forms derived from the currency hint
    ///    (e.g., GBX → XLON → ".L" → "NG.L" is tried before "NG").
    ///    This is essential for non-US brokers where the raw CSV ticker has no suffix.
    /// 2. Base candidates from `symbol_resolution_candidates` (handles suffix-stripping
    ///    for already-qualified symbols like "SHOP.TO").
    async fn resolve_symbol_exchange_mic(
        &self,
        symbol: &str,
        currency: &str,
    ) -> ResolvedSymbolInfo {
        // Build candidates: bare first, then currency-hinted suffix.
        // Bare first avoids wasted searches for US ETFs in CAD accounts (EEMV, GLDM).
        // Suffix is only needed for truly ambiguous symbols (T → TELUS vs AT&T).
        let mut candidates = symbol_resolution_candidates(symbol);
        let preferred = exchanges_for_currency(currency);
        if !symbol.contains('.') && !preferred.is_empty() {
            if let Some(suffix) = yahoo_suffix_for_mic(preferred[0]) {
                if !suffix.is_empty() {
                    let suffixed = format!("{}{}", symbol, suffix);
                    if !candidates.iter().any(|e| e.eq_ignore_ascii_case(&suffixed)) {
                        candidates.push(suffixed);
                    }
                }
            }
        }

        // Currency-aware resolution: prefer a result whose exchange matches the
        // activity currency. If no match, fall back to first valid result.
        // e.g., "T" with CAD: bare "T" → AT&T (XNYS/USD, no match) → save fallback
        //        → try "T.TO" → TELUS (XTSE/CAD, match) → accept.
        // e.g., "EEMV" with CAD: bare "EEMV" → EEMV (BTS/USD, no match) → save fallback
        //        → try "EEMV.TO" → empty → use fallback (EEMV/BTS). Correct.
        let mut fallback: Option<ResolvedSymbolInfo> = None;

        for candidate in &candidates {
            let result = self
                .quote_service
                .search_symbol_with_currency(candidate, Some(currency))
                .await
                .ok()
                .and_then(|results| results.into_iter().next());

            if let Some(r) = result {
                if let Some(ref mic) = r.exchange_mic {
                    let info = ResolvedSymbolInfo {
                        exchange_mic: Some(mic.clone()),
                        name: Some(r.long_name).filter(|n| !n.is_empty()),
                    };
                    let exchange_matches = preferred.iter().any(|&p| p.eq_ignore_ascii_case(mic));
                    if exchange_matches {
                        return info; // Exchange matches currency — best result
                    }
                    if fallback.is_none() {
                        fallback = Some(info);
                    }
                }
            }
        }

        fallback.unwrap_or_default()
    }

    /// Creates a quote from activity data to serve as a price fallback.
    /// Uses `DataSource::Manual` for MANUAL-mode assets (provider sync won't overwrite),
    /// and `DataSource::Broker` for MARKET-mode assets (coexists with provider quotes).
    ///
    /// Only called for activity types where `unit_price` represents the asset's
    /// market price (BUY, SELL, TRANSFER_IN). Income activities (DIVIDEND,
    /// INTEREST) store payment amounts in `unit_price`, not asset prices.
    async fn create_quote_from_activity(
        &self,
        asset_id: &str,
        unit_price: Decimal,
        currency: &str,
        activity_date: &str,
        data_source: String,
    ) -> Result<()> {
        // Parse activity date
        let timestamp = if let Ok(dt) = DateTime::parse_from_rfc3339(activity_date) {
            dt.with_timezone(&Utc)
        } else if let Ok(date) = NaiveDate::parse_from_str(activity_date, "%Y-%m-%d") {
            Utc.from_utc_datetime(&date.and_hms_opt(12, 0, 0).unwrap())
        } else {
            debug!(
                "Could not parse activity date '{}' for quote creation",
                activity_date
            );
            return Ok(());
        };

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
            open: unit_price,
            high: unit_price,
            low: unit_price,
            close: unit_price,
            adjclose: unit_price,
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
                    asset_id, activity_date, unit_price
                );
            }
            Err(e) => {
                // Log but don't fail the activity creation
                debug!("Failed to create quote for asset {}: {}", asset_id, e);
            }
        }

        Ok(())
    }

    /// Parses CSV content with the given configuration.
    pub fn parse_csv(&self, content: &[u8], config: &ParseConfig) -> Result<ParsedCsvResult> {
        csv_parser::parse_csv(content, config)
    }
}

impl ActivityService {
    /// JSON metadata key for a non-standard option contract multiplier (e.g. mini options = 10).
    const METADATA_CONTRACT_MULTIPLIER: &'static str = "contract_multiplier";

    /// Extracts a custom contract multiplier from the activity metadata JSON, if present.
    fn custom_option_multiplier(activity_metadata: Option<&str>) -> Option<Decimal> {
        activity_metadata
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .and_then(|v| v.get(Self::METADATA_CONTRACT_MULTIPLIER)?.as_f64())
            .and_then(Decimal::from_f64_retain)
            .filter(|d| d.is_sign_positive() && !d.is_zero())
    }

    /// Infers the asset kind and instrument type from symbol, exchange, and input values.
    /// Returns (AssetKind, Option<InstrumentType>).
    fn infer_asset_kind(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        asset_kind_input: Option<&str>,
    ) -> (AssetKind, Option<InstrumentType>) {
        // 1. If explicit input is provided, use it
        if let Some(asset_kind_value) = asset_kind_input {
            match asset_kind_value.to_uppercase().as_str() {
                "SECURITY" | "INVESTMENT" | "EQUITY" => {
                    return (AssetKind::Investment, Some(InstrumentType::Equity))
                }
                "CRYPTO" => return (AssetKind::Investment, Some(InstrumentType::Crypto)),
                "FX_RATE" | "FX" => return (AssetKind::Fx, Some(InstrumentType::Fx)),
                "OPTION" | "OPT" => return (AssetKind::Investment, Some(InstrumentType::Option)),
                "BOND" => return (AssetKind::Investment, Some(InstrumentType::Bond)),
                "COMMODITY" | "CMDTY" | "METAL" => {
                    return (AssetKind::Investment, Some(InstrumentType::Metal))
                }
                "PROPERTY" | "PROP" => return (AssetKind::Property, None),
                "VEHICLE" | "VEH" => return (AssetKind::Vehicle, None),
                "COLLECTIBLE" | "COLL" => return (AssetKind::Collectible, None),
                "PRECIOUS_METAL" | "PREC" => return (AssetKind::PreciousMetal, None),
                "PRIVATE_EQUITY" | "PEQ" => return (AssetKind::PrivateEquity, None),
                "LIABILITY" | "LIAB" => return (AssetKind::Liability, None),
                "OTHER" | "ALT" => return (AssetKind::Other, None),
                _ => {} // Fall through to inference
            }
        }

        // 2. Crypto pair pattern (e.g., BTC-USD, ETH-CAD) — checked before
        //    exchange_mic because brokers may attach their MIC to crypto pairs
        let upper_symbol = symbol.to_uppercase();
        if let Some((_base, quote)) = upper_symbol.rsplit_once('-') {
            let quote = quote.trim();
            let crypto_quotes = [
                "USD", "CAD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "HKD", "SGD", "CNY", "SEK",
                "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "MXN", "BRL", "KRW", "INR", "ZAR", "BTC",
                "ETH", "USDT", "USDC", "DAI", "BUSD", "USDP", "TUSD", "FDUSD",
            ];
            if crypto_quotes.contains(&quote) {
                return (AssetKind::Investment, Some(InstrumentType::Crypto));
            }
        }

        // 3. OCC option symbol heuristic (e.g. AAPL240119C00150000)
        // Must be checked before exchange MIC — search providers may attach an
        // exchange MIC (e.g. "OPRA") to option symbols, which would otherwise
        // cause them to be misclassified as equities.
        if crate::utils::occ_symbol::looks_like_occ_symbol(&upper_symbol) {
            return (AssetKind::Investment, Some(InstrumentType::Option));
        }

        // 4. If exchange MIC is provided, it's an equity
        if exchange_mic.is_some() {
            return (AssetKind::Investment, Some(InstrumentType::Equity));
        }

        // 5. Common crypto symbols heuristic (no MIC, bare symbol like BTC, ETH)
        let common_crypto = [
            "BTC", "ETH", "XRP", "LTC", "BCH", "ADA", "DOT", "LINK", "XLM", "DOGE", "UNI", "SOL",
            "AVAX", "MATIC", "ATOM", "ALGO", "VET", "FIL", "TRX", "ETC", "XMR", "AAVE", "MKR",
            "COMP", "SNX", "YFI", "SUSHI", "CRV",
        ];
        if common_crypto.contains(&upper_symbol.as_str()) {
            return (AssetKind::Investment, Some(InstrumentType::Crypto));
        }

        // 6. Default to equity (most common case)
        (AssetKind::Investment, Some(InstrumentType::Equity))
    }

    fn is_asset_not_found_error(err: &Error) -> bool {
        matches!(err, Error::Database(DatabaseError::NotFound(_)))
    }

    fn has_submitted_asset_identity(
        submitted_symbol: Option<&str>,
        submitted_exchange_mic: Option<&str>,
        submitted_instrument_type: Option<&InstrumentType>,
        submitted_quote_ccy: Option<&str>,
    ) -> bool {
        submitted_symbol
            .map(str::trim)
            .filter(|symbol| !symbol.is_empty())
            .is_some()
            || submitted_exchange_mic
                .map(str::trim)
                .filter(|mic| !mic.is_empty())
                .is_some()
            || submitted_instrument_type.is_some()
            || submitted_quote_ccy
                .map(str::trim)
                .filter(|ccy| !ccy.is_empty())
                .is_some()
    }

    fn asset_matches_submitted_identity(
        existing_asset: &crate::assets::Asset,
        submitted_symbol: Option<&str>,
        submitted_exchange_mic: Option<&str>,
        submitted_instrument_type: Option<&InstrumentType>,
        submitted_quote_ccy: Option<&str>,
    ) -> bool {
        let submitted_identity = canonicalize_market_identity(
            submitted_instrument_type.cloned(),
            submitted_symbol,
            submitted_exchange_mic,
            submitted_quote_ccy,
        );
        let existing_identity = canonicalize_market_identity(
            existing_asset.instrument_type.clone(),
            existing_asset
                .instrument_symbol
                .as_deref()
                .or(existing_asset.display_code.as_deref()),
            existing_asset.instrument_exchange_mic.as_deref(),
            Some(existing_asset.quote_ccy.as_str()),
        );

        if let Some(submitted_type) = submitted_instrument_type {
            if existing_asset.instrument_type.as_ref() != Some(submitted_type) {
                return false;
            }
        }

        if let Some(submitted_symbol) = submitted_identity.instrument_symbol.as_deref() {
            if Some(submitted_symbol) != existing_identity.instrument_symbol.as_deref() {
                return false;
            }
        }

        match submitted_instrument_type.or(existing_asset.instrument_type.as_ref()) {
            Some(InstrumentType::Crypto | InstrumentType::Fx) => {
                if let Some(submitted_quote_ccy) = submitted_identity.quote_ccy.as_deref() {
                    return Some(submitted_quote_ccy) == existing_identity.quote_ccy.as_deref();
                }
                true
            }
            Some(InstrumentType::Option) => true,
            _ => {
                if let Some(submitted_mic) = submitted_identity.instrument_exchange_mic.as_deref() {
                    return Some(submitted_mic)
                        == existing_identity.instrument_exchange_mic.as_deref();
                }
                true
            }
        }
    }

    fn resolved_submitted_asset_id(
        &self,
        submitted_asset_id: Option<&str>,
        submitted_symbol: Option<&str>,
        submitted_exchange_mic: Option<&str>,
        submitted_instrument_type: Option<&InstrumentType>,
        submitted_quote_ccy: Option<&str>,
    ) -> Result<Option<String>> {
        let Some(asset_id) = submitted_asset_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            return Ok(None);
        };

        let has_identity = Self::has_submitted_asset_identity(
            submitted_symbol,
            submitted_exchange_mic,
            submitted_instrument_type,
            submitted_quote_ccy,
        );

        match self.asset_service.get_asset_by_id(asset_id) {
            Ok(existing_asset) => {
                if has_identity
                    && !Self::asset_matches_submitted_identity(
                        &existing_asset,
                        submitted_symbol,
                        submitted_exchange_mic,
                        submitted_instrument_type,
                        submitted_quote_ccy,
                    )
                {
                    Ok(None)
                } else {
                    Ok(Some(asset_id.to_string()))
                }
            }
            Err(err) if has_identity && Self::is_asset_not_found_error(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Finds an existing asset by instrument fields, searching all assets.
    fn find_existing_asset_id(
        &self,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<&InstrumentType>,
        quote_ccy: Option<&str>,
    ) -> Option<String> {
        let assets = self.asset_service.get_assets().unwrap_or_default();
        let upper_symbol = symbol.to_uppercase();
        let expected_key = instrument_type.and_then(|itype| match itype {
            InstrumentType::Crypto | InstrumentType::Fx => quote_ccy.and_then(|ccy| {
                let normalized_ccy = ccy.trim().to_uppercase();
                if normalized_ccy.is_empty() {
                    None
                } else {
                    Some(format!(
                        "{}:{}/{}",
                        itype.as_db_str(),
                        upper_symbol,
                        normalized_ccy
                    ))
                }
            }),
            _ => exchange_mic
                .filter(|mic| !mic.trim().is_empty())
                .map(|mic| {
                    format!(
                        "{}:{}@{}",
                        itype.as_db_str(),
                        upper_symbol,
                        mic.trim().to_uppercase()
                    )
                })
                .or_else(|| Some(format!("{}:{}", itype.as_db_str(), upper_symbol))),
        });

        // Fallback key for OCC option symbols that were previously misclassified
        // as EQUITY due to exchange MIC taking priority over OCC heuristic.
        // Must mirror the key format the old code would have produced (with MIC when present).
        let fallback_equity_key = if matches!(instrument_type, Some(InstrumentType::Option)) {
            exchange_mic
                .filter(|mic| !mic.trim().is_empty())
                .map(|mic| {
                    format!(
                        "{}:{}@{}",
                        InstrumentType::Equity.as_db_str(),
                        upper_symbol,
                        mic.trim().to_uppercase()
                    )
                })
                .or_else(|| {
                    Some(format!(
                        "{}:{}",
                        InstrumentType::Equity.as_db_str(),
                        upper_symbol,
                    ))
                })
        } else {
            None
        };

        if let Some(ref key) = expected_key {
            // Pass 1: exact instrument key match
            for asset in &assets {
                if asset.instrument_key.as_deref() == Some(key) {
                    return Some(asset.id.clone());
                }
            }
            // Pass 2: fallback for legacy misclassified options
            if let Some(ref fallback) = fallback_equity_key {
                for asset in &assets {
                    if asset.instrument_key.as_deref() == Some(fallback.as_str()) {
                        return Some(asset.id.clone());
                    }
                }
            }
        }

        for asset in &assets {
            if let (Some(ref a_symbol), Some(ref a_type)) =
                (&asset.instrument_symbol, &asset.instrument_type)
            {
                let type_matches = instrument_type.is_none_or(|t| t == a_type);
                let symbol_matches = a_symbol.to_uppercase() == upper_symbol;
                let mic_matches = if matches!(a_type, InstrumentType::Option) {
                    // OCC option ticker is globally unique; tolerate legacy MIC mismatch to avoid duplicates.
                    match (exchange_mic, &asset.instrument_exchange_mic) {
                        (Some(mic), Some(a_mic)) => mic.eq_ignore_ascii_case(a_mic),
                        _ => true,
                    }
                } else {
                    match (exchange_mic, &asset.instrument_exchange_mic) {
                        (Some(mic), Some(a_mic)) => mic.eq_ignore_ascii_case(a_mic),
                        (None, None) => true,
                        _ => false,
                    }
                };
                let ccy_matches = if matches!(a_type, InstrumentType::Crypto | InstrumentType::Fx) {
                    quote_ccy.is_none_or(|ccy| asset.quote_ccy.eq_ignore_ascii_case(ccy))
                } else {
                    true
                };
                if type_matches && symbol_matches && mic_matches && ccy_matches {
                    return Some(asset.id.clone());
                }
            }
        }
        None
    }

    async fn prepare_new_activity(&self, mut activity: NewActivity) -> Result<NewActivity> {
        activity.subtype = NewActivity::canonicalize_subtype(activity.subtype.as_deref());
        Self::normalize_new_activity_economic_signs(&mut activity);
        let account: Account = self.account_service.get_account(&activity.account_id)?;
        let base_ccy = self.account_service.get_base_currency().unwrap_or_default();
        let account_currency = resolve_currency(&[&account.currency, &base_ccy]);

        let currency = resolve_currency(&[&activity.currency, &account_currency, &base_ccy]);
        Self::validate_new_activity_income_values(&activity)?;

        if activity.activity_type == ACTIVITY_TYPE_SPLIT {
            activity.amount = activity.amount.map(|v| v.abs());
            Self::validate_split_ratio(&activity.activity_type, activity.amount)?;
        }

        // Extract asset fields from nested `asset` object
        let symbol = activity.get_symbol_code().map(|s| s.to_string());
        let exchange_mic = activity.get_exchange_mic().map(|s| s.to_string());
        let asset_kind_input = activity.get_kind().map(|s| s.to_string());
        let quote_ccy_input = Self::normalize_quote_ccy(activity.get_quote_ccy());
        let instrument_type_input = Self::parse_instrument_type(activity.get_instrument_type());
        let asset_name = activity.get_name().map(|s| s.to_string());
        let quote_mode = activity.get_quote_mode().map(|s| s.to_string());
        let parsed_quote_mode =
            quote_mode
                .as_deref()
                .and_then(|mode| match mode.to_uppercase().as_str() {
                    "MANUAL" => Some(QuoteMode::Manual),
                    "MARKET" => Some(QuoteMode::Market),
                    _ => None,
                });

        let inferred = symbol.as_deref().map(|s| {
            self.infer_asset_kind(s, exchange_mic.as_deref(), asset_kind_input.as_deref())
        });
        let inferred_instrument_type = inferred.as_ref().and_then(|(_, it)| it.clone());
        let effective_instrument_type = instrument_type_input
            .clone()
            .or(inferred_instrument_type.clone());
        let effective_kind = instrument_type_input
            .as_ref()
            .map(Self::kind_from_instrument_type)
            .or_else(|| inferred.as_ref().map(|(kind, _)| kind.clone()));

        // Normalize symbol + MIC using payload/suffix only (no live lookup for user save paths).
        let is_crypto = effective_instrument_type.as_ref() == Some(&InstrumentType::Crypto);
        let is_option = effective_instrument_type.as_ref() == Some(&InstrumentType::Option);
        let is_non_security_instrument = matches!(
            effective_instrument_type.as_ref(),
            Some(InstrumentType::Crypto | InstrumentType::Fx)
        );
        let (base_symbol, suffix_mic) = symbol
            .as_deref()
            .map(parse_symbol_with_exchange_suffix)
            .unwrap_or(("", None));
        let exchange_mic = if is_non_security_instrument {
            None
        } else {
            exchange_mic.or_else(|| suffix_mic.map(|mic| mic.to_string()))
        };
        let normalized_symbol_for_lookup = if base_symbol.is_empty() {
            None
        } else if is_crypto {
            Some(
                parse_crypto_pair_symbol(base_symbol)
                    .map(|(base, _)| base)
                    .unwrap_or_else(|| base_symbol.to_string()),
            )
        } else if is_option {
            // Normalize broker-specific option symbols (e.g. Fidelity's "-MU270115C600")
            // to standard OCC format before storing.
            Some(
                crate::utils::occ_symbol::normalize_option_symbol(base_symbol)
                    .unwrap_or_else(|| base_symbol.to_string()),
            )
        } else {
            Some(base_symbol.to_string())
        };
        let submitted_asset_id = self.resolved_submitted_asset_id(
            activity.get_symbol_id(),
            normalized_symbol_for_lookup.as_deref(),
            exchange_mic.as_deref(),
            effective_instrument_type.as_ref(),
            quote_ccy_input.as_deref(),
        )?;
        if let Some(asset_input) = activity.asset.as_mut() {
            asset_input.id = submitted_asset_id.clone();
        }

        match symbol.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw_symbol) => {
                if is_garbage_symbol(raw_symbol) {
                    return Err(ActivityError::InvalidData(format!(
                        "Invalid symbol '{}'. Please search for a valid ticker.",
                        raw_symbol
                    ))
                    .into());
                }

                self.asset_service.validate_persisted_symbol_metadata(
                    normalized_symbol_for_lookup
                        .as_deref()
                        .unwrap_or(raw_symbol),
                    submitted_asset_id.as_deref(),
                    exchange_mic.as_deref(),
                    effective_instrument_type.as_ref(),
                    parsed_quote_mode,
                    quote_ccy_input.as_deref(),
                )?;
            }
            None if activity
                .get_symbol_id()
                .filter(|id| !id.trim().is_empty())
                .is_none()
                && Self::requires_asset_identity(
                    &activity.activity_type,
                    activity.subtype.as_deref(),
                ) =>
            {
                return Err(ActivityError::InvalidData(
                    "Asset-backed activities need either asset_id or symbol".to_string(),
                )
                .into());
            }
            None => {}
        }

        let quote_lookup_symbol = normalized_symbol_for_lookup.clone().unwrap_or_default();

        // Use pair quote for crypto/FX; otherwise resolve from payload and existing data:
        // explicit input -> existing asset -> MIC fallback -> activity/account.
        let mut quote_ccy_for_asset = quote_ccy_input.clone();
        let asset_currency = if is_crypto {
            symbol
                .as_deref()
                .and_then(parse_crypto_pair_symbol)
                .map(|(_, quote)| quote)
                .or_else(|| quote_ccy_input.clone())
                .unwrap_or_else(|| currency.clone())
        } else if is_non_security_instrument {
            quote_ccy_input.clone().unwrap_or(currency.clone())
        } else {
            let existing_asset_quote_ccy = self
                .existing_asset_quote_ccy_by_id(submitted_asset_id.as_deref())
                .or_else(|| {
                    normalized_symbol_for_lookup
                        .as_deref()
                        .and_then(|resolved_symbol| {
                            self.asset_service.existing_quote_ccy_by_symbol(
                                resolved_symbol,
                                exchange_mic.as_deref(),
                                effective_instrument_type.as_ref(),
                            )
                        })
                });
            let (resolved_quote_ccy, resolution_source) = self
                .resolve_quote_ccy(
                    quote_lookup_symbol.as_str(),
                    exchange_mic.as_deref(),
                    effective_instrument_type.as_ref(),
                    quote_ccy_input.as_deref(),
                    existing_asset_quote_ccy.as_deref(),
                    currency.as_str(),
                    false,
                )
                .await;
            if matches!(
                resolution_source,
                QuoteCcyResolutionSource::ExplicitInput | QuoteCcyResolutionSource::ProviderQuote
            ) {
                quote_ccy_for_asset = Some(resolved_quote_ccy.clone());
            }
            resolved_quote_ccy
        };

        // Resolve asset_id:
        // 1. If symbol is provided, search existing assets or prepare for creation
        // 2. If only asset.id is provided (UUID), use it directly
        // 3. Cash activities: no asset
        let resolved_asset_id = if let Some(ref normalized_symbol) = normalized_symbol_for_lookup {
            // Look up existing asset by instrument fields
            let existing_id = self
                .find_existing_asset_id(
                    normalized_symbol,
                    exchange_mic.as_deref(),
                    effective_instrument_type.as_ref(),
                    Some(&asset_currency),
                )
                .or_else(|| submitted_asset_id.clone());

            if let Some(id) = existing_id {
                Some(id)
            } else {
                // Create new asset with generated UUID
                let new_id = Uuid::new_v4().to_string();

                // Build structured metadata for option/bond/metal assets
                let structured_metadata = if let Some(mult) =
                    Self::custom_option_multiplier(activity.metadata.as_deref())
                {
                    crate::assets::build_option_metadata(normalized_symbol, mult)
                } else {
                    crate::assets::build_asset_metadata(
                        effective_instrument_type.as_ref(),
                        normalized_symbol,
                    )
                };

                let metadata = crate::assets::AssetMetadata {
                    name: asset_name.clone(),
                    kind: effective_kind.clone(),
                    instrument_exchange_mic: exchange_mic.clone(),
                    instrument_symbol: Some(normalized_symbol.clone()),
                    instrument_type: effective_instrument_type.clone(),
                    display_code: Some(normalized_symbol.clone()),
                    requested_quote_ccy: quote_ccy_for_asset.clone(),
                    asset_metadata: structured_metadata,
                };
                self.asset_service
                    .get_or_create_minimal_asset(
                        &new_id,
                        Some(asset_currency.clone()),
                        Some(metadata),
                        quote_mode.clone(),
                    )
                    .await?;
                Some(new_id)
            }
        } else if let Some(asset_id) = submitted_asset_id.as_deref() {
            // Existing asset_id provided (UUID from frontend)
            Some(asset_id.to_string())
        } else if !Self::requires_asset_identity(
            &activity.activity_type,
            activity.subtype.as_deref(),
        ) {
            None // Symbol-optional types have no asset when symbol is absent
        } else {
            return Err(ActivityError::InvalidData(
                "Asset-backed activities need either asset_id or symbol".to_string(),
            )
            .into());
        };

        // Update activity's asset with resolved asset_id
        if let Some(ref resolved_id) = resolved_asset_id {
            match activity.asset.as_mut() {
                Some(asset) => asset.id = Some(resolved_id.clone()),
                None => {
                    activity.asset = Some(AssetResolutionInput {
                        id: Some(resolved_id.clone()),
                        ..Default::default()
                    });
                }
            }
        }

        // Process asset if asset_id is resolved
        if let Some(ref asset_id) = resolved_asset_id {
            let canonical_symbol = normalized_symbol_for_lookup.clone();
            let metadata = crate::assets::AssetMetadata {
                name: asset_name.clone(),
                kind: effective_kind,
                instrument_exchange_mic: exchange_mic.clone(),
                instrument_symbol: canonical_symbol.clone(),
                instrument_type: effective_instrument_type.clone(),
                display_code: canonical_symbol,
                requested_quote_ccy: quote_ccy_for_asset.clone(),
                asset_metadata: None,
            };
            let mut asset = if normalized_symbol_for_lookup.is_none() {
                self.asset_service.get_asset_by_id(asset_id)?
            } else {
                self.asset_service
                    .get_or_create_minimal_asset(
                        asset_id,
                        Some(asset_currency.clone()),
                        Some(metadata),
                        quote_mode.clone(),
                    )
                    .await?
            };

            // Update asset quote mode if specified (for existing assets that need mode change)
            if let Some(ref mode) = quote_mode {
                let requested_mode = mode.to_uppercase();
                let current_mode = asset.quote_mode.as_db_str();
                if requested_mode != current_mode {
                    asset = self
                        .asset_service
                        .update_quote_mode_silent(&asset.id, &requested_mode)
                        .await?;
                }
            }

            // Create a quote from the activity price as a fallback, but only
            // for MANUAL-mode assets. For MARKET-mode assets the unit price is
            // a cost input, not a market price, and writing it here would
            // shadow provider quotes.
            let is_manual_mode = asset.quote_mode == QuoteMode::Manual
                || matches!(parsed_quote_mode, Some(QuoteMode::Manual));
            if is_manual_mode
                && PRICE_BEARING_ACTIVITY_TYPES.contains(&activity.activity_type.as_str())
            {
                if let Some(unit_price) = activity.unit_price {
                    let source = DATA_SOURCE_MANUAL.to_string();
                    self.create_quote_from_activity(
                        asset_id,
                        unit_price,
                        &currency,
                        &activity.activity_date,
                        source,
                    )
                    .await?;
                }
            }

            if activity.currency.is_empty() {
                activity.currency = asset.quote_ccy.clone();
            }

            // Register FX pair for activity currency if different from account currency
            if activity.currency != account_currency {
                self.fx_service
                    .register_currency_pair(activity.currency.as_str(), account_currency.as_str())
                    .await?;
            }

            // Register FX pair for asset currency if different from account currency
            if asset.quote_ccy != account_currency && asset.quote_ccy != activity.currency {
                self.fx_service
                    .register_currency_pair(asset.quote_ccy.as_str(), account_currency.as_str())
                    .await?;
            }
        } else {
            // For pure cash movements without asset, just register FX if needed
            if activity.currency.is_empty() {
                activity.currency = self.resolve_activity_currency("", None, &account_currency);
            }

            if activity.currency != account_currency {
                self.fx_service
                    .register_currency_pair(activity.currency.as_str(), account_currency.as_str())
                    .await?;
            }
        }

        // Normalize amounts to absolute values (direction is determined by activity type)
        activity.quantity = activity.quantity.map(|v| v.abs());
        activity.unit_price = activity.unit_price.map(|v| v.abs());
        activity.amount = activity.amount.map(|v| v.abs());
        activity.fee = activity.fee.map(|v| v.abs());

        // Securities transfers derive monetary value from quantity × unit_price at
        // read time. Any inbound `amount` is redundant and has historically been
        // a source of corruption (e.g. amount = qty² × unit_price stored on the
        // row). Clear it only when unit_price is present so legacy imports that
        // carry qty + amount (no unit_price) keep their monetary value.
        if is_securities_transfer(&activity.activity_type, resolved_asset_id.as_deref())
            && activity.unit_price.is_some()
        {
            activity.amount = None;
        }

        // Normalize minor currency units (e.g., GBp -> GBP) and convert amounts
        if get_normalization_rule(&activity.currency).is_some() {
            if let Some(unit_price) = activity.unit_price {
                let (normalized_price, _) = normalize_amount(unit_price, &activity.currency);
                activity.unit_price = Some(normalized_price);
            }
            if let Some(amount) = activity.amount {
                let (normalized_amount, _) = normalize_amount(amount, &activity.currency);
                activity.amount = Some(normalized_amount);
            }
            if let Some(fee) = activity.fee {
                let (normalized_fee, normalized_currency) =
                    normalize_amount(fee, &activity.currency);
                activity.fee = Some(normalized_fee);
                activity.currency = normalized_currency.to_string();
            } else {
                let (_, normalized_currency) = normalize_amount(Decimal::ZERO, &activity.currency);
                activity.currency = normalized_currency.to_string();
            }
        }

        // Preserve explicit idempotency key when provided (e.g., intentional manual duplicates).
        // Otherwise compute a stable content-based key for deduplication.
        let explicit_idempotency_key = activity
            .idempotency_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        if let Some(key) = explicit_idempotency_key {
            activity.idempotency_key = Some(key);
        } else if let Ok(date) = DateTime::parse_from_rfc3339(&activity.activity_date)
            .map(|dt| dt.with_timezone(&Utc))
            .or_else(|_| {
                NaiveDate::parse_from_str(&activity.activity_date, "%Y-%m-%d")
                    .map(|d| Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default()))
            })
        {
            let key = compute_idempotency_key(
                &activity.account_id,
                &activity.activity_type,
                &date,
                activity.get_symbol_id(),
                activity.quantity,
                activity.unit_price,
                activity.amount,
                &activity.currency,
                activity.source_record_id.as_deref(),
                activity.notes.as_deref(),
            );
            activity.idempotency_key = Some(key);
        }

        if let Some(key) = activity.idempotency_key.as_ref() {
            let existing = self
                .activity_repository
                .check_existing_duplicates(std::slice::from_ref(key))?;
            if let Some(existing_activity_id) = existing.get(key) {
                return Err(Self::duplicate_activity_error(Some(existing_activity_id)));
            }
        }

        Ok(activity)
    }

    async fn prepare_update_activity(
        &self,
        mut activity: ActivityUpdate,
    ) -> Result<ActivityUpdate> {
        let account: Account = self.account_service.get_account(&activity.account_id)?;
        let base_ccy = self.account_service.get_base_currency().unwrap_or_default();
        let account_currency = resolve_currency(&[&account.currency, &base_ccy]);
        let currency = resolve_currency(&[&activity.currency, &account_currency]);

        if activity.activity_type == ACTIVITY_TYPE_SPLIT {
            activity.amount = activity.amount.map(|v| v.map(|d| d.abs()));
            self.validate_split_ratio_update(
                &activity.id,
                &activity.activity_type,
                activity.amount,
            )?;
        }

        // Extract asset fields
        let symbol = activity.get_symbol_code().map(|s| s.to_string());
        let exchange_mic = activity.get_exchange_mic().map(|s| s.to_string());
        let asset_kind_input = activity.get_kind().map(|s| s.to_string());
        let quote_ccy_input = Self::normalize_quote_ccy(activity.get_quote_ccy());
        let instrument_type_input = Self::parse_instrument_type(activity.get_instrument_type());
        let asset_name = activity.get_name().map(|s| s.to_string());
        let quote_mode = activity.get_quote_mode().map(|s| s.to_string());
        let parsed_quote_mode =
            quote_mode
                .as_deref()
                .and_then(|mode| match mode.to_uppercase().as_str() {
                    "MANUAL" => Some(QuoteMode::Manual),
                    "MARKET" => Some(QuoteMode::Market),
                    _ => None,
                });

        let inferred = symbol.as_deref().map(|s| {
            self.infer_asset_kind(s, exchange_mic.as_deref(), asset_kind_input.as_deref())
        });
        let inferred_instrument_type = inferred.as_ref().and_then(|(_, it)| it.clone());
        let effective_instrument_type = instrument_type_input
            .clone()
            .or(inferred_instrument_type.clone());
        let effective_kind = instrument_type_input
            .as_ref()
            .map(Self::kind_from_instrument_type)
            .or_else(|| inferred.as_ref().map(|(kind, _)| kind.clone()));

        // Normalize symbol + MIC using payload/suffix only (no live lookup for user save paths).
        let is_crypto = effective_instrument_type.as_ref() == Some(&InstrumentType::Crypto);
        let is_non_security_instrument = matches!(
            effective_instrument_type.as_ref(),
            Some(InstrumentType::Crypto | InstrumentType::Fx)
        );
        let (base_symbol, suffix_mic) = symbol
            .as_deref()
            .map(parse_symbol_with_exchange_suffix)
            .unwrap_or(("", None));
        let exchange_mic = if is_non_security_instrument {
            None
        } else {
            exchange_mic.or_else(|| suffix_mic.map(|mic| mic.to_string()))
        };
        let is_option = effective_instrument_type.as_ref() == Some(&InstrumentType::Option);
        let normalized_symbol_for_lookup = if base_symbol.is_empty() {
            None
        } else if is_crypto {
            Some(
                parse_crypto_pair_symbol(base_symbol)
                    .map(|(base, _)| base)
                    .unwrap_or_else(|| base_symbol.to_string()),
            )
        } else if is_option {
            Some(
                crate::utils::occ_symbol::normalize_option_symbol(base_symbol)
                    .unwrap_or_else(|| base_symbol.to_string()),
            )
        } else {
            Some(base_symbol.to_string())
        };
        let submitted_asset_id = self.resolved_submitted_asset_id(
            activity.get_symbol_id(),
            normalized_symbol_for_lookup.as_deref(),
            exchange_mic.as_deref(),
            effective_instrument_type.as_ref(),
            quote_ccy_input.as_deref(),
        )?;
        if let Some(asset_input) = activity.asset.as_mut() {
            asset_input.id = submitted_asset_id.clone();
        }

        match symbol.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw_symbol) => {
                if is_garbage_symbol(raw_symbol) {
                    return Err(ActivityError::InvalidData(format!(
                        "Invalid symbol '{}'. Please search for a valid ticker.",
                        raw_symbol
                    ))
                    .into());
                }

                self.asset_service.validate_persisted_symbol_metadata(
                    normalized_symbol_for_lookup
                        .as_deref()
                        .unwrap_or(raw_symbol),
                    submitted_asset_id.as_deref(),
                    exchange_mic.as_deref(),
                    effective_instrument_type.as_ref(),
                    parsed_quote_mode,
                    quote_ccy_input.as_deref(),
                )?;
            }
            None if activity
                .get_symbol_id()
                .filter(|id| !id.trim().is_empty())
                .is_none()
                && Self::requires_asset_identity(
                    &activity.activity_type,
                    activity.subtype.as_deref(),
                ) =>
            {
                return Err(ActivityError::InvalidData(
                    "Asset-backed activities need either asset_id or symbol".to_string(),
                )
                .into());
            }
            None => {}
        }

        let quote_lookup_symbol = normalized_symbol_for_lookup.clone().unwrap_or_default();
        let mut quote_ccy_for_asset = quote_ccy_input.clone();
        let asset_currency = if is_crypto {
            symbol
                .as_deref()
                .and_then(parse_crypto_pair_symbol)
                .map(|(_, quote)| quote)
                .or_else(|| quote_ccy_input.clone())
                .unwrap_or_else(|| currency.clone())
        } else if is_non_security_instrument {
            quote_ccy_input.clone().unwrap_or(currency.clone())
        } else {
            let existing_asset_quote_ccy = self
                .existing_asset_quote_ccy_by_id(submitted_asset_id.as_deref())
                .or_else(|| {
                    normalized_symbol_for_lookup
                        .as_deref()
                        .and_then(|resolved_symbol| {
                            self.asset_service.existing_quote_ccy_by_symbol(
                                resolved_symbol,
                                exchange_mic.as_deref(),
                                effective_instrument_type.as_ref(),
                            )
                        })
                });
            let (resolved_quote_ccy, resolution_source) = self
                .resolve_quote_ccy(
                    quote_lookup_symbol.as_str(),
                    exchange_mic.as_deref(),
                    effective_instrument_type.as_ref(),
                    quote_ccy_input.as_deref(),
                    existing_asset_quote_ccy.as_deref(),
                    currency.as_str(),
                    false,
                )
                .await;
            if matches!(
                resolution_source,
                QuoteCcyResolutionSource::ExplicitInput | QuoteCcyResolutionSource::ProviderQuote
            ) {
                quote_ccy_for_asset = Some(resolved_quote_ccy.clone());
            }
            resolved_quote_ccy
        };

        // Resolve asset_id (same logic as prepare_new_activity)
        let resolved_asset_id = if let Some(ref normalized_symbol) = normalized_symbol_for_lookup {
            let existing_id = self
                .find_existing_asset_id(
                    normalized_symbol,
                    exchange_mic.as_deref(),
                    effective_instrument_type.as_ref(),
                    Some(&asset_currency),
                )
                .or_else(|| submitted_asset_id.clone());

            if let Some(id) = existing_id {
                Some(id)
            } else {
                let new_id = Uuid::new_v4().to_string();
                let structured_metadata = if let Some(mult) =
                    Self::custom_option_multiplier(activity.metadata.as_deref())
                {
                    crate::assets::build_option_metadata(normalized_symbol, mult)
                } else {
                    crate::assets::build_asset_metadata(
                        effective_instrument_type.as_ref(),
                        normalized_symbol,
                    )
                };
                let metadata = crate::assets::AssetMetadata {
                    name: asset_name.clone(),
                    kind: effective_kind.clone(),
                    instrument_exchange_mic: exchange_mic.clone(),
                    instrument_symbol: Some(normalized_symbol.clone()),
                    instrument_type: effective_instrument_type.clone(),
                    display_code: Some(normalized_symbol.clone()),
                    requested_quote_ccy: quote_ccy_for_asset.clone(),
                    asset_metadata: structured_metadata,
                };
                self.asset_service
                    .get_or_create_minimal_asset(
                        &new_id,
                        Some(asset_currency.clone()),
                        Some(metadata),
                        quote_mode.clone(),
                    )
                    .await?;
                Some(new_id)
            }
        } else if let Some(asset_id) = submitted_asset_id.as_deref() {
            Some(asset_id.to_string())
        } else if !Self::requires_asset_identity(
            &activity.activity_type,
            activity.subtype.as_deref(),
        ) {
            None
        } else {
            return Err(ActivityError::InvalidData(
                "Asset-backed activities need either asset_id or symbol".to_string(),
            )
            .into());
        };

        // Update activity's asset with resolved asset_id
        if let Some(ref resolved_id) = resolved_asset_id {
            match activity.asset.as_mut() {
                Some(asset) => asset.id = Some(resolved_id.clone()),
                None => {
                    activity.asset = Some(AssetResolutionInput {
                        id: Some(resolved_id.clone()),
                        ..Default::default()
                    });
                }
            }
        }

        // Process asset if asset_id is resolved
        if let Some(ref asset_id) = resolved_asset_id {
            let canonical_symbol = normalized_symbol_for_lookup.clone();
            let metadata = crate::assets::AssetMetadata {
                name: asset_name.clone(),
                kind: effective_kind,
                instrument_exchange_mic: exchange_mic.clone(),
                instrument_symbol: canonical_symbol.clone(),
                instrument_type: effective_instrument_type.clone(),
                display_code: canonical_symbol,
                requested_quote_ccy: quote_ccy_for_asset.clone(),
                asset_metadata: None,
            };
            let mut asset = if normalized_symbol_for_lookup.is_none() {
                self.asset_service.get_asset_by_id(asset_id)?
            } else {
                self.asset_service
                    .get_or_create_minimal_asset(
                        asset_id,
                        Some(asset_currency.clone()),
                        Some(metadata),
                        quote_mode.clone(),
                    )
                    .await?
            };

            // Update asset quote mode if specified
            if let Some(ref mode) = quote_mode {
                let requested_mode = mode.to_uppercase();
                let current_mode = asset.quote_mode.as_db_str();
                if requested_mode != current_mode {
                    asset = self
                        .asset_service
                        .update_quote_mode_silent(&asset.id, &requested_mode)
                        .await?;
                }
            }

            // Create a quote from the activity price as a fallback, but only
            // for MANUAL-mode assets. For MARKET-mode assets the unit price is
            // a cost input, not a market price, and writing it here would
            // shadow provider quotes.
            let is_manual_mode = asset.quote_mode == QuoteMode::Manual
                || matches!(parsed_quote_mode, Some(QuoteMode::Manual));
            if is_manual_mode
                && PRICE_BEARING_ACTIVITY_TYPES.contains(&activity.activity_type.as_str())
            {
                if let Some(Some(unit_price)) = activity.unit_price {
                    let source = DATA_SOURCE_MANUAL.to_string();
                    self.create_quote_from_activity(
                        asset_id,
                        unit_price,
                        &currency,
                        &activity.activity_date,
                        source,
                    )
                    .await?;
                }
            }

            if activity.currency.is_empty() {
                activity.currency = asset.quote_ccy.clone();
            }

            if activity.currency != account_currency {
                self.fx_service
                    .register_currency_pair(activity.currency.as_str(), account_currency.as_str())
                    .await?;
            }

            if asset.quote_ccy != account_currency && asset.quote_ccy != activity.currency {
                self.fx_service
                    .register_currency_pair(asset.quote_ccy.as_str(), account_currency.as_str())
                    .await?;
            }
        } else {
            if activity.currency.is_empty() {
                activity.currency = self.resolve_activity_currency("", None, &account_currency);
            }

            if activity.currency != account_currency {
                self.fx_service
                    .register_currency_pair(activity.currency.as_str(), account_currency.as_str())
                    .await?;
            }
        }

        // Normalize amounts to absolute values (direction is determined by activity type)
        activity.quantity = activity.quantity.map(|v| v.map(|d| d.abs()));
        activity.unit_price = activity.unit_price.map(|v| v.map(|d| d.abs()));
        activity.amount = activity.amount.map(|v| v.map(|d| d.abs()));
        activity.fee = activity.fee.map(|v| v.map(|d| d.abs()));

        // Securities transfers derive value from quantity × unit_price; clear
        // `amount` on update only when the patch carries a unit_price so callers
        // cannot re-introduce a stale value. Legacy rows that lack unit_price
        // rely on amount as their monetary source of truth, so leave amount
        // alone when unit_price isn't being set.
        if is_securities_transfer(&activity.activity_type, resolved_asset_id.as_deref())
            && matches!(activity.unit_price, Some(Some(_)))
        {
            activity.amount = Some(None);
        }

        // Normalize minor currency units
        if get_normalization_rule(&activity.currency).is_some() {
            if let Some(Some(unit_price)) = activity.unit_price {
                let (normalized_price, _) = normalize_amount(unit_price, &activity.currency);
                activity.unit_price = Some(Some(normalized_price));
            }
            if let Some(Some(amount)) = activity.amount {
                let (normalized_amount, _) = normalize_amount(amount, &activity.currency);
                activity.amount = Some(Some(normalized_amount));
            }
            if let Some(Some(fee)) = activity.fee {
                let (normalized_fee, normalized_currency) =
                    normalize_amount(fee, &activity.currency);
                activity.fee = Some(Some(normalized_fee));
                activity.currency = normalized_currency.to_string();
            } else {
                let (_, normalized_currency) =
                    normalize_amount(rust_decimal::Decimal::ZERO, &activity.currency);
                activity.currency = normalized_currency.to_string();
            }
        }

        Ok(activity)
    }

    /// Builds an AssetSpec from a NewActivity.
    /// Returns None for cash activities that don't need an asset.
    async fn build_asset_spec(
        &self,
        activity: &NewActivity,
        account: &Account,
        symbol_mic_cache: &HashMap<String, Option<String>>,
        mode: PreparationMode,
        quote_ccy_cache: &mut QuoteCcyCache,
    ) -> Result<Option<crate::assets::AssetSpec>> {
        use crate::assets::{parse_crypto_pair_symbol, AssetSpec};

        let base_ccy = self.account_service.get_base_currency().unwrap_or_default();
        let account_currency = resolve_currency(&[&account.currency, &base_ccy]);
        let quote_ccy_input = Self::normalize_quote_ccy(activity.get_quote_ccy());

        let symbol = match activity.get_symbol_code() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                // No symbol provided - check if we have an asset_id directly (UUID)
                if let Some(asset_id) = activity.get_symbol_id() {
                    if !asset_id.is_empty() {
                        let asset_id = self
                            .resolved_submitted_asset_id(
                                Some(asset_id),
                                None,
                                None,
                                None,
                                quote_ccy_input.as_deref(),
                            )?
                            .ok_or_else(|| {
                                ActivityError::InvalidData(
                                    "Asset-backed activity needs symbol or asset_id".to_string(),
                                )
                            })?;
                        let existing_asset = self.asset_service.get_asset_by_id(&asset_id)?;

                        // asset_id is a UUID; use the existing asset to build the spec
                        let currency = Self::normalize_quote_ccy(activity.get_quote_ccy())
                            .or_else(|| {
                                if !activity.currency.is_empty() {
                                    Some(activity.currency.clone())
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(existing_asset.quote_ccy);

                        let quote_mode = activity.get_quote_mode().and_then(|s| {
                            match s.to_uppercase().as_str() {
                                "MARKET" => Some(QuoteMode::Market),
                                "MANUAL" => Some(QuoteMode::Manual),
                                _ => None,
                            }
                        });

                        return Ok(Some(AssetSpec {
                            id: Some(asset_id),
                            display_code: None,
                            instrument_symbol: None,
                            instrument_exchange_mic: None,
                            instrument_type: None,
                            quote_ccy: currency,
                            requested_quote_ccy: quote_ccy_input.clone(),
                            kind: AssetKind::Investment,
                            quote_mode,
                            name: activity.get_name().map(|s| s.to_string()),
                            metadata: None,
                        }));
                    }
                }
                // Symbol-optional types with no symbol → no asset needed
                if !Self::requires_asset_identity(
                    &activity.activity_type,
                    activity.subtype.as_deref(),
                ) {
                    return Ok(None);
                }
                return Err(ActivityError::InvalidData(
                    "Asset-backed activity needs symbol or asset_id".to_string(),
                )
                .into());
            }
        };

        if is_garbage_symbol(symbol.as_str()) {
            return Err(ActivityError::InvalidData(format!(
                "Invalid symbol '{}'. Please search for a valid ticker.",
                symbol
            ))
            .into());
        }

        // Strip Yahoo suffix from symbol (e.g. GOOG.TO → GOOG + XTSE)
        let (base_symbol, suffix_mic) = parse_symbol_with_exchange_suffix(&symbol);

        // Get exchange MIC: prefer explicit value, then cache, then suffix-derived
        let allow_live_resolution = mode.allows_live_resolution();
        let cached_exchange_mic = if allow_live_resolution {
            symbol_mic_cache.get(&symbol).cloned().flatten()
        } else {
            None
        };
        let exchange_mic = activity
            .get_exchange_mic()
            .map(|s| s.to_string())
            .or(cached_exchange_mic)
            .or_else(|| suffix_mic.map(|s| s.to_string()));

        // Determine currency
        let currency = if !activity.currency.is_empty() {
            activity.currency.clone()
        } else {
            account_currency.clone()
        };

        let instrument_type_input = Self::parse_instrument_type(activity.get_instrument_type());

        // Infer asset kind and instrument type using base symbol
        let (inferred_kind, inferred_instrument_type) =
            self.infer_asset_kind(base_symbol, exchange_mic.as_deref(), activity.get_kind());
        let instrument_type = instrument_type_input.clone().or(inferred_instrument_type);
        let kind = instrument_type_input
            .as_ref()
            .map(Self::kind_from_instrument_type)
            .unwrap_or(inferred_kind);

        // Parse quote mode if provided
        let quote_mode = activity
            .get_quote_mode()
            .and_then(|s| match s.to_uppercase().as_str() {
                "MARKET" => Some(QuoteMode::Market),
                "MANUAL" => Some(QuoteMode::Manual),
                _ => None,
            });

        // Crypto/FX assets don't have exchange MICs — clear any that leaked from frontend/suffix
        let is_crypto = instrument_type.as_ref() == Some(&InstrumentType::Crypto);
        let is_non_security = matches!(
            instrument_type.as_ref(),
            Some(InstrumentType::Crypto | InstrumentType::Fx)
        );
        let is_option = instrument_type.as_ref() == Some(&InstrumentType::Option);
        // OCC option symbols are globally unique — exchange MIC would fragment identity
        let exchange_mic = if is_non_security || is_option {
            None
        } else {
            exchange_mic
        };
        let normalized_symbol = if is_crypto {
            parse_crypto_pair_symbol(base_symbol)
                .map(|(base, _)| base)
                .unwrap_or_else(|| base_symbol.to_string())
        } else if is_option {
            crate::utils::occ_symbol::normalize_option_symbol(base_symbol)
                .unwrap_or_else(|| base_symbol.to_string())
        } else {
            base_symbol.to_string()
        };
        let submitted_asset_id = self.resolved_submitted_asset_id(
            activity.get_symbol_id(),
            Some(normalized_symbol.as_str()),
            exchange_mic.as_deref(),
            instrument_type.as_ref(),
            quote_ccy_input.as_deref(),
        )?;
        let quote_lookup_symbol = normalized_symbol.clone();

        if !allow_live_resolution {
            self.asset_service.validate_persisted_symbol_metadata(
                normalized_symbol.as_str(),
                submitted_asset_id.as_deref(),
                exchange_mic.as_deref(),
                instrument_type.as_ref(),
                quote_mode,
                quote_ccy_input.as_deref(),
            )?;
        }

        // For crypto, use the quote currency from the pair if available
        let mut quote_ccy_for_asset = quote_ccy_input.clone();
        let asset_currency = if is_crypto {
            parse_crypto_pair_symbol(base_symbol)
                .map(|(_, quote)| quote)
                .or_else(|| quote_ccy_input.clone())
                .unwrap_or_else(|| currency.clone())
        } else {
            let existing_asset_quote_ccy = self
                .existing_asset_quote_ccy_by_id(submitted_asset_id.as_deref())
                .or_else(|| {
                    self.asset_service.existing_quote_ccy_by_symbol(
                        normalized_symbol.as_str(),
                        exchange_mic.as_deref(),
                        instrument_type.as_ref(),
                    )
                });
            let allow_provider_lookup = allow_live_resolution
                && quote_mode != Some(QuoteMode::Manual)
                && !matches!(
                    instrument_type.as_ref(),
                    Some(InstrumentType::Crypto | InstrumentType::Fx)
                );
            let has_deterministic_precedence = normalize_quote_ccy_code(quote_ccy_input.as_deref())
                .is_some()
                || normalize_quote_ccy_code(existing_asset_quote_ccy.as_deref()).is_some();
            let provider_ccy = if allow_provider_lookup && !has_deterministic_precedence {
                self.fetch_provider_quote_ccy(
                    quote_lookup_symbol.as_str(),
                    exchange_mic.as_deref(),
                    instrument_type.as_ref(),
                    quote_ccy_cache,
                )
                .await
            } else {
                None
            };
            let (resolved_quote_ccy, resolution_source) = resolve_quote_ccy_precedence(
                quote_ccy_input.as_deref(),
                existing_asset_quote_ccy.as_deref(),
                provider_ccy.as_deref(),
                exchange_mic.as_deref().and_then(mic_to_currency),
                Some(currency.as_str()),
            )
            .unwrap_or_else(|| (currency.clone(), QuoteCcyResolutionSource::TerminalFallback));
            if matches!(
                resolution_source,
                QuoteCcyResolutionSource::ExplicitInput | QuoteCcyResolutionSource::ProviderQuote
            ) {
                quote_ccy_for_asset = Some(resolved_quote_ccy.clone());
            }
            resolved_quote_ccy
        };

        // Look up existing asset by instrument fields to get its UUID
        let existing_id = self
            .find_existing_asset_id(
                &normalized_symbol,
                exchange_mic.as_deref(),
                instrument_type.as_ref(),
                Some(&asset_currency),
            )
            .or(submitted_asset_id);

        Ok(Some(AssetSpec {
            id: existing_id,
            display_code: Some(normalized_symbol.clone()),
            instrument_symbol: Some(normalized_symbol.clone()),
            instrument_exchange_mic: exchange_mic,
            instrument_type,
            quote_ccy: asset_currency,
            requested_quote_ccy: quote_ccy_for_asset,
            kind,
            quote_mode,
            name: activity.get_name().map(|s| s.to_string()),
            metadata: None,
        }))
    }

    /// Validates currency codes on an activity, marking invalid if malformed.
    fn validate_currency(&self, activity: &mut ActivityImport, account_currency: &str) {
        if activity.currency.is_empty() {
            activity.is_valid = false;
            let mut errors = activity.errors.take().unwrap_or_default();
            errors
                .entry("currency".to_string())
                .or_default()
                .push("Activity currency is missing in the import data.".to_string());
            activity.errors = Some(errors);
        } else if activity.currency != account_currency {
            let from = account_currency;
            let to = &activity.currency;
            if from.len() != 3
                || !from.chars().all(|c| c.is_alphabetic())
                || to.len() != 3
                || !to.chars().all(|c| c.is_alphabetic())
            {
                activity.is_valid = false;
                let mut errors = activity.errors.take().unwrap_or_default();
                errors
                    .entry("currency".to_string())
                    .or_default()
                    .push(format!("Invalid currency code: {} or {}", from, to));
                activity.errors = Some(errors);
            }
        }
    }

    fn normalize_import_activity_subtype(activity: &mut ActivityImport) {
        activity.subtype = NewActivity::canonicalize_subtype(activity.subtype.as_deref());
        if activity
            .subtype
            .as_deref()
            .is_some_and(|subtype| subtype.eq_ignore_ascii_case(&activity.activity_type))
        {
            activity.subtype = None;
        }
    }

    fn validate_import_asset_backed_income_values(
        activity: &ActivityImport,
    ) -> std::result::Result<(), (String, String)> {
        let quantity = activity.quantity.map(|value| value.abs());
        let unit_price = activity.unit_price.map(|value| value.abs());
        let amount = activity.amount.map(|value| value.abs());

        NewActivity::validate_asset_backed_income_values(
            &activity.activity_type,
            activity.subtype.as_deref(),
            quantity,
            unit_price,
            amount,
        )
        .map_err(|err| {
            let message = err.to_string();
            let field = if message.contains("positive quantity") {
                "quantity"
            } else if message.contains("Income amount") {
                "amount"
            } else {
                "unitPrice"
            };
            (field.to_string(), message)
        })
    }

    async fn check_activities_import_for_account(
        &self,
        account_id: String,
        activities: Vec<ActivityImport>,
    ) -> Result<Vec<ActivityImport>> {
        let account: Account = self.account_service.get_account(&account_id)?;
        let base_ccy = self.account_service.get_base_currency().unwrap_or_default();
        let account_currency = resolve_currency(&[&account.currency, &base_ccy]);

        let symbol_resolution_keys: HashSet<SymbolResolutionKey> = activities
            .iter()
            .filter(|a| {
                let sym = a.symbol.trim();
                !sym.is_empty()
                    && matches!(
                        Self::classify_import_symbol_disposition(
                            &a.activity_type,
                            a.subtype.as_deref(),
                            sym,
                            a.quantity,
                            a.unit_price,
                        ),
                        ImportSymbolDisposition::ResolveAsset
                    )
                    && a.exchange_mic.is_none()
                    && a.asset_id.as_deref().is_none_or(str::is_empty)
            })
            .map(|a| {
                let ccy = if a.currency.is_empty() {
                    account_currency.clone()
                } else {
                    a.currency.clone()
                };
                (a.symbol.clone(), ccy, normalize_isin_key(a.isin.as_deref()))
            })
            .collect();
        let symbol_batch = self.resolve_symbols_batch(symbol_resolution_keys).await;
        let symbol_mic_cache: HashMap<SymbolResolutionKey, Option<String>> = symbol_batch
            .iter()
            .map(|(k, info)| (k.clone(), info.exchange_mic.clone()))
            .collect();
        let symbol_name_cache: HashMap<SymbolResolutionKey, Option<String>> = symbol_batch
            .into_iter()
            .map(|(k, info)| (k, info.name))
            .collect();
        let mut quote_ccy_cache: QuoteCcyCache = HashMap::new();
        let mut activities_with_status: Vec<ActivityImport> = Vec::new();

        for mut activity in activities {
            activity.id = Some(Uuid::new_v4().to_string());
            if activity.account_name.is_none() {
                activity.account_name = Some(account.name.clone());
            }
            if activity.account_id.is_none() {
                activity.account_id = Some(account_id.clone());
            }
            self.hydrate_import_activity_from_asset_id(&mut activity);
            Self::normalize_import_activity_subtype(&mut activity);

            let symbol = activity.symbol.trim().to_string();

            if let Err((field, message)) =
                Self::validate_import_asset_backed_income_values(&activity)
            {
                activity.is_valid = false;
                let mut errors = std::collections::HashMap::new();
                errors.insert(field, vec![message]);
                activity.errors = Some(errors);
                activities_with_status.push(activity);
                continue;
            }

            match Self::classify_import_symbol_disposition(
                &activity.activity_type,
                activity.subtype.as_deref(),
                &symbol,
                activity.quantity,
                activity.unit_price,
            ) {
                ImportSymbolDisposition::CashMovement => {
                    activity.symbol = String::new();
                    activity.exchange_mic = None;
                    activity.quote_ccy = None;
                    activity.instrument_type = None;
                    if activity.currency.is_empty() {
                        activity.currency = account_currency.clone();
                    }
                    activity.is_valid = true;
                    self.validate_currency(&mut activity, &account_currency);
                    activities_with_status.push(activity);
                    continue;
                }
                ImportSymbolDisposition::NeedsReview(msg) => {
                    activity.is_valid = false;
                    let mut errors = std::collections::HashMap::new();
                    errors.insert("symbol".to_string(), vec![msg]);
                    activity.errors = Some(errors);
                    activities_with_status.push(activity);
                    continue;
                }
                ImportSymbolDisposition::ResolveAsset => {
                    if symbol.is_empty() {
                        activity.is_valid = false;
                        let mut errors = std::collections::HashMap::new();
                        errors.insert(
                            "symbol".to_string(),
                            vec![format!(
                                "Symbol is required for {} activities.",
                                &activity.activity_type
                            )],
                        );
                        activity.errors = Some(errors);
                        activities_with_status.push(activity);
                        continue;
                    }
                    if is_garbage_symbol(&symbol) {
                        activity.is_valid = false;
                        let mut errors = std::collections::HashMap::new();
                        errors.insert(
                            "symbol".to_string(),
                            vec![format!(
                                "Invalid symbol '{}'. Please correct or remove it.",
                                &symbol
                            )],
                        );
                        activity.errors = Some(errors);
                        activities_with_status.push(activity);
                        continue;
                    }
                }
            }

            let resolve_ccy = if activity.currency.is_empty() {
                account_currency.clone()
            } else {
                activity.currency.clone()
            };
            let resolution_key = (
                activity.symbol.clone(),
                resolve_ccy.clone(),
                normalize_isin_key(activity.isin.as_deref()),
            );
            let exchange_mic = activity
                .exchange_mic
                .clone()
                .or_else(|| symbol_mic_cache.get(&resolution_key).cloned().flatten());

            let (base_symbol, suffix_mic) = parse_symbol_with_exchange_suffix(&symbol);
            let resolved_mic = exchange_mic.or_else(|| suffix_mic.map(|s| s.to_string()));

            let (inferred_kind, inferred_instrument_type) =
                self.infer_asset_kind(base_symbol, resolved_mic.as_deref(), None);
            let instrument_type_input =
                Self::parse_instrument_type(activity.instrument_type.as_deref());
            let effective_instrument_type = instrument_type_input
                .clone()
                .or(inferred_instrument_type.clone());
            let effective_kind = instrument_type_input
                .as_ref()
                .map(Self::kind_from_instrument_type)
                .unwrap_or(inferred_kind);

            let is_crypto = effective_instrument_type.as_ref() == Some(&InstrumentType::Crypto);
            let is_non_security = matches!(
                effective_instrument_type.as_ref(),
                Some(InstrumentType::Crypto | InstrumentType::Fx)
            );
            let resolved_mic = if is_non_security { None } else { resolved_mic };
            let normalized_symbol = if is_crypto {
                parse_crypto_pair_symbol(base_symbol)
                    .map(|(base, _)| base)
                    .unwrap_or_else(|| base_symbol.to_string())
            } else {
                base_symbol.to_string()
            };

            let is_manual_quote = activity
                .quote_mode
                .as_deref()
                .map(|m| m.to_uppercase() == "MANUAL")
                .unwrap_or(false);

            activity.exchange_mic = resolved_mic.clone();
            activity.symbol = normalized_symbol.clone();
            if activity.instrument_type.is_none() {
                activity.instrument_type = effective_instrument_type
                    .as_ref()
                    .map(|it| it.as_db_str().to_string());
            }

            let mut asset_currency: Option<String> = None;
            let quote_ccy_input = if matches!(
                effective_instrument_type,
                Some(InstrumentType::Crypto | InstrumentType::Fx)
            ) {
                parse_crypto_pair_symbol(base_symbol)
                    .map(|(_, quote)| quote)
                    .or_else(|| Self::normalize_quote_ccy(activity.quote_ccy.as_deref()))
                    .or_else(|| {
                        let c = activity.currency.trim();
                        if c.is_empty() {
                            None
                        } else {
                            Some(c.to_string())
                        }
                    })
            } else {
                None
            };
            let existing_id = activity.asset_id.clone().or_else(|| {
                self.find_existing_asset_id(
                    &normalized_symbol,
                    resolved_mic.as_deref(),
                    effective_instrument_type.as_ref(),
                    quote_ccy_input.as_deref(),
                )
            });

            // Equity without MIC must either match an existing asset or be manual-quoted.
            // Check AFTER find_existing_asset_id so custom assets (e.g. delisted TWTR)
            // with no MIC are still matched.
            let is_equity = effective_kind == AssetKind::Investment
                && effective_instrument_type.as_ref() == Some(&InstrumentType::Equity);
            if is_equity && resolved_mic.is_none() && !is_manual_quote && existing_id.is_none() {
                activity.is_valid = false;
                let mut errors = std::collections::HashMap::new();
                errors.insert(
                    "symbol".to_string(),
                    vec![format!(
                        "Could not find '{}' in market data. Please search for the correct ticker symbol.",
                        &activity.symbol
                    )],
                );
                activity.errors = Some(errors);
                activities_with_status.push(activity);
                continue;
            }
            if let Some(ref id) = existing_id {
                activity.asset_id = Some(id.clone());
                if let Ok(asset) = self.asset_service.get_asset_by_id(id) {
                    activity.symbol_name = asset.name;
                    asset_currency = Some(asset.quote_ccy.clone());
                    if activity.quote_mode.is_none() {
                        activity.quote_mode = Some(match asset.quote_mode {
                            QuoteMode::Manual => "MANUAL".to_string(),
                            QuoteMode::Market => "MARKET".to_string(),
                        });
                    }
                } else {
                    activity.symbol_name = Some(normalized_symbol.clone());
                }
            } else {
                // Use provider-supplied name when available; fall back to symbol
                let provider_name = symbol_name_cache
                    .get(&resolution_key)
                    .and_then(|n| n.clone())
                    .filter(|n| {
                        !n.is_empty() && n.to_uppercase() != normalized_symbol.to_uppercase()
                    });
                activity.symbol_name = provider_name.or_else(|| Some(normalized_symbol.clone()));
            }

            if activity.quote_ccy.is_none() {
                let terminal_fallback = if activity.currency.trim().is_empty() {
                    account_currency.as_str()
                } else {
                    activity.currency.as_str()
                };
                let explicit_quote_ccy = Self::normalize_quote_ccy(activity.quote_ccy.as_deref());

                let (resolved_quote_ccy, resolution_source) = if matches!(
                    effective_instrument_type,
                    Some(InstrumentType::Crypto | InstrumentType::Fx)
                ) {
                    self.resolve_quote_ccy(
                        &normalized_symbol,
                        None,
                        effective_instrument_type.as_ref(),
                        parse_crypto_pair_symbol(base_symbol)
                            .map(|(_, quote)| quote)
                            .or(explicit_quote_ccy.clone())
                            .as_deref(),
                        asset_currency.as_deref(),
                        terminal_fallback,
                        false,
                    )
                    .await
                } else {
                    let has_deterministic = normalize_quote_ccy_code(explicit_quote_ccy.as_deref())
                        .is_some()
                        || normalize_quote_ccy_code(asset_currency.as_deref()).is_some();
                    let provider_ccy = if !has_deterministic {
                        self.fetch_provider_quote_ccy(
                            &normalized_symbol,
                            resolved_mic.as_deref(),
                            effective_instrument_type.as_ref(),
                            &mut quote_ccy_cache,
                        )
                        .await
                    } else {
                        None
                    };
                    resolve_quote_ccy_precedence(
                        explicit_quote_ccy.as_deref(),
                        asset_currency.as_deref(),
                        provider_ccy.as_deref(),
                        resolved_mic.as_deref().and_then(mic_to_currency),
                        Some(terminal_fallback),
                    )
                    .unwrap_or_else(|| {
                        (
                            terminal_fallback.to_string(),
                            QuoteCcyResolutionSource::TerminalFallback,
                        )
                    })
                };

                activity.quote_ccy = Some(resolved_quote_ccy);

                if resolution_source == QuoteCcyResolutionSource::MicFallback {
                    let msg = format!(
                        "{} price currency was inferred as {} from the exchange. Please confirm it is correct.",
                        activity.symbol,
                        activity.quote_ccy.as_deref().unwrap_or_default(),
                    );
                    Self::add_activity_warning(&mut activity, "_quote_ccy_fallback", &msg);
                }
            }

            if activity.currency.is_empty() {
                activity.currency = self.resolve_activity_currency(
                    "",
                    asset_currency.as_deref(),
                    &account_currency,
                );
            }

            activity.is_valid = true;
            self.validate_currency(&mut activity, &account_currency);
            activities_with_status.push(activity);
        }

        let mut keys: Vec<Option<String>> = Vec::with_capacity(activities_with_status.len());
        let mut first_index_by_key: HashMap<String, usize> = HashMap::new();
        let mut batch_dup_sources: HashMap<usize, usize> = HashMap::new();

        for (idx, activity) in activities_with_status.iter().enumerate() {
            if !activity.is_valid
                || activity
                    .errors
                    .as_ref()
                    .is_some_and(|errors| !errors.is_empty())
            {
                keys.push(None);
                continue;
            }

            let Some(key) = Self::build_import_idempotency_key(activity, &account_id) else {
                keys.push(None);
                continue;
            };

            if let Some(first_idx) = first_index_by_key.get(&key).copied() {
                batch_dup_sources.insert(idx, first_idx);
            } else {
                first_index_by_key.insert(key.clone(), idx);
            }
            keys.push(Some(key));
        }

        let unique_keys: Vec<String> = first_index_by_key.into_keys().collect();
        let existing = if unique_keys.is_empty() {
            HashMap::new()
        } else {
            self.check_existing_duplicates(unique_keys)
                .unwrap_or_default()
        };

        for (idx, maybe_key) in keys.iter().enumerate() {
            let Some(key) = maybe_key else {
                continue;
            };

            if let Some(existing_id) = existing.get(key) {
                let activity = &mut activities_with_status[idx];
                Self::add_activity_warning(
                    activity,
                    "_duplicate",
                    "Duplicate activity already exists",
                );
                activity.duplicate_of_id = Some(existing_id.clone());
                continue;
            }

            if let Some(first_idx) = batch_dup_sources.get(&idx).copied() {
                let duplicate_line_number = activities_with_status
                    .get(first_idx)
                    .and_then(|a| a.line_number)
                    .unwrap_or((first_idx + 1) as i32);
                let activity = &mut activities_with_status[idx];
                Self::add_activity_warning(
                    activity,
                    "_duplicate",
                    &format!(
                        "Duplicate of line {} in this import batch",
                        duplicate_line_number
                    ),
                );
                activity.duplicate_of_line_number = Some(duplicate_line_number);
            }
        }

        Ok(activities_with_status)
    }

    /// Normalizes an `ActivityImport` for DB insertion. Does NOT add validation errors —
    /// the import apply path runs a lightweight invariant check afterward.
    ///
    /// - CashMovement: clears symbol, exchange_mic, quote_ccy, instrument_type
    /// - SPLIT: falls back to `account_currency` when currency is missing or invalid
    fn normalize_for_insert(activity: &mut ActivityImport, account_currency: &str) {
        Self::normalize_import_activity_subtype(activity);

        if Self::classify_import_symbol_disposition(
            &activity.activity_type,
            activity.subtype.as_deref(),
            activity.symbol.trim(),
            activity.quantity,
            activity.unit_price,
        ) == ImportSymbolDisposition::CashMovement
        {
            activity.symbol = String::new();
            activity.exchange_mic = None;
            activity.quote_ccy = None;
            activity.instrument_type = None;
            if activity.currency.trim().is_empty() {
                activity.currency = account_currency.to_string();
            }
        }

        if activity.activity_type == ACTIVITY_TYPE_SPLIT {
            let ccy = activity.currency.trim();
            if ccy.len() != 3 || !ccy.chars().all(|c| c.is_ascii_alphabetic()) {
                activity.currency = account_currency.to_string();
            }
        }
    }
}

#[async_trait::async_trait]
impl ActivityServiceTrait for ActivityService {
    fn get_activity(&self, activity_id: &str) -> Result<Activity> {
        self.activity_repository.get_activity(activity_id)
    }

    /// Retrieves all activities
    fn get_activities(&self) -> Result<Vec<Activity>> {
        self.activity_repository.get_activities()
    }

    /// Retrieves activities by account ID
    fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>> {
        self.activity_repository
            .get_activities_by_account_id(account_id)
    }

    /// Retrieves activities by account IDs
    fn get_activities_by_account_ids(&self, account_ids: &[String]) -> Result<Vec<Activity>> {
        self.activity_repository
            .get_activities_by_account_ids(account_ids)
    }

    /// Retrieves all trading activities
    fn get_trading_activities(&self) -> Result<Vec<Activity>> {
        self.activity_repository.get_trading_activities()
    }

    /// Retrieves all income activities
    fn get_income_activities(&self) -> Result<Vec<Activity>> {
        self.activity_repository.get_income_activities()
    }

    /// Searches activities with various filters and pagination
    fn search_activities(
        &self,
        page: i64,
        page_size: i64,
        account_id_filter: Option<Vec<String>>,
        activity_type_filter: Option<Vec<String>>,
        asset_id_keyword: Option<String>,
        sort: Option<Sort>,
        needs_review_filter: Option<bool>,
        date_from: Option<NaiveDate>,
        date_to: Option<NaiveDate>,
        instrument_type_filter: Option<Vec<String>>,
    ) -> Result<ActivitySearchResponse> {
        self.activity_repository.search_activities(
            page,
            page_size,
            account_id_filter,
            activity_type_filter,
            asset_id_keyword,
            sort,
            needs_review_filter,
            date_from,
            date_to,
            instrument_type_filter,
        )
    }

    /// Creates a new activity
    async fn create_activity(&self, activity: NewActivity) -> Result<Activity> {
        let prepared = self.prepare_new_activity(activity).await?;
        let created = self
            .activity_repository
            .create_activity(prepared)
            .await
            .map_err(Self::map_duplicate_idempotency_violation)?;

        // Emit domain event after successful creation
        let account_ids = vec![created.account_id.clone()];
        let asset_ids = created.asset_id.clone().into_iter().collect();
        let currencies = vec![created.currency.clone()];
        self.emit_activities_changed(
            account_ids,
            asset_ids,
            currencies,
            Some(created.activity_date),
        );

        Ok(created)
    }

    /// Updates an existing activity
    async fn update_activity(&self, mut activity: ActivityUpdate) -> Result<Activity> {
        // Get the existing activity BEFORE the update to capture old account_id and asset_id
        // This ensures we emit events for both old and new locations if they changed
        let existing = self.activity_repository.get_activity(&activity.id)?;
        Self::hydrate_and_validate_update_against_existing(&mut activity, &existing)?;

        let prepared = self.prepare_update_activity(activity).await?;
        let updated = self.activity_repository.update_activity(prepared).await?;

        // Emit domain event after successful update
        // Include BOTH old and new account_ids and asset_ids (if they differ)
        let mut account_ids_set: HashSet<String> = HashSet::new();
        let mut asset_ids_set: HashSet<String> = HashSet::new();
        let mut currencies_set: HashSet<String> = HashSet::new();

        // Add old values
        account_ids_set.insert(existing.account_id.clone());
        if let Some(ref old_asset_id) = existing.asset_id {
            asset_ids_set.insert(old_asset_id.clone());
        }
        currencies_set.insert(existing.currency.clone());

        // Add new values
        account_ids_set.insert(updated.account_id.clone());
        if let Some(ref new_asset_id) = updated.asset_id {
            asset_ids_set.insert(new_asset_id.clone());
        }
        currencies_set.insert(updated.currency.clone());

        let account_ids: Vec<String> = account_ids_set.into_iter().collect();
        let asset_ids: Vec<String> = asset_ids_set.into_iter().collect();
        let currencies: Vec<String> = currencies_set.into_iter().collect();
        let earliest_activity_at_utc = existing.activity_date.min(updated.activity_date);
        self.emit_activities_changed(
            account_ids,
            asset_ids,
            currencies,
            Some(earliest_activity_at_utc),
        );

        Ok(updated)
    }

    /// Deletes an activity
    async fn delete_activity(&self, activity_id: String) -> Result<Activity> {
        let deleted = self
            .activity_repository
            .delete_activity(activity_id)
            .await?;

        // Emit domain event after successful deletion
        let account_ids = vec![deleted.account_id.clone()];
        let asset_ids = deleted.asset_id.clone().into_iter().collect();
        let currencies = vec![deleted.currency.clone()];
        self.emit_activities_changed(
            account_ids,
            asset_ids,
            currencies,
            Some(deleted.activity_date),
        );

        Ok(deleted)
    }

    async fn link_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        let (transfer_in, transfer_out) = self
            .activity_repository
            .link_transfer_activities(activity_a_id, activity_b_id)
            .await?;

        let mut account_ids: HashSet<String> = HashSet::new();
        let mut asset_ids: HashSet<String> = HashSet::new();
        let mut currencies: HashSet<String> = HashSet::new();
        for activity in [&transfer_in, &transfer_out] {
            account_ids.insert(activity.account_id.clone());
            if let Some(ref asset_id) = activity.asset_id {
                asset_ids.insert(asset_id.clone());
            }
            currencies.insert(activity.currency.clone());
        }
        let earliest_at = transfer_in.activity_date.min(transfer_out.activity_date);
        self.emit_activities_changed(
            account_ids.into_iter().collect(),
            asset_ids.into_iter().collect(),
            currencies.into_iter().collect(),
            Some(earliest_at),
        );

        Ok((transfer_in, transfer_out))
    }

    async fn unlink_transfer_activities(
        &self,
        activity_a_id: String,
        activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        let (transfer_in, transfer_out) = self
            .activity_repository
            .unlink_transfer_activities(activity_a_id, activity_b_id)
            .await?;

        let mut account_ids: HashSet<String> = HashSet::new();
        let mut asset_ids: HashSet<String> = HashSet::new();
        let mut currencies: HashSet<String> = HashSet::new();
        for activity in [&transfer_in, &transfer_out] {
            account_ids.insert(activity.account_id.clone());
            if let Some(ref asset_id) = activity.asset_id {
                asset_ids.insert(asset_id.clone());
            }
            currencies.insert(activity.currency.clone());
        }
        let earliest_at = transfer_in.activity_date.min(transfer_out.activity_date);
        self.emit_activities_changed(
            account_ids.into_iter().collect(),
            asset_ids.into_iter().collect(),
            currencies.into_iter().collect(),
            Some(earliest_at),
        );

        Ok((transfer_in, transfer_out))
    }

    async fn bulk_mutate_activities(
        &self,
        request: ActivityBulkMutationRequest,
    ) -> Result<ActivityBulkMutationResult> {
        let mut errors: Vec<ActivityBulkMutationError> = Vec::new();
        let mut prepared_creates: Vec<NewActivity> = Vec::new();
        let mut prepared_updates: Vec<ActivityUpdate> = Vec::new();
        let mut valid_delete_ids: Vec<String> = Vec::new();

        // Capture OLD account_ids and asset_ids BEFORE updates/deletes for proper event emission
        // This ensures that when an activity moves accounts or changes assets, both old and new locations get recalculated
        let mut old_account_ids: HashSet<String> = HashSet::new();
        let mut old_asset_ids: HashSet<String> = HashSet::new();
        let mut old_currencies: HashSet<String> = HashSet::new();

        // Use save preparation for all creates at once
        if !request.creates.is_empty() {
            // Get account from first create (all creates in a bulk request typically share the same account)
            let account_id = &request.creates[0].account_id;
            let account = self.account_service.get_account(account_id)?;

            // Store temp_ids for error reporting (prepare result uses indices)
            let temp_ids: Vec<Option<String>> =
                request.creates.iter().map(|a| a.id.clone()).collect();

            let prepare_result = self
                .prepare_activities_for_save(request.creates, &account)
                .await?;

            // Convert preparation errors to bulk mutation errors
            for (idx, error) in prepare_result.errors {
                errors.push(ActivityBulkMutationError {
                    id: temp_ids.get(idx).cloned().flatten(),
                    action: "create".to_string(),
                    message: error,
                });
            }

            // Extract prepared activities
            prepared_creates = prepare_result
                .prepared
                .into_iter()
                .map(|p| p.activity)
                .collect();
        }

        // For updates: capture OLD values before preparing the update
        for update_request in request.updates {
            let mut update_request = update_request;
            let target_id = update_request.id.clone();
            // Get the existing activity to capture old account_id and asset_id
            match self.activity_repository.get_activity(&target_id) {
                Ok(existing) => {
                    old_account_ids.insert(existing.account_id.clone());
                    if let Some(ref asset_id) = existing.asset_id {
                        old_asset_ids.insert(asset_id.clone());
                    }
                    old_currencies.insert(existing.currency.clone());
                    if let Err(err) = Self::hydrate_and_validate_update_against_existing(
                        &mut update_request,
                        &existing,
                    ) {
                        errors.push(ActivityBulkMutationError {
                            id: Some(target_id),
                            action: "update".to_string(),
                            message: err.to_string(),
                        });
                        continue;
                    }
                }
                Err(_) => {
                    // Activity doesn't exist - will fail during prepare_update_activity
                }
            }
            match self.prepare_update_activity(update_request).await {
                Ok(prepared) => prepared_updates.push(prepared),
                Err(err) => {
                    errors.push(ActivityBulkMutationError {
                        id: Some(target_id),
                        action: "update".to_string(),
                        message: err.to_string(),
                    });
                }
            }
        }

        // For deletes: capture OLD values before deletion
        for delete_id in request.delete_ids {
            match self.activity_repository.get_activity(&delete_id) {
                Ok(existing) => {
                    // Capture old values for event emission
                    old_account_ids.insert(existing.account_id.clone());
                    if let Some(ref asset_id) = existing.asset_id {
                        old_asset_ids.insert(asset_id.clone());
                    }
                    old_currencies.insert(existing.currency.clone());
                    valid_delete_ids.push(delete_id.clone());
                }
                Err(err) => {
                    errors.push(ActivityBulkMutationError {
                        id: Some(delete_id),
                        action: "delete".to_string(),
                        message: err.to_string(),
                    });
                }
            }
        }

        if !errors.is_empty() {
            let outcome = ActivityBulkMutationResult {
                errors,
                ..Default::default()
            };
            return Ok(outcome);
        }

        let mut persisted = self
            .activity_repository
            .bulk_mutate_activities(prepared_creates, prepared_updates, valid_delete_ids)
            .await
            .map_err(Self::map_duplicate_idempotency_violation)?;

        persisted.errors = errors;

        // Emit ONE aggregated domain event for all mutations
        // Start with OLD values captured before updates/deletes (to recalculate old locations)
        let mut account_ids_set: HashSet<String> = old_account_ids;
        let mut asset_ids_set: HashSet<String> = old_asset_ids;
        let mut currencies_set: HashSet<String> = HashSet::new();

        // Add NEW values from created and updated activities
        for activity in &persisted.created {
            account_ids_set.insert(activity.account_id.clone());
            if let Some(ref asset_id) = activity.asset_id {
                asset_ids_set.insert(asset_id.clone());
            }
            currencies_set.insert(activity.currency.clone());
        }
        for activity in &persisted.updated {
            account_ids_set.insert(activity.account_id.clone());
            if let Some(ref asset_id) = activity.asset_id {
                asset_ids_set.insert(asset_id.clone());
            }
            currencies_set.insert(activity.currency.clone());
        }
        // Note: deleted activities' old values are already in the sets from old_account_ids/old_asset_ids

        // Only emit if there were actual changes
        if !account_ids_set.is_empty() {
            let account_ids: Vec<String> = account_ids_set.into_iter().collect();
            let asset_ids: Vec<String> = asset_ids_set.into_iter().collect();
            let currencies: Vec<String> = currencies_set.into_iter().collect();
            let earliest_activity_at_utc = Self::earliest_activity_at_utc(
                persisted
                    .created
                    .iter()
                    .chain(persisted.updated.iter())
                    .chain(persisted.deleted.iter()),
            );
            self.emit_activities_changed(
                account_ids,
                asset_ids,
                currencies,
                earliest_activity_at_utc,
            );
        }

        Ok(persisted)
    }

    async fn check_activities_import(
        &self,
        activities: Vec<ActivityImport>,
    ) -> Result<Vec<ActivityImport>> {
        let mut missing_account_results: Vec<(usize, ActivityImport)> = Vec::new();
        let mut grouped: HashMap<String, Vec<(usize, ActivityImport)>> = HashMap::new();

        for (idx, mut activity) in activities.into_iter().enumerate() {
            let Some(account_id) = activity
                .account_id
                .clone()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            else {
                Self::add_activity_error(
                    &mut activity,
                    "accountId",
                    "Account is required before running backend validation.",
                );
                missing_account_results.push((idx, activity));
                continue;
            };

            activity.account_id = Some(account_id.clone());
            grouped.entry(account_id).or_default().push((idx, activity));
        }

        let total_len =
            grouped.values().map(Vec::len).sum::<usize>() + missing_account_results.len();
        let mut ordered: Vec<Option<ActivityImport>> = vec![None; total_len];

        for (idx, activity) in missing_account_results {
            ordered[idx] = Some(activity);
        }

        for (account_id, entries) in grouped {
            let indexes: Vec<usize> = entries.iter().map(|(idx, _)| *idx).collect();
            let account_activities: Vec<ActivityImport> =
                entries.into_iter().map(|(_, activity)| activity).collect();

            match self
                .check_activities_import_for_account(account_id.clone(), account_activities.clone())
                .await
            {
                Ok(validated) => {
                    for (offset, activity) in validated.into_iter().enumerate() {
                        if let Some(idx) = indexes.get(offset).copied() {
                            ordered[idx] = Some(activity);
                        }
                    }
                }
                Err(e) => {
                    // Per-account validation failed (e.g., account not found,
                    // DB error). Mark all activities in this group with the
                    // error instead of failing the entire batch.
                    log::warn!(
                        "check_activities_import: account {} validation failed: {}",
                        account_id,
                        e
                    );
                    for (offset, mut activity) in account_activities.into_iter().enumerate() {
                        Self::add_activity_error(
                            &mut activity,
                            "general",
                            &format!("Validation failed: {}", e),
                        );
                        if let Some(idx) = indexes.get(offset).copied() {
                            ordered[idx] = Some(activity);
                        }
                    }
                }
            }
        }

        Ok(ordered.into_iter().flatten().collect())
    }

    async fn preview_import_assets(
        &self,
        candidates: Vec<ImportAssetCandidate>,
    ) -> Result<Vec<ImportAssetPreviewItem>> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        let preview_activities: Vec<ActivityImport> = candidates
            .iter()
            .enumerate()
            .map(|(idx, candidate)| ActivityImport {
                id: None,
                date: "2000-01-01".to_string(),
                symbol: candidate.symbol.clone(),
                activity_type: ACTIVITY_TYPE_BUY.to_string(),
                quantity: Some(Decimal::ONE),
                unit_price: Some(Decimal::ONE),
                currency: candidate.currency.clone().unwrap_or_default(),
                fee: None,
                amount: None,
                comment: None,
                account_id: Some(candidate.account_id.clone()),
                account_name: None,
                symbol_name: None,
                exchange_mic: candidate.exchange_mic.clone(),
                quote_ccy: candidate.quote_ccy.clone(),
                instrument_type: candidate.instrument_type.clone(),
                quote_mode: candidate.quote_mode.clone(),
                errors: None,
                warnings: None,
                duplicate_of_id: None,
                duplicate_of_line_number: None,
                is_draft: true,
                is_valid: false,
                line_number: Some((idx + 1) as i32),
                fx_rate: None,
                subtype: None,
                asset_id: None,
                isin: candidate.isin.clone(),
                force_import: false,
                is_external: None,
            })
            .collect();

        let validated = self.check_activities_import(preview_activities).await?;
        let validated_by_line: HashMap<i32, ActivityImport> = validated
            .into_iter()
            .filter_map(|activity| {
                activity
                    .line_number
                    .map(|line_number| (line_number, activity))
            })
            .collect();

        let previews = candidates
            .into_iter()
            .enumerate()
            .map(|(idx, candidate)| {
                let line_number = (idx + 1) as i32;
                let Some(activity) = validated_by_line.get(&line_number) else {
                    return ImportAssetPreviewItem {
                        key: candidate.key,
                        status: ImportAssetPreviewStatus::NeedsFixing,
                        resolution_source: "missing_preview_result".to_string(),
                        asset_id: None,
                        draft: None,
                        errors: Some(HashMap::from([(
                            "symbol".to_string(),
                            vec!["Asset preview did not return a result.".to_string()],
                        )])),
                        warnings: None,
                    };
                };

                let has_errors = activity
                    .errors
                    .as_ref()
                    .is_some_and(|errors| !errors.is_empty())
                    || !activity.is_valid;

                if has_errors {
                    return ImportAssetPreviewItem {
                        key: candidate.key,
                        status: ImportAssetPreviewStatus::NeedsFixing,
                        resolution_source: "validation_error".to_string(),
                        asset_id: None,
                        draft: None,
                        errors: activity.errors.clone(),
                        warnings: activity.warnings.clone(),
                    };
                }

                if let Some(asset_id) = activity.asset_id.clone() {
                    let draft = self
                        .asset_service
                        .get_asset_by_id(&asset_id)
                        .ok()
                        .map(|asset| Self::asset_to_new_asset_draft(&asset));

                    return ImportAssetPreviewItem {
                        key: candidate.key,
                        status: ImportAssetPreviewStatus::ExistingAsset,
                        resolution_source: "existing_asset".to_string(),
                        asset_id: Some(asset_id),
                        draft,
                        errors: None,
                        warnings: activity.warnings.clone(),
                    };
                }

                // Equity without exchange MIC → needs manual resolution
                let is_equity = matches!(
                    Self::parse_instrument_type(activity.instrument_type.as_deref()),
                    Some(InstrumentType::Equity)
                );
                let is_manual = activity
                    .quote_mode
                    .as_deref()
                    .map(|m| m.eq_ignore_ascii_case("MANUAL"))
                    .unwrap_or(false);
                if is_equity && activity.exchange_mic.is_none() && !is_manual {
                    let mut errors = std::collections::HashMap::new();
                    errors.insert(
                        "symbol".to_string(),
                        vec![format!(
                            "Could not determine the exchange for '{}'. Please search for the correct ticker.",
                            &activity.symbol
                        )],
                    );
                    return ImportAssetPreviewItem {
                        key: candidate.key,
                        status: ImportAssetPreviewStatus::NeedsFixing,
                        resolution_source: "missing_exchange".to_string(),
                        asset_id: None,
                        draft: self.build_new_asset_draft_from_import(activity),
                        errors: Some(errors),
                        warnings: activity.warnings.clone(),
                    };
                }

                ImportAssetPreviewItem {
                    key: candidate.key,
                    status: ImportAssetPreviewStatus::AutoResolvedNewAsset,
                    resolution_source: "provider_resolution".to_string(),
                    asset_id: None,
                    draft: self.build_new_asset_draft_from_import(activity),
                    errors: None,
                    warnings: activity.warnings.clone(),
                }
            })
            .collect();

        Ok(previews)
    }

    async fn import_activities(
        &self,
        activities: Vec<ActivityImport>,
    ) -> Result<ImportActivitiesResult> {
        let total = activities.len();

        // ── 1. Separate valid from missing-account ───────────────────────────
        let mut ordered: Vec<Option<ActivityImport>> = vec![None; total];
        let mut valid: Vec<(usize, ActivityImport)> = Vec::with_capacity(total);

        for (idx, mut activity) in activities.into_iter().enumerate() {
            let account_id = activity
                .account_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            match account_id {
                Some(id) => {
                    activity.account_id = Some(id);
                    valid.push((idx, activity));
                }
                None => {
                    Self::add_activity_error(
                        &mut activity,
                        "accountId",
                        "Account is required before importing activities.",
                    );
                    ordered[idx] = Some(activity);
                }
            }
        }

        if valid.is_empty() {
            return Ok(ImportActivitiesResult {
                activities: ordered.into_iter().flatten().collect(),
                import_run_id: String::new(),
                summary: ImportActivitiesSummary {
                    total: total as u32,
                    imported: 0,
                    skipped: total as u32,
                    duplicates: 0,
                    assets_created: 0,
                    success: false,
                    error_message: Some("Account is required for all activities.".to_string()),
                },
            });
        }

        // ── 2. Resolve account currencies (one query per unique account) ─────
        let base_ccy = self.account_service.get_base_currency().unwrap_or_default();
        let unique_account_ids: HashSet<String> = valid
            .iter()
            .filter_map(|(_, a)| a.account_id.clone())
            .collect();

        let mut account_currencies: HashMap<String, String> =
            HashMap::with_capacity(unique_account_ids.len());

        for account_id in &unique_account_ids {
            let account = self.account_service.get_account(account_id)?;
            let currency = resolve_currency(&[&account.currency, &base_ccy]);
            account_currencies.insert(account_id.clone(), currency);
        }

        // ── 3. Normalize + convert each activity ─────────────────────────────
        let mut import_activities_indexed: Vec<(usize, ActivityImport)> =
            Vec::with_capacity(valid.len());

        for (idx, mut activity) in valid {
            let account_id = activity.account_id.as_deref().unwrap_or("");
            let account_currency = account_currencies
                .get(account_id)
                .map(String::as_str)
                .unwrap_or(&base_ccy);
            Self::normalize_for_insert(&mut activity, account_currency);
            import_activities_indexed.push((idx, activity));
        }

        // ── 3.5: Lightweight pre-insert validation (no asset/FX resolution) ───
        // Catches rows that slipped through the review step without proper resolution.
        // date errors → "symbol" to match frontend field-keying convention.
        let mut has_validation_errors = false;
        for (_, activity) in import_activities_indexed.iter_mut() {
            let has_symbol = !activity.symbol.trim().is_empty();
            let has_asset_id = activity
                .asset_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|asset_id| !asset_id.is_empty());
            let symbol_disposition = Self::classify_import_symbol_disposition(
                &activity.activity_type,
                activity.subtype.as_deref(),
                activity.symbol.trim(),
                activity.quantity,
                activity.unit_price,
            );
            let valid_date = DateTime::parse_from_rfc3339(&activity.date).is_ok()
                || NaiveDate::parse_from_str(&activity.date, "%Y-%m-%d").is_ok();
            if !valid_date {
                activity.is_valid = false;
                Self::add_activity_error(
                    activity,
                    "symbol",
                    &format!("Invalid date '{}'.", activity.date),
                );
                has_validation_errors = true;
                continue;
            }
            if let Err((field, message)) =
                Self::validate_import_asset_backed_income_values(activity)
            {
                activity.is_valid = false;
                Self::add_activity_error(activity, &field, &message);
                has_validation_errors = true;
                continue;
            }
            if let ImportSymbolDisposition::NeedsReview(message) = &symbol_disposition {
                Self::add_activity_error(activity, "symbol", message);
                activity.is_valid = false;
                has_validation_errors = true;
                continue;
            }
            if matches!(symbol_disposition, ImportSymbolDisposition::ResolveAsset)
                && !has_symbol
                && !has_asset_id
            {
                Self::add_activity_error(
                    activity,
                    "symbol",
                    "Symbol or asset_id is required to import this activity.",
                );
                activity.is_valid = false;
                has_validation_errors = true;
                continue;
            }
            // Symbol-required rows with no asset_id need quote_ccy + instrument_type
            // so the asset can be created or matched on first portfolio calculation.
            if matches!(symbol_disposition, ImportSymbolDisposition::ResolveAsset)
                && !has_asset_id
                && has_symbol
            {
                if activity
                    .quote_ccy
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    Self::add_activity_error(
                        activity,
                        "quoteCcy",
                        "Price currency (quoteCcy) is required to import this activity.",
                    );
                    activity.is_valid = false;
                    has_validation_errors = true;
                }
                if activity
                    .instrument_type
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    Self::add_activity_error(
                        activity,
                        "instrumentType",
                        "Instrument type is required to import this activity.",
                    );
                    activity.is_valid = false;
                    has_validation_errors = true;
                }
            }
        }

        if has_validation_errors {
            let skipped = import_activities_indexed
                .iter()
                .filter(|(_, a)| !a.is_valid)
                .count() as u32;
            for (idx, activity) in import_activities_indexed {
                ordered[idx] = Some(activity);
            }
            return Ok(ImportActivitiesResult {
                activities: ordered.into_iter().flatten().collect(),
                import_run_id: String::new(),
                summary: ImportActivitiesSummary {
                    total: total as u32,
                    imported: 0,
                    skipped,
                    duplicates: 0,
                    assets_created: 0,
                    success: false,
                    error_message: Some("Validation errors found in activities.".to_string()),
                },
            });
        }

        // ── 4. Convert to NewActivity ────────────────────────────────────────
        // source_slice keeps the original ActivityImport values for idempotency
        // and later transfer-pair matching using the pre-normalized data.
        let source_slice: Vec<ActivityImport> = import_activities_indexed
            .iter()
            .map(|(_, a)| a.clone())
            .collect();

        let mut new_activities: Vec<NewActivity> = source_slice
            .iter()
            .cloned()
            .map(NewActivity::from)
            .collect();

        for (new_act, src) in new_activities.iter_mut().zip(source_slice.iter()) {
            new_act.subtype = NewActivity::canonicalize_subtype(new_act.subtype.as_deref());
            Self::normalize_new_activity_economic_signs(new_act);
            new_act.idempotency_key = Self::build_import_idempotency_key(src, &new_act.account_id);
        }

        // ── 5. Partition hard duplicates before insert ───────────────────────
        let mut first_index_by_key: HashMap<String, usize> = HashMap::new();
        let mut batch_dup_sources: HashMap<usize, usize> = HashMap::new();

        for (position, activity) in new_activities.iter().enumerate() {
            let Some(key) = activity.idempotency_key.as_ref() else {
                continue;
            };

            if let Some(first_idx) = first_index_by_key.get(key).copied() {
                batch_dup_sources.insert(position, first_idx);
            } else {
                first_index_by_key.insert(key.clone(), position);
            }
        }

        let existing_duplicates = if first_index_by_key.is_empty() {
            HashMap::new()
        } else {
            self.check_existing_duplicates(first_index_by_key.keys().cloned().collect())?
        };

        let mut duplicate_count = 0u32;
        let mut insertable_positions: Vec<usize> = Vec::with_capacity(new_activities.len());

        for (position, activity) in new_activities.iter_mut().enumerate() {
            // Clone to avoid holding a borrow on `activity` across the mutable
            // `activity.idempotency_key = None` needed for force-import.
            let Some(key) = activity.idempotency_key.clone() else {
                insertable_positions.push(position);
                continue;
            };

            let is_force_import = import_activities_indexed
                .get(position)
                .is_some_and(|(_, imp)| imp.force_import);

            if let Some(existing_id) = existing_duplicates.get(&key) {
                if is_force_import {
                    // User explicitly chose to import despite DB duplicate.
                    // Clear key so the unique constraint is not violated.
                    activity.idempotency_key = None;
                    insertable_positions.push(position);
                } else {
                    if let Some((_, import_activity)) = import_activities_indexed.get_mut(position)
                    {
                        Self::add_activity_warning(
                            import_activity,
                            "_duplicate",
                            "Duplicate activity already exists",
                        );
                        import_activity.duplicate_of_id = Some(existing_id.clone());
                    }
                    duplicate_count += 1;
                }
                continue;
            }

            if let Some(first_idx) = batch_dup_sources.get(&position).copied() {
                if is_force_import {
                    // User explicitly chose to import despite batch duplicate.
                    activity.idempotency_key = None;
                    insertable_positions.push(position);
                } else {
                    let duplicate_line_number = import_activities_indexed
                        .get(first_idx)
                        .and_then(|(_, activity)| activity.line_number)
                        .unwrap_or((first_idx + 1) as i32);
                    if let Some((_, import_activity)) = import_activities_indexed.get_mut(position)
                    {
                        Self::add_activity_warning(
                            import_activity,
                            "_duplicate",
                            &format!(
                                "Duplicate of line {} in this import batch",
                                duplicate_line_number
                            ),
                        );
                        import_activity.duplicate_of_line_number = Some(duplicate_line_number);
                    }
                    duplicate_count += 1;
                }
                continue;
            }

            // Not a duplicate — force_import is a no-op, key is preserved.
            insertable_positions.push(position);
        }

        let mut insertable_sources: Vec<(usize, ActivityImport)> =
            Vec::with_capacity(insertable_positions.len());
        let mut insertable_new_activities: Vec<NewActivity> =
            Vec::with_capacity(insertable_positions.len());

        for position in insertable_positions {
            if let Some(indexed_activity) = import_activities_indexed.get(position).cloned() {
                insertable_sources.push(indexed_activity);
            }
            if let Some(new_activity) = new_activities.get(position).cloned() {
                insertable_new_activities.push(new_activity);
            }
        }

        let insertable_source_slice: Vec<ActivityImport> = insertable_sources
            .iter()
            .map(|(_, activity)| activity.clone())
            .collect();
        // Link only rows that will be inserted so a duplicate-skipped leg cannot
        // leave its counterpart with an orphan source_group_id.
        self.link_imported_transfer_pairs(&insertable_source_slice, &mut insertable_new_activities);

        // ── 6. Ensure FX pairs (one batch call) ──────────────────────────────
        let mut fx_pairs: HashSet<(String, String)> = HashSet::new();
        for (new_act, (_, src)) in insertable_new_activities
            .iter()
            .zip(insertable_sources.iter())
        {
            let account_id = src.account_id.as_deref().unwrap_or("");
            let account_currency = account_currencies
                .get(account_id)
                .cloned()
                .unwrap_or_else(|| base_ccy.clone());
            let act_ccy = new_act.currency.clone();
            if !act_ccy.is_empty() && act_ccy != account_currency {
                fx_pairs.insert((act_ccy.clone(), account_currency.clone()));
            }
            if let Some(quote_ccy) = new_act.get_quote_ccy() {
                let quote_ccy = quote_ccy.to_string();
                if quote_ccy != account_currency && quote_ccy != act_ccy {
                    fx_pairs.insert((quote_ccy, account_currency.clone()));
                }
            }
        }
        if !fx_pairs.is_empty() {
            self.fx_service
                .ensure_fx_pairs(fx_pairs.into_iter().collect())
                .await?;
        }

        // ── 7. Create ImportRun ───────────────────────────────────────────────
        let first_account_id = import_activities_indexed
            .first()
            .and_then(|(_, a)| a.account_id.as_deref())
            .unwrap_or("")
            .to_string();

        let import_run = ImportRun::new(
            first_account_id,
            "csv".to_string(),
            ImportRunType::Import,
            ImportRunMode::Incremental,
            ReviewMode::Never,
        );
        let import_run_id = import_run.id.clone();

        if let Some(ref repo) = self.import_run_repository {
            if let Err(e) = repo.create(import_run.clone()).await {
                warn!("Failed to create import run: {}", e);
            }
        }

        // ── 8. Collect event metadata ─────────────────────────────────────────
        let account_ids: Vec<String> = insertable_sources
            .iter()
            .filter_map(|(_, a)| a.account_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let asset_ids: Vec<String> = insertable_new_activities
            .iter()
            .filter_map(|a| a.get_symbol_id().map(str::to_string))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let currencies: Vec<String> = insertable_new_activities
            .iter()
            .map(|a| a.currency.clone())
            .filter(|c| !c.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let earliest_at = Self::earliest_new_activity_at_utc(insertable_new_activities.iter());

        // ── 9. Insert all non-duplicate activities in one transaction ────────
        let inserted_count = if insertable_new_activities.is_empty() {
            0
        } else {
            match self
                .activity_repository
                .create_activities(insertable_new_activities)
                .await
            {
                Ok(n) => n as u32,
                Err(e) => {
                    if let Some(ref repo) = self.import_run_repository {
                        let mut failed_run = import_run.clone();
                        failed_run.fail(e.to_string());
                        if let Err(ue) = repo.update(failed_run).await {
                            warn!("Failed to mark import run as failed: {}", ue);
                        }
                    }
                    return Err(e);
                }
            }
        };

        // ── 10. Finalize ImportRun ────────────────────────────────────────────
        if let Some(ref repo) = self.import_run_repository {
            let mut completed_run = import_run;
            completed_run.complete();
            completed_run.summary = Some(ImportRunSummary {
                fetched: total as u32,
                inserted: inserted_count,
                updated: 0,
                skipped: duplicate_count,
                warnings: duplicate_count,
                errors: 0,
                removed: 0,
                assets_created: 0,
            });
            if let Err(e) = repo.update(completed_run).await {
                warn!("Failed to update import run with success status: {}", e);
            }
        }

        // ── 11. Emit events + build ordered result ────────────────────────────
        if inserted_count > 0 {
            self.emit_activities_changed(account_ids, asset_ids, currencies, earliest_at);
        }

        for (idx, activity) in import_activities_indexed {
            ordered[idx] = Some(activity);
        }

        Ok(ImportActivitiesResult {
            activities: ordered.into_iter().flatten().collect(),
            import_run_id,
            summary: ImportActivitiesSummary {
                total: total as u32,
                imported: inserted_count,
                skipped: duplicate_count,
                duplicates: duplicate_count,
                assets_created: 0,
                success: true,
                error_message: None,
            },
        })
    }

    /// Gets the first activity date for given account IDs
    fn get_first_activity_date(
        &self,
        account_ids: Option<&[String]>,
    ) -> Result<Option<chrono::DateTime<Utc>>> {
        self.activity_repository
            .get_first_activity_date(account_ids)
    }

    /// Gets the import mapping for a given account ID and context kind.
    /// Normalizes legacy values ("ACTIVITY" → "CSV_ACTIVITY", "HOLDINGS" → "CSV_HOLDINGS").
    fn get_import_mapping(
        &self,
        account_id: String,
        context_kind: String,
    ) -> Result<ImportMappingData> {
        let context_kind = normalize_context_kind_value(&context_kind).to_string();
        let mapping = self
            .activity_repository
            .get_import_mapping(&account_id, &context_kind)?;

        let mut result = match mapping {
            Some(m) => m.to_mapping_data().map_err(|e| {
                ActivityError::InvalidData(format!("Failed to parse mapping data: {}", e))
            })?,
            None => ImportMappingData::default(),
        };
        result.account_id = account_id;
        result.context_kind = context_kind;
        Ok(result)
    }

    fn list_import_templates(&self) -> Result<Vec<ImportTemplateData>> {
        self.activity_repository
            .list_import_templates()?
            .into_iter()
            .map(|template| {
                template.to_template_data().map_err(|e| {
                    crate::errors::Error::from(ActivityError::InvalidData(format!(
                        "Failed to parse import template data: {}",
                        e
                    )))
                })
            })
            .collect()
    }

    fn get_import_template(&self, template_id: String) -> Result<ImportTemplateData> {
        let template = self.activity_repository.get_import_template(&template_id)?;
        match template {
            Some(template) => template.to_template_data().map_err(|e| {
                ActivityError::InvalidData(format!("Failed to parse import template data: {}", e))
                    .into()
            }),
            None => Ok(ImportTemplateData {
                id: template_id,
                ..ImportTemplateData::default()
            }),
        }
    }

    async fn link_account_template(
        &self,
        account_id: String,
        template_id: String,
        context_kind: String,
    ) -> Result<()> {
        let context_kind = normalize_context_kind_value(&context_kind).to_string();
        self.activity_repository
            .link_account_template(&account_id, &template_id, &context_kind)
            .await
    }

    /// Saves or updates an import mapping
    async fn save_import_mapping(
        &self,
        mut mapping_data: ImportMappingData,
    ) -> Result<ImportMappingData> {
        mapping_data.context_kind =
            normalize_context_kind_value(&mapping_data.context_kind).to_string();
        let mapping = ImportMapping::from_mapping_data(&mapping_data)?;
        self.activity_repository
            .save_import_mapping(&mapping)
            .await?;
        Ok(mapping_data)
    }

    async fn save_import_template(
        &self,
        template_data: ImportTemplateData,
    ) -> Result<ImportTemplateData> {
        let template = ImportTemplate::from_template_data(&template_data)?;
        self.activity_repository
            .save_import_template(&template)
            .await?;
        Ok(template_data)
    }

    async fn delete_import_template(&self, template_id: String) -> Result<()> {
        self.activity_repository
            .delete_import_template(&template_id)
            .await
    }

    fn get_broker_sync_profile(
        &self,
        account_id: String,
        source_system: String,
    ) -> Result<BrokerSyncProfileData> {
        let template = self
            .activity_repository
            .get_broker_sync_profile(&account_id, &source_system)?;
        match template {
            Some(t) => t.to_broker_profile_data().map_err(|e| {
                ActivityError::InvalidData(format!("Failed to parse broker profile data: {}", e))
                    .into()
            }),
            None => Ok(BrokerSyncProfileData {
                source_system,
                ..BrokerSyncProfileData::default()
            }),
        }
    }

    async fn save_broker_sync_profile_rules(
        &self,
        request: SaveBrokerSyncProfileRulesRequest,
    ) -> Result<BrokerSyncProfileData> {
        use super::activities_model::BrokerProfileScope;

        // Determine template ID based on scope
        let template_id = if request.scope == BrokerProfileScope::Account {
            format!(
                "broker_{}_{}",
                request.source_system.to_lowercase(),
                request.account_id
            )
        } else {
            format!("broker_{}", request.source_system.to_lowercase())
        };

        // Load the base profile to merge patches into.
        // 1. If the exact target template already exists, use it (subsequent saves).
        // 2. Otherwise, seed from the precedence chain so inherited defaults are preserved.
        //    For BROKER scope: skip account-specific profiles to avoid leaking private overrides.
        let existing = match self.activity_repository.get_import_template(&template_id)? {
            Some(t) if t.kind == TemplateKind::BrokerActivity => {
                t.to_broker_profile_data().unwrap_or_default()
            }
            _ => {
                // First save — seed from effective baseline.
                // get_broker_sync_profile respects account→broker→system precedence.
                // For BROKER scope, use empty account_id so it skips account-specific lookup.
                let seed_account = if request.scope == BrokerProfileScope::Account {
                    &request.account_id
                } else {
                    ""
                };
                self.get_broker_sync_profile(
                    seed_account.to_string(),
                    request.source_system.clone(),
                )?
            }
        };

        // Merge patches into existing
        let mut activity_mappings = existing.activity_mappings;
        for (key, values) in request.activity_rule_patches {
            activity_mappings.insert(key, values);
        }
        let mut symbol_mappings = existing.symbol_mappings;
        for (key, value) in request.security_rule_patches {
            symbol_mappings.insert(key, value);
        }
        let mut symbol_mapping_meta = existing.symbol_mapping_meta;
        for (key, meta) in request.security_rule_meta_patches {
            symbol_mapping_meta.insert(key, meta);
        }

        let profile_data = BrokerSyncProfileData {
            id: template_id,
            name: format!("{} Profile", request.source_system),
            scope: ImportTemplateScope::User,
            source_system: request.source_system.clone(),
            activity_mappings,
            symbol_mappings,
            symbol_mapping_meta,
        };

        let template = ImportTemplate::from_broker_profile_data(&profile_data).map_err(|e| {
            crate::errors::Error::from(ActivityError::InvalidData(format!(
                "Failed to serialize broker profile: {}",
                e
            )))
        })?;

        self.activity_repository
            .save_broker_sync_profile(&template)
            .await?;

        // Link to account if scope is Account
        if request.scope == BrokerProfileScope::Account {
            self.activity_repository
                .link_broker_sync_profile(
                    &request.account_id,
                    &profile_data.id,
                    &request.source_system,
                )
                .await?;
        }

        Ok(profile_data)
    }

    /// Checks for existing activities with the given idempotency keys.
    ///
    /// Returns a map of {idempotency_key: existing_activity_id} for keys that already exist.
    fn check_existing_duplicates(
        &self,
        idempotency_keys: Vec<String>,
    ) -> Result<HashMap<String, String>> {
        self.activity_repository
            .check_existing_duplicates(&idempotency_keys)
    }

    fn parse_csv(
        &self,
        content: &[u8],
        config: &csv_parser::ParseConfig,
    ) -> Result<csv_parser::ParsedCsvResult> {
        csv_parser::parse_csv(content, config)
    }

    /// Upserts multiple activities (insert or update on conflict).
    /// Used by broker sync to efficiently sync activities.
    /// Emits a single aggregated ActivitiesChanged event for all upserted activities.
    async fn upsert_activities_bulk(
        &self,
        activities: Vec<ActivityUpsert>,
    ) -> Result<BulkUpsertResult> {
        if activities.is_empty() {
            return Ok(BulkUpsertResult::default());
        }

        let earliest_activity_at_utc = Self::earliest_upsert_activity_at_utc(&activities);

        // Collect unique account_ids, asset_ids, and currencies for the event before the upsert
        let account_ids: Vec<String> = activities
            .iter()
            .map(|a| a.account_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        let asset_ids: Vec<String> = activities
            .iter()
            .filter_map(|a| a.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let currencies: Vec<String> = activities
            .iter()
            .map(|a| a.currency.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();

        // Perform the upsert via repository
        let result = self.activity_repository.bulk_upsert(activities).await?;

        // Emit single aggregated event if any activities were affected
        if result.upserted > 0 {
            self.emit_activities_changed(
                account_ids,
                asset_ids,
                currencies,
                earliest_activity_at_utc,
            );
        }

        Ok(result)
    }

    async fn prepare_activities_for_save(
        &self,
        activities: Vec<NewActivity>,
        account: &Account,
    ) -> Result<PrepareActivitiesResult> {
        self.prepare_activities_internal(activities, account, PreparationMode::Save)
            .await
    }

    async fn prepare_activities_for_import(
        &self,
        activities: Vec<NewActivity>,
        account: &Account,
    ) -> Result<PrepareActivitiesResult> {
        self.prepare_activities_internal(activities, account, PreparationMode::ImportApply)
            .await
    }

    async fn prepare_activities_for_sync(
        &self,
        activities: Vec<NewActivity>,
        account: &Account,
    ) -> Result<PrepareActivitiesResult> {
        self.prepare_activities_internal(activities, account, PreparationMode::Sync)
            .await
    }
}

// Private helper methods for ActivityService
impl ActivityService {
    async fn prepare_activities_internal(
        &self,
        activities: Vec<NewActivity>,
        account: &Account,
        mode: PreparationMode,
    ) -> Result<PrepareActivitiesResult> {
        use crate::assets::AssetSpec;

        if activities.is_empty() {
            return Ok(PrepareActivitiesResult::default());
        }

        let activities: Vec<NewActivity> = activities
            .into_iter()
            .map(Self::normalize_activity_for_preparation)
            .collect();

        let mut result = PrepareActivitiesResult::default();
        let base_ccy = self.account_service.get_base_currency().unwrap_or_default();
        let account_currency = resolve_currency(&[&account.currency, &base_ccy]);

        // 1. Batch resolve symbols → MICs when live resolution is enabled.
        let symbol_mic_cache = if mode.allows_live_resolution() {
            let symbols_to_resolve: HashSet<String> = activities
                .iter()
                .filter_map(|a| {
                    let symbol = a.get_symbol_code()?;
                    let has_mic = a.get_exchange_mic().is_some();
                    let instrument_type_input =
                        Self::parse_instrument_type(a.get_instrument_type());
                    let is_non_security_instrument = matches!(
                        instrument_type_input,
                        Some(InstrumentType::Crypto | InstrumentType::Fx)
                    );
                    let is_cash = symbol.starts_with("CASH:");
                    if !has_mic && !is_cash && !is_non_security_instrument {
                        Some(symbol.to_string())
                    } else {
                        None
                    }
                })
                .collect();

            self.resolve_symbols_batch_single_currency(symbols_to_resolve, &account_currency)
                .await
        } else {
            HashMap::new()
        };

        // 2. Build AssetSpecs for each activity
        let mut asset_specs: Vec<AssetSpec> = Vec::new();
        let mut activity_asset_map: Vec<Option<String>> = Vec::with_capacity(activities.len());
        let mut quote_ccy_cache: QuoteCcyCache = HashMap::new();
        let mut sync_review_indices: HashSet<usize> = HashSet::new();

        for (idx, activity) in activities.iter().enumerate() {
            if let Err(e) = activity.validate() {
                if mode.is_sync() {
                    warn!(
                        "Broker sync activity at index {} failed validation and will be imported for review: {}",
                        idx, e
                    );
                    sync_review_indices.insert(idx);
                } else {
                    result.errors.push((idx, e.to_string()));
                    activity_asset_map.push(None);
                    continue;
                }
            }

            match self
                .build_asset_spec(
                    activity,
                    account,
                    &symbol_mic_cache,
                    mode,
                    &mut quote_ccy_cache,
                )
                .await
            {
                Ok(Some(spec)) => {
                    // Use spec.id if available, or instrument_key for mapping
                    let map_key = spec.id.clone().or_else(|| spec.instrument_key());
                    activity_asset_map.push(map_key);
                    asset_specs.push(spec);
                }
                Ok(None) => {
                    // Cash activities have no asset
                    activity_asset_map.push(None);
                }
                Err(e) => {
                    if mode.is_sync() {
                        warn!(
                            "Broker sync activity at index {} could not resolve an asset and will be imported for review: {}",
                            idx, e
                        );
                        sync_review_indices.insert(idx);
                    } else {
                        result.errors.push((idx, e.to_string()));
                    }
                    activity_asset_map.push(None);
                }
            }
        }

        // 3. Deduplicate specs and call ensure_assets()
        let unique_specs: Vec<AssetSpec> = asset_specs
            .into_iter()
            .fold(HashMap::new(), |mut map, spec| {
                let key = spec
                    .id
                    .clone()
                    .unwrap_or_else(|| spec.instrument_key().unwrap_or_default());
                map.entry(key).or_insert(spec);
                map
            })
            .into_values()
            .collect();

        let ensure_result = self
            .asset_service
            .ensure_assets(unique_specs, self.activity_repository.as_ref())
            .await?;

        result.assets_created = ensure_result.created_ids.len() as u32;
        result.created_asset_ids = ensure_result.created_ids.clone();

        // Build reverse lookup: instrument_key → asset_id for resolving activity_asset_map entries
        let mut key_to_asset_id: HashMap<String, String> = HashMap::new();
        for asset in ensure_result.assets.values() {
            if let Some(ref key) = asset.instrument_key {
                key_to_asset_id.insert(key.clone(), asset.id.clone());
            }
        }

        // Resolve activity_asset_map entries: replace instrument_key refs with actual asset IDs
        for entry in &mut activity_asset_map {
            if let Some(ref map_key) = entry {
                // If the map_key is not a direct asset ID in ensure_result, try instrument_key lookup
                if !ensure_result.assets.contains_key(map_key) {
                    if let Some(asset_id) = key_to_asset_id.get(map_key) {
                        *entry = Some(asset_id.clone());
                    } else {
                        // Unresolved instrument_key — clear to avoid FK violation
                        warn!(
                            "Could not resolve asset for key '{}'; activity will have no linked asset",
                            map_key
                        );
                        *entry = None;
                    }
                }
            }
        }

        // 4. Collect FX pairs and call ensure_fx_pairs()
        // Include both activity currency and asset currency pairs
        let mut fx_pairs: Vec<(String, String)> = Vec::new();

        for (idx, a) in activities.iter().enumerate() {
            let activity_currency = if !a.currency.is_empty() {
                a.currency.clone()
            } else if let Some(asset_id) = activity_asset_map.get(idx).and_then(|id| id.as_ref()) {
                ensure_result
                    .assets
                    .get(asset_id)
                    .map(|asset| asset.quote_ccy.clone())
                    .unwrap_or_else(|| account_currency.clone())
            } else {
                account_currency.clone()
            };

            // Activity currency vs account currency
            if activity_currency != account_currency {
                fx_pairs.push((activity_currency.clone(), account_currency.clone()));
            }

            // Asset currency vs account currency (when asset currency differs from both)
            if let Some(asset_id) = activity_asset_map.get(idx).and_then(|id| id.as_ref()) {
                if let Some(asset) = ensure_result.assets.get(asset_id) {
                    if asset.quote_ccy != account_currency && asset.quote_ccy != activity_currency {
                        fx_pairs.push((asset.quote_ccy.clone(), account_currency.clone()));
                    }
                }
            }
        }

        self.fx_service.ensure_fx_pairs(fx_pairs).await?;

        // 5. Build PreparedActivity for each valid activity
        for (idx, mut activity) in activities.into_iter().enumerate() {
            // Skip if we already recorded an error for this index
            if result.errors.iter().any(|(i, _)| *i == idx) {
                continue;
            }

            let resolved_asset_id = activity_asset_map.get(idx).cloned().flatten();

            // Determine FX pair needed
            let activity_currency = if !activity.currency.is_empty() {
                activity.currency.clone()
            } else if let Some(asset_id) = resolved_asset_id.as_ref() {
                ensure_result
                    .assets
                    .get(asset_id)
                    .map(|asset| asset.quote_ccy.clone())
                    .unwrap_or_else(|| account_currency.clone())
            } else {
                account_currency.clone()
            };
            let fx_pair = if activity_currency != account_currency {
                Some((activity_currency.clone(), account_currency.clone()))
            } else {
                None
            };

            // Validate the activity
            if let Err(e) = activity.validate() {
                if mode.is_sync() {
                    warn!(
                        "Broker sync activity at index {} failed final validation and will be imported for review: {}",
                        idx, e
                    );
                    sync_review_indices.insert(idx);
                } else {
                    result.errors.push((idx, e.to_string()));
                    continue;
                }
            }

            if mode.is_sync()
                && Self::sync_asset_income_needs_downgrade(&activity, resolved_asset_id.as_deref())
            {
                Self::downgrade_unresolvable_sync_asset_income(&mut activity);
                sync_review_indices.insert(idx);
            }

            // Update activity's asset with resolved asset_id
            if let Some(ref asset_id) = resolved_asset_id {
                match activity.asset.as_mut() {
                    Some(asset) => asset.id = Some(asset_id.clone()),
                    None => {
                        activity.asset = Some(AssetResolutionInput {
                            id: Some(asset_id.clone()),
                            ..Default::default()
                        });
                    }
                }
            }

            // 6. Create a quote from the activity price as a fallback, but only
            // for MANUAL-mode assets. For MARKET-mode assets the unit price is
            // a cost input, not a market price; writing it as BROKER would
            // misattribute user input as broker-sourced (BROKER is reserved
            // for connect-synced activities) and can shadow provider quotes.
            if PRICE_BEARING_ACTIVITY_TYPES.contains(&activity.activity_type.as_str()) {
                if let Some(ref asset_id) = resolved_asset_id {
                    if let Some(unit_price) = activity.unit_price {
                        let is_manual_mode = ensure_result
                            .assets
                            .get(asset_id)
                            .is_some_and(|a| a.quote_mode == QuoteMode::Manual);
                        if is_manual_mode {
                            let currency = if !activity.currency.is_empty() {
                                &activity.currency
                            } else {
                                &account_currency
                            };
                            self.create_quote_from_activity(
                                asset_id,
                                unit_price,
                                currency,
                                &activity.activity_date,
                                DATA_SOURCE_MANUAL.to_string(),
                            )
                            .await?;
                        }
                    }
                }
            }

            // Ensure currency is set for cash activities or missing currency
            if activity.currency.is_empty() {
                if let Some(asset_id) = resolved_asset_id.as_ref() {
                    if let Some(asset) = ensure_result.assets.get(asset_id) {
                        activity.currency = asset.quote_ccy.clone();
                    } else {
                        activity.currency = account_currency.clone();
                    }
                } else {
                    activity.currency = account_currency.clone();
                }
            }

            // Normalize amounts to absolute values (direction is determined by activity type)
            activity.quantity = activity.quantity.map(|v| v.abs());
            activity.unit_price = activity.unit_price.map(|v| v.abs());
            activity.amount = activity.amount.map(|v| v.abs());
            activity.fee = activity.fee.map(|v| v.abs());

            if let Err(e) = Self::validate_split_ratio(&activity.activity_type, activity.amount) {
                if mode.is_sync() {
                    warn!(
                        "Broker sync activity at index {} has invalid split data and will be imported for review: {}",
                        idx, e
                    );
                    sync_review_indices.insert(idx);
                } else {
                    return Err(e);
                }
            }

            if mode.is_sync() && sync_review_indices.contains(&idx) {
                activity.needs_review = Some(true);
            }

            // Securities transfers derive monetary value from quantity × unit_price;
            // never persist an inbound `amount` for them when unit_price is present
            // (see prepare_new_activity). Legacy imports with qty + amount and no
            // unit_price keep their monetary value.
            if is_securities_transfer(&activity.activity_type, resolved_asset_id.as_deref())
                && activity.unit_price.is_some()
            {
                activity.amount = None;
            }

            // Normalize minor currency units (e.g., GBp -> GBP) and convert amounts
            if get_normalization_rule(&activity.currency).is_some() {
                if let Some(unit_price) = activity.unit_price {
                    let (normalized_price, _) = normalize_amount(unit_price, &activity.currency);
                    activity.unit_price = Some(normalized_price);
                }
                if let Some(amount) = activity.amount {
                    let (normalized_amount, _) = normalize_amount(amount, &activity.currency);
                    activity.amount = Some(normalized_amount);
                }
                if let Some(fee) = activity.fee {
                    let (normalized_fee, normalized_currency) =
                        normalize_amount(fee, &activity.currency);
                    activity.fee = Some(normalized_fee);
                    activity.currency = normalized_currency.to_string();
                } else {
                    let (_, normalized_currency) =
                        normalize_amount(Decimal::ZERO, &activity.currency);
                    activity.currency = normalized_currency.to_string();
                }
            }

            let explicit_idempotency_key = activity
                .idempotency_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);

            if let Some(key) = explicit_idempotency_key {
                activity.idempotency_key = Some(key);
            } else if let Ok(date) = DateTime::parse_from_rfc3339(&activity.activity_date)
                .map(|dt| dt.with_timezone(&Utc))
                .or_else(|_| {
                    NaiveDate::parse_from_str(&activity.activity_date, "%Y-%m-%d")
                        .map(|d| Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default()))
                })
            {
                let key = compute_idempotency_key(
                    &activity.account_id,
                    &activity.activity_type,
                    &date,
                    activity.get_symbol_id(),
                    activity.quantity,
                    activity.unit_price,
                    activity.amount,
                    &activity.currency,
                    activity.source_record_id.as_deref(),
                    activity.notes.as_deref(),
                );
                activity.idempotency_key = Some(key);
            }

            result.prepared.push(PreparedActivity {
                activity,
                resolved_asset_id,
                fx_pair,
            });
        }

        Ok(result)
    }

    /// Links matching TRANSFER_IN and TRANSFER_OUT activities by setting a shared source_group_id.
    /// Matches are based on same date, currency, symbol, and amount.
    fn link_imported_transfer_pairs(
        &self,
        validated_activities: &[ActivityImport],
        new_activities: &mut [NewActivity],
    ) {
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        struct TransferMatchKey {
            date: NaiveDate,
            currency: String,
            symbol: String,
            amount: Decimal,
        }

        fn parse_activity_date(date_str: &str) -> Option<NaiveDate> {
            if let Ok(dt) = DateTime::parse_from_rfc3339(date_str) {
                return Some(dt.date_naive());
            }
            NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()
        }

        fn transfer_match_key(activity: &ActivityImport) -> Option<TransferMatchKey> {
            let date = parse_activity_date(&activity.date)?;
            let amount = activity.amount.or_else(|| {
                let quantity = activity.quantity?;
                let unit_price = activity.unit_price?;
                Some(quantity * unit_price)
            })?;
            if amount.is_zero() {
                return None;
            }
            Some(TransferMatchKey {
                date,
                currency: activity.currency.clone(),
                symbol: activity.symbol.clone(),
                amount,
            })
        }

        fn set_transfer_flow_external(
            metadata: Option<String>,
            is_external: bool,
        ) -> Option<String> {
            let mut value = metadata
                .and_then(|metadata| serde_json::from_str::<serde_json::Value>(&metadata).ok())
                .unwrap_or_else(|| serde_json::json!({}));

            if !value.is_object() {
                value = serde_json::json!({});
            }

            let object = value
                .as_object_mut()
                .expect("transfer metadata value should be an object");
            let flow = object
                .entry("flow")
                .or_insert_with(|| serde_json::json!({}));
            if !flow.is_object() {
                *flow = serde_json::json!({});
            }
            if let Some(flow_object) = flow.as_object_mut() {
                flow_object.insert("is_external".to_string(), serde_json::json!(is_external));
            }

            Some(value.to_string())
        }

        fn same_account(
            validated_activities: &[ActivityImport],
            in_idx: usize,
            out_idx: usize,
        ) -> bool {
            let in_account = validated_activities
                .get(in_idx)
                .and_then(|activity| activity.account_id.as_deref());
            let out_account = validated_activities
                .get(out_idx)
                .and_then(|activity| activity.account_id.as_deref());

            matches!((in_account, out_account), (Some(in_account), Some(out_account)) if in_account == out_account)
        }

        let mut transfer_in: HashMap<TransferMatchKey, Vec<usize>> = HashMap::new();
        let mut transfer_out: HashMap<TransferMatchKey, Vec<usize>> = HashMap::new();

        for (idx, activity) in validated_activities.iter().enumerate() {
            let activity_type = activity.activity_type.as_str();
            if activity_type != ACTIVITY_TYPE_TRANSFER_IN
                && activity_type != ACTIVITY_TYPE_TRANSFER_OUT
            {
                continue;
            }

            if let Some(key) = transfer_match_key(activity) {
                if activity_type == ACTIVITY_TYPE_TRANSFER_IN {
                    transfer_in.entry(key).or_default().push(idx);
                } else {
                    transfer_out.entry(key).or_default().push(idx);
                }
            }
        }

        for (key, in_indices) in transfer_in {
            if let Some(out_indices) = transfer_out.get(&key) {
                let mut used_out_indices = HashSet::new();
                for in_idx in in_indices {
                    let Some(out_idx) = out_indices.iter().copied().find(|out_idx| {
                        !used_out_indices.contains(out_idx)
                            && !same_account(validated_activities, in_idx, *out_idx)
                    }) else {
                        continue;
                    };
                    used_out_indices.insert(out_idx);
                    let group_id = Uuid::new_v4().to_string();
                    if let Some(activity) = new_activities.get_mut(in_idx) {
                        activity.source_group_id = Some(group_id.clone());
                        activity.metadata =
                            set_transfer_flow_external(activity.metadata.take(), false);
                    }
                    if let Some(activity) = new_activities.get_mut(out_idx) {
                        activity.source_group_id = Some(group_id);
                        activity.metadata =
                            set_transfer_flow_external(activity.metadata.take(), false);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod securities_transfer_tests {
    use super::is_securities_transfer;

    #[test]
    fn transfer_with_security_asset_is_securities() {
        assert!(is_securities_transfer("TRANSFER_IN", Some("AAPL")));
        assert!(is_securities_transfer("TRANSFER_OUT", Some("FWIA")));
    }

    #[test]
    fn transfer_with_cash_asset_is_not_securities() {
        assert!(!is_securities_transfer("TRANSFER_IN", Some("CASH:USD")));
        assert!(!is_securities_transfer("TRANSFER_OUT", Some("$CASH-EUR")));
        assert!(!is_securities_transfer("TRANSFER_IN", Some("CASH-GBP")));
    }

    #[test]
    fn transfer_without_resolved_asset_is_not_securities() {
        assert!(!is_securities_transfer("TRANSFER_IN", None));
    }

    #[test]
    fn non_transfer_types_are_not_securities_transfers() {
        assert!(!is_securities_transfer("BUY", Some("AAPL")));
        assert!(!is_securities_transfer("DEPOSIT", Some("CASH:USD")));
    }
}
