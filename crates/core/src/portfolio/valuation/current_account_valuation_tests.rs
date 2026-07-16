use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::{HashMap, VecDeque};

use crate::{
    accounts::{Account, TrackingMode},
    assets::{Asset, AssetKind, InstrumentType, QuoteMode},
    portfolio::{
        economic_events::BasisStatus,
        snapshot::{AccountStateSnapshot, Position, SnapshotSource},
        valuation::{
            calculate_current_valuation_response_from_snapshots, filter_current_valuation_accounts,
            unique_account_ids, CurrentValuationRate, DailyAccountValuation, ExternalFlowSource,
            ValuationStatus,
        },
    },
    quotes::{LatestQuotePair, Quote},
};

fn account(id: &str, currency: &str) -> Account {
    let now =
        chrono::NaiveDateTime::parse_from_str("2026-03-17 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
    Account {
        id: id.to_string(),
        name: format!("Account {id}"),
        account_type: "SECURITIES".to_string(),
        group: None,
        currency: currency.to_string(),
        is_default: false,
        is_active: true,
        created_at: now,
        updated_at: now,
        platform_id: None,
        account_number: None,
        meta: None,
        provider: None,
        provider_account_id: None,
        is_archived: false,
        tracking_mode: TrackingMode::Transactions,
    }
}

fn asset(id: &str, kind: AssetKind) -> Asset {
    let now =
        chrono::NaiveDateTime::parse_from_str("2026-03-17 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
    Asset {
        id: id.to_string(),
        kind,
        name: Some(id.to_string()),
        display_code: Some(id.to_string()),
        quote_mode: QuoteMode::Market,
        quote_ccy: "USD".to_string(),
        created_at: now,
        updated_at: now,
        ..Default::default()
    }
}

fn position(
    account_id: &str,
    asset_id: &str,
    quantity: Decimal,
    currency: &str,
    is_alternative: bool,
) -> Position {
    let now = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    Position {
        id: format!("POS-{account_id}-{asset_id}"),
        account_id: account_id.to_string(),
        asset_id: asset_id.to_string(),
        quantity,
        average_cost: Decimal::ZERO,
        total_cost_basis: Decimal::ZERO,
        currency: currency.to_string(),
        inception_date: now,
        lots: VecDeque::new(),
        created_at: now,
        last_updated: now,
        is_alternative,
        contract_multiplier: Decimal::ONE,
    }
}

fn snapshot(
    account_id: &str,
    currency: &str,
    positions: HashMap<String, Position>,
    cash_balances: HashMap<String, Decimal>,
) -> AccountStateSnapshot {
    AccountStateSnapshot {
        id: format!("snapshot-{account_id}"),
        account_id: account_id.to_string(),
        snapshot_date: NaiveDate::from_ymd_opt(2026, 3, 17).unwrap(),
        currency: currency.to_string(),
        positions,
        cash_balances,
        cost_basis: Decimal::ZERO,
        net_contribution: Decimal::ZERO,
        net_contribution_base: Decimal::ZERO,
        cash_total_account_currency: Decimal::ZERO,
        cash_total_base_currency: Decimal::ZERO,
        calculated_at: DateTime::<Utc>::from_timestamp(1_776_476_400, 0)
            .unwrap()
            .naive_utc(),
        source: SnapshotSource::Calculated,
    }
}

fn quote_pair(asset_id: &str, close: Decimal, currency: &str) -> LatestQuotePair {
    let now = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    LatestQuotePair {
        latest: Quote {
            id: format!("{asset_id}-quote"),
            asset_id: asset_id.to_string(),
            timestamp: now,
            open: close,
            high: close,
            low: close,
            close,
            adjclose: close,
            volume: Decimal::ZERO,
            currency: currency.to_string(),
            data_source: "TEST".to_string(),
            created_at: now,
            notes: None,
        },
        previous: None,
    }
}

fn stale_daily_valuation(account_id: &str) -> DailyAccountValuation {
    DailyAccountValuation {
        id: format!("{account_id}_2026-03-17"),
        account_id: account_id.to_string(),
        valuation_date: NaiveDate::from_ymd_opt(2026, 3, 17).unwrap(),
        account_currency: "CAD".to_string(),
        base_currency: "USD".to_string(),
        fx_rate_to_base: dec!(0.8),
        cash_balance: Decimal::ZERO,
        investment_market_value: dec!(125),
        total_value: dec!(125),
        cost_basis: Decimal::ZERO,
        book_basis: Decimal::ZERO,
        net_contribution: Decimal::ZERO,
        cash_balance_base: Decimal::ZERO,
        investment_market_value_base: dec!(100),
        total_value_base: dec!(100),
        cost_basis_base: Decimal::ZERO,
        book_basis_base: Decimal::ZERO,
        net_contribution_base: Decimal::ZERO,
        external_inflow_base: Decimal::ZERO,
        external_outflow_base: Decimal::ZERO,
        external_flow_source: ExternalFlowSource::Unknown,
        performance_eligible_value_base: dec!(100),
        value_status: ValuationStatus::Complete,
        basis_status: BasisStatus::Complete,
        calculated_at: DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
    }
}

fn latest_rate(from: &str, to: &str) -> Decimal {
    match (from, to) {
        (from, to) if from == to => Decimal::ONE,
        ("USD", "CAD") => dec!(1.25),
        ("CAD", "USD") => dec!(0.8),
        ("EUR", "USD") => dec!(1.1),
        ("EUR", "CAD") => dec!(1.375),
        ("GBP", "USD") => dec!(1.25),
        _ => Decimal::ONE,
    }
}

#[test]
fn current_account_valuation_uses_latest_snapshot_positions_without_mutating_daily_valuation() {
    let account = account("acc-1", "CAD");
    let stale = stale_daily_valuation("acc-1");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_800_000_000, 0).unwrap();
    let quote_as_of = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([(
        "acc-1".to_string(),
        snapshot(
            "acc-1",
            "CAD",
            HashMap::from([
                (
                    "AAPL".to_string(),
                    position("acc-1", "AAPL", Decimal::ONE, "USD", false),
                ),
                (
                    "PROPERTY".to_string(),
                    position("acc-1", "PROPERTY", Decimal::ONE, "CAD", true),
                ),
            ]),
            HashMap::from([("CAD".to_string(), dec!(5))]),
        ),
    )]);
    let assets = HashMap::from([
        ("AAPL".to_string(), asset("AAPL", AssetKind::Investment)),
        (
            "PROPERTY".to_string(),
            asset("PROPERTY", AssetKind::Property),
        ),
    ]);
    let quotes = HashMap::from([
        ("AAPL".to_string(), quote_pair("AAPL", dec!(120), "USD")),
        (
            "PROPERTY".to_string(),
            quote_pair("PROPERTY", dec!(500), "CAD"),
        ),
    ]);

    let response = calculate_current_valuation_response_from_snapshots(
        "account:acc-1",
        &[account],
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        true,
        latest_rate,
    );
    let current = &response.accounts;

    assert_eq!(current.len(), 1);
    assert_eq!(current[0].account_id, "acc-1");
    assert_eq!(current[0].investment_market_value_base, dec!(120));
    assert_eq!(current[0].cash_balance_base, dec!(4));
    assert_eq!(current[0].total_value_base, dec!(124));
    assert_eq!(current[0].investment_market_value, dec!(150));
    assert_eq!(current[0].cash_balance, dec!(5));
    assert_eq!(current[0].total_value, dec!(155));
    assert_eq!(current[0].source_data_as_of, Some(quote_as_of));
    assert_eq!(current[0].calculated_at, calculated_at);
    assert_eq!(stale.total_value_base, dec!(100));
}

#[test]
fn current_account_valuation_includes_security_and_cash_excludes_asset_kind_alternatives() {
    let account = account("acc-1", "USD");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([(
        "acc-1".to_string(),
        snapshot(
            "acc-1",
            "USD",
            HashMap::from([
                (
                    "AAPL".to_string(),
                    position("acc-1", "AAPL", dec!(2), "USD", false),
                ),
                (
                    "HOUSE".to_string(),
                    position("acc-1", "HOUSE", Decimal::ONE, "USD", false),
                ),
            ]),
            HashMap::from([("USD".to_string(), dec!(25))]),
        ),
    )]);
    let assets = HashMap::from([
        ("AAPL".to_string(), asset("AAPL", AssetKind::Investment)),
        ("HOUSE".to_string(), asset("HOUSE", AssetKind::Property)),
    ]);
    let quotes = HashMap::from([
        ("AAPL".to_string(), quote_pair("AAPL", dec!(50), "USD")),
        ("HOUSE".to_string(), quote_pair("HOUSE", dec!(900), "USD")),
    ]);

    let response = calculate_current_valuation_response_from_snapshots(
        "account:acc-1",
        &[account],
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        true,
        latest_rate,
    );
    let current = &response.accounts;

    assert_eq!(current[0].investment_market_value_base, dec!(100));
    assert_eq!(current[0].cash_balance_base, dec!(25));
    assert_eq!(current[0].total_value_base, dec!(125));
}

#[test]
fn current_valuation_response_excludes_expired_options() {
    let account = account("acc-1", "USD");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([(
        "acc-1".to_string(),
        snapshot(
            "acc-1",
            "USD",
            HashMap::from([
                (
                    "AAPL".to_string(),
                    position("acc-1", "AAPL", dec!(2), "USD", false),
                ),
                (
                    "AAPL260316C00100000".to_string(),
                    position("acc-1", "AAPL260316C00100000", Decimal::ONE, "USD", false),
                ),
            ]),
            HashMap::from([("USD".to_string(), dec!(25))]),
        ),
    )]);
    let mut expired_option = asset("AAPL260316C00100000", AssetKind::Investment);
    expired_option.instrument_type = Some(InstrumentType::Option);
    expired_option.instrument_symbol = Some("AAPL260316C00100000".to_string());
    let assets = HashMap::from([
        ("AAPL".to_string(), asset("AAPL", AssetKind::Investment)),
        ("AAPL260316C00100000".to_string(), expired_option),
    ]);
    let quotes = HashMap::from([
        ("AAPL".to_string(), quote_pair("AAPL", dec!(50), "USD")),
        (
            "AAPL260316C00100000".to_string(),
            quote_pair("AAPL260316C00100000", dec!(500), "USD"),
        ),
    ]);

    let response = calculate_current_valuation_response_from_snapshots(
        "account:acc-1",
        &[account],
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        true,
        latest_rate,
    );

    assert_eq!(response.summary.holdings_count, 2);
    assert_eq!(response.summary.investment_market_value_base, dec!(100));
    assert_eq!(response.summary.total_value_base, dec!(125));
}

#[test]
fn current_valuation_response_normalizes_minor_currency_splits() {
    let account = account("acc-1", "USD");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([(
        "acc-1".to_string(),
        snapshot(
            "acc-1",
            "USD",
            HashMap::from([(
                "VOD".to_string(),
                position("acc-1", "VOD", dec!(2), "GBp", false),
            )]),
            HashMap::from([("GBp".to_string(), dec!(100))]),
        ),
    )]);
    let assets = HashMap::from([("VOD".to_string(), asset("VOD", AssetKind::Investment))]);
    let quotes = HashMap::from([("VOD".to_string(), quote_pair("VOD", dec!(500), "GBp"))]);

    let response = calculate_current_valuation_response_from_snapshots(
        "account:acc-1",
        &[account],
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        true,
        latest_rate,
    );

    assert_eq!(response.summary.investment_market_value_base, dec!(12.5));
    assert_eq!(response.summary.cash_balance_base, dec!(1.25));
    assert_eq!(response.summary.total_value_base, dec!(13.75));
    assert!(response
        .summary
        .currency_split
        .iter()
        .all(|split| split.currency != "GBp"));

    let gbp_split = response
        .summary
        .currency_split
        .iter()
        .find(|split| split.currency == "GBP")
        .expect("GBP currency split");
    assert_eq!(gbp_split.value_base, dec!(13.75));
    assert_eq!(gbp_split.value_local, None);

    let gbp_cash_split = response
        .summary
        .cash_currency_split
        .iter()
        .find(|split| split.currency == "GBP")
        .expect("GBP cash split");
    assert_eq!(gbp_cash_split.value_base, dec!(1.25));
    assert_eq!(gbp_cash_split.value_local, Some(dec!(1)));
}

#[test]
fn current_account_valuation_returns_zero_for_no_snapshot() {
    let account = account("empty", "USD");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();

    let response = calculate_current_valuation_response_from_snapshots(
        "account:empty",
        &[account],
        &HashMap::new(),
        &HashMap::new(),
        &HashMap::new(),
        "USD",
        calculated_at,
        true,
        latest_rate,
    );
    let current = &response.accounts;

    assert_eq!(current[0].account_id, "empty");
    assert_eq!(current[0].total_value, Decimal::ZERO);
    assert_eq!(current[0].total_value_base, Decimal::ZERO);
    assert_eq!(current[0].source_data_as_of, None);
}

#[test]
fn current_valuation_warns_and_excludes_unpriced_positions_from_holding_count() {
    let account = account("acc-1", "USD");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([(
        "acc-1".to_string(),
        snapshot(
            "acc-1",
            "USD",
            HashMap::from([(
                "AAPL".to_string(),
                position("acc-1", "AAPL", dec!(2), "USD", false),
            )]),
            HashMap::new(),
        ),
    )]);
    let assets = HashMap::from([("AAPL".to_string(), asset("AAPL", AssetKind::Investment))]);

    let response = calculate_current_valuation_response_from_snapshots(
        "account:acc-1",
        &[account],
        &snapshots,
        &assets,
        &HashMap::new(),
        "USD",
        calculated_at,
        true,
        latest_rate,
    );

    assert_eq!(response.summary.holdings_count, 0);
    assert_eq!(response.summary.investment_market_value_base, Decimal::ZERO);
    assert!(response.summary.warnings.iter().any(
        |warning| warning == "Some market prices are missing, so this value may be incomplete."
    ));
    assert!(response.accounts[0].warnings.iter().any(
        |warning| warning == "Some market prices are missing, so this value may be incomplete."
    ));
}

#[test]
fn current_valuation_surfaces_fx_fallback_warnings() {
    let account = account("acc-1", "USD");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([(
        "acc-1".to_string(),
        snapshot(
            "acc-1",
            "USD",
            HashMap::from([(
                "AAPL".to_string(),
                position("acc-1", "AAPL", dec!(2), "EUR", false),
            )]),
            HashMap::new(),
        ),
    )]);
    let assets = HashMap::from([("AAPL".to_string(), asset("AAPL", AssetKind::Investment))]);
    let quotes = HashMap::from([("AAPL".to_string(), quote_pair("AAPL", dec!(50), "EUR"))]);

    let response = calculate_current_valuation_response_from_snapshots(
        "account:acc-1",
        &[account],
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        true,
        |from, to| {
            if from == to {
                CurrentValuationRate {
                    rate: Decimal::ONE,
                    warning: None,
                }
            } else {
                CurrentValuationRate {
                    rate: Decimal::ONE,
                    warning: Some(
                        "Some exchange rates are missing, so this value may be approximate."
                            .to_string(),
                    ),
                }
            }
        },
    );

    assert_eq!(response.summary.total_value_base, dec!(100));
    assert!(response.summary.warnings.contains(
        &"Some exchange rates are missing, so this value may be approximate.".to_string()
    ));
    assert!(response.accounts[0].warnings.contains(
        &"Some exchange rates are missing, so this value may be approximate.".to_string()
    ));
}

#[test]
fn current_valuation_keeps_account_currency_fx_warnings_off_summary() {
    let account = account("acc-1", "CAD");
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([(
        "acc-1".to_string(),
        snapshot(
            "acc-1",
            "CAD",
            HashMap::from([(
                "AAPL".to_string(),
                position("acc-1", "AAPL", dec!(2), "USD", false),
            )]),
            HashMap::new(),
        ),
    )]);
    let assets = HashMap::from([("AAPL".to_string(), asset("AAPL", AssetKind::Investment))]);
    let quotes = HashMap::from([("AAPL".to_string(), quote_pair("AAPL", dec!(50), "USD"))]);

    let response = calculate_current_valuation_response_from_snapshots(
        "account:acc-1",
        &[account],
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        true,
        |from, to| {
            if from == to {
                CurrentValuationRate {
                    rate: Decimal::ONE,
                    warning: None,
                }
            } else {
                CurrentValuationRate {
                    rate: Decimal::ONE,
                    warning: Some(
                        "Some exchange rates are missing, so this value may be approximate."
                            .to_string(),
                    ),
                }
            }
        },
    );

    assert_eq!(response.summary.total_value_base, dec!(100));
    assert!(response.summary.warnings.is_empty());
    assert!(response.accounts[0].warnings.contains(
        &"Some exchange rates are missing, so this value may be approximate.".to_string()
    ));
}

#[test]
fn current_account_valuation_preserves_requested_account_order() {
    let requested = unique_account_ids(vec![
        "second".to_string(),
        "first".to_string(),
        "second".to_string(),
    ]);
    let accounts = filter_current_valuation_accounts(
        Some(&requested),
        vec![account("first", "USD"), account("second", "USD")],
    );

    assert_eq!(
        accounts
            .iter()
            .map(|account| account.id.as_str())
            .collect::<Vec<_>>(),
        vec!["second", "first"]
    );
}

#[test]
fn current_valuation_account_filter_keeps_hidden_and_excludes_archived_requested_accounts() {
    let requested = unique_account_ids(vec![
        "active".to_string(),
        "inactive".to_string(),
        "archived".to_string(),
    ]);
    let mut inactive = account("inactive", "USD");
    inactive.is_active = false;
    let mut archived = account("archived", "USD");
    archived.is_archived = true;

    let accounts = filter_current_valuation_accounts(
        Some(&requested),
        vec![archived, inactive, account("active", "USD")],
    );

    assert_eq!(
        accounts
            .iter()
            .map(|account| account.id.as_str())
            .collect::<Vec<_>>(),
        vec!["active", "inactive"]
    );
}

#[test]
fn current_valuation_response_summarizes_scope_and_optionally_returns_accounts() {
    let accounts = vec![account("second", "CAD"), account("first", "USD")];
    let calculated_at = DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap();
    let snapshots = HashMap::from([
        (
            "first".to_string(),
            snapshot(
                "first",
                "USD",
                HashMap::from([(
                    "AAPL".to_string(),
                    position("first", "AAPL", dec!(2), "USD", false),
                )]),
                HashMap::from([("USD".to_string(), dec!(25))]),
            ),
        ),
        (
            "second".to_string(),
            snapshot(
                "second",
                "CAD",
                HashMap::from([
                    (
                        "SHOP".to_string(),
                        position("second", "SHOP", dec!(1), "CAD", false),
                    ),
                    (
                        "HOUSE".to_string(),
                        position("second", "HOUSE", dec!(1), "CAD", false),
                    ),
                    (
                        "ZERO".to_string(),
                        position("second", "ZERO", Decimal::ZERO, "CAD", false),
                    ),
                ]),
                HashMap::from([("CAD".to_string(), dec!(10))]),
            ),
        ),
    ]);
    let assets = HashMap::from([
        ("AAPL".to_string(), asset("AAPL", AssetKind::Investment)),
        ("SHOP".to_string(), asset("SHOP", AssetKind::Investment)),
        ("HOUSE".to_string(), asset("HOUSE", AssetKind::Property)),
        ("ZERO".to_string(), asset("ZERO", AssetKind::Investment)),
    ]);
    let quotes = HashMap::from([
        ("AAPL".to_string(), quote_pair("AAPL", dec!(50), "USD")),
        ("SHOP".to_string(), quote_pair("SHOP", dec!(100), "CAD")),
        ("HOUSE".to_string(), quote_pair("HOUSE", dec!(900), "CAD")),
        ("ZERO".to_string(), quote_pair("ZERO", dec!(100), "CAD")),
    ]);

    let response = calculate_current_valuation_response_from_snapshots(
        "accounts:test",
        &accounts,
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        true,
        latest_rate,
    );

    assert_eq!(response.summary.scope_id, "accounts:test");
    assert_eq!(response.summary.base_currency, "USD");
    assert_eq!(response.summary.account_count, 2);
    assert_eq!(response.summary.holdings_count, 4);
    assert_eq!(response.summary.cash_balance_base, dec!(33));
    assert_eq!(response.summary.investment_market_value_base, dec!(180));
    assert_eq!(response.summary.total_value_base, dec!(213));
    assert_eq!(
        response.summary.source_data_as_of,
        Some(DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap())
    );
    assert_eq!(
        response
            .accounts
            .iter()
            .map(|valuation| valuation.account_id.as_str())
            .collect::<Vec<_>>(),
        vec!["second", "first"]
    );

    let cad_cash = response
        .summary
        .cash_currency_split
        .iter()
        .find(|split| split.currency == "CAD")
        .expect("CAD cash split");
    assert_eq!(cad_cash.value_base, dec!(8));
    assert_eq!(cad_cash.value_local, Some(dec!(10)));

    let summary_only = calculate_current_valuation_response_from_snapshots(
        "accounts:test",
        &accounts,
        &snapshots,
        &assets,
        &quotes,
        "USD",
        calculated_at,
        false,
        latest_rate,
    );
    assert!(summary_only.accounts.is_empty());
    assert_eq!(summary_only.summary.total_value_base, dec!(213));
    assert_eq!(
        summary_only.summary.source_data_as_of,
        Some(DateTime::<Utc>::from_timestamp(1_776_480_000, 0).unwrap())
    );
}
