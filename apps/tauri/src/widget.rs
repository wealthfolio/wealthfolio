//! Home-screen and desktop widget snapshot (iOS and macOS).
//!
//! After each portfolio update the app writes a small, totals-only snapshot
//! into the App Group folder that the WidgetKit extension reads. The widget
//! never opens the database. Each section comes from the same reads as the
//! screen it mirrors (Dashboard, Net Worth, Spending), so the numbers agree.
//! Other platforms write nothing.
//!
//! The top holdings carry symbols, names, today's change and logos, but no
//! amounts or quantities.

use std::sync::Mutex;

use base64::Engine;
use chrono::{DateTime, Datelike, Days, Months, NaiveDate, NaiveTime, TimeZone, Utc};
use rust_decimal::{prelude::ToPrimitive, Decimal};
use serde::Serialize;
use tauri::AppHandle;
use wealthfolio_core::{
    assets::InstrumentType,
    holdings::{Holding, HoldingType},
    performance::{PerformanceResult, PerformanceSummaryProfile, PerformanceSummaryStatus},
    portfolios::AccountScope,
    utils::{
        occ_symbol::parse_occ_symbol,
        time_utils::{parse_user_timezone_or_default, user_today},
    },
    valuation::{CurrentValuationResponse, DailyAccountValuation, ValuationStatus},
};
use wealthfolio_spending::analytics::{DayBucket, ReportRequest};

use crate::{
    commands::portfolio::{
        current_valuation_for_scope, get_holdings_for_filter, historical_valuations_for_scope,
        performance_summary_for_scope,
    },
    context::ServiceContext,
};

/// Bumped when the snapshot's shape changes; the widget ignores other versions.
const SNAPSHOT_VERSION: u32 = 3;
/// Holdings shown by the Top Holdings widget's largest size.
const TOP_HOLDINGS: usize = 6;
/// The lines cover the app's "1M" period: one calendar month back to today.
fn month_ago(today: NaiveDate) -> NaiveDate {
    today.checked_sub_months(Months::new(1)).unwrap_or(today)
}

/// The last JSON handed to the widget (`""` after a clear), so an unchanged
/// snapshot neither rewrites the file nor spends WidgetKit's reload budget.
static LAST_PUBLISHED: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSnapshot {
    pub version: u32,
    pub currency: String,
    /// The app's "Gain and loss colours" setting (`green-up`, `red-up`,
    /// `red-up-blue-down`), so the widget colours changes as the app does.
    pub gain_colors: String,
    pub as_of: DateTime<Utc>,
    pub investments: Option<InvestmentsSection>,
    pub net_worth: Option<NetWorthSection>,
    pub spending: Option<SpendingSection>,
    /// The Dashboard's Top Holdings, largest first.
    pub top_holdings: Vec<TopHolding>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopHolding {
    /// As the Dashboard labels it: an option's underlying, else the symbol
    /// before any exchange suffix.
    pub symbol: String,
    pub name: Option<String>,
    /// A fraction: 0.0123 is 1.23%.
    pub day_change_percent: Option<f64>,
    /// A PNG, base64-encoded: the asset's custom logo, else the bundled one.
    pub logo: Option<String>,
}

/// The Dashboard headline: current total and its 1D change.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentsSection {
    pub total: f64,
    pub day_change: Option<f64>,
    /// A fraction: 0.0123 is 1.23%.
    pub day_change_percent: Option<f64>,
    pub history: Vec<HistoryPoint>,
}

/// The Net Worth page headline over its "1M" period.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthSection {
    pub total: f64,
    /// Change from the first to the last point of `history`, as the page shows it.
    pub change: Option<f64>,
    /// A fraction, only for a positive start and a nonnegative end, as on the page.
    pub change_percent: Option<f64>,
    pub history: Vec<HistoryPoint>,
}

/// This calendar month on the Spending tab.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendingSection {
    pub spent: f64,
    /// Every day of the month; days after today carry `None`.
    pub days: Vec<SpendingDay>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendingDay {
    pub date: NaiveDate,
    pub amount: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub date: NaiveDate,
    pub value: f64,
}

fn display_value(value: Decimal) -> f64 {
    value.to_f64().unwrap_or_default()
}

/// Shapes the Dashboard's reads. `None` when there are no accounts.
fn investments_from_parts(
    current: &CurrentValuationResponse,
    day: Option<&PerformanceResult>,
    history: &[DailyAccountValuation],
) -> Option<InvestmentsSection> {
    let summary = &current.summary;
    if summary.account_count == 0 {
        return None;
    }
    // Same rules as the Dashboard: a gain or return only when it is complete,
    // and no line point for a day the engine could not value.
    let day_summary = day.map(|result| &result.summary);
    let day_change = day_summary
        .filter(|s| s.amount_status == PerformanceSummaryStatus::Complete)
        .and_then(|s| s.amount)
        .map(display_value);
    let day_change_percent = day_summary
        .filter(|s| s.percent_status == PerformanceSummaryStatus::Complete)
        .and_then(|s| s.percent)
        .map(display_value);
    let history = history
        .iter()
        .filter(|point| point.value_status != ValuationStatus::Unavailable)
        .map(|point| HistoryPoint {
            date: point.valuation_date,
            value: display_value(point.total_value_base),
        })
        .collect();

    Some(InvestmentsSection {
        total: display_value(summary.total_value_base),
        day_change,
        day_change_percent,
        history,
    })
}

/// Shapes the Net Worth page's reads. `None` when nothing is tracked.
fn net_worth_from_parts(
    total: Decimal,
    has_anything: bool,
    history: Vec<HistoryPoint>,
) -> Option<NetWorthSection> {
    if !has_anything {
        return None;
    }
    let (change, change_percent) = match (history.first(), history.last()) {
        (Some(first), Some(last)) if history.len() >= 2 => {
            // The Net Worth page's rule: a percent needs a start of at least
            // 1 that is positive, and an end that isn't negative.
            let change = last.value - first.value;
            let percent = (first.value >= 1.0 && last.value >= 0.0).then(|| change / first.value);
            (Some(change), percent)
        }
        _ => (None, None),
    };
    Some(NetWorthSection {
        total: display_value(total),
        change,
        change_percent,
        history,
    })
}

/// Every day of `today`'s month, with the report's outflow up to today.
fn spending_from_parts(spent: f64, by_day: &[DayBucket], today: NaiveDate) -> SpendingSection {
    let first = today.with_day(1).unwrap_or(today);
    let days = first
        .iter_days()
        .take_while(|date| date.month() == first.month())
        .map(|date| SpendingDay {
            date,
            amount: (date <= today).then(|| {
                let key = date.to_string();
                by_day
                    .iter()
                    .filter(|bucket| bucket.date == key)
                    // A fold from 0.0: an empty f64 `sum()` is -0.0.
                    .fold(0.0, |total, bucket| total + bucket.outflow)
            }),
        })
        .collect();
    SpendingSection { spent, days }
}

/// The Dashboard's Top Holdings: no cash or alternative assets, largest value
/// first.
fn pick_top_holdings(holdings: &[Holding]) -> Vec<&Holding> {
    let mut picked: Vec<&Holding> = holdings
        .iter()
        .filter(|holding| holding.holding_type != HoldingType::Cash)
        .filter(|holding| {
            !holding
                .asset_kind
                .as_ref()
                .is_some_and(|kind| kind.is_alternative())
        })
        .collect();
    picked.sort_by_key(|holding| std::cmp::Reverse(holding.market_value.base.unwrap_or_default()));
    picked.truncate(TOP_HOLDINGS);
    picked
}

/// The Dashboard row's label for a symbol.
fn holding_label(symbol: &str) -> String {
    match parse_occ_symbol(symbol) {
        Ok(option) => option.underlying,
        Err(_) => symbol.split('.').next().unwrap_or(symbol).to_string(),
    }
}

/// Bundled logo pack filenames for an asset, best match first.
///
/// A port of `resolveTickerLogoFilenames` in `packages/ui/src/lib/ticker-logo.ts`;
/// keep the two in step. The tests below repeat that function's own cases.
fn ticker_logo_filenames(symbol: &str, exchange_mic: Option<&str>, crypto: bool) -> Vec<String> {
    let normalized = symbol.trim().to_uppercase();
    let allowed = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit() || "$^._:-".contains(c);
    if normalized.is_empty()
        || normalized.contains("..")
        || normalized.contains('/')
        || normalized.contains('\\')
        || !normalized.chars().all(allowed)
    {
        return Vec::new();
    }
    let file_symbol = |value: &str| {
        let mut out = String::with_capacity(value.len());
        for c in value.chars() {
            let c = if ".^_:".contains(c) { '-' } else { c };
            if !(c == '-' && out.ends_with('-')) {
                out.push(c);
            }
        }
        out
    };
    // `^(.*)-([A-Z0-9]{4})$`: a symbol already carrying its market code.
    let market_suffix = |value: &str| {
        value
            .rsplit_once('-')
            .filter(|(_, mic)| {
                mic.len() == 4
                    && mic
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            })
            .map(|(bare, _)| bare.to_string())
    };
    let mut names = Vec::new();
    if crypto {
        names.push(format!("crypto/{}", file_symbol(&normalized)));
        // `^(.+)-([A-Z]{3,5})$`: a pair such as BTC-USD.
        if let Some((base, _)) = normalized.rsplit_once('-').filter(|(base, quote)| {
            !base.is_empty()
                && (3..=5).contains(&quote.len())
                && quote.chars().all(|c| c.is_ascii_uppercase())
        }) {
            names.push(format!("crypto/{}", file_symbol(base)));
        }
    } else {
        let exact = if market_suffix(&normalized).is_some() {
            normalized.clone()
        } else {
            let mic = exchange_mic
                .map(|mic| mic.trim().to_uppercase())
                .filter(|mic| mic.len() == 4 && mic.chars().all(|c| c.is_ascii_alphanumeric()));
            match mic {
                Some(mic) => format!("{}-{mic}", file_symbol(&normalized)),
                None => file_symbol(&normalized),
            }
        };
        names.push(exact.clone());
        // Provider suffixes such as `.TO` map to the pack's market codes.
        if let Some((base, suffix)) = normalized
            .rsplit_once('.')
            .filter(|(base, suffix)| !base.is_empty() && !suffix.is_empty())
        {
            let mic = match suffix {
                "AS" => Some("XAMS"),
                "AX" => Some("XASX"),
                "DE" => Some("XETR"),
                "L" => Some("XLON"),
                "NZ" => Some("XNZE"),
                "PA" => Some("XPAR"),
                "T" => Some("XTKS"),
                "TO" => Some("XTSE"),
                _ => None,
            };
            let base = file_symbol(base);
            if let (Some(mic), false) = (mic, base.is_empty()) {
                names.push(format!("{base}-{mic}"));
                names.push(base);
            }
        }
        names.push(market_suffix(&exact).unwrap_or_else(|| file_symbol(&normalized)));
    }
    let mut unique = Vec::new();
    for name in names {
        if !name.is_empty() && !unique.contains(&name) {
            unique.push(name);
        }
    }
    unique
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The asset's custom logo, else its bundled one. Tauri answers a missing
/// bundled file with `index.html`, so only real PNGs count.
fn holding_logo(
    app_handle: &AppHandle,
    context: &ServiceContext,
    holding: &Holding,
) -> Option<String> {
    let instrument = holding.instrument.as_ref()?;
    if let Ok(Some(logo)) = context.asset_logo_service().get_asset_logo(&instrument.id) {
        return Some(logo.data_base64);
    }
    let symbol = parse_occ_symbol(&instrument.symbol)
        .map(|option| option.underlying)
        .unwrap_or_else(|_| instrument.symbol.clone());
    let crypto = instrument.instrument_type == Some(InstrumentType::Crypto);
    let resolver = app_handle.asset_resolver();
    ticker_logo_filenames(&symbol, instrument.exchange_mic.as_deref(), crypto)
        .into_iter()
        .find_map(|name| {
            resolver
                .get(format!("/ticker-logos/{name}.png"))
                .filter(|asset| asset.bytes().starts_with(PNG_SIGNATURE))
        })
        .map(|asset| base64::engine::general_purpose::STANDARD.encode(asset.bytes()))
}

async fn build_top_holdings(app_handle: &AppHandle, context: &ServiceContext) -> Vec<TopHolding> {
    let Ok(holdings) = get_holdings_for_filter(context, AccountScope::All, false).await else {
        return Vec::new();
    };
    pick_top_holdings(&holdings)
        .into_iter()
        .filter_map(|holding| {
            let instrument = holding.instrument.as_ref()?;
            Some(TopHolding {
                symbol: holding_label(&instrument.symbol),
                name: instrument
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
                day_change_percent: holding.day_change_pct.map(display_value),
                logo: holding_logo(app_handle, context, holding),
            })
        })
        .collect()
}

async fn build_investments(
    context: &ServiceContext,
    today: NaiveDate,
) -> Result<Option<InvestmentsSection>, String> {
    let scope = AccountScope::All;
    let current = current_valuation_for_scope(context, &scope, false).await?;
    // The Dashboard's "1D" period: yesterday to today.
    let day = performance_summary_for_scope(
        context,
        &scope,
        today.checked_sub_days(Days::new(1)),
        Some(today),
        PerformanceSummaryProfile::Dashboard,
    )
    .await
    .ok();
    let history =
        historical_valuations_for_scope(context, &scope, Some(month_ago(today)), Some(today))
            .await
            .unwrap_or_default();
    Ok(investments_from_parts(&current, day.as_ref(), &history))
}

async fn build_net_worth(
    context: &ServiceContext,
    today: NaiveDate,
) -> Result<Option<NetWorthSection>, String> {
    let service = context.net_worth_service();
    let current = service
        .get_net_worth(today)
        .await
        .map_err(|e| e.to_string())?;
    let history = service
        .get_net_worth_history(month_ago(today), today)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|point| HistoryPoint {
            date: point.date,
            value: display_value(point.net_worth),
        })
        .collect();
    let has_anything = !current.assets.total.is_zero() || !current.liabilities.total.is_zero();
    Ok(net_worth_from_parts(
        current.net_worth,
        has_anything,
        history,
    ))
}

async fn build_spending(
    context: &ServiceContext,
    today: NaiveDate,
    timezone: &str,
) -> Result<Option<SpendingSection>, String> {
    let settings = context
        .spending_settings_service()
        .get()
        .await
        .map_err(|e| e.to_string())?;
    if !settings.enabled || settings.account_ids.is_empty() {
        return Ok(None);
    }
    // The Spending tab's month: local midnight on the 1st to the month's last
    // second, in the user's timezone.
    let tz = parse_user_timezone_or_default(timezone);
    let first = today.with_day(1).unwrap_or(today);
    let next = first.checked_add_months(Months::new(1)).unwrap_or(first);
    let local = |date: NaiveDate| {
        tz.from_local_datetime(&date.and_time(NaiveTime::MIN))
            .earliest()
            .map(|at| at.with_timezone(&Utc))
    };
    let (Some(start), Some(end)) = (local(first), local(next)) else {
        return Ok(None);
    };
    let end = end - chrono::Duration::milliseconds(1);
    let report = context
        .spending_analytics_service()
        .monthly_report(
            ReportRequest {
                start_date: start.to_rfc3339(),
                end_date: end.to_rfc3339(),
                account_ids: None,
            },
            timezone,
            &context.get_base_currency(),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(spending_from_parts(
        report.current.outflow,
        &report.by_day,
        today,
    )))
}

async fn build_snapshot(
    app_handle: &AppHandle,
    context: &ServiceContext,
) -> Result<Option<WidgetSnapshot>, String> {
    let currency = context.get_base_currency();
    if currency.trim().is_empty() {
        return Ok(None);
    }
    let timezone = context.get_timezone();
    let today = user_today(parse_user_timezone_or_default(&timezone));

    // One section failing leaves the others showing.
    let investments = build_investments(context, today).await.ok().flatten();
    let net_worth = build_net_worth(context, today).await.ok().flatten();
    let spending = build_spending(context, today, &timezone)
        .await
        .ok()
        .flatten();
    if investments.is_none() && net_worth.is_none() && spending.is_none() {
        return Ok(None);
    }
    let top_holdings = if investments.is_some() {
        build_top_holdings(app_handle, context).await
    } else {
        Vec::new()
    };
    let gain_colors = context
        .settings_service()
        .get_settings()
        .map(|settings| settings.gain_colors)
        .unwrap_or_default();

    Ok(Some(WidgetSnapshot {
        version: SNAPSHOT_VERSION,
        currency,
        gain_colors,
        as_of: Utc::now(),
        investments,
        net_worth,
        spending,
        top_holdings,
    }))
}

/// Records `json` as published. False when it equals the last one, ignoring
/// `asOf`, which changes on every build.
fn mark_published(json: &str) -> bool {
    let Ok(mut last) = LAST_PUBLISHED.lock() else {
        return true;
    };
    if last.as_deref() == Some(json) {
        return false;
    }
    *last = Some(json.to_string());
    true
}

fn forget_published() {
    if let Ok(mut last) = LAST_PUBLISHED.lock() {
        *last = None;
    }
}

/// Rebuilds the snapshot and hands it to the widget. Never fails the caller:
/// the widget is a convenience, and the portfolio update has already finished.
pub async fn publish(app_handle: &AppHandle, context: &ServiceContext) {
    if !cfg!(any(target_os = "ios", target_os = "macos")) {
        return;
    }
    let snapshot = match build_snapshot(app_handle, context).await {
        Ok(snapshot) => snapshot,
        Err(_) => {
            log::warn!("Widget snapshot could not be built");
            return;
        }
    };
    let Some(snapshot) = snapshot else {
        clear();
        return;
    };
    // Compare without the timestamp, so an update that changed nothing
    // neither rewrites the file nor reloads the widget.
    let unchanged_key = serde_json::to_string(&WidgetSnapshot {
        as_of: DateTime::<Utc>::UNIX_EPOCH,
        ..snapshot.clone()
    });
    let (Ok(key), Ok(json)) = (unchanged_key, serde_json::to_string(&snapshot)) else {
        log::warn!("Widget snapshot could not be encoded");
        return;
    };
    if !mark_published(&key) {
        return;
    }
    if !platform::write(&json) {
        log::warn!("Widget snapshot could not be written");
        // Let the next update try again.
        forget_published();
    }
}

/// Removes the snapshot, so a locked or deleted profile shows nothing.
pub fn clear() {
    if !cfg!(any(target_os = "ios", target_os = "macos")) || !mark_published("") {
        return;
    }
    if !platform::clear() {
        log::warn!("Widget snapshot could not be removed");
        forget_published();
    }
}

/// The Swift side is `widget-bridge/Sources/WidgetBridge/WidgetSnapshotBridge.swift`:
/// compiled into the iOS app target, and linked into the macOS app by swift-rs.
#[cfg(any(target_os = "ios", target_os = "macos"))]
#[allow(unsafe_code, reason = "the widget bridge is a C ABI exported by Swift")]
mod platform {
    use std::ffi::{c_char, CString};

    extern "C" {
        fn wf_widget_write_snapshot(json: *const c_char) -> i32;
        fn wf_widget_clear_snapshot() -> i32;
    }

    pub fn write(json: &str) -> bool {
        let Ok(json) = CString::new(json) else {
            return false;
        };
        // SAFETY: `json` is a NUL-terminated string that outlives the call;
        // Swift copies it before returning.
        unsafe { wf_widget_write_snapshot(json.as_ptr()) == 0 }
    }

    pub fn clear() -> bool {
        // SAFETY: takes no arguments and only touches the App Group folder.
        unsafe { wf_widget_clear_snapshot() == 0 }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
mod platform {
    pub fn write(_json: &str) -> bool {
        true
    }

    pub fn clear() -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wealthfolio_core::{
        performance::PerformanceSummary,
        valuation::{CurrentValuationResponse, CurrentValuationSummary},
    };

    fn d(value: &str) -> Decimal {
        value.parse().unwrap()
    }

    fn date(value: &str) -> NaiveDate {
        value.parse().unwrap()
    }

    fn calculated_at() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 11, 15, 0, 0).unwrap()
    }

    fn current(total: Decimal, accounts: usize) -> CurrentValuationResponse {
        CurrentValuationResponse {
            summary: CurrentValuationSummary {
                scope_id: "all".into(),
                base_currency: "CAD".into(),
                cash_balance_base: Decimal::ZERO,
                investment_market_value_base: total,
                total_value_base: total,
                holdings_count: 1,
                account_count: accounts,
                currency_split: Vec::new(),
                cash_currency_split: Vec::new(),
                source_data_as_of: None,
                calculated_at: calculated_at(),
                warnings: Vec::new(),
            },
            accounts: Vec::new(),
        }
    }

    fn day(amount: Option<Decimal>, percent: Option<Decimal>, complete: bool) -> PerformanceResult {
        let status = if complete {
            PerformanceSummaryStatus::Complete
        } else {
            PerformanceSummaryStatus::Unavailable
        };
        let mut result = wealthfolio_core::performance::empty_performance_metrics(
            "all",
            "CAD".into(),
            None,
            None,
        );
        result.summary = PerformanceSummary {
            amount,
            percent,
            amount_status: status,
            percent_status: status,
            ..PerformanceSummary::default()
        };
        result
    }

    fn valuation(on: &str, total: Decimal, status: ValuationStatus) -> DailyAccountValuation {
        DailyAccountValuation {
            id: on.into(),
            account_id: "acc".into(),
            valuation_date: date(on),
            account_currency: "CAD".into(),
            base_currency: "CAD".into(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance: Decimal::ZERO,
            investment_market_value: total,
            total_value: total,
            cost_basis: Decimal::ZERO,
            book_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            cash_balance_base: Decimal::ZERO,
            investment_market_value_base: total,
            total_value_base: total,
            cost_basis_base: Decimal::ZERO,
            book_basis_base: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            external_flow_source: Default::default(),
            performance_eligible_value_base: total,
            value_status: status,
            basis_status: Default::default(),
            calculated_at: calculated_at(),
        }
    }

    fn point(on: &str, value: f64) -> HistoryPoint {
        HistoryPoint {
            date: date(on),
            value,
        }
    }

    #[test]
    fn no_accounts_means_no_investments() {
        assert_eq!(
            investments_from_parts(&current(Decimal::ZERO, 0), None, &[]),
            None
        );
    }

    #[test]
    fn investments_carry_the_dashboard_total_and_complete_day_change() {
        let section = investments_from_parts(
            &current(d("1250.50"), 2),
            Some(&day(Some(d("12.5")), Some(d("0.01")), true)),
            &[],
        )
        .unwrap();
        assert_eq!(section.total, 1250.5);
        assert_eq!(section.day_change, Some(12.5));
        assert_eq!(section.day_change_percent, Some(0.01));
    }

    #[test]
    fn investments_drop_an_incomplete_day_change() {
        let section = investments_from_parts(
            &current(d("10"), 1),
            Some(&day(Some(d("1")), Some(d("0.1")), false)),
            &[],
        )
        .unwrap();
        assert_eq!(section.day_change, None);
        assert_eq!(section.day_change_percent, None);
    }

    #[test]
    fn investments_leave_unvalued_days_off_the_line() {
        let history = [
            valuation("2026-11-09", d("100"), ValuationStatus::Complete),
            valuation("2026-11-10", d("0"), ValuationStatus::Unavailable),
            valuation("2026-11-11", d("105"), ValuationStatus::PartialUnpriced),
        ];
        let section = investments_from_parts(&current(d("105"), 1), None, &history).unwrap();
        let dates: Vec<String> = section.history.iter().map(|p| p.date.to_string()).collect();
        assert_eq!(dates, ["2026-11-09", "2026-11-11"]);
    }

    #[test]
    fn net_worth_change_runs_first_to_last_point() {
        let section = net_worth_from_parts(
            d("1200"),
            true,
            vec![point("2026-10-13", 1000.0), point("2026-11-11", 1200.0)],
        )
        .unwrap();
        assert_eq!(section.total, 1200.0);
        assert_eq!(section.change, Some(200.0));
        assert_eq!(section.change_percent, Some(0.2));
    }

    #[test]
    fn net_worth_percent_needs_a_positive_start() {
        let section = net_worth_from_parts(
            d("50"),
            true,
            vec![point("2026-10-13", -100.0), point("2026-11-11", 50.0)],
        )
        .unwrap();
        assert_eq!(section.change, Some(150.0));
        assert_eq!(section.change_percent, None);
    }

    #[test]
    fn net_worth_is_absent_when_nothing_is_tracked() {
        assert_eq!(net_worth_from_parts(Decimal::ZERO, false, Vec::new()), None);
    }

    #[test]
    fn spending_fills_the_month_and_leaves_future_days_empty() {
        let by_day = [
            DayBucket {
                date: "2026-11-02".into(),
                income: 0.0,
                outflow: 40.0,
            },
            DayBucket {
                date: "2026-11-11".into(),
                income: 500.0,
                outflow: 12.5,
            },
        ];
        let section = spending_from_parts(52.5, &by_day, date("2026-11-11"));
        assert_eq!(section.spent, 52.5);
        assert_eq!(section.days.len(), 30);
        assert_eq!(section.days[0].amount, Some(0.0));
        assert!(section.days[0].amount.unwrap().is_sign_positive());
        assert_eq!(section.days[1].amount, Some(40.0));
        assert_eq!(section.days[10].amount, Some(12.5));
        assert_eq!(section.days[11].amount, None);
        assert_eq!(section.days[29].date, date("2026-11-30"));
    }

    #[test]
    fn serializes_the_fields_the_widget_reads() {
        let snapshot = WidgetSnapshot {
            version: SNAPSHOT_VERSION,
            currency: "CAD".into(),
            gain_colors: "green-up".into(),
            as_of: calculated_at(),
            investments: investments_from_parts(&current(d("5"), 1), None, &[]),
            net_worth: None,
            spending: Some(spending_from_parts(0.0, &[], date("2026-02-01"))),
            top_holdings: vec![TopHolding {
                symbol: "AAPL".into(),
                name: Some("Apple Inc.".into()),
                day_change_percent: Some(0.0043),
                logo: None,
            }],
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        for key in [
            "version",
            "currency",
            "gainColors",
            "asOf",
            "investments",
            "netWorth",
            "spending",
            "topHoldings",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        for key in ["symbol", "name", "dayChangePercent", "logo"] {
            assert!(json["topHoldings"][0].get(key).is_some(), "missing {key}");
        }
        for key in ["total", "dayChange", "dayChangePercent", "history"] {
            assert!(json["investments"].get(key).is_some(), "missing {key}");
        }
        assert_eq!(json["spending"]["days"].as_array().unwrap().len(), 28);
    }

    /// The cases of `resolveTickerLogoFilenames` in
    /// `apps/frontend/src/addons/iframe/ticker-logo-asset-bridge.test.ts`.
    #[test]
    fn logo_filenames_match_the_frontend_rules() {
        let names = ticker_logo_filenames;
        assert_eq!(names("SHOP-XTSE", None, false), ["SHOP-XTSE", "SHOP"]);
        assert_eq!(names("SHOP", Some("XTSE"), false), ["SHOP-XTSE", "SHOP"]);
        assert_eq!(
            names("SHOP.TO", None, false),
            ["SHOP-TO", "SHOP-XTSE", "SHOP"]
        );
        assert_eq!(
            names("HEIA.AS", None, false),
            ["HEIA-AS", "HEIA-XAMS", "HEIA"]
        );
        assert_eq!(names("BRK.B", None, false), ["BRK-B"]);
        assert_eq!(names("BRK.B", Some("XNYS"), false), ["BRK-B-XNYS", "BRK-B"]);
        assert_eq!(names("BTC", None, true), ["crypto/BTC"]);
        assert_eq!(
            names("BTC-USD", None, true),
            ["crypto/BTC-USD", "crypto/BTC"]
        );
        assert_eq!(names("aapl", None, false), ["AAPL"]);
        assert!(names("../etc", None, false).is_empty());
        assert!(names("A B", None, false).is_empty());
    }

    #[test]
    fn holding_labels_follow_the_dashboard() {
        assert_eq!(holding_label("SHOP.TO"), "SHOP");
        assert_eq!(holding_label("AAPL"), "AAPL");
        assert_eq!(holding_label("AAPL250321C00150000"), "AAPL");
    }

    #[test]
    fn an_unchanged_snapshot_is_not_published_twice() {
        let json = "{\"version\":2,\"test\":\"unchanged\"}";
        assert!(mark_published(json));
        assert!(!mark_published(json));
        assert!(mark_published(""));
    }
}
