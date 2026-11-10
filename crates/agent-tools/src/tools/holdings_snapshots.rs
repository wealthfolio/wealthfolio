//! Holdings snapshot tools (MCP-only).
//!
//! A HOLDINGS-mode account's holdings come from dated snapshots: the
//! positions and cash on each date. `get_holdings_snapshots` lists an
//! account's snapshot dates or reads one date. `prepare_holdings_snapshot`
//! checks a snapshot against the stored ones without writing, and
//! `commit_holdings_snapshot` checks it again and saves it through the same
//! core function as the app's holdings form. A snapshot replaces whatever is
//! stored for its date. Cash left out is carried forward from the snapshot it
//! replaces or the latest earlier one, never zeroed.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wealthfolio_core::accounts::{Account, TrackingMode};
use wealthfolio_core::assets::{
    Asset, AssetMetadata, AssetResolutionInput, InstrumentType, QuoteMode,
};
use wealthfolio_core::portfolio::snapshot::{
    validate_holdings_import_snapshot, AccountStateSnapshot, HoldingsImportPositionValidationInput,
    HoldingsImportSnapshotValidationInput, ManualHoldingEntry, ManualHoldingInput,
    ManualHoldingsEntry, ManualSnapshotService, SnapshotServiceTrait,
};
use wealthfolio_core::quotes::constants::DATA_SOURCE_MANUAL;
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Max positions per snapshot, so one call cannot force unbounded writes.
const MAX_POSITIONS: usize = 200;
/// Max snapshot dates listed per call.
const MAX_DATES: usize = 400;

fn failed(error: impl std::fmt::Display) -> AgentToolError {
    AgentToolError::ExecutionFailed(error.to_string())
}

fn snapshot_service(
    env: &dyn AgentEnvironment,
) -> Result<Arc<dyn SnapshotServiceTrait>, AgentToolError> {
    env.snapshot_service()
        .ok_or_else(|| failed("Holdings snapshots are not available in this environment"))
}

fn parse_date(date: &str) -> Result<NaiveDate, AgentToolError> {
    NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").map_err(|_| {
        AgentToolError::InvalidInput(format!("date '{date}' isn't valid; use YYYY-MM-DD"))
    })
}

fn user_timezone(env: &dyn AgentEnvironment) -> Result<String, AgentToolError> {
    Ok(env
        .settings_service()
        .get_settings()
        .map_err(failed)?
        .timezone)
}

fn asset_symbol(asset: &Asset) -> Option<String> {
    asset
        .display_code
        .clone()
        .or_else(|| asset.instrument_symbol.clone())
}

/// One stored position, as the tools show it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPositionDto {
    pub asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub quantity: String,
    pub average_cost: String,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashBalanceDto {
    pub currency: String,
    pub amount: String,
}

fn cash_dtos(cash: &HashMap<String, Decimal>) -> Vec<CashBalanceDto> {
    let mut cash: Vec<_> = cash
        .iter()
        .map(|(currency, amount)| CashBalanceDto {
            currency: currency.clone(),
            amount: amount.normalize().to_string(),
        })
        .collect();
    cash.sort_by(|a, b| a.currency.cmp(&b.currency));
    cash
}

async fn position_dtos(
    env: &dyn AgentEnvironment,
    snapshot: &AccountStateSnapshot,
) -> Result<Vec<SnapshotPositionDto>, AgentToolError> {
    let ids: Vec<String> = snapshot.positions.keys().cloned().collect();
    let assets: HashMap<String, Asset> = env
        .asset_service()
        .get_assets_by_asset_ids(&ids)
        .await
        .map_err(failed)?
        .into_iter()
        .map(|asset| (asset.id.clone(), asset))
        .collect();
    let mut positions: Vec<_> = snapshot
        .positions
        .values()
        .map(|position| {
            let asset = assets.get(&position.asset_id);
            SnapshotPositionDto {
                asset_id: position.asset_id.clone(),
                symbol: asset.and_then(asset_symbol),
                exchange_mic: asset.and_then(|asset| asset.instrument_exchange_mic.clone()),
                name: asset.and_then(|asset| asset.name.clone()),
                quantity: position.quantity.normalize().to_string(),
                average_cost: position.average_cost.normalize().to_string(),
                currency: position.currency.clone(),
            }
        })
        .collect();
    positions.sort_by(|a, b| a.symbol.cmp(&b.symbol).then(a.asset_id.cmp(&b.asset_id)));
    Ok(positions)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotAccountDto {
    pub id: String,
    pub name: String,
    pub currency: String,
    pub tracking_mode: TrackingMode,
    pub connected: bool,
}

impl From<&Account> for SnapshotAccountDto {
    fn from(account: &Account) -> Self {
        Self {
            id: account.id.clone(),
            name: account.name.clone(),
            currency: account.currency.clone(),
            tracking_mode: account.tracking_mode,
            connected: account.provider_account_id.is_some(),
        }
    }
}

fn get_account(env: &dyn AgentEnvironment, account_id: &str) -> Result<Account, AgentToolError> {
    env.account_service()
        .get_account(account_id.trim())
        .map_err(|_| {
            AgentToolError::InvalidInput(format!(
                "No account with id {account_id}; get_accounts lists the accounts and their ids"
            ))
        })
}

// ── get_holdings_snapshots ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetHoldingsSnapshotsArgs {
    pub account_id: String,
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDateDto {
    pub date: String,
    /// MANUAL_ENTRY, CSV_IMPORT, BROKER_IMPORTED, SYNTHETIC or CALCULATED.
    pub source: String,
    pub position_count: usize,
    pub cash_currency_count: usize,
}

/// List an account's snapshot dates, or read one date's positions and cash.
pub struct GetHoldingsSnapshots;

#[async_trait::async_trait]
impl AgentTool for GetHoldingsSnapshots {
    fn name(&self) -> &'static str {
        "get_holdings_snapshots"
    }

    fn description(&self) -> &'static str {
        "Read an account's holdings snapshots. Without date: the snapshot dates, newest first, with source and counts. With date (YYYY-MM-DD): that date's positions (assetId, symbol, quantity, average cost, currency) and cash balances. For HOLDINGS-mode accounts these snapshots are the holdings; for TRANSACTIONS-mode accounts they are calculated from activities. Use the assetIds from here in prepare_holdings_snapshot."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "accountId": { "type": "string", "description": "Account id from get_accounts." },
                "date": { "type": "string", "description": "YYYY-MM-DD. Omit to list the dates." }
            },
            "required": ["accountId"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetHoldingsSnapshotsArgs = serde_json::from_value(args)?;
        let account = get_account(env.as_ref(), &args.account_id)?;
        let snapshots = snapshot_service(env.as_ref())?;

        let Some(date) = args.date.as_deref() else {
            let mut dates: Vec<SnapshotDateDto> = snapshots
                .get_snapshot_metadata(&account.id, None, None)
                .map_err(failed)?
                .into_iter()
                .map(|snapshot| SnapshotDateDto {
                    date: snapshot.snapshot_date,
                    source: snapshot.source,
                    position_count: snapshot.position_count,
                    cash_currency_count: snapshot.cash_currency_count,
                })
                .collect();
            dates.sort_by(|a, b| b.date.cmp(&a.date));
            let total = dates.len();
            dates.truncate(MAX_DATES);
            let mut content = json!({
                "account": SnapshotAccountDto::from(&account),
                "snapshots": dates,
                "count": dates.len(),
            });
            if total > MAX_DATES {
                content["truncated"] = json!(true);
                content["originalCount"] = json!(total);
            }
            return Ok(AgentToolResult { content });
        };

        let date = parse_date(date)?;
        let snapshot = snapshots
            .get_holdings_keyframes(&account.id, Some(date), Some(date))
            .map_err(failed)?
            .into_iter()
            .find(|snapshot| snapshot.snapshot_date == date)
            .ok_or_else(|| {
                AgentToolError::InvalidInput(format!(
                    "No snapshot on {date} for this account; call without date to list its snapshot dates"
                ))
            })?;
        Ok(AgentToolResult {
            content: json!({
                "account": SnapshotAccountDto::from(&account),
                "date": date.to_string(),
                "source": snapshot.source.as_str(),
                "positions": position_dtos(env.as_ref(), &snapshot).await?,
                "cash": cash_dtos(&snapshot.cash_balances),
            }),
        })
    }
}

// ── prepare / commit ────────────────────────────────────────────────────────

/// One position of a reviewed snapshot: an existing asset by `assetId`, or a
/// reviewed listing (symbol, quote currency, instrument type and, for
/// equities, exchange).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotPositionInput {
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub exchange_mic: Option<String>,
    #[serde(default)]
    pub quote_ccy: Option<String>,
    #[serde(default)]
    pub instrument_type: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// MANUAL for an asset priced by hand (quotes through commit_quote_import).
    #[serde(default)]
    pub quote_mode: Option<String>,
    /// A JSON number or a decimal string.
    pub quantity: Decimal,
    #[serde(default)]
    pub average_cost: Option<Decimal>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CashInput {
    pub currency: String,
    pub amount: Decimal,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HoldingsSnapshotArgs {
    pub account_id: String,
    pub date: String,
    pub positions: Vec<SnapshotPositionInput>,
    /// Left out or null: carry the cash forward. An empty list: no cash.
    #[serde(default)]
    pub cash: Option<Vec<CashInput>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionOutcome {
    Added,
    Changed,
    Unchanged,
    Removed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionChangeDto {
    pub outcome: PositionOutcome,
    /// Absent for a listing no asset matches yet; saving creates the asset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    pub currency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_cost_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_cost: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CashSource {
    /// The request lists the cash.
    Entered,
    /// The request leaves cash out: the compared snapshot's cash is kept.
    CarriedForward,
}

/// What the new snapshot is compared with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparedSnapshotDto {
    pub date: String,
    /// True when it is the snapshot of the same date, which this one replaces.
    pub replaced: bool,
}

/// The checked snapshot: what the preview shows, and the entry the commit
/// saves when it is valid.
#[derive(Debug)]
struct SnapshotPlan {
    account: SnapshotAccountDto,
    date: String,
    compared: Option<ComparedSnapshotDto>,
    positions: Vec<PositionChangeDto>,
    cash_source: CashSource,
    cash_before: Vec<CashBalanceDto>,
    cash: Vec<CashBalanceDto>,
    first_prices: Vec<FirstPriceDto>,
    warnings: Vec<String>,
    errors: Vec<String>,
    entry: Option<ManualHoldingsEntry>,
}

/// A price the save writes: a hand-priced asset's first, from its average
/// cost.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstPriceDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    pub symbol: String,
    pub price: String,
    pub currency: String,
    pub date: String,
}

/// A position resolved for saving.
struct PlannedPosition {
    asset_id: Option<String>,
    symbol: String,
    exchange_mic: Option<String>,
    quote_ccy: Option<String>,
    instrument_type: Option<String>,
    name: Option<String>,
    quote_mode: Option<String>,
    currency: String,
    quantity: Decimal,
    average_cost: Decimal,
    /// The asset is priced by hand (MANUAL quote mode), now or once created.
    priced_by_hand: bool,
}

fn account_errors(account: &Account) -> Vec<String> {
    let mut errors = Vec::new();
    if account.tracking_mode != TrackingMode::Holdings {
        errors.push(format!(
            "Holdings snapshots can be saved only for HOLDINGS-mode accounts; this account tracks {}. Its holdings come from activities.",
            serde_json::to_value(account.tracking_mode)
                .ok()
                .and_then(|mode| mode.as_str().map(str::to_string))
                .unwrap_or_default()
        ));
    }
    if account.provider_account_id.is_some() {
        errors.push(
            "This account is connected to a broker, whose sync writes its snapshots".to_string(),
        );
    }
    errors
}

fn trimmed(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn listing_label(position: &SnapshotPositionInput, index: usize) -> String {
    trimmed(&position.symbol)
        .or_else(|| trimmed(&position.asset_id))
        .unwrap_or_else(|| format!("position {}", index + 1))
}

/// The position an existing asset saves: its own listing and currency. A
/// quote mode is set only on a new asset; changing an existing one here
/// would reprice it everywhere it is held.
fn existing_position(
    asset: &Asset,
    label: &str,
    quote_mode: Option<String>,
    position: &SnapshotPositionInput,
    errors: &mut Vec<String>,
) -> Option<PlannedPosition> {
    if quote_mode
        .as_deref()
        .is_some_and(|mode| mode != asset.quote_mode.as_db_str())
    {
        errors.push(format!(
            "{label}: quoteMode applies only to new assets; this asset is priced {} (change that in the app)",
            asset.quote_mode.as_db_str()
        ));
        return None;
    }
    Some(PlannedPosition {
        asset_id: Some(asset.id.clone()),
        symbol: asset_symbol(asset).unwrap_or_else(|| asset.id.clone()),
        exchange_mic: asset.instrument_exchange_mic.clone(),
        quote_ccy: None,
        instrument_type: None,
        name: None,
        quote_mode: None,
        currency: asset.quote_ccy.clone(),
        quantity: position.quantity,
        average_cost: position.average_cost.unwrap_or(Decimal::ZERO),
        priced_by_hand: asset.quote_mode == QuoteMode::Manual,
    })
}

/// Check one position and resolve what it saves. A listing that names a
/// stored asset, as saving would match it, becomes that asset.
fn plan_position(
    position: &SnapshotPositionInput,
    index: usize,
    assets: &HashMap<String, Asset>,
    find_listing: &dyn Fn(&AssetMetadata, &str) -> Option<Asset>,
    account_currency: &str,
    errors: &mut Vec<String>,
) -> Option<PlannedPosition> {
    let label = listing_label(position, index);
    let mut ok = true;
    if position.quantity <= Decimal::ZERO {
        errors.push(format!(
            "{label}: quantity must be above zero; leave a position out to remove it"
        ));
        ok = false;
    }
    if position
        .average_cost
        .is_some_and(|cost| cost < Decimal::ZERO)
    {
        errors.push(format!("{label}: averageCost cannot be negative"));
        ok = false;
    }
    let quote_mode = match trimmed(&position.quote_mode).map(|mode| mode.to_uppercase()) {
        None => None,
        Some(mode) if mode == "MANUAL" || mode == "MARKET" => Some(mode),
        Some(_) => {
            errors.push(format!("{label}: quoteMode must be MARKET or MANUAL"));
            ok = false;
            None
        }
    };

    if let Some(asset_id) = trimmed(&position.asset_id) {
        let Some(asset) = assets.get(&asset_id) else {
            errors.push(format!(
                "{label}: no asset with id {asset_id}; use get_holdings_snapshots or get_holdings for ids, or give a reviewed symbol instead"
            ));
            return None;
        };
        let planned = existing_position(asset, &label, quote_mode, position, errors);
        return planned.filter(|_| ok);
    }

    let Some(symbol) = trimmed(&position.symbol).map(|symbol| symbol.to_uppercase()) else {
        errors.push(format!(
            "{label}: give an assetId, or a symbol with quoteCcy and instrumentType"
        ));
        return None;
    };
    // The listing must be reviewed, so saving never looks the symbol up with
    // a market data provider.
    let reviewed = AssetResolutionInput {
        key: symbol.clone(),
        source_symbol: symbol.clone(),
        account_currency: account_currency.to_string(),
        activity_currency: None,
        exchange_mic: trimmed(&position.exchange_mic),
        // Left as entered when it is not letters, so the review check below
        // refuses it.
        quote_ccy: trimmed(&position.quote_ccy)
            .map(|code| super::currency_code(&code).unwrap_or(code)),
        instrument_type: trimmed(&position.instrument_type)
            .as_deref()
            .and_then(InstrumentType::from_external_str),
        quote_mode: match quote_mode.as_deref() {
            Some("MANUAL") => Some(QuoteMode::Manual),
            Some(_) => Some(QuoteMode::Market),
            None => None,
        },
        isin: None,
        asset_id: None,
        provider_id: None,
        provider_symbol: None,
    };
    if !reviewed.reviewed_metadata_is_sufficient() {
        errors.push(format!(
            "{symbol}: a new listing needs quoteCcy (such as USD or GBp) and instrumentType (such as EQUITY, ETF, CRYPTO, BOND), and an exchangeMic for an equity unless quoteMode is MANUAL"
        ));
        return None;
    }
    let quote_ccy = reviewed.quote_ccy.clone().unwrap_or_default();
    let planned = PlannedPosition {
        asset_id: None,
        symbol,
        exchange_mic: reviewed.exchange_mic.clone(),
        quote_ccy: Some(quote_ccy.clone()),
        instrument_type: trimmed(&position.instrument_type),
        name: trimmed(&position.name),
        priced_by_hand: quote_mode.as_deref() == Some("MANUAL"),
        quote_mode,
        currency: quote_ccy,
        quantity: position.quantity,
        average_cost: position.average_cost.unwrap_or(Decimal::ZERO),
    };

    // Saving matches a listing to a stored asset by its instrument key; ask
    // core the same question, so the preview and the save agree.
    if let Some(asset) = find_listing(&planned.holding_input().asset_metadata(), &planned.currency)
    {
        if asset.quote_ccy != planned.currency {
            errors.push(format!(
                "{}: matches the stored asset {}, quoted in {}, not {}; use its assetId",
                planned.symbol, asset.id, asset.quote_ccy, planned.currency
            ));
            return None;
        }
        let planned = existing_position(&asset, &label, planned.quote_mode, position, errors);
        return planned.filter(|_| ok);
    }
    ok.then_some(planned)
}

impl PlannedPosition {
    /// The holding as the save receives it.
    fn holding_input(&self) -> ManualHoldingInput {
        ManualHoldingInput {
            asset_id: self.asset_id.clone(),
            symbol: self.symbol.clone(),
            exchange_mic: self.exchange_mic.clone(),
            quantity: self.quantity,
            currency: self.currency.clone(),
            average_cost: self.average_cost,
            name: self.name.clone(),
            data_source: (self.quote_mode.as_deref() == Some("MANUAL"))
                .then(|| DATA_SOURCE_MANUAL.to_string()),
            asset_kind: None,
            quote_ccy: self.quote_ccy.clone(),
            instrument_type: self.instrument_type.clone(),
            provider_id: None,
            provider_symbol: None,
        }
    }
}

/// Entered cash by currency, its codes as core reads them, so `usd` and `USD`
/// are one balance (listed twice) and never an unknown currency.
fn entered_cash(entered: &[CashInput], errors: &mut Vec<String>) -> HashMap<String, Decimal> {
    let mut cash = HashMap::new();
    for balance in entered {
        let Some(currency) = super::currency_code(&balance.currency) else {
            errors.push(format!(
                "Cash currency '{}' must be a currency code of letters, such as EUR",
                balance.currency.trim()
            ));
            continue;
        };
        if cash.insert(currency.clone(), balance.amount).is_some() {
            errors.push(format!("Cash in {currency} is listed twice"));
        }
    }
    cash
}

async fn plan_snapshot(
    env: &dyn AgentEnvironment,
    args: &HoldingsSnapshotArgs,
) -> Result<SnapshotPlan, AgentToolError> {
    if args.positions.len() > MAX_POSITIONS {
        return Err(AgentToolError::InvalidInput(format!(
            "A snapshot is limited to {MAX_POSITIONS} positions, got {}",
            args.positions.len()
        )));
    }
    let account = get_account(env, &args.account_id)?;
    let snapshots = snapshot_service(env)?;
    let mut errors = account_errors(&account);
    let mut warnings = Vec::new();

    // The date rules of the holdings CSV import: a real day, not in the
    // future, not before the earliest supported date.
    let today = user_today(parse_user_timezone_or_default(&user_timezone(env)?));
    let validation = HoldingsImportSnapshotValidationInput {
        date: args.date.trim().to_string(),
        positions: Vec::<HoldingsImportPositionValidationInput>::new(),
        cash_balances: Vec::new(),
    };
    let date = match validate_holdings_import_snapshot(&account.id, today, &validation) {
        Ok(date) => Some(date),
        Err(date_errors) => {
            errors.extend(date_errors);
            None
        }
    };

    // The snapshot this one replaces, or else the latest earlier one: one
    // stored snapshot, read as it was saved.
    let base = match date {
        Some(date) => snapshots
            .get_latest_holdings_keyframe(&account.id, date)
            .map_err(failed)?,
        None => None,
    };
    let base_positions: BTreeMap<String, (SnapshotPositionDto, Decimal, Decimal)> = match &base {
        Some(snapshot) => position_dtos(env, snapshot)
            .await?
            .into_iter()
            .map(|dto| {
                let stored = &snapshot.positions[&dto.asset_id];
                (
                    dto.asset_id.clone(),
                    (dto, stored.quantity, stored.average_cost),
                )
            })
            .collect(),
        None => BTreeMap::new(),
    };

    let asset_ids: Vec<String> = args
        .positions
        .iter()
        .filter_map(|position| trimmed(&position.asset_id))
        .collect();
    let assets: HashMap<String, Asset> = if asset_ids.is_empty() {
        HashMap::new()
    } else {
        env.asset_service()
            .get_assets_by_asset_ids(&asset_ids)
            .await
            .map_err(failed)?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect()
    };

    let asset_service = env.asset_service();
    let find_listing = |metadata: &AssetMetadata, currency: &str| {
        asset_service.find_asset_by_listing(metadata, Some(currency))
    };
    let mut planned = Vec::new();
    for (index, position) in args.positions.iter().enumerate() {
        if let Some(position) = plan_position(
            position,
            index,
            &assets,
            &find_listing,
            &account.currency,
            &mut errors,
        ) {
            planned.push(position);
        }
    }
    // A stored position keeps its own currency: its cost may be in another
    // unit than the asset's quote (GBP cost for a GBp quote).
    for position in &mut planned {
        if let Some((stored, _, _)) = position
            .asset_id
            .as_deref()
            .and_then(|id| base_positions.get(id))
        {
            position.currency = stored.currency.clone();
        }
    }

    // One row per asset, as the snapshot keeps one position per asset. New
    // listings with one instrument key (BTC and BTC-USD) save as one asset.
    let mut seen = HashMap::new();
    let mut changes = Vec::new();
    let mut kept = Vec::new();
    for position in &planned {
        let stored_id = position.asset_id.as_deref();
        let key = stored_id
            .map(str::to_string)
            .or_else(|| {
                asset_service.listing_instrument_key(
                    &position.holding_input().asset_metadata(),
                    Some(&position.currency),
                )
            })
            .unwrap_or_else(|| {
                format!(
                    "{}@{}",
                    position.symbol,
                    position.exchange_mic.clone().unwrap_or_default()
                )
            });
        if seen.insert(key, ()).is_some() {
            errors.push(format!(
                "{} is listed twice; give one row per asset",
                position.symbol
            ));
            continue;
        }
        let stored = stored_id.and_then(|id| base_positions.get(id));
        if let Some(id) = stored_id {
            kept.push(id.to_string());
        }
        let outcome = match stored {
            None => PositionOutcome::Added,
            Some((_, quantity, cost))
                if *quantity == position.quantity && *cost == position.average_cost =>
            {
                PositionOutcome::Unchanged
            }
            Some(_) => PositionOutcome::Changed,
        };
        changes.push(PositionChangeDto {
            outcome,
            asset_id: stored_id.map(str::to_string),
            symbol: Some(position.symbol.clone()),
            exchange_mic: position.exchange_mic.clone(),
            currency: position.currency.clone(),
            quantity_before: stored.map(|(dto, _, _)| dto.quantity.clone()),
            quantity: Some(position.quantity.normalize().to_string()),
            average_cost_before: stored.map(|(dto, _, _)| dto.average_cost.clone()),
            average_cost: Some(position.average_cost.normalize().to_string()),
        });
    }
    for (id, (stored, _, _)) in &base_positions {
        if !kept.contains(id) {
            changes.push(PositionChangeDto {
                outcome: PositionOutcome::Removed,
                asset_id: Some(id.clone()),
                symbol: stored.symbol.clone(),
                exchange_mic: stored.exchange_mic.clone(),
                currency: stored.currency.clone(),
                quantity_before: Some(stored.quantity.clone()),
                quantity: None,
                average_cost_before: Some(stored.average_cost.clone()),
                average_cost: None,
            });
        }
    }

    let cash_before = base
        .as_ref()
        .map(|snapshot| snapshot.cash_balances.clone())
        .unwrap_or_default();
    let (cash_source, cash) = match &args.cash {
        None => (CashSource::CarriedForward, cash_before.clone()),
        Some(entered) => (CashSource::Entered, entered_cash(entered, &mut errors)),
    };
    if cash_source == CashSource::CarriedForward && cash_before.is_empty() {
        warnings.push(
            "No cash is stored before this date and the request lists none: the snapshot has no cash.".to_string(),
        );
    }

    let compared = base.as_ref().map(|snapshot| ComparedSnapshotDto {
        date: snapshot.snapshot_date.to_string(),
        replaced: Some(snapshot.snapshot_date) == date,
    });
    match &compared {
        Some(compared) if compared.replaced => warnings.push(format!(
            "This replaces the snapshot of {}: positions not listed are removed from that date.",
            compared.date
        )),
        Some(compared) => warnings.push(format!(
            "This adds a snapshot; positions are compared with the latest earlier one, of {}.",
            compared.date
        )),
        None => {}
    }
    if planned.iter().any(|position| position.asset_id.is_none()) {
        warnings.push(
            "A listing that no stored asset matches creates a new asset when saved.".to_string(),
        );
    }

    // Saving gives a hand-priced asset with no price on or before the date
    // its average cost as its first price, as the holdings form does.
    let mut first_prices = Vec::new();
    if let Some(date) = date {
        for position in &planned {
            if !position.priced_by_hand || position.average_cost.is_zero() {
                continue;
            }
            let priced = match position.asset_id.as_deref() {
                // A failed lookup counts as priced, as the save counts it.
                Some(id) => env
                    .quote_service()
                    .get_latest_quotes_as_of(&[id.to_string()], date)
                    .map_or(true, |quotes| quotes.contains_key(id)),
                None => false,
            };
            if !priced {
                first_prices.push(FirstPriceDto {
                    asset_id: position.asset_id.clone(),
                    symbol: position.symbol.clone(),
                    price: position.average_cost.normalize().to_string(),
                    currency: position.currency.clone(),
                    date: date.to_string(),
                });
            }
        }
    }
    if !first_prices.is_empty() {
        warnings.push(
            "Hand-priced assets with no price on or before this date get their average cost as their first price (see firstPrices), as in the app. Save other prices with commit_quote_import.".to_string(),
        );
    }

    let entry = errors.is_empty().then(|| ManualHoldingsEntry {
        holdings: planned
            .iter()
            .map(|position| {
                let holding = position.holding_input();
                ManualHoldingEntry {
                    asset_id: holding.asset_id,
                    symbol: holding.symbol,
                    quantity: holding.quantity.to_string(),
                    currency: holding.currency,
                    average_cost: Some(holding.average_cost.to_string()),
                    exchange_mic: holding.exchange_mic,
                    quote_ccy: holding.quote_ccy,
                    instrument_type: holding.instrument_type,
                    provider_id: holding.provider_id,
                    provider_symbol: holding.provider_symbol,
                    name: holding.name,
                    data_source: holding.data_source,
                    asset_kind: holding.asset_kind,
                }
            })
            .collect(),
        cash_balances: cash
            .iter()
            .map(|(currency, amount)| (currency.clone(), amount.to_string()))
            .collect(),
        snapshot_date: date.map(|date| date.to_string()),
    });

    Ok(SnapshotPlan {
        account: SnapshotAccountDto::from(&account),
        date: date
            .map(|date| date.to_string())
            .unwrap_or_else(|| args.date.clone()),
        compared,
        positions: changes,
        cash_source,
        cash_before: cash_dtos(&cash_before),
        cash: cash_dtos(&cash),
        first_prices,
        warnings,
        errors,
        entry,
    })
}

fn snapshot_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "accountId": { "type": "string", "description": "A HOLDINGS-mode account that is not connected to a broker." },
            "date": { "type": "string", "description": "Snapshot date, YYYY-MM-DD, today or earlier. A snapshot already stored on this date is replaced." },
            "positions": {
                "type": "array",
                "maxItems": MAX_POSITIONS,
                "description": "Every position held on the date. Positions left out are not held on that date.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "assetId": { "type": "string", "description": "An existing asset, from get_holdings_snapshots or get_holdings. Preferred." },
                        "symbol": { "type": "string", "description": "Without assetId: the reviewed ticker." },
                        "exchangeMic": { "type": "string", "description": "Without assetId: the exchange MIC, such as XNAS; needed for equities unless quoteMode is MANUAL." },
                        "quoteCcy": { "type": "string", "description": "Without assetId: the currency the listing is quoted in (minor units such as GBp are case-sensitive)." },
                        "instrumentType": { "type": "string", "description": "Without assetId: EQUITY, ETF, MUTUAL_FUND, CRYPTO, BOND, OPTION, METAL, ..." },
                        "name": { "type": "string" },
                        "quoteMode": { "type": "string", "enum": ["MARKET", "MANUAL"], "description": "For a new asset only: MANUAL for an asset priced by hand. A stored asset keeps its own mode." },
                        "quantity": { "type": "number", "exclusiveMinimum": 0 },
                        "averageCost": { "type": "number", "minimum": 0, "description": "Average cost per unit in the position's currency; 0 when left out." }
                    },
                    "required": ["quantity"]
                }
            },
            "cash": {
                "type": ["array", "null"],
                "description": "Cash balances on the date. Leave out to carry the cash forward from the snapshot this replaces or the latest earlier one; an empty list means no cash.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "currency": { "type": "string" },
                        "amount": { "type": "number" }
                    },
                    "required": ["currency", "amount"]
                }
            }
        },
        "required": ["accountId", "date", "positions"]
    })
}

/// Keep the account, date, asset ids, symbols and counts; never quantities,
/// costs or cash amounts.
fn snapshot_for_audit(args: &serde_json::Value) -> serde_json::Value {
    let positions = args
        .get("positions")
        .and_then(|positions| positions.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    json!({
        "accountId": args.get("accountId").and_then(|value| value.as_str()),
        "date": args.get("date").and_then(|value| value.as_str()),
        "positions": positions
            .iter()
            .take(MAX_POSITIONS)
            .map(|position| json!({
                "assetId": position.get("assetId").and_then(|value| value.as_str()),
                "symbol": position.get("symbol").and_then(|value| value.as_str()),
            }))
            .collect::<Vec<_>>(),
        "positionCount": positions.len(),
        "cashCount": args.get("cash").and_then(|cash| cash.as_array()).map(Vec::len),
    })
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotChangeSummary {
    pub added: usize,
    pub changed: usize,
    pub unchanged: usize,
    pub removed: usize,
}

fn summarize(positions: &[PositionChangeDto]) -> SnapshotChangeSummary {
    let mut summary = SnapshotChangeSummary::default();
    for position in positions {
        match position.outcome {
            PositionOutcome::Added => summary.added += 1,
            PositionOutcome::Changed => summary.changed += 1,
            PositionOutcome::Unchanged => summary.unchanged += 1,
            PositionOutcome::Removed => summary.removed += 1,
        }
    }
    summary
}

fn plan_content(plan: &SnapshotPlan) -> serde_json::Value {
    json!({
        "account": plan.account,
        "date": plan.date,
        "comparedWith": plan.compared,
        "summary": summarize(&plan.positions),
        "positions": plan.positions,
        "cash": {
            "source": plan.cash_source,
            "before": plan.cash_before,
            "after": plan.cash,
        },
        "firstPrices": plan.first_prices,
        "warnings": plan.warnings,
        "errors": plan.errors,
    })
}

/// Preview a holdings snapshot without saving it.
pub struct PrepareHoldingsSnapshot;

#[async_trait::async_trait]
impl AgentTool for PrepareHoldingsSnapshot {
    fn name(&self) -> &'static str {
        "prepare_holdings_snapshot"
    }

    fn description(&self) -> &'static str {
        "Preview saving a holdings snapshot (every position held on one date, and cash) for a HOLDINGS-mode account that is not connected to a broker, WITHOUT saving. A snapshot replaces whatever is stored on its date: positions left out are not held on that date. Each position names an existing asset by assetId (from get_holdings_snapshots or get_holdings), or a reviewed listing: symbol, quoteCcy, instrumentType and, for an equity, exchangeMic; listings are never looked up with a market data provider. Cash left out is carried forward from the snapshot this replaces or the latest earlier one, never zeroed; an empty cash list means no cash. Returns, against that compared snapshot, each position as added, changed, unchanged or removed, cash before and after, warnings and errors. Prices are not part of a snapshot, with one exception the preview lists in firstPrices: as in the app, a hand-priced (MANUAL) asset with no price on or before the date gets its average cost as its first price. Save other prices with commit_quote_import. Show the preview to the user, then pass the same arguments to commit_holdings_snapshot. Up to 200 positions."
    }

    fn input_schema(&self) -> serde_json::Value {
        snapshot_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead, AgentScope::HoldingsWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        snapshot_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: HoldingsSnapshotArgs = serde_json::from_value(args)?;
        let plan = plan_snapshot(env.as_ref(), &args).await?;
        let mut content = plan_content(&plan);
        content["ready"] = json!(plan.entry.is_some());
        Ok(AgentToolResult { content })
    }
}

/// Save a reviewed holdings snapshot.
pub struct CommitHoldingsSnapshot;

#[async_trait::async_trait]
impl AgentTool for CommitHoldingsSnapshot {
    fn name(&self) -> &'static str {
        "commit_holdings_snapshot"
    }

    fn description(&self) -> &'static str {
        "Save a holdings snapshot. This MUTATES data: only call it after prepare_holdings_snapshot and the user's confirmation, with the same arguments. The snapshot is checked again; if it has errors, nothing is saved and committed is false. It replaces whatever is stored on its date, and cash left out is carried forward, as the preview showed. Saving can create assets for new listings, register the currency pairs they need, and write the first prices the preview listed in firstPrices. Holdings and valuations recalculate in the background; check them with get_holdings or get_valuation_history in a few seconds."
    }

    fn input_schema(&self) -> serde_json::Value {
        snapshot_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead, AgentScope::HoldingsWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        snapshot_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: HoldingsSnapshotArgs = serde_json::from_value(args)?;
        let plan = plan_snapshot(env.as_ref(), &args).await?;
        let mut content = plan_content(&plan);
        let Some(entry) = plan.entry else {
            content["committed"] = json!(false);
            content["message"] = json!("Nothing was saved; see errors.");
            return Ok(AgentToolResult { content });
        };
        let account = get_account(env.as_ref(), &args.account_id)?;
        let fx = env
            .fx_service()
            .ok_or_else(|| failed("Holdings snapshots are not available in this environment"))?;
        let saved = ManualSnapshotService::new(
            env.asset_service(),
            fx,
            snapshot_service(env.as_ref())?,
            env.quote_service(),
        )
        .with_timezone(user_timezone(env.as_ref())?)
        .save_manual_holdings(&account, &env.base_currency(), entry)
        .await
        .map_err(failed)?;
        content["committed"] = json!(true);
        content["assetIds"] = json!(saved.asset_ids);
        content["message"] = json!(
            "Snapshot saved. Holdings and valuations recalculate in the background: check them with get_holdings or get_valuation_history in a few seconds."
        );
        Ok(AgentToolResult { content })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(id: &str, symbol: &str, ccy: &str) -> Asset {
        Asset {
            id: id.to_string(),
            display_code: Some(symbol.to_string()),
            instrument_symbol: Some(symbol.to_string()),
            instrument_exchange_mic: Some("XNAS".to_string()),
            quote_ccy: ccy.to_string(),
            ..Asset::default()
        }
    }

    fn position(value: serde_json::Value) -> SnapshotPositionInput {
        serde_json::from_value(value).unwrap()
    }

    fn no_listing(_: &AssetMetadata, _: &str) -> Option<Asset> {
        None
    }

    #[test]
    fn a_listing_of_a_stored_asset_becomes_that_asset() {
        let stored = asset("a", "AAPL", "USD");
        let find = |metadata: &AssetMetadata, currency: &str| {
            (metadata.instrument_symbol.as_deref() == Some("AAPL") && currency == "USD")
                .then(|| stored.clone())
        };
        let listing = json!({
            "symbol": "aapl", "exchangeMic": "XNAS", "quoteCcy": "USD",
            "instrumentType": "EQUITY", "quantity": 2
        });
        let mut errors = Vec::new();
        let planned = plan_position(
            &position(listing),
            0,
            &HashMap::new(),
            &find,
            "USD",
            &mut errors,
        )
        .unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        // The same id as an assetId row, so a second row for it is a duplicate.
        assert_eq!(planned.asset_id.as_deref(), Some("a"));
        assert!(planned.holding_input().data_source.is_none());

        let other_currency = |_: &AssetMetadata, _: &str| Some(asset("a", "AAPL", "EUR"));
        let mut errors = Vec::new();
        assert!(plan_position(
            &position(json!({
                "symbol": "AAPL", "exchangeMic": "XNAS", "quoteCcy": "USD",
                "instrumentType": "EQUITY", "quantity": 2
            })),
            0,
            &HashMap::new(),
            &other_currency,
            "USD",
            &mut errors,
        )
        .is_none());
        assert!(errors[0].contains("use its assetId"), "{errors:?}");
    }

    #[test]
    fn a_snapshot_never_changes_a_stored_assets_quote_mode() {
        let stored = asset("a", "AAPL", "USD");
        let assets = HashMap::from([("a".to_string(), stored.clone())]);
        let mut errors = Vec::new();
        assert!(plan_position(
            &position(json!({ "assetId": "a", "quoteMode": "MANUAL", "quantity": 1 })),
            0,
            &assets,
            &no_listing,
            "USD",
            &mut errors,
        )
        .is_none());
        assert!(errors[0].contains("quoteMode"), "{errors:?}");

        let find = |_: &AssetMetadata, _: &str| Some(stored.clone());
        let mut errors = Vec::new();
        assert!(plan_position(
            &position(json!({
                "symbol": "AAPL", "quoteCcy": "USD", "instrumentType": "EQUITY",
                "quoteMode": "MANUAL", "quantity": 1
            })),
            0,
            &HashMap::new(),
            &find,
            "USD",
            &mut errors,
        )
        .is_none());
        assert!(errors[0].contains("quoteMode"), "{errors:?}");

        // Its own mode, or none, is fine, and saving sends no mode.
        let mut errors = Vec::new();
        let planned = plan_position(
            &position(json!({ "assetId": "a", "quoteMode": "MARKET", "quantity": 1 })),
            0,
            &assets,
            &no_listing,
            "USD",
            &mut errors,
        )
        .unwrap();
        assert!(planned.holding_input().data_source.is_none());
    }

    #[test]
    fn existing_assets_take_their_quote_currency() {
        let assets = HashMap::from([("a".to_string(), asset("a", "VOD", "GBp"))]);
        let mut errors = Vec::new();
        let planned = plan_position(
            &position(json!({ "assetId": "a", "quantity": 10, "averageCost": "1.5" })),
            0,
            &assets,
            &no_listing,
            "GBP",
            &mut errors,
        )
        .unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(planned.currency, "GBp");
        assert_eq!(planned.symbol, "VOD");
        assert_eq!(planned.average_cost, Decimal::new(15, 1));
    }

    #[test]
    fn new_listings_must_be_reviewed() {
        let assets = HashMap::new();
        for unreviewed in [
            json!({ "symbol": "AAPL", "quantity": 1 }),
            json!({ "symbol": "AAPL", "quoteCcy": "USD", "quantity": 1 }),
            json!({ "symbol": "AAPL", "quoteCcy": "USD", "instrumentType": "EQUITY", "quantity": 1 }),
        ] {
            let mut errors = Vec::new();
            assert!(plan_position(
                &position(unreviewed),
                0,
                &assets,
                &no_listing,
                "USD",
                &mut errors
            )
            .is_none());
            assert_eq!(errors.len(), 1);
        }
        let mut errors = Vec::new();
        let planned = plan_position(
            &position(json!({
                "symbol": "aapl", "exchangeMic": "XNAS", "quoteCcy": "USD",
                "instrumentType": "EQUITY", "quantity": 1
            })),
            0,
            &assets,
            &no_listing,
            "USD",
            &mut errors,
        )
        .unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(planned.symbol, "AAPL");
        assert_eq!(planned.currency, "USD");
        // A hand-priced equity needs no exchange.
        let mut errors = Vec::new();
        assert!(plan_position(
            &position(json!({
                "symbol": "PRIVATE", "quoteCcy": "EUR", "instrumentType": "EQUITY",
                "quoteMode": "MANUAL", "quantity": 1
            })),
            0,
            &assets,
            &no_listing,
            "EUR",
            &mut errors,
        )
        .is_some());
    }

    #[test]
    fn quantities_must_be_positive_and_unknown_assets_are_refused() {
        let assets = HashMap::from([("a".to_string(), asset("a", "AAPL", "USD"))]);
        for (row, expected) in [
            (json!({ "assetId": "a", "quantity": 0 }), "above zero"),
            (json!({ "assetId": "a", "quantity": -2 }), "above zero"),
            (
                json!({ "assetId": "a", "quantity": 1, "averageCost": -1 }),
                "negative",
            ),
            (json!({ "assetId": "missing", "quantity": 1 }), "no asset"),
            (json!({ "quantity": 1 }), "assetId"),
        ] {
            let mut errors = Vec::new();
            assert!(
                plan_position(&position(row), 0, &assets, &no_listing, "USD", &mut errors)
                    .is_none()
            );
            assert!(errors[0].contains(expected), "{errors:?}");
        }
    }

    #[test]
    fn currencies_are_read_as_core_spells_them() {
        let mut errors = Vec::new();
        let planned = plan_position(
            &position(json!({
                "symbol": "AAPL", "exchangeMic": "XNAS", "quoteCcy": "usd",
                "instrumentType": "EQUITY", "quantity": 1
            })),
            0,
            &HashMap::new(),
            &no_listing,
            "USD",
            &mut errors,
        )
        .unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(planned.currency, "USD");
        assert_eq!(planned.quote_ccy.as_deref(), Some("USD"));
        // Pence keep their spelling.
        let planned = plan_position(
            &position(json!({
                "symbol": "VOD", "exchangeMic": "XLON", "quoteCcy": "GBp",
                "instrumentType": "EQUITY", "quantity": 1
            })),
            0,
            &HashMap::new(),
            &no_listing,
            "GBP",
            &mut errors,
        )
        .unwrap();
        assert_eq!(planned.currency, "GBp");

        let cash = |value| serde_json::from_value::<Vec<CashInput>>(value).unwrap();
        let mut errors = Vec::new();
        let entered = entered_cash(
            &cash(json!([{ "currency": "usd", "amount": 1 }, { "currency": "GBp", "amount": 2 }])),
            &mut errors,
        );
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(
            entered,
            HashMap::from([
                ("USD".to_string(), Decimal::ONE),
                ("GBp".to_string(), Decimal::TWO)
            ])
        );
        for bad in [
            json!([{ "currency": "usd", "amount": 1 }, { "currency": "USD", "amount": 2 }]),
            json!([{ "currency": "U$D", "amount": 1 }]),
            json!([{ "currency": " ", "amount": 1 }]),
        ] {
            let mut errors = Vec::new();
            entered_cash(&cash(bad), &mut errors);
            assert_eq!(errors.len(), 1, "{errors:?}");
        }
    }

    #[test]
    fn cash_left_out_is_not_an_empty_list() {
        let args: HoldingsSnapshotArgs = serde_json::from_value(json!({
            "accountId": "a", "date": "2026-01-31", "positions": []
        }))
        .unwrap();
        assert!(args.cash.is_none());
        let args: HoldingsSnapshotArgs = serde_json::from_value(json!({
            "accountId": "a", "date": "2026-01-31", "positions": [], "cash": null
        }))
        .unwrap();
        assert!(args.cash.is_none());
        let args: HoldingsSnapshotArgs = serde_json::from_value(json!({
            "accountId": "a", "date": "2026-01-31", "positions": [], "cash": []
        }))
        .unwrap();
        assert_eq!(args.cash.map(|cash| cash.len()), Some(0));
    }

    #[test]
    fn audit_keeps_ids_and_counts_only() {
        let audit = CommitHoldingsSnapshot.sanitize_args_for_audit(&json!({
            "accountId": "acc", "date": "2026-01-31",
            "positions": [{ "assetId": "a", "quantity": 12.5, "averageCost": 99 }],
            "cash": [{ "currency": "USD", "amount": 1234.56 }],
            "note": "private"
        }));
        assert_eq!(
            audit,
            json!({
                "accountId": "acc", "date": "2026-01-31",
                "positions": [{ "assetId": "a", "symbol": null }],
                "positionCount": 1, "cashCount": 1
            })
        );
        assert_eq!(
            PrepareHoldingsSnapshot.sanitize_args_for_audit(&json!({})),
            json!({
                "accountId": null, "date": null, "positions": [],
                "positionCount": 0, "cashCount": null
            })
        );
    }

    #[test]
    fn prepare_and_commit_take_the_same_arguments() {
        assert_eq!(
            PrepareHoldingsSnapshot.input_schema(),
            CommitHoldingsSnapshot.input_schema()
        );
    }
}
