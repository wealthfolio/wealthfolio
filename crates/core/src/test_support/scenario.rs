//! Scenario fixture schema (architecture §5): one YAML file of FACTS per scenario.
//!
//! The loader is strict (`deny_unknown_fields`) and enforces the capture
//! disciplines that keep the legacy oracle deterministic: unique activity
//! timestamps, explicit decimals, and references that resolve.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rust_decimal::Decimal;
use serde::de::{self, DeserializeOwned, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::accounts::{Account, TrackingMode};
use crate::activities::{Activity, ActivityStatus};
use crate::assets::{Asset, AssetKind, InstrumentType, QuoteMode};
use crate::fx::ExchangeRate;
use crate::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotSource};
use crate::quotes::Quote;

/// Noon on `as_of` in the policy timezone: `user_today` resolves to `as_of`
/// and every activity dated that day is already in the past.
pub fn as_of_instant(as_of: NaiveDate, timezone: &str) -> DateTime<Utc> {
    let tz: chrono_tz::Tz = timezone.parse().expect("validated timezone");
    tz.from_local_datetime(&as_of.and_hms_opt(12, 0, 0).expect("noon"))
        .single()
        .expect("noon exists in every zone")
        .with_timezone(&Utc)
}

/// Root of the shared fixture tree (scenarios + goldens). Owned by the engine
/// crate so both harnesses read the same files.
pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../portfolio-engine/tests/fixtures")
}

pub fn scenarios_dir() -> PathBuf {
    fixtures_dir().join("scenarios")
}

/// `goldens/<kind>` where kind is `legacy` or `kernel`.
pub fn goldens_dir(kind: &str) -> PathBuf {
    fixtures_dir().join("goldens").join(kind)
}

/// Catalog markers (architecture §5): `L` ledgered divergence, `K` kernel-only,
/// `S` shell-level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Marker {
    L,
    K,
    S,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub intent: String,
    #[serde(default)]
    pub markers: Vec<Marker>,
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
    /// Extra performance windows beyond the implicit all-time window.
    #[serde(default)]
    pub performance_windows: Vec<PerformanceWindowSpec>,
    /// Ordered fact mutations + recalculation modes (LIFE family). Each step
    /// is captured and compared against a full rebuild of the same facts.
    #[serde(default)]
    pub lifecycle: Vec<LifecycleStep>,
    #[serde(default)]
    pub expected_notes: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LifecycleStep {
    pub label: String,
    /// New "today"; defaults to the scenario `as_of`.
    #[serde(default)]
    pub as_of: Option<NaiveDate>,
    #[serde(default)]
    pub add_activities: Vec<ActivitySpec>,
    /// Replaces the activity with the same id.
    #[serde(default)]
    pub update_activities: Vec<ActivitySpec>,
    #[serde(default)]
    pub remove_activities: Vec<String>,
    #[serde(default)]
    pub add_quotes: Vec<QuoteSpec>,
    #[serde(default)]
    pub add_fx_rates: Vec<FxRateSpec>,
    pub recalc: RecalcSpec,
}

/// Which legacy recalculation modes the step runs.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecalcSpec {
    /// `FULL` | `SINCE_DATE` | `INCREMENTAL_FROM_LAST` | `NONE`
    #[serde(default = "default_recalc_mode")]
    pub snapshots: String,
    /// `FULL` | `SINCE_DATE` | `INCREMENTAL_FROM_LAST` | `NONE`
    #[serde(default = "default_recalc_mode")]
    pub valuations: String,
    /// Required by `SINCE_DATE`.
    #[serde(default)]
    pub since: Option<NaiveDate>,
    /// Scope; default every non-archived account.
    #[serde(default)]
    pub accounts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySpec {
    pub base_currency: String,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    pub as_of: NaiveDate,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountSpec {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub currency: String,
    #[serde(default = "default_account_type")]
    pub account_type: String,
    #[serde(default = "default_tracking_mode")]
    pub tracking_mode: String,
    #[serde(default)]
    pub is_archived: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetSpec {
    pub id: String,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    pub quote_ccy: String,
    #[serde(default = "default_asset_kind")]
    pub kind: String,
    /// `EQUITY` (default), `CRYPTO`, `OPTION`, `BOND`, `METAL`, `FX`, or
    /// `NONE` for an untyped legacy asset.
    #[serde(default = "default_instrument_type")]
    pub instrument_type: String,
    #[serde(default)]
    pub contract_multiplier: Option<Dec>,
    #[serde(default = "default_quote_mode")]
    pub quote_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivitySpec {
    pub id: String,
    pub account: String,
    #[serde(rename = "type")]
    pub activity_type: String,
    /// RFC 3339 instant, or a bare `YYYY-MM-DD` which means 12:00:00 UTC.
    pub date: String,
    /// Row creation instant; defaults to the stamp. Orders same-instant rows.
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub asset: Option<String>,
    #[serde(default)]
    pub quantity: Option<Dec>,
    #[serde(default)]
    pub unit_price: Option<Dec>,
    /// Stored FINAL cash (the writer's output), never re-derived at runtime.
    #[serde(default)]
    pub amount: Option<Dec>,
    #[serde(default)]
    pub fee: Option<Dec>,
    #[serde(default)]
    pub tax: Option<Dec>,
    /// Defaults to the account currency. May be empty on purpose (EDGE-CUR).
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub fx_rate: Option<Dec>,
    #[serde(default)]
    pub subtype: Option<String>,
    #[serde(default = "default_status")]
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
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuoteSpec {
    pub asset: String,
    pub day: NaiveDate,
    pub close: Dec,
    /// Defaults to the asset quote currency.
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default = "default_source")]
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FxRateSpec {
    pub from: String,
    pub to: String,
    pub day: NaiveDate,
    pub rate: Dec,
    #[serde(default = "default_source")]
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedSnapshotSpec {
    pub account: String,
    pub date: NaiveDate,
    #[serde(default = "default_observed_source")]
    pub source: String,
    #[serde(default)]
    pub positions: Vec<ObservedPositionSpec>,
    /// Cash by currency; totals are computed in the account currency only.
    #[serde(default)]
    pub cash: BTreeMap<String, Dec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservedPositionSpec {
    pub asset: String,
    pub quantity: Dec,
    #[serde(default)]
    pub average_cost: Option<Dec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceWindowSpec {
    pub label: String,
    /// `None` = every non-archived account.
    #[serde(default)]
    pub accounts: Option<Vec<String>>,
    #[serde(default)]
    pub start: Option<NaiveDate>,
    #[serde(default)]
    pub end: Option<NaiveDate>,
}

/// Decimal that accepts YAML numbers or strings without going through `f64`
/// precision (numbers are re-parsed from their shortest textual form).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dec(pub Decimal);

impl<'de> Deserialize<'de> for Dec {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DecVisitor;

        impl Visitor<'_> for DecVisitor {
            type Value = Dec;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a decimal number or string")
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

        deserializer.deserialize_any(DecVisitor)
    }
}

fn default_timezone() -> String {
    "UTC".to_string()
}
fn default_account_type() -> String {
    "SECURITIES".to_string()
}
fn default_tracking_mode() -> String {
    "TRANSACTIONS".to_string()
}
fn default_asset_kind() -> String {
    "INVESTMENT".to_string()
}
fn default_instrument_type() -> String {
    "EQUITY".to_string()
}
fn default_quote_mode() -> String {
    "MARKET".to_string()
}
fn default_status() -> String {
    "POSTED".to_string()
}
fn default_source() -> String {
    "MANUAL".to_string()
}
fn default_observed_source() -> String {
    "MANUAL_ENTRY".to_string()
}
fn default_recalc_mode() -> String {
    "FULL".to_string()
}

/// Loads and validates one scenario file. Panics with the file path on any
/// schema or discipline violation — fixtures are code.
pub fn load_scenario(path: &Path) -> Scenario {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let scenario: Scenario =
        serde_yaml::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    if let Err(error) = scenario.validate() {
        panic!("{}: {error}", path.display());
    }
    scenario
}

/// Every scenario under `scenarios/`, sorted by path for stable iteration.
pub fn load_all_scenarios() -> Vec<Scenario> {
    let mut paths = Vec::new();
    collect_yaml(&scenarios_dir(), &mut paths);
    paths.sort();
    paths.iter().map(|path| load_scenario(path)).collect()
}

fn collect_yaml(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_yaml(&path, out);
        } else if path
            .extension()
            .is_some_and(|ext| ext == "yaml" || ext == "yml")
        {
            out.push(path);
        }
    }
}

/// Domain rows built from a scenario: exactly what the repositories would
/// hand the services.
#[derive(Debug, Clone)]
pub struct ScenarioFacts {
    pub base_currency: String,
    pub timezone: String,
    pub as_of: NaiveDate,
    pub accounts: Vec<Account>,
    pub assets: Vec<Asset>,
    pub activities: Vec<Activity>,
    pub quotes: Vec<Quote>,
    pub fx_rates: Vec<ExchangeRate>,
    pub observed_snapshots: Vec<AccountStateSnapshot>,
}

impl Scenario {
    pub fn has_marker(&self, marker: Marker) -> bool {
        self.markers.contains(&marker)
    }

    /// Parity-eligible = neither kernel-only nor shell-level (architecture §5).
    pub fn is_parity_eligible(&self) -> bool {
        !self.has_marker(Marker::K) && !self.has_marker(Marker::S)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("scenario id is empty".to_string());
        }
        self.policy
            .timezone
            .parse::<chrono_tz::Tz>()
            .map_err(|_| format!("unknown timezone {:?}", self.policy.timezone))?;

        let account_ids: HashSet<&str> = self.accounts.iter().map(|a| a.id.as_str()).collect();
        if account_ids.len() != self.accounts.len() {
            return Err("duplicate account id".to_string());
        }
        let asset_ids: HashSet<&str> = self.assets.iter().map(|a| a.id.as_str()).collect();
        if asset_ids.len() != self.assets.len() {
            return Err("duplicate asset id".to_string());
        }

        let mut activity_ids = HashSet::new();
        let mut instants = HashMap::new();
        for activity in &self.activities {
            if !activity_ids.insert(activity.id.as_str()) {
                return Err(format!("duplicate activity id {:?}", activity.id));
            }
            if !account_ids.contains(activity.account.as_str()) {
                return Err(format!(
                    "activity {:?} references unknown account {:?}",
                    activity.id, activity.account
                ));
            }
            if let Some(asset) = &activity.asset {
                if !asset_ids.contains(asset.as_str()) {
                    return Err(format!(
                        "activity {:?} references unknown asset {:?}",
                        activity.id, asset
                    ));
                }
            }
            let created_at = activity
                .created_at
                .as_deref()
                .map(parse_instant)
                .transpose()
                .map_err(|e| format!("activity {} created_at: {e}", activity.id))?;
            let instant = parse_instant(&activity.date)
                .map_err(|error| format!("activity {:?}: {error}", activity.id))?;
            // Same-instant rows fold by created_at (then id); without one the
            // order would depend on the id alone, which no fixture may rely on.
            if let Some(other) = instants.insert((instant, created_at), activity.id.clone()) {
                return Err(format!(
                    "activities {:?} and {:?} share timestamp {instant}; give same-instant \
                     rows distinct created_at values so their fold order is explicit",
                    other, activity.id
                ));
            }
        }
        for quote in &self.quotes {
            if !asset_ids.contains(quote.asset.as_str()) {
                return Err(format!("quote references unknown asset {:?}", quote.asset));
            }
        }
        for observed in &self.observed_snapshots {
            if !account_ids.contains(observed.account.as_str()) {
                return Err(format!(
                    "observed snapshot references unknown account {:?}",
                    observed.account
                ));
            }
            for position in &observed.positions {
                if !asset_ids.contains(position.asset.as_str()) {
                    return Err(format!(
                        "observed snapshot references unknown asset {:?}",
                        position.asset
                    ));
                }
            }
        }
        for step in &self.lifecycle {
            for activity in step.add_activities.iter().chain(&step.update_activities) {
                if !account_ids.contains(activity.account.as_str()) {
                    return Err(format!(
                        "step {:?}: activity {:?} references unknown account {:?}",
                        step.label, activity.id, activity.account
                    ));
                }
                if let Some(asset) = &activity.asset {
                    if !asset_ids.contains(asset.as_str()) {
                        return Err(format!(
                            "step {:?}: activity {:?} references unknown asset {:?}",
                            step.label, activity.id, asset
                        ));
                    }
                }
                parse_instant(&activity.date)
                    .map_err(|error| format!("step {:?}: {error}", step.label))?;
            }
            for activity in &step.add_activities {
                if !activity_ids.insert(activity.id.as_str()) {
                    return Err(format!(
                        "step {:?}: adds duplicate activity id {:?}",
                        step.label, activity.id
                    ));
                }
            }
            for activity in &step.update_activities {
                if !activity_ids.contains(activity.id.as_str()) {
                    return Err(format!(
                        "step {:?}: updates unknown activity {:?}",
                        step.label, activity.id
                    ));
                }
            }
            for id in &step.remove_activities {
                if !activity_ids.remove(id.as_str()) {
                    return Err(format!(
                        "step {:?}: removes unknown activity {:?}",
                        step.label, id
                    ));
                }
            }
            let mode_ok = |mode: &str| {
                matches!(
                    mode,
                    "FULL" | "SINCE_DATE" | "INCREMENTAL_FROM_LAST" | "NONE"
                )
            };
            if !mode_ok(&step.recalc.snapshots) || !mode_ok(&step.recalc.valuations) {
                return Err(format!("step {:?}: unknown recalc mode", step.label));
            }
            if (step.recalc.snapshots == "SINCE_DATE" || step.recalc.valuations == "SINCE_DATE")
                && step.recalc.since.is_none()
            {
                return Err(format!("step {:?}: SINCE_DATE needs `since`", step.label));
            }
        }
        for window in &self.performance_windows {
            for account in window.accounts.iter().flatten() {
                if !account_ids.contains(account.as_str()) {
                    return Err(format!(
                        "performance window {:?} references unknown account {:?}",
                        window.label, account
                    ));
                }
            }
        }
        Ok(())
    }

    /// The facts after the first `steps` lifecycle steps: activities added,
    /// replaced or removed (stamped with the step's `as_of`), quotes and FX
    /// rows added, and `as_of` advanced. The coordinator's lifecycle runner
    /// compares an incrementally maintained projection against a fresh run
    /// over these facts.
    pub fn facts_after(&self, steps: usize) -> ScenarioFacts {
        let mut facts = self.facts();
        let accounts = facts.accounts.clone();
        let assets = facts.assets.clone();
        let account_currency: HashMap<&str, &str> = accounts
            .iter()
            .map(|account| (account.id.as_str(), account.currency.as_str()))
            .collect();
        let asset_by_id: HashMap<&str, &Asset> = assets
            .iter()
            .map(|asset| (asset.id.as_str(), asset))
            .collect();
        let lookup = FactLookup {
            account_currency: &account_currency,
            asset_by_id: &asset_by_id,
        };
        for step in self.lifecycle.iter().take(steps) {
            if let Some(as_of) = step.as_of {
                facts.as_of = as_of;
            }
            let stamp = Some(as_of_instant(facts.as_of, &facts.timezone));
            facts
                .activities
                .retain(|a| !step.remove_activities.contains(&a.id));
            for spec in &step.update_activities {
                let replacement = lookup.activity(spec, stamp);
                if let Some(slot) = facts.activities.iter_mut().find(|a| a.id == spec.id) {
                    *slot = replacement;
                }
            }
            facts.activities.extend(
                step.add_activities
                    .iter()
                    .map(|spec| lookup.activity(spec, stamp)),
            );
            for spec in &step.add_quotes {
                let quote = lookup.quote(spec);
                facts.quotes.retain(|q| {
                    !(q.asset_id == quote.asset_id
                        && q.timestamp.date_naive() == quote.timestamp.date_naive())
                });
                facts.quotes.push(quote);
            }
            facts
                .fx_rates
                .extend(step.add_fx_rates.iter().map(fx_rate_from_spec));
        }
        facts
    }

    pub fn facts(&self) -> ScenarioFacts {
        let as_of = self.policy.as_of;
        let stamp: NaiveDateTime = as_of.and_time(NaiveTime::MIN);
        let stamp_utc: DateTime<Utc> = Utc.from_utc_datetime(&stamp);

        let accounts: Vec<Account> = self
            .accounts
            .iter()
            .map(|spec| Account {
                id: spec.id.clone(),
                name: spec.name.clone().unwrap_or_else(|| spec.id.clone()),
                account_type: spec.account_type.clone(),
                group: None,
                currency: spec.currency.clone(),
                is_default: false,
                is_active: true,
                created_at: stamp,
                updated_at: stamp,
                platform_id: None,
                account_number: None,
                meta: None,
                provider: None,
                provider_account_id: None,
                is_archived: spec.is_archived,
                tracking_mode: parse_enum(&spec.tracking_mode, "tracking_mode"),
            })
            .collect();
        let account_currency: HashMap<&str, &str> = accounts
            .iter()
            .map(|account| (account.id.as_str(), account.currency.as_str()))
            .collect();

        let assets: Vec<Asset> = self
            .assets
            .iter()
            .map(|spec| {
                let symbol = spec.symbol.clone().unwrap_or_else(|| spec.id.clone());
                let instrument_type: Option<InstrumentType> = (spec.instrument_type != "NONE")
                    .then(|| parse_enum(&spec.instrument_type, "instrument_type"));
                let kind: AssetKind = parse_enum(&spec.kind, "kind");
                let quote_mode: QuoteMode = parse_enum(&spec.quote_mode, "quote_mode");
                Asset {
                    id: spec.id.clone(),
                    kind,
                    name: spec.name.clone().or_else(|| Some(symbol.clone())),
                    display_code: Some(symbol.clone()),
                    notes: None,
                    metadata: spec.contract_multiplier.map(
                        |multiplier| json!({ "contractMultiplier": multiplier.0.to_string() }),
                    ),
                    is_active: true,
                    quote_mode,
                    quote_ccy: spec.quote_ccy.clone(),
                    instrument_type,
                    instrument_symbol: Some(symbol.clone()),
                    instrument_exchange_mic: None,
                    instrument_key: None,
                    provider_config: None,
                    exchange_name: None,
                    created_at: stamp,
                    updated_at: stamp,
                }
            })
            .collect();
        let asset_by_id: HashMap<&str, &Asset> = assets
            .iter()
            .map(|asset| (asset.id.as_str(), asset))
            .collect();

        let lookup = FactLookup {
            account_currency: &account_currency,
            asset_by_id: &asset_by_id,
        };
        let activities: Vec<Activity> = self
            .activities
            .iter()
            .map(|spec| lookup.activity(spec, None))
            .collect();
        let quotes: Vec<Quote> = self.quotes.iter().map(|spec| lookup.quote(spec)).collect();
        let fx_rates: Vec<ExchangeRate> = self.fx_rates.iter().map(fx_rate_from_spec).collect();

        let observed_snapshots: Vec<AccountStateSnapshot> = self
            .observed_snapshots
            .iter()
            .map(|spec| {
                let currency = account_currency[spec.account.as_str()].to_string();
                let inception = midnight_utc(spec.date);
                let mut positions = HashMap::new();
                let mut cost_basis = Decimal::ZERO;
                for holding in &spec.positions {
                    let asset = asset_by_id[holding.asset.as_str()];
                    let mut position = Position::new_with_alternative_flag(
                        spec.account.clone(),
                        asset.id.clone(),
                        asset.quote_ccy.clone(),
                        inception,
                        asset.is_alternative(),
                        asset.contract_multiplier(),
                    );
                    position.quantity = holding.quantity.0;
                    position.average_cost = holding.average_cost.map(|d| d.0).unwrap_or_default();
                    position.total_cost_basis = position.quantity * position.average_cost;
                    cost_basis += position.total_cost_basis;
                    positions.insert(asset.id.clone(), position);
                }
                let cash_balances: HashMap<String, Decimal> = spec
                    .cash
                    .iter()
                    .map(|(ccy, amount)| (ccy.clone(), amount.0))
                    .collect();
                let cash_in_account_currency: Decimal = cash_balances
                    .iter()
                    .filter(|(ccy, _)| ccy.as_str() == currency)
                    .map(|(_, amount)| *amount)
                    .sum();
                AccountStateSnapshot {
                    id: AccountStateSnapshot::stable_id(&spec.account, spec.date),
                    account_id: spec.account.clone(),
                    snapshot_date: spec.date,
                    currency,
                    positions,
                    cash_balances,
                    cost_basis,
                    net_contribution: Decimal::ZERO,
                    net_contribution_base: Decimal::ZERO,
                    cash_total_account_currency: cash_in_account_currency,
                    cash_total_base_currency: Decimal::ZERO,
                    calculated_at: stamp_utc.naive_utc(),
                    source: parse_enum::<SnapshotSource>(&spec.source, "source"),
                }
            })
            .collect();

        ScenarioFacts {
            base_currency: self.policy.base_currency.clone(),
            timezone: self.policy.timezone.clone(),
            as_of,
            accounts,
            assets,
            activities,
            quotes,
            fx_rates,
            observed_snapshots,
        }
    }
}

/// Reference data a spec needs to become a domain row.
pub struct FactLookup<'a> {
    pub account_currency: &'a HashMap<&'a str, &'a str>,
    pub asset_by_id: &'a HashMap<&'a str, &'a Asset>,
}

impl FactLookup<'_> {
    /// `stamp` overrides `created_at`/`updated_at` (the edit instant of a
    /// lifecycle step); baseline rows are stamped with their own date.
    pub fn activity(&self, spec: &ActivitySpec, stamp: Option<DateTime<Utc>>) -> Activity {
        let activity_date = parse_instant(&spec.date).expect("validated");
        let default_stamp = stamp.unwrap_or(activity_date);
        let updated_at = spec
            .updated_at
            .as_deref()
            .map(|raw| parse_instant(raw).expect("validated updated_at"))
            .unwrap_or(default_stamp);
        let currency = spec
            .currency
            .clone()
            .unwrap_or_else(|| self.account_currency[spec.account.as_str()].to_string());
        Activity {
            id: spec.id.clone(),
            account_id: spec.account.clone(),
            asset_id: spec.asset.clone(),
            activity_type: spec.activity_type.clone(),
            activity_type_override: spec.activity_type_override.clone(),
            source_type: None,
            subtype: spec.subtype.clone(),
            status: parse_enum::<ActivityStatus>(&spec.status, "status"),
            activity_date,
            settlement_date: None,
            quantity: spec.quantity.map(|d| d.0),
            unit_price: spec.unit_price.map(|d| d.0),
            amount: spec.amount.map(|d| d.0),
            fee: spec.fee.map(|d| d.0),
            tax: spec.tax.map(|d| d.0),
            currency,
            fx_rate: spec.fx_rate.map(|d| d.0),
            notes: None,
            metadata: spec.metadata.clone(),
            source_system: spec.source_system.clone(),
            source_record_id: None,
            source_group_id: spec.source_group_id.clone(),
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: spec.is_user_modified,
            needs_review: false,
            created_at: spec
                .created_at
                .as_deref()
                .map(|s| parse_instant(s).expect("validated"))
                .unwrap_or(default_stamp),
            updated_at,
        }
    }

    pub fn quote(&self, spec: &QuoteSpec) -> Quote {
        let timestamp = midnight_utc(spec.day);
        let currency = spec
            .currency
            .clone()
            .unwrap_or_else(|| self.asset_by_id[spec.asset.as_str()].quote_ccy.clone());
        Quote {
            id: format!("{}_{}_{}", spec.asset, spec.day, spec.source),
            asset_id: spec.asset.clone(),
            timestamp,
            open: spec.close.0,
            high: spec.close.0,
            low: spec.close.0,
            close: spec.close.0,
            adjclose: spec.close.0,
            volume: Decimal::ZERO,
            currency,
            data_source: spec.source.clone(),
            created_at: timestamp,
            notes: None,
        }
    }
}

pub fn fx_rate_from_spec(spec: &FxRateSpec) -> ExchangeRate {
    ExchangeRate {
        id: format!("fx-{}-{}", spec.from, spec.to),
        from_currency: spec.from.clone(),
        to_currency: spec.to.clone(),
        rate: spec.rate.0,
        source: spec.source.clone(),
        timestamp: midnight_utc(spec.day),
    }
}

/// RFC 3339 instant, or `YYYY-MM-DD` meaning noon UTC (safe for every
/// policy timezone between UTC−11 and UTC+11).
pub fn parse_instant(raw: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(instant) = DateTime::parse_from_rfc3339(raw) {
        return Ok(instant.with_timezone(&Utc));
    }
    let date = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|error| format!("unparseable date {raw:?}: {error}"))?;
    Ok(Utc.from_utc_datetime(&date.and_time(NaiveTime::from_hms_opt(12, 0, 0).unwrap())))
}

pub fn midnight_utc(day: NaiveDate) -> DateTime<Utc> {
    Utc.from_utc_datetime(&day.and_time(NaiveTime::MIN))
}

/// Parses SCREAMING_SNAKE enum codes through the model's own serde names.
fn parse_enum<T: DeserializeOwned>(raw: &str, field: &str) -> T {
    serde_json::from_value(Value::String(raw.trim().to_ascii_uppercase()))
        .unwrap_or_else(|error| panic!("invalid {field} {raw:?}: {error}"))
}

impl TrackingMode {}
