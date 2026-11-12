//! `prepare_asset_update` / `commit_asset_update`: fix an asset's listing,
//! quote currency, quote mode or provider (#2467).
//!
//! Both tools build the same plan: the full profile `update_asset_profile`
//! would store (storage clears fields a payload leaves out, so every field is
//! sent back), the core preview of that profile with any identity collision,
//! the quote the chosen provider returns for the new listing, and whether the
//! provider history is replaced. The commit builds it again and writes only
//! when nothing blocks it.

use std::sync::Arc;

use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use wealthfolio_core::assets::{
    normalize_quote_ccy_code, Asset, AssetKind, InstrumentType, QuoteMode, UpdateAssetProfile,
};
use wealthfolio_core::fx::currency::{get_normalization_rule, normalize_currency_code};
use wealthfolio_core::quotes::constants::DATA_SOURCE_CUSTOM_SCRAPER;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::asset_market_data::{
    asset_detail, asset_holdings, preferred_provider_id, quote_sources, redact_urls,
    AssetDetailDto, AssetHoldingDto, QuoteSourceDto, CUSTOM_PROVIDER_PREFIX,
};
use crate::tools::refresh_market_data::{
    replace_provider_history, RefreshErrorDto, ReplacedHistoryDto,
};

/// `Some(None)` when the field is `null`, `None` when it is missing.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSymbolInput {
    pub provider: String,
    /// `null` removes the provider's symbol.
    pub symbol: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetUpdateArgs {
    pub asset_id: String,
    #[serde(default)]
    pub quote_currency: Option<String>,
    #[serde(default)]
    pub quote_mode: Option<QuoteMode>,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub exchange_mic: Option<String>,
    /// Missing: unchanged. `null`: no preferred provider.
    #[serde(default, deserialize_with = "present")]
    pub preferred_provider: Option<Option<String>>,
    #[serde(default)]
    pub provider_symbol: Option<ProviderSymbolInput>,
    #[serde(default)]
    pub keep_history: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldChangeDto {
    pub field: &'static str,
    pub before: Value,
    pub after: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCheckDto {
    /// Provider asked; none means the enabled providers in priority order.
    pub requested_provider: Option<String>,
    pub resolved_provider: Option<String>,
    pub currency: Option<String>,
    pub price: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub asset_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAssetUpdateOutput {
    pub asset_id: String,
    /// True when nothing blocks the update; commit with the same arguments.
    pub ready: bool,
    pub current: AssetDetailDto,
    pub changes: Vec<FieldChangeDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_check: Option<ProviderCheckDto>,
    /// The commit replaces the provider history after the update.
    pub replace_history: bool,
    pub holdings: Vec<AssetHoldingDto>,
    /// Accounts whose holdings could not be read for this asset.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub incomplete_account_ids: Vec<String>,
    pub quote_sources: Vec<QuoteSourceDto>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAssetUpdateOutput {
    pub asset_id: String,
    pub committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<AssetDetailDto>,
    pub changes: Vec<FieldChangeDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_replaced: Option<ReplacedHistoryDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_error: Option<RefreshErrorDto>,
    /// `queued` when valuations and a price sync follow the update.
    pub recalculation: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

/// Everything prepare reports and commit acts on.
struct UpdatePlan {
    asset: Asset,
    profile: UpdateAssetProfile,
    changes: Vec<FieldChangeDto>,
    conflict: Option<ConflictDto>,
    provider_check: Option<ProviderCheckDto>,
    replace_history: bool,
    warnings: Vec<String>,
    errors: Vec<String>,
}

fn exec_err(error: impl std::fmt::Display) -> AgentToolError {
    AgentToolError::ExecutionFailed(error.to_string())
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Override in the shape core's provider resolver reads for an instrument
/// type (`ProviderInstrument`); a metal also needs its quote currency.
fn provider_override(
    instrument_type: Option<&InstrumentType>,
    symbol: &str,
    quote_ccy: &str,
) -> Value {
    match instrument_type {
        Some(InstrumentType::Bond) => serde_json::json!({ "type": "bond_isin", "isin": symbol }),
        Some(InstrumentType::Crypto) => {
            serde_json::json!({ "type": "crypto_symbol", "symbol": symbol })
        }
        Some(InstrumentType::Fx) => serde_json::json!({ "type": "fx_symbol", "symbol": symbol }),
        Some(InstrumentType::Metal) => {
            serde_json::json!({ "type": "metal_symbol", "symbol": symbol, "quote": quote_ccy })
        }
        _ => serde_json::json!({ "type": "equity_symbol", "symbol": symbol }),
    }
}

/// The asset's provider configuration with the requested provider changes,
/// keeping every key the request does not touch.
fn updated_provider_config(asset: &Asset, args: &AssetUpdateArgs) -> Option<Value> {
    let mut config: Map<String, Value> = asset
        .provider_config
        .as_ref()
        .and_then(|c| c.as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(preferred) = &args.preferred_provider {
        config.remove("preferred_provider");
        config.remove("custom_provider_code");
        if let Some(provider) = trimmed(preferred.as_deref()) {
            match provider.strip_prefix(CUSTOM_PROVIDER_PREFIX) {
                Some(code) => {
                    config.insert(
                        "preferred_provider".into(),
                        DATA_SOURCE_CUSTOM_SCRAPER.into(),
                    );
                    config.insert("custom_provider_code".into(), code.trim().into());
                }
                None => {
                    config.insert("preferred_provider".into(), provider.into());
                }
            }
        }
    }
    if let Some(input) = &args.provider_symbol {
        let provider = input.provider.trim().to_string();
        let mut overrides = config
            .remove("overrides")
            .and_then(|o| o.as_object().cloned())
            .unwrap_or_default();
        match trimmed(input.symbol.as_deref()) {
            Some(symbol) => {
                overrides.insert(
                    provider,
                    provider_override(
                        asset.instrument_type.as_ref(),
                        symbol,
                        &normalize_quote_ccy_code(args.quote_currency.as_deref())
                            .unwrap_or_else(|| asset.quote_ccy.clone()),
                    ),
                );
            }
            None => {
                overrides.remove(&provider);
            }
        }
        if !overrides.is_empty() {
            config.insert("overrides".into(), Value::Object(overrides));
        }
    }
    (!config.is_empty()).then_some(Value::Object(config))
}

/// The full profile to store: the asset's current values, with the requested
/// changes. Storage clears provider config, quote mode, name, display code
/// and notes when a payload leaves them out, so all of them are sent.
fn requested_profile(asset: &Asset, args: &AssetUpdateArgs) -> UpdateAssetProfile {
    let exchange_mic = trimmed(args.exchange_mic.as_deref()).map(str::to_uppercase);
    let mic_changed = exchange_mic
        .as_deref()
        .is_some_and(|mic| Some(mic) != asset.instrument_exchange_mic.as_deref().map(str::trim));
    let quote_ccy = match normalize_quote_ccy_code(args.quote_currency.as_deref()) {
        Some(ccy) => Some(ccy),
        // A new exchange without a currency takes the exchange's currency,
        // as the app's editor does.
        None if mic_changed => None,
        None => Some(asset.quote_ccy.clone()),
    };
    UpdateAssetProfile {
        name: asset.name.clone(),
        display_code: asset.display_code.clone(),
        notes: asset.notes.clone().unwrap_or_default(),
        kind: Some(asset.kind.clone()),
        quote_mode: Some(args.quote_mode.unwrap_or(asset.quote_mode)),
        quote_ccy,
        instrument_type: asset.instrument_type.clone(),
        instrument_symbol: trimmed(args.symbol.as_deref())
            .map(str::to_string)
            .or_else(|| asset.instrument_symbol.clone()),
        instrument_exchange_mic: exchange_mic.or_else(|| asset.instrument_exchange_mic.clone()),
        provider_config: updated_provider_config(asset, args),
        metadata: None,
    }
}

/// The asset as it would read after storing `profile`.
fn asset_after(asset: &Asset, profile: &UpdateAssetProfile) -> Asset {
    Asset {
        display_code: profile.display_code.clone(),
        quote_mode: profile.quote_mode.unwrap_or(asset.quote_mode),
        quote_ccy: profile
            .quote_ccy
            .clone()
            .unwrap_or_else(|| asset.quote_ccy.clone()),
        instrument_symbol: profile.instrument_symbol.clone(),
        instrument_exchange_mic: profile.instrument_exchange_mic.clone(),
        provider_config: profile.provider_config.clone(),
        ..asset.clone()
    }
}

fn field_changes(before: &Asset, after: &Asset) -> Vec<FieldChangeDto> {
    let fields: [(&'static str, Value, Value); 7] = [
        (
            "quoteCurrency",
            before.quote_ccy.clone().into(),
            after.quote_ccy.clone().into(),
        ),
        (
            "quoteMode",
            serde_json::to_value(before.quote_mode).unwrap_or_default(),
            serde_json::to_value(after.quote_mode).unwrap_or_default(),
        ),
        (
            "symbol",
            before.instrument_symbol.clone().into(),
            after.instrument_symbol.clone().into(),
        ),
        (
            "displayCode",
            before.display_code.clone().into(),
            after.display_code.clone().into(),
        ),
        (
            "exchangeMic",
            before.instrument_exchange_mic.clone().into(),
            after.instrument_exchange_mic.clone().into(),
        ),
        (
            "preferredProvider",
            preferred_provider_id(before).into(),
            preferred_provider_id(after).into(),
        ),
        (
            "providerOverrides",
            before.provider_overrides().cloned().unwrap_or(Value::Null),
            after.provider_overrides().cloned().unwrap_or(Value::Null),
        ),
    ];
    fields
        .into_iter()
        .filter(|(_, before, after)| before != after)
        .map(|(field, before, after)| FieldChangeDto {
            field,
            before,
            after,
        })
        .collect()
}

/// Whether a change makes the stored provider quotes stale.
fn changes_prices(changes: &[FieldChangeDto]) -> bool {
    changes.iter().any(|change| {
        matches!(
            change.field,
            "quoteCurrency" | "symbol" | "exchangeMic" | "preferredProvider" | "providerOverrides"
        )
    })
}

/// Check that a provider named in the request exists and is enabled, before
/// anything is sent to it.
async fn check_provider(
    env: &dyn AgentEnvironment,
    provider: &str,
    allow_custom: bool,
) -> Result<Option<String>, AgentToolError> {
    let builtin = env
        .quote_service()
        .get_providers_info()
        .await
        .map_err(exec_err)?;
    if let Some(code) = provider.strip_prefix(CUSTOM_PROVIDER_PREFIX) {
        if !allow_custom {
            return Ok(Some(format!(
                "Provider symbols cannot be set for the custom provider '{provider}'"
            )));
        }
        let dispatch_enabled = builtin
            .iter()
            .any(|info| info.id == DATA_SOURCE_CUSTOM_SCRAPER && info.enabled);
        let custom = env.custom_providers().map_err(exec_err)?;
        return Ok(match custom.iter().find(|c| c.id == code.trim()) {
            None => Some(format!("Custom provider '{provider}' does not exist")),
            Some(c) if !c.enabled || !dispatch_enabled => {
                Some(format!("Custom provider '{provider}' is disabled"))
            }
            Some(_) => None,
        });
    }
    Ok(
        match builtin
            .iter()
            .find(|info| info.id == provider && info.id != DATA_SOURCE_CUSTOM_SCRAPER)
        {
            None => Some(format!(
                "Provider '{provider}' does not exist; see get_market_data_providers"
            )),
            Some(info) if !info.enabled => Some(format!(
                "Provider '{provider}' is disabled; the user can enable it in Settings > Market Data"
            )),
            Some(_) => None,
        },
    )
}

async fn build_plan(
    env: &dyn AgentEnvironment,
    args: &AssetUpdateArgs,
) -> Result<UpdatePlan, AgentToolError> {
    let asset_id = args.asset_id.trim();
    let asset = env
        .asset_service()
        .get_asset_by_id(asset_id)
        .map_err(|_| AgentToolError::InvalidInput(format!("Asset '{asset_id}' was not found")))?;
    if asset.kind != AssetKind::Investment {
        return Err(AgentToolError::InvalidInput(format!(
            "Asset '{asset_id}' is not an investment; only investment assets can be updated here"
        )));
    }
    if args.quote_currency.is_some()
        && !normalize_quote_ccy_code(args.quote_currency.as_deref()).is_some_and(|ccy| {
            // ISO codes, pence codes, and crypto quotes such as USDT or FDUSD.
            (3..=5).contains(&ccy.len()) && ccy.chars().all(|c| c.is_ascii_alphanumeric())
        })
    {
        return Err(AgentToolError::InvalidInput(
            "quoteCurrency must be a currency code such as USD, GBp or USDT".to_string(),
        ));
    }
    if let Some(input) = &args.provider_symbol {
        if input.provider.trim().is_empty() {
            return Err(AgentToolError::InvalidInput(
                "providerSymbol.provider is required".to_string(),
            ));
        }
    }

    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    // Provider checks come first: a disabled or unknown provider gets no request.
    if let Some(Some(provider)) = &args.preferred_provider {
        if let Some(error) = check_provider(env, provider.trim(), true).await? {
            errors.push(error);
        }
    }
    if let Some(input) = &args.provider_symbol {
        if let Some(error) = check_provider(env, input.provider.trim(), false).await? {
            errors.push(error);
        }
    }

    let requested = requested_profile(&asset, args);
    let preview = env
        .asset_service()
        .preview_asset_profile_update(&asset.id, requested)
        .map_err(exec_err)?;
    let profile = preview.profile;
    let after = asset_after(&asset, &profile);
    let changes = field_changes(&asset, &after);
    if changes.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "The request changes nothing on this asset".to_string(),
        ));
    }
    let conflict = preview.conflicting_asset.map(|other| ConflictDto {
        label: other
            .display_code
            .clone()
            .or(other.instrument_symbol.clone())
            .unwrap_or_else(|| other.id.clone()),
        asset_id: other.id,
    });
    if let Some(conflict) = &conflict {
        errors.push(format!(
            "Asset {} ({}) already has this listing; the update would be refused",
            conflict.label, conflict.asset_id
        ));
    }

    let prices_change = changes_prices(&changes);
    let mut provider_check = None;
    // Switching to MARKET makes providers the price source, so it is checked
    // like a listing change.
    let starts_syncing =
        after.quote_mode == QuoteMode::Market && asset.quote_mode != QuoteMode::Market;
    if after.quote_mode == QuoteMode::Market
        && (prices_change || starts_syncing)
        && errors.is_empty()
    {
        let requested_provider = preferred_provider_id(&after);
        let symbol = after
            .instrument_symbol
            .clone()
            .or(after.display_code.clone())
            .unwrap_or_default();
        // The asset as it would be stored, so the provider is asked with the
        // same provider configuration (overrides included) a sync uses.
        let resolved = env
            .quote_service()
            .resolve_asset_quote(&after)
            .await
            .map_err(|e| exec_err(redact_urls(&e.to_string())))?;
        match resolved.currency.as_deref() {
            None => {
                let listing = after
                    .instrument_exchange_mic
                    .as_deref()
                    .map(|mic| format!(" on {mic}"))
                    .unwrap_or_default();
                errors.push(match requested_provider.as_deref() {
                    Some(provider) => format!(
                        "{provider} returned no quote for {symbol}{listing}; check the symbol, exchange and provider"
                    ),
                    None => format!(
                        "No enabled provider returned a quote for {symbol}{listing}; check the symbol, exchange and provider"
                    ),
                });
            }
            Some(currency) if !same_quote_currency(currency, &after.quote_ccy) => {
                errors.push(format!(
                    "The provider quotes this listing in {currency}, not {}; set quoteCurrency to \
                 {currency} or pick another listing",
                    after.quote_ccy
                ))
            }
            Some(_) => {}
        }
        provider_check = Some(ProviderCheckDto {
            requested_provider,
            resolved_provider: resolved.resolved_provider_id,
            currency: resolved.currency,
            price: resolved.price.and_then(|p| p.to_f64()),
        });
    } else if after.quote_mode == QuoteMode::Manual && prices_change {
        warnings.push(
            "The asset uses manual quotes, so no provider was asked; prices come from the \
             quotes you save"
                .to_string(),
        );
    }

    let custom_provider = asset_preferred_is_custom(&after);
    // Provider rows kept from before a switch to MANUAL may come from another
    // provider or listing, so switching back replaces them too.
    let wants_replace = (prices_change || starts_syncing) && after.quote_mode == QuoteMode::Market;
    if wants_replace && custom_provider && !args.keep_history {
        warnings.push(
            "Provider history cannot be replaced for a custom provider; stored provider quotes \
             stay until a refresh overwrites them"
                .to_string(),
        );
    }
    if wants_replace && args.keep_history {
        warnings.push(
            "keepHistory: stored provider quotes from before the change stay, including any in \
             the old currency"
                .to_string(),
        );
    }
    let replace_history = wants_replace && !args.keep_history && !custom_provider;

    Ok(UpdatePlan {
        asset,
        profile,
        changes,
        conflict,
        provider_check,
        replace_history,
        warnings,
        errors,
    })
}

/// Whether the fields a profile update writes are unchanged. Storage does not
/// bump `updated_at` on profile edits, so the fields themselves are compared.
fn same_profile(a: &Asset, b: &Asset) -> bool {
    a.name == b.name
        && a.display_code == b.display_code
        && a.notes == b.notes
        && a.kind == b.kind
        && a.quote_mode == b.quote_mode
        && a.quote_ccy == b.quote_ccy
        && a.instrument_type == b.instrument_type
        && a.instrument_symbol == b.instrument_symbol
        && a.instrument_exchange_mic == b.instrument_exchange_mic
        && a.provider_config == b.provider_config
        && a.metadata == b.metadata
}

/// Whether two quote currency codes name the same currency and unit: GBp
/// and GBX are both pence, GBP and GBp are not.
fn same_quote_currency(a: &str, b: &str) -> bool {
    a == b
        || (normalize_currency_code(a) == normalize_currency_code(b)
            && get_normalization_rule(a).map(|rule| rule.factor)
                == get_normalization_rule(b).map(|rule| rule.factor))
}

fn asset_preferred_is_custom(asset: &Asset) -> bool {
    asset.preferred_provider().as_deref() == Some(DATA_SOURCE_CUSTOM_SCRAPER)
}

fn schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "assetId": { "type": "string", "description": "Asset id, from get_asset." },
            "quoteCurrency": { "type": "string", "description": "Currency the prices are quoted in, e.g. USD, EUR or GBp (pence)." },
            "quoteMode": { "type": "string", "enum": ["MARKET", "MANUAL"], "description": "MARKET syncs prices from providers; MANUAL uses saved quotes only." },
            "symbol": { "type": "string", "description": "Ticker without exchange suffix, e.g. CSPX." },
            "exchangeMic": { "type": "string", "description": "ISO 10383 exchange code of the listing, e.g. XLON or XNAS." },
            "preferredProvider": { "type": ["string", "null"], "description": "Provider id from get_market_data_providers (CUSTOM:<code> for a custom provider); null to use the enabled providers in priority order." },
            "providerSymbol": {
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "description": "Built-in provider id." },
                    "symbol": { "type": ["string", "null"], "description": "Symbol that provider uses, e.g. CSPX.L; null removes it." }
                },
                "required": ["provider", "symbol"],
                "additionalProperties": false
            },
            "keepHistory": { "type": "boolean", "description": "Keep the stored provider quotes after a currency, listing or provider change. Default false: they are replaced." }
        },
        "required": ["assetId"],
        "additionalProperties": false
    })
}

/// Tool to preview a change to an asset's market-data setup.
pub struct PrepareAssetUpdate;

#[async_trait::async_trait]
impl AgentTool for PrepareAssetUpdate {
    fn name(&self) -> &'static str {
        "prepare_asset_update"
    }

    fn description(&self) -> &'static str {
        "Preview a fix to an asset's market-data setup without saving: quote currency, quote \
         mode, symbol, exchange MIC, preferred provider (any enabled provider from \
         get_market_data_providers, including a custom one) or one provider's symbol. Fields \
         you leave out keep their values. Shows the changes (symbol and MIC are normalized as \
         the app does), the accounts holding the asset, its stored quotes by source and \
         currency, and an existing asset with the same listing (a conflict). When the listing, \
         currency or provider changes on a MARKET asset (or it switches to MARKET), it asks the chosen provider for the \
         latest quote of the new listing (a network request; disabled providers are never \
         asked) and refuses when the provider has no quote or quotes another currency. \
         `replaceHistory` says whether commit_asset_update will then replace the stored provider \
         quotes (default for such changes, so old-currency rows go away; MANUAL quotes stay; \
         `keepHistory: true` skips it). Transactions, quantities and cost never change. Show \
         the user the changes and errors, then call commit_asset_update with the same arguments \
         when `ready` is true."
    }

    fn input_schema(&self) -> Value {
        schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead, AgentScope::MarketDataWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: AssetUpdateArgs = serde_json::from_value(args)?;
        let plan = build_plan(env.as_ref(), &args).await?;
        let (holdings, incomplete_account_ids) =
            asset_holdings(env.as_ref(), &plan.asset.id).await?;
        let mut warnings = plan.warnings;
        if !incomplete_account_ids.is_empty() {
            warnings.push(
                "Holdings of some accounts could not be read, so `holdings` may miss accounts \
                 that hold this asset; see incompleteAccountIds"
                    .to_string(),
            );
        }
        let quote_sources = quote_sources(
            &env.quote_service()
                .get_stored_quotes(&plan.asset.id, None, None)
                .map_err(exec_err)?,
        );
        let output = PrepareAssetUpdateOutput {
            asset_id: plan.asset.id.clone(),
            ready: plan.errors.is_empty(),
            current: asset_detail(&plan.asset),
            changes: plan.changes,
            conflict: plan.conflict,
            provider_check: plan.provider_check,
            replace_history: plan.replace_history,
            holdings,
            incomplete_account_ids,
            quote_sources,
            warnings,
            errors: plan.errors,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// Tool to save a reviewed change to an asset's market-data setup.
pub struct CommitAssetUpdate;

#[async_trait::async_trait]
impl AgentTool for CommitAssetUpdate {
    fn name(&self) -> &'static str {
        "commit_asset_update"
    }

    fn description(&self) -> &'static str {
        "Save a change previewed with prepare_asset_update; pass the same arguments. It runs the \
         same checks again, including the provider request, and saves nothing when one fails \
         (`committed: false` with `errors`). Then, when `replaceHistory` applied, it replaces the \
         asset's stored provider quotes from the new provider and listing (MANUAL and BROKER \
         quotes are kept). Prices sync and valuations recalculate in the background; check \
         with get_asset or get_health_status a few seconds later."
    }

    fn input_schema(&self) -> Value {
        schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead, AgentScope::MarketDataWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: AssetUpdateArgs = serde_json::from_value(args)?;
        let plan = build_plan(env.as_ref(), &args).await?;
        if !plan.errors.is_empty() {
            let output = CommitAssetUpdateOutput {
                asset_id: plan.asset.id,
                committed: false,
                asset: None,
                changes: plan.changes,
                history_replaced: None,
                history_error: None,
                recalculation: "none",
                warnings: plan.warnings,
                errors: plan.errors,
            };
            return Ok(AgentToolResult {
                content: serde_json::to_value(output)?,
            });
        }

        // The provider request can take a while; an edit made meanwhile (in
        // the app, say) must not be overwritten with the profile read before.
        let current = env
            .asset_service()
            .get_asset_by_id(&plan.asset.id)
            .map_err(exec_err)?;
        if !same_profile(&current, &plan.asset) {
            let output = CommitAssetUpdateOutput {
                asset_id: plan.asset.id,
                committed: false,
                asset: None,
                changes: plan.changes,
                history_replaced: None,
                history_error: None,
                recalculation: "none",
                warnings: plan.warnings,
                errors: vec![
                    "The asset changed while it was being checked; nothing was saved. Run \
                     prepare_asset_update again."
                        .to_string(),
                ],
            };
            return Ok(AgentToolResult {
                content: serde_json::to_value(output)?,
            });
        }
        let updated = env
            .asset_service()
            .update_asset_profile(&plan.asset.id, plan.profile)
            .await
            .map_err(exec_err)?;
        let (history_replaced, history_error) = if plan.replace_history {
            let (mut replaced, mut errors) =
                replace_provider_history(env.clone(), vec![updated.id.clone()]).await?;
            (replaced.pop(), errors.pop())
        } else {
            (None, None)
        };
        let output = CommitAssetUpdateOutput {
            asset_id: updated.id.clone(),
            committed: true,
            asset: Some(asset_detail(&updated)),
            changes: plan.changes,
            history_replaced,
            history_error,
            recalculation: "queued",
            warnings: plan.warnings,
            errors: Vec::new(),
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}
