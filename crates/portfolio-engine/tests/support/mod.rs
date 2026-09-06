//! Shared support for the engine's fixture-driven tests: loads the scenario
//! YAMLs owned by this crate into `RawFacts`, captures projection output in
//! the golden shape shared with the retired legacy oracle (architecture §4.5).

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use rust_decimal::Decimal;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use wealthfolio_portfolio_engine::lot_records;
use wealthfolio_portfolio_engine::measure::{
    measure_account, measure_scope, MeasureInputs, MeasureProfile,
};
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::resolve::FxResolver;
use wealthfolio_portfolio_engine::value::{aggregate_scope, Resolved, ValueInputs, Window};

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

// ---------------------------------------------------------------- schema

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dec(pub Decimal);

impl<'de> Deserialize<'de> for Dec {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Dec;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("decimal")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Dec, E> {
                Decimal::from_str(v.trim()).map(Dec).map_err(E::custom)
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Dec, E> {
                Ok(Dec(Decimal::from(v)))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Dec, E> {
                Ok(Dec(Decimal::from(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Dec, E> {
                Decimal::from_str(&v.to_string())
                    .map(Dec)
                    .map_err(E::custom)
            }
        }
        deserializer.deserialize_any(V)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Scenario {
    pub id: String,
    #[serde(default)]
    pub markers: Vec<String>,
    pub policy: PolicySpec,
    pub accounts: Vec<AccountSpec>,
    #[serde(default)]
    pub assets: Vec<AssetSpec>,
    #[serde(default)]
    pub activities: Vec<ActivitySpec>,
    #[serde(default)]
    pub quotes: Vec<QuoteSpec>,
    #[serde(default)]
    pub fx_rates: Vec<FxRateSpec>,
    #[serde(default)]
    pub observed_snapshots: Vec<ObservedSnapshotSpec>,
    #[serde(default)]
    pub performance_windows: Vec<PerformanceWindowSpec>,
    #[serde(default)]
    pub lifecycle: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PerformanceWindowSpec {
    pub label: String,
    #[serde(default)]
    pub accounts: Option<Vec<String>>,
    #[serde(default)]
    pub start: Option<NaiveDate>,
    #[serde(default)]
    pub end: Option<NaiveDate>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PolicySpec {
    pub base_currency: String,
    #[serde(default = "utc")]
    pub timezone: String,
    pub as_of: NaiveDate,
}

fn utc() -> String {
    "UTC".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountSpec {
    pub id: String,
    pub currency: String,
    #[serde(default = "securities")]
    pub account_type: String,
    #[serde(default = "transactions")]
    pub tracking_mode: String,
    #[serde(default)]
    pub is_archived: bool,
}

fn securities() -> String {
    "SECURITIES".into()
}
fn transactions() -> String {
    "TRANSACTIONS".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetSpec {
    pub id: String,
    pub quote_ccy: String,
    #[serde(default = "investment")]
    pub kind: String,
    #[serde(default = "equity")]
    pub instrument_type: String,
    #[serde(default)]
    pub contract_multiplier: Option<Dec>,
}

fn investment() -> String {
    "INVESTMENT".into()
}
fn equity() -> String {
    "EQUITY".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivitySpec {
    pub id: String,
    pub account: String,
    #[serde(rename = "type")]
    pub activity_type: String,
    pub date: String,
    /// Row creation instant; defaults to `date`. Orders same-instant rows.
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub asset: Option<String>,
    #[serde(default)]
    pub quantity: Option<Dec>,
    #[serde(default)]
    pub unit_price: Option<Dec>,
    #[serde(default)]
    pub amount: Option<Dec>,
    #[serde(default)]
    pub fee: Option<Dec>,
    #[serde(default)]
    pub tax: Option<Dec>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub fx_rate: Option<Dec>,
    #[serde(default)]
    pub subtype: Option<String>,
    #[serde(default = "posted")]
    pub status: String,
    #[serde(rename = "override", default)]
    pub activity_type_override: Option<String>,
    #[serde(default)]
    pub source_group_id: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub source_system: Option<String>,
    #[serde(default)]
    pub is_user_modified: bool,
}

fn posted() -> String {
    "POSTED".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct QuoteSpec {
    pub asset: String,
    pub day: NaiveDate,
    pub close: Dec,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default = "manual")]
    pub source: String,
}

fn manual() -> String {
    "MANUAL".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct FxRateSpec {
    pub from: String,
    pub to: String,
    pub day: NaiveDate,
    pub rate: Dec,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ObservedSnapshotSpec {
    pub account: String,
    pub date: NaiveDate,
    #[serde(default)]
    pub positions: Vec<ObservedPositionSpec>,
    #[serde(default)]
    pub cash: BTreeMap<String, Dec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ObservedPositionSpec {
    pub asset: String,
    pub quantity: Dec,
    #[serde(default)]
    pub average_cost: Option<Dec>,
    /// Stored position currency (default: the asset's quote currency).
    #[serde(default)]
    pub currency: Option<String>,
}

impl Scenario {
    pub fn raw_facts(&self) -> RawFacts {
        let timezone: chrono_tz::Tz = self.policy.timezone.parse().expect("timezone");
        let policy = Policy::new(
            Currency::parse(&self.policy.base_currency).expect("base currency"),
            timezone,
            self.policy.as_of,
        );
        let account_currency: BTreeMap<&str, &str> = self
            .accounts
            .iter()
            .map(|a| (a.id.as_str(), a.currency.as_str()))
            .collect();
        let asset_currency: BTreeMap<&str, &str> = self
            .assets
            .iter()
            .map(|a| (a.id.as_str(), a.quote_ccy.as_str()))
            .collect();
        RawFacts {
            policy,
            accounts: self
                .accounts
                .iter()
                .map(|a| RawAccount {
                    id: a.id.clone(),
                    currency: a.currency.clone(),
                    account_type: a.account_type.clone(),
                    tracking_mode: a.tracking_mode.clone(),
                    is_archived: a.is_archived,
                })
                .collect(),
            assets: self
                .assets
                .iter()
                .map(|a| RawAsset {
                    id: a.id.clone(),
                    quote_currency: a.quote_ccy.clone(),
                    kind: a.kind.clone(),
                    instrument_type: (a.instrument_type != "NONE")
                        .then(|| a.instrument_type.clone()),
                    contract_multiplier: a.contract_multiplier.map(|d| d.0),
                })
                .collect(),
            activities: self
                .activities
                .iter()
                .map(|a| {
                    let timestamp = parse_instant(&a.date);
                    RawActivity {
                        id: a.id.clone(),
                        account_id: a.account.clone(),
                        asset_id: a.asset.clone(),
                        activity_type: a.activity_type.clone(),
                        activity_type_override: a.activity_type_override.clone(),
                        subtype: a.subtype.clone(),
                        status: a.status.clone(),
                        timestamp,
                        created_at: a
                            .created_at
                            .as_deref()
                            .map(parse_instant)
                            .unwrap_or(timestamp),
                        quantity: a.quantity.map(|d| d.0),
                        unit_price: a.unit_price.map(|d| d.0),
                        amount: a.amount.map(|d| d.0),
                        fee: a.fee.map(|d| d.0),
                        tax: a.tax.map(|d| d.0),
                        currency: a
                            .currency
                            .clone()
                            .unwrap_or_else(|| account_currency[a.account.as_str()].to_string()),
                        fx_rate: a.fx_rate.map(|d| d.0),
                        source_group_id: a.source_group_id.clone(),
                        external_transfer: a
                            .metadata
                            .as_ref()
                            .and_then(|m| m.get("flow"))
                            .and_then(|f| f.get("is_external"))
                            .and_then(Value::as_bool),
                        source_system: a.source_system.clone(),
                        is_user_modified: a.is_user_modified,
                        updated_at: timestamp,
                    }
                })
                .collect(),
            quotes: self
                .quotes
                .iter()
                .map(|q| RawQuote {
                    asset_id: q.asset.clone(),
                    day: q.day,
                    close: q.close.0,
                    currency: q.currency.clone().unwrap_or_else(|| {
                        asset_currency
                            .get(q.asset.as_str())
                            .map(|c| c.to_string())
                            .unwrap_or_default()
                    }),
                    source: q.source.clone(),
                })
                .collect(),
            fx_rates: self
                .fx_rates
                .iter()
                .map(|r| RawFxRate {
                    from: r.from.clone(),
                    to: r.to.clone(),
                    day: r.day,
                    rate: r.rate.0,
                })
                .collect(),
            observed_snapshots: self
                .observed_snapshots
                .iter()
                .map(|s| {
                    let currency = account_currency[s.account.as_str()];
                    let positions: Vec<RawObservedPosition> = s
                        .positions
                        .iter()
                        .map(|p| {
                            let average_cost = p.average_cost.map(|d| d.0).unwrap_or_default();
                            RawObservedPosition {
                                asset_id: p.asset.clone(),
                                currency: p.currency.clone().unwrap_or_default(),
                                quantity: p.quantity.0,
                                average_cost,
                                total_cost_basis: p.quantity.0 * average_cost,
                                cost_basis_account: None,
                                cost_basis_base: None,
                            }
                        })
                        .collect();
                    RawObservedSnapshot {
                        account_id: s.account.clone(),
                        date: s.date,
                        cost_basis: positions.iter().map(|p| p.total_cost_basis).sum(),
                        net_contribution: Decimal::ZERO,
                        net_contribution_base: Decimal::ZERO,
                        cash_total_account_currency: s
                            .cash
                            .iter()
                            .filter(|(ccy, _)| ccy.as_str() == currency)
                            .map(|(_, amount)| amount.0)
                            .sum(),
                        cash_total_base_currency: Decimal::ZERO,
                        positions,
                        cash: s.cash.iter().map(|(c, a)| (c.clone(), a.0)).collect(),
                    }
                })
                .collect(),
        }
    }
}

pub fn parse_instant(raw: &str) -> DateTime<Utc> {
    if let Ok(instant) = DateTime::parse_from_rfc3339(raw) {
        return instant.with_timezone(&Utc);
    }
    let date = NaiveDate::parse_from_str(raw, "%Y-%m-%d").expect("date");
    Utc.from_utc_datetime(&date.and_time(NaiveTime::from_hms_opt(12, 0, 0).unwrap()))
}

/// `SCENARIO_FILTER=NOM-,EDGE-CCY` narrows every harness to ids with one of
/// the comma-separated prefixes; unset means every scenario.
pub fn scenario_selected(id: &str) -> bool {
    match std::env::var("SCENARIO_FILTER") {
        Ok(filter) if !filter.trim().is_empty() => filter
            .split(',')
            .map(str::trim)
            .any(|prefix| !prefix.is_empty() && id.starts_with(prefix)),
        _ => true,
    }
}

pub fn load_all_scenarios() -> Vec<Scenario> {
    let mut paths = Vec::new();
    collect_yaml(&fixtures_dir().join("scenarios"), &mut paths);
    paths.sort();
    paths
        .iter()
        .map(|path| {
            let text = std::fs::read_to_string(path).expect("read scenario");
            serde_yaml::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        })
        .collect()
}

fn collect_yaml(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_yaml(&path, out);
        } else if path.extension().is_some_and(|e| e == "yaml" || e == "yml") {
            out.push(path);
        }
    }
}

// ------------------------------------------------------- canonical output

pub fn fmt_decimal(value: Decimal) -> String {
    let rounded = value.round_dp(8);
    if rounded.is_zero() {
        "0".to_string()
    } else {
        rounded.normalize().to_string()
    }
}

fn fmt_opt(value: Option<Decimal>) -> Option<String> {
    value.map(fmt_decimal)
}

/// Projection-level sections of the legacy golden, in the same shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectionCapture {
    pub keyframes: Vec<Value>,
    pub lots: Vec<Value>,
    pub disposals: Vec<Value>,
}

/// Valuation-level sections of the legacy golden (`valuations`, `flows`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValuationCapture {
    pub valuations: Vec<Value>,
    pub flows: Vec<Value>,
}

/// `valuations` are the persisted rows; `flows` is the scoped read
/// performance uses (single-account scope, internal pairs netted).
pub fn capture_valuation(
    inputs: &ValueInputs<'_>,
    series: &BTreeMap<AccountId, ValuationSeries>,
    account: &AccountId,
) -> Result<ValuationCapture, String> {
    let valuations = series
        .get(account)
        .map(|s| s.days.iter().map(valuation_value).collect())
        .unwrap_or_default();
    let flows = if series.contains_key(account) {
        flow_values(
            &aggregate_scope(
                &inputs.resolved,
                &inputs.bundle.disposals,
                series,
                std::slice::from_ref(account),
                Window::default(),
            )?
            .days,
        )
    } else {
        Vec::new()
    };
    Ok(ValuationCapture { valuations, flows })
}

/// Legacy `flow_captures`: days carrying a flow or a degraded provenance.
pub fn flow_values(days: &[DailyValuation]) -> Vec<Value> {
    days.iter()
        .filter(|day| {
            !day.flow.inflow_base.is_zero()
                || !day.flow.outflow_base.is_zero()
                || day.flow.source != FlowSource::NoFlow
        })
        .map(|day| {
            serde_json::json!({
                "date": day.date.to_string(),
                "inflow_base": fmt_decimal(day.flow.inflow_base),
                "outflow_base": fmt_decimal(day.flow.outflow_base),
                "source": enum_str(&day.flow.source),
            })
        })
        .collect()
}

/// Portfolio flows: the scoped read over every non-archived account.
pub fn capture_portfolio_flows(
    inputs: &ValueInputs<'_>,
    series: &BTreeMap<AccountId, ValuationSeries>,
) -> Result<Vec<Value>, String> {
    let scope: Vec<AccountId> = inputs
        .resolved
        .facts
        .accounts
        .values()
        .filter(|a| !a.archived)
        .map(|a| a.id.clone())
        .collect();
    if scope.is_empty() {
        return Ok(Vec::new());
    }
    aggregate_scope(
        &inputs.resolved,
        &inputs.bundle.disposals,
        series,
        &scope,
        Window::default(),
    )
    .map(|scoped| flow_values(&scoped.days))
}

fn enum_str<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn valuation_value(day: &DailyValuation) -> Value {
    serde_json::json!({
        "date": day.date.to_string(),
        "fx_rate_to_base": fmt_decimal(day.fx_rate_to_base),
        "cash_balance": fmt_decimal(day.cash_balance),
        "investment_market_value": fmt_decimal(day.investment_market_value),
        "total_value": fmt_decimal(day.total_value),
        "cost_basis": fmt_decimal(day.cost_basis),
        "book_basis": fmt_decimal(day.book_basis),
        "net_contribution": fmt_decimal(day.net_contribution),
        "cash_balance_base": fmt_decimal(day.cash_balance_base),
        "investment_market_value_base": fmt_decimal(day.investment_market_value_base),
        "total_value_base": fmt_decimal(day.total_value_base),
        "cost_basis_base": fmt_decimal(day.cost_basis_base),
        "book_basis_base": fmt_decimal(day.book_basis_base),
        "net_contribution_base": fmt_decimal(day.net_contribution_base),
        "external_inflow_base": fmt_decimal(day.flow.inflow_base),
        "external_outflow_base": fmt_decimal(day.flow.outflow_base),
        "external_flow_source": enum_str(&day.flow.source),
        "performance_eligible_value_base": fmt_decimal(day.performance_eligible_value_base),
        "value_status": legacy_status_name(&enum_str(&day.value_status)),
        "basis_status": legacy_status_name(&enum_str(&day.basis_status)),
    })
}

/// Legacy stores statuses in lowerCamelCase (`partialUnpriced`).
fn legacy_status_name(screaming: &str) -> String {
    let mut out = String::new();
    for (index, part) in screaming.split('_').enumerate() {
        let lower = part.to_ascii_lowercase();
        if index == 0 {
            out.push_str(&lower);
        } else {
            let mut chars = lower.chars();
            if let Some(first) = chars.next() {
                out.push(first.to_ascii_uppercase());
                out.push_str(chars.as_str());
            }
        }
    }
    out
}

pub fn capture_projection(
    bundle: &ProjectionBundle,
    account: &AccountId,
    facts: &CanonicalFacts,
    fx: &FxResolver<'_>,
) -> ProjectionCapture {
    let base = facts.policy.base_currency.as_str();
    let keyframes = bundle
        .keyframes
        .get(account)
        .map(|frames| frames.iter().map(keyframe_value).collect())
        .unwrap_or_default();

    let lots: Vec<Value> = lot_records(bundle, facts, fx)
        .into_iter()
        .filter(|lot| lot.account == *account)
        .map(|lot| {
            serde_json::json!({
                "id": lot.id,
                "asset_id": lot.asset.as_str(),
                "open_date": lot.open_date.to_string(),
                "open_activity_id": lot.open_activity.as_ref().map(|a| a.as_str().to_string()),
                "original_quantity": fmt_decimal(lot.original_quantity),
                "remaining_quantity": fmt_decimal(lot.remaining_quantity),
                "cost_per_unit": fmt_decimal(lot.cost_per_unit),
                "original_cost_basis": fmt_decimal(lot.original_cost_basis),
                "remaining_cost_basis": fmt_decimal(lot.remaining_cost_basis),
                "original_cost_basis_base": fmt_decimal(lot.original_cost_basis_base),
                "remaining_cost_basis_base": fmt_decimal(lot.remaining_cost_basis_base),
                "fee_allocated": fmt_decimal(lot.fee_allocated),
                "fee_allocated_base": fmt_decimal(lot.fee_allocated_base),
                "tax_allocated": fmt_decimal(lot.tax_allocated),
                "tax_allocated_base": fmt_decimal(lot.tax_allocated_base),
                "currency": lot.currency.as_str(),
                "base_currency": base,
                "fx_rate_to_base": fmt_decimal(lot.fx_rate_to_base),
                "fx_rate_to_account": fmt_opt(lot.fx_rate_to_account),
                "split_ratio": fmt_decimal(lot.split_ratio),
                "is_closed": lot.is_closed(),
                "close_date": lot.close_date.map(|d| d.to_string()),
                "close_activity_id": lot.close_event.as_ref().map(|e| e.as_str().to_string()),
            })
        })
        .collect();

    let mut disposals: Vec<&LotDisposal> = bundle
        .disposals
        .iter()
        .filter(|d| d.account == *account)
        .collect();
    disposals.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.event.cmp(&b.event))
            .then_with(|| a.id.cmp(&b.id))
    });
    let disposals = disposals
        .into_iter()
        .map(|d| {
            serde_json::json!({
                "id": d.id,
                "lot_id": d.lot_id,
                "asset_id": d.asset.as_str(),
                "activity_id": d.event.as_str(),
                "date": d.date.to_string(),
                "quantity": fmt_decimal(d.quantity),
                "proceeds": fmt_decimal(d.proceeds),
                "cost_basis": fmt_decimal(d.cost_basis),
                "realized_pnl": fmt_decimal(d.realized_pnl),
                "proceeds_base": fmt_decimal(d.proceeds_base),
                "cost_basis_base": fmt_decimal(d.cost_basis_base),
                "realized_pnl_base": fmt_decimal(d.realized_pnl_base),
                "currency": d.currency.as_str(),
                "fx_rate_to_base": fmt_decimal(d.fx_rate_to_base),
            })
        })
        .collect();

    ProjectionCapture {
        keyframes,
        lots,
        disposals,
    }
}

/// Storage nulls `open_activity_id` when it points at a synthetic leg id
/// (`{activity}:buy`) rather than an activity row.
fn activity_ref(event: Option<&EventId>, facts: &CanonicalFacts) -> Value {
    match event {
        Some(id)
            if facts
                .activities
                .iter()
                .any(|a| a.id.as_str() == id.as_str()) =>
        {
            Value::String(id.as_str().to_string())
        }
        _ => Value::Null,
    }
}

fn keyframe_value(frame: &Keyframe) -> Value {
    let positions: serde_json::Map<String, Value> = frame
        .state
        .positions
        .iter()
        .map(|(asset, position)| {
            (
                asset.as_str().to_string(),
                serde_json::json!({
                    "quantity": fmt_decimal(position.quantity),
                    "average_cost": fmt_decimal(position.average_cost),
                    "total_cost_basis": fmt_decimal(position.total_cost_basis),
                    "currency": position.currency.as_str(),
                    "cost_basis_account": fmt_opt(position.cost_basis_account),
                    "cost_basis_base": fmt_opt(position.cost_basis_base),
                    "contract_multiplier": fmt_decimal(position.contract_multiplier),
                    "is_alternative": position.alternative,
                }),
            )
        })
        .collect();
    let cash: serde_json::Map<String, Value> = frame
        .state
        .cash
        .iter()
        .map(|(currency, amount)| {
            (
                currency.as_str().to_string(),
                Value::String(fmt_decimal(*amount)),
            )
        })
        .collect();
    serde_json::json!({
        "date": frame.date.to_string(),
        "source": "CALCULATED",
        "positions": positions,
        "cash": cash,
        "cost_basis": fmt_decimal(frame.state.cost_basis),
        "net_contribution": fmt_decimal(frame.state.net_contribution),
        "net_contribution_base": fmt_decimal(frame.state.net_contribution_base),
        "cash_total_account_currency": fmt_decimal(frame.state.cash_total_account),
        "cash_total_base_currency": fmt_decimal(frame.state.cash_total_base),
    })
}

// ------------------------------------------------------- performance

pub fn all_windows(scenario: &Scenario) -> Vec<PerformanceWindowSpec> {
    let mut windows = vec![PerformanceWindowSpec {
        label: "all_time".to_string(),
        accounts: None,
        start: None,
        end: None,
    }];
    windows.extend(scenario.performance_windows.iter().cloned());
    windows
}

pub fn capture_account_performance(
    inputs: &MeasureInputs<'_>,
    account: &AccountId,
    window: &PerformanceWindowSpec,
) -> Value {
    let result = measure_account(
        inputs,
        account,
        Window {
            start: window.start,
            end: window.end,
        },
        MeasureProfile::Full,
    )
    .expect("account performance");
    performance_value(&result)
}

pub fn capture_scope_performance(
    inputs: &MeasureInputs<'_>,
    scope: &[AccountId],
    window: &PerformanceWindowSpec,
) -> Value {
    let result = measure_scope(
        inputs,
        "portfolio",
        scope,
        Window {
            start: window.start,
            end: window.end,
        },
        MeasureProfile::Full,
    )
    .expect("scope performance");
    performance_value(&result)
}

/// The legacy `PerformanceCapture` shape.
pub fn performance_value(result: &PerformanceResult) -> Value {
    let camel = |v: &BasisStatus| legacy_status_name(&enum_str(v));
    serde_json::json!({
        "method": enum_str(&result.method),
        "period_start": result.period_start.map(|d| d.to_string()),
        "period_end": result.period_end.map(|d| d.to_string()),
        "returns": {
            "twr": fmt_opt(result.returns.twr),
            "annualized_twr": fmt_opt(result.returns.annualized_twr),
            "irr": fmt_opt(result.returns.irr),
            "annualized_irr": fmt_opt(result.returns.annualized_irr),
            "value_return": fmt_opt(result.returns.value_return),
            "annualized_value_return": fmt_opt(result.returns.annualized_value_return),
        },
        "attribution": {
            "contributions": fmt_decimal(result.attribution.contributions),
            "distributions": fmt_decimal(result.attribution.distributions),
            "income": fmt_decimal(result.attribution.income),
            "realized_pnl": fmt_decimal(result.attribution.realized_pnl),
            "unrealized_pnl_change": fmt_decimal(result.attribution.unrealized_pnl_change),
            "fx_effect": fmt_decimal(result.attribution.fx_effect),
            "fees": fmt_decimal(result.attribution.fees),
            "taxes": fmt_decimal(result.attribution.taxes),
            "residual": fmt_decimal(result.attribution.residual),
        },
        "risk": {
            "volatility": fmt_opt(result.risk.volatility),
            "max_drawdown": fmt_opt(result.risk.max_drawdown),
            "peak_date": result.risk.peak_date.map(|d| d.to_string()),
            "trough_date": result.risk.trough_date.map(|d| d.to_string()),
            "recovery_date": result.risk.recovery_date.map(|d| d.to_string()),
            "drawdown_duration_days": result.risk.drawdown_duration_days,
        },
        "summary": {
            "amount": fmt_opt(result.summary.amount),
            "percent": fmt_opt(result.summary.percent),
            "method": enum_str(&result.summary.method),
            "basis": enum_str(&result.summary.basis),
            "quality": enum_str(&result.summary.quality),
            "amount_status": enum_str(&result.summary.amount_status),
            "percent_status": enum_str(&result.summary.percent_status),
            "basis_status": camel(&result.summary.basis_status),
        },
        "basis_status": camel(&result.basis_status),
        "quality": enum_str(&result.data_quality.status),
        "is_holdings_mode": result.is_holdings_mode,
        "is_mixed_tracking_mode": result.is_mixed_tracking_mode,
        "series": result.series.iter().map(|p| serde_json::json!({
            "date": p.date.to_string(),
            "value": fmt_decimal(p.value),
        })).collect::<Vec<_>>(),
    })
}

// ------------------------------------------------------- golden sections

fn strip_insta_header(text: &str) -> &str {
    let mut parts = text.splitn(3, "---\n");
    parts.next();
    parts.next();
    parts.next().unwrap_or(text)
}

/// Paths where two JSON trees differ (`path: left != right`).
pub fn diff_values(path: &str, left: &Value, right: &Value, out: &mut Vec<String>) {
    match (left, right) {
        (Value::Object(l), Value::Object(r)) => {
            let keys: std::collections::BTreeSet<&String> = l.keys().chain(r.keys()).collect();
            for key in keys {
                let child = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                match (l.get(key), r.get(key)) {
                    (Some(a), Some(b)) => diff_values(&child, a, b, out),
                    (Some(a), None) => out.push(format!("{child}: {a} != <absent>")),
                    (None, Some(b)) => out.push(format!("{child}: <absent> != {b}")),
                    (None, None) => {}
                }
            }
        }
        (Value::Array(l), Value::Array(r)) => {
            if l.len() != r.len() {
                out.push(format!("{path}: {} items != {} items", l.len(), r.len()));
            }
            for (i, (a, b)) in l.iter().zip(r.iter()).enumerate() {
                diff_values(&format!("{path}[{i}]"), a, b, out);
            }
        }
        _ => {
            if left != right {
                out.push(format!("{path}: {left} != {right}"));
            }
        }
    }
}

// ------------------------------------------------------------ pipeline

use wealthfolio_portfolio_engine::compile::CompiledLedger;
use wealthfolio_portfolio_engine::diagnostics::Diagnostic;
use wealthfolio_portfolio_engine::error::EngineError;
use wealthfolio_portfolio_engine::resolve::ResolvedSurfaces;
use wealthfolio_portfolio_engine::{compile, normalize, project, resolve_surfaces, value};

/// All five stages over one set of facts, from genesis to `as_of`.
pub struct Pipeline {
    pub facts: CanonicalFacts,
    pub normalize_diagnostics: Vec<Diagnostic>,
    pub ledger: CompiledLedger,
    pub range: DateRange,
    pub surfaces: ResolvedSurfaces,
    pub bundle: ProjectionBundle,
    pub series: BTreeMap<AccountId, ValuationSeries>,
}

pub fn projection_range(facts: &CanonicalFacts) -> DateRange {
    let start = facts
        .activities
        .iter()
        .map(|a| a.date)
        .min()
        .unwrap_or(facts.policy.as_of);
    DateRange {
        start,
        end: facts.policy.as_of,
    }
}

impl Pipeline {
    pub fn run(raw: RawFacts) -> Result<Pipeline, EngineError> {
        let normalized = normalize(raw)?;
        let facts = normalized.facts;
        let ledger = compile(&facts);
        let range = projection_range(&facts);
        let surfaces = resolve_surfaces(&facts, range);
        let bundle = {
            let fx = FxResolver {
                surface: &surfaces.fx,
                policy: &facts.policy,
            };
            project(&ledger, &facts, &fx, None, range)?
        };
        let series = value(&ValueInputs {
            resolved: Resolved {
                facts: &facts,
                ledger: &ledger,
                surfaces: &surfaces,
                range,
            },
            bundle: &bundle,
        });
        Ok(Pipeline {
            facts,
            normalize_diagnostics: normalized.diagnostics,
            ledger,
            range,
            surfaces,
            bundle,
            series,
        })
    }

    pub fn from_scenario(scenario: &Scenario) -> Pipeline {
        Pipeline::run(scenario.raw_facts()).unwrap_or_else(|e| panic!("{}: {e}", scenario.id))
    }

    pub fn fx(&self) -> FxResolver<'_> {
        FxResolver {
            surface: &self.surfaces.fx,
            policy: &self.facts.policy,
        }
    }

    pub fn resolved(&self) -> Resolved<'_> {
        Resolved {
            facts: &self.facts,
            ledger: &self.ledger,
            surfaces: &self.surfaces,
            range: self.range,
        }
    }

    pub fn value_inputs(&self) -> ValueInputs<'_> {
        ValueInputs {
            resolved: self.resolved(),
            bundle: &self.bundle,
        }
    }

    /// Storage-shaped lots of the projection (the read path's input).
    pub fn lots(&self) -> Vec<LotRecord> {
        lot_records(&self.bundle, &self.facts, &self.fx())
    }

    /// The read-path inputs over this pipeline's own outputs.
    pub fn measure_inputs<'a>(&'a self, lots: &'a [LotRecord]) -> MeasureInputs<'a> {
        MeasureInputs {
            resolved: self.resolved(),
            series: &self.series,
            lots,
            disposals: &self.bundle.disposals,
        }
    }

    /// Every non-archived account, the legacy portfolio scope.
    pub fn portfolio_scope(&self) -> Vec<AccountId> {
        self.facts
            .accounts
            .values()
            .filter(|a| !a.archived)
            .map(|a| a.id.clone())
            .collect()
    }

    /// All diagnostics of the run, sorted, as `severity code source: message`.
    pub fn diagnostics(&self) -> Vec<String> {
        let mut lines: Vec<String> = self
            .normalize_diagnostics
            .iter()
            .map(|d| ("normalize", d))
            .chain(self.ledger.diagnostics.iter().map(|d| ("compile", d)))
            .chain(self.bundle.diagnostics.iter().map(|d| ("project", d)))
            .chain(
                self.series
                    .values()
                    .flat_map(|s| s.diagnostics.iter().map(|d| ("value", d))),
            )
            .map(|(stage, d)| {
                format!(
                    "{stage}/{}: {:?} {:?}: {}",
                    d.source, d.severity, d.code, d.message
                )
            })
            .collect();
        lines.sort();
        lines.dedup();
        lines
    }
}

/// The kernel golden body: the legacy `CaptureBody` shape produced by the
/// kernel (holdings-mode keyframes are the observed snapshots).
pub fn capture_body(pipeline: &Pipeline, windows: &[PerformanceWindowSpec]) -> Value {
    let inputs = pipeline.value_inputs();
    let lots = pipeline.lots();
    let measure_inputs = pipeline.measure_inputs(&lots);
    let fx = pipeline.fx();
    let scope = pipeline.portfolio_scope();
    let mut accounts = serde_json::Map::new();
    for (id, account) in &pipeline.facts.accounts {
        if account.archived {
            continue;
        }
        let holdings = account.tracking == TrackingMode::Holdings;
        let projection = if holdings {
            ProjectionCapture {
                keyframes: observed_keyframes(pipeline, id),
                lots: Vec::new(),
                disposals: Vec::new(),
            }
        } else {
            capture_projection(&pipeline.bundle, id, &pipeline.facts, &fx)
        };
        let valuation =
            capture_valuation(&inputs, &pipeline.series, id).unwrap_or(ValuationCapture {
                valuations: Vec::new(),
                flows: Vec::new(),
            });
        let mut performance = serde_json::Map::new();
        for window in windows {
            let in_scope = window
                .accounts
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|w| w == id.as_str()));
            if in_scope {
                performance.insert(
                    window.label.clone(),
                    capture_account_performance(&measure_inputs, id, window),
                );
            }
        }
        accounts.insert(
            id.as_str().to_string(),
            serde_json::json!({
                "currency": account.currency.as_str(),
                "tracking_mode": enum_str(&account.tracking),
                "keyframes": projection.keyframes,
                "lots": projection.lots,
                "disposals": projection.disposals,
                "valuations": valuation.valuations,
                "flows": valuation.flows,
                "performance": performance,
            }),
        );
    }
    let mut portfolio = serde_json::Map::new();
    for window in windows {
        let window_scope: Vec<AccountId> = window
            .accounts
            .as_ref()
            .map(|ids| ids.iter().map(|w| AccountId::new(w.as_str())).collect())
            .unwrap_or_else(|| scope.clone());
        if window_scope.is_empty() {
            continue;
        }
        portfolio.insert(
            window.label.clone(),
            capture_scope_performance(&measure_inputs, &window_scope, window),
        );
    }
    let portfolio_flows = capture_portfolio_flows(&inputs, &pipeline.series).unwrap_or_default();
    serde_json::json!({
        "accounts": accounts,
        "portfolio": portfolio,
        "portfolio_flows": portfolio_flows,
        "diagnostics": pipeline.diagnostics(),
    })
}

fn observed_keyframes(pipeline: &Pipeline, account: &AccountId) -> Vec<Value> {
    pipeline
        .facts
        .observed_snapshots
        .iter()
        .filter(|s| s.account == *account)
        .map(|s| {
            let positions: serde_json::Map<String, Value> = s
                .positions
                .iter()
                .map(|(asset, p)| {
                    (
                        asset.as_str().to_string(),
                        serde_json::json!({
                            "quantity": fmt_decimal(p.quantity),
                            "total_cost_basis": fmt_decimal(p.total_cost_basis),
                        }),
                    )
                })
                .collect();
            let cash: serde_json::Map<String, Value> = s
                .cash
                .iter()
                .map(|(c, a)| (c.as_str().to_string(), Value::String(fmt_decimal(*a))))
                .collect();
            serde_json::json!({
                "date": s.date.to_string(),
                "source": "OBSERVED",
                "positions": positions,
                "cash": cash,
            })
        })
        .collect()
}
