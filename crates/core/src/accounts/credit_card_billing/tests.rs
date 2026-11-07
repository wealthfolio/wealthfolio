use super::*;
use chrono::{DateTime, Utc};
use rust_decimal_macros::dec;

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}

fn card(closing_day: u32, due_day: u32) -> Account {
    Account {
        id: "card".into(),
        account_type: account_types::CREDIT_CARD.into(),
        currency: "BRL".into(),
        tracking_mode: TrackingMode::Transactions,
        meta: Some(
            serde_json::json!({"creditCardBilling": {
                "closingDay": closing_day, "dueDay": due_day,
            }})
            .to_string(),
        ),
        ..Account::default()
    }
}

fn row(id: &str, instant: &str, kind: &str, amount: Decimal) -> CashLedgerActivity {
    let instant = instant.parse::<DateTime<Utc>>().unwrap();
    CashLedgerActivity {
        id: id.into(),
        account_id: "card".into(),
        asset_id: None,
        activity_type: kind.into(),
        activity_type_override: None,
        subtype: None,
        status: ActivityStatus::Posted,
        activity_date: instant,
        created_at: instant,
        quantity: None,
        unit_price: None,
        amount: Some(amount),
        fee: None,
        tax: None,
        currency: "BRL".into(),
    }
}

#[test]
fn clamps_short_months_including_leap_years_without_losing_the_requested_day() {
    let settings = CreditCardBillingSettings {
        closing_day: 31,
        due_day: 10,
    };
    let feb = settings.period(date("2028-02-01")).unwrap();
    assert_eq!(feb.start_date, date("2028-02-01"));
    assert_eq!(feb.closing_date, date("2028-02-29"));
    assert_eq!(feb.due_date, date("2028-03-10"));
    let march = settings.period(date("2028-03-01")).unwrap();
    assert_eq!(march.start_date, date("2028-03-01"));
    assert_eq!(march.closing_date, date("2028-03-31"));
    assert_eq!(
        settings.period(date("2027-02-01")).unwrap().closing_date,
        date("2027-02-28")
    );
}

#[test]
fn due_day_is_strictly_after_closing_in_the_same_or_following_month() {
    for (closing_day, due_day, expected) in [
        (10, 20, "2026-12-20"),
        (20, 10, "2027-01-10"),
        (20, 20, "2027-01-20"),
    ] {
        let period = CreditCardBillingSettings {
            closing_day,
            due_day,
        }
        .period(date("2026-12-01"))
        .unwrap();
        assert_eq!(period.due_date, date(expected));
    }
    let clamped = CreditCardBillingSettings {
        closing_day: 30,
        due_day: 31,
    }
    .period(date("2027-02-01"))
    .unwrap();
    assert_eq!(clamped.due_date, date("2027-03-31"));
}

#[test]
fn validates_billing_metadata_without_echoing_its_contents() {
    for settings in [
        serde_json::json!({"closingDay": 0, "dueDay": 10}),
        serde_json::json!({"closingDay": 1, "dueDay": 32}),
        serde_json::json!({"closingDay": 1.5, "dueDay": 10}),
        serde_json::json!({"closingDay": "private value", "dueDay": 10}),
        serde_json::json!({"closingDay": 1}),
    ] {
        let meta = serde_json::json!({"creditCardBilling": settings}).to_string();
        let error = CreditCardBillingSettings::from_meta(Some(&meta)).unwrap_err();
        assert!(!error.to_string().contains("private value"));
    }
    assert!(CreditCardBillingSettings::from_meta(Some("{}"))
        .unwrap()
        .is_none());
    assert!(
        CreditCardBillingSettings::from_meta(Some("{\"creditCardBilling\":null}"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn statement_balance_carries_debt_and_credits_without_booking_another_expense() {
    let rows = vec![
        row("next-cycle", "2026-11-11T00:00:00Z", "WITHDRAWAL", dec!(70)),
        row("opening", "2026-09-01T00:00:00Z", "WITHDRAWAL", dec!(100)),
        row("payment", "2026-10-15T00:00:00Z", "TRANSFER_IN", dec!(80)),
        row("charge", "2026-10-12T00:00:00Z", "WITHDRAWAL", dec!(50.15)),
        row("refund", "2026-11-01T00:00:00Z", "CREDIT", dec!(10.10)),
        row("interest", "2026-11-10T23:59:00Z", "INTEREST", dec!(2)),
    ];
    let statements =
        credit_card_statements(&card(10, 20), &rows, date("2026-11-12"), chrono_tz::UTC).unwrap();
    assert_eq!(statements[0].closing_date, date("2026-12-10"));
    assert!(!statements[0].is_closed);
    assert_eq!(statements[0].balances[0].balance, "132.05");
    assert_eq!(statements[1].start_date, date("2026-10-11"));
    assert_eq!(statements[1].closing_date, date("2026-11-10"));
    assert!(statements[1].is_closed);
    assert_eq!(statements[1].balances[0].balance, "62.05");
    assert_eq!(statements[2].balances[0].balance, "100");
}

#[test]
fn keeps_currencies_separate_and_ignores_unposted_future_and_other_accounts() {
    let mut abroad = row("abroad", "2026-11-01T00:00:00Z", "WITHDRAWAL", dec!(9.99));
    abroad.currency = "USD".into();
    let mut pending = row("pending", "2026-11-02T00:00:00Z", "WITHDRAWAL", dec!(999));
    pending.status = ActivityStatus::Pending;
    let mut other = pending.clone();
    other.id = "other".into();
    other.account_id = "other".into();
    other.status = ActivityStatus::Posted;
    let rows = vec![
        abroad,
        pending,
        other,
        row("credit", "2026-11-01T00:00:00Z", "TRANSFER_IN", dec!(15)),
        row("future", "2026-12-01T00:00:00Z", "BUY", dec!(900)),
    ];
    let statements =
        credit_card_statements(&card(10, 20), &rows, date("2026-11-05"), chrono_tz::UTC).unwrap();
    assert_eq!(statements.len(), 1);
    assert_eq!(statements[0].balances[0].currency, "BRL");
    assert_eq!(statements[0].balances[0].balance, "-15");
    assert_eq!(statements[0].balances[1].currency, "USD");
    assert_eq!(statements[0].balances[1].balance, "9.99");
}

#[test]
fn closing_day_includes_the_whole_day_in_the_configured_timezone() {
    let rows = vec![
        row(
            "closing-day",
            "2026-11-11T02:59:59Z",
            "WITHDRAWAL",
            dec!(50),
        ),
        row("next-day", "2026-11-11T03:00:00Z", "WITHDRAWAL", dec!(20)),
    ];
    let tz = chrono_tz::America::Sao_Paulo;
    let on_closing = credit_card_statements(&card(10, 20), &rows, date("2026-11-10"), tz).unwrap();
    assert!(!on_closing[0].is_closed);
    assert_eq!(on_closing[0].balances[0].balance, "50");
    let after = credit_card_statements(&card(10, 20), &rows, date("2026-11-11"), tz).unwrap();
    assert_eq!(after[0].balances[0].balance, "70");
    assert_eq!(after[1].balances[0].balance, "50");
    assert!(after[1].is_closed);
}

#[test]
fn unconfigured_cards_have_no_statements_and_non_cards_are_rejected() {
    let mut account = card(10, 20);
    account.meta = None;
    assert!(
        credit_card_statements(&account, &[], date("2026-11-07"), chrono_tz::UTC)
            .unwrap()
            .is_empty()
    );
    account.tracking_mode = TrackingMode::NotSet;
    assert!(credit_card_statements(&account, &[], date("2026-11-07"), chrono_tz::UTC).is_err());
    account.tracking_mode = TrackingMode::Transactions;
    account.account_type = account_types::CASH.into();
    assert!(credit_card_statements(&account, &[], date("2026-11-07"), chrono_tz::UTC).is_err());
}

#[test]
fn account_create_and_update_reject_invalid_billing_days() {
    use crate::accounts::{AccountUpdate, NewAccount};
    let input = |closing_day: u32| {
        serde_json::json!({
            "id": "card", "name": "Card", "accountType": "CREDIT_CARD", "currency": "BRL",
            "isDefault": false, "isActive": true, "trackingMode": "TRANSACTIONS",
            "meta": serde_json::json!({"creditCardBilling": {"closingDay": closing_day, "dueDay": 20}}).to_string(),
        })
    };
    for day in [0, 32] {
        assert!(serde_json::from_value::<NewAccount>(input(day))
            .unwrap()
            .validate()
            .is_err());
        assert!(serde_json::from_value::<AccountUpdate>(input(day))
            .unwrap()
            .validate()
            .is_err());
    }
    assert!(serde_json::from_value::<NewAccount>(input(31))
        .unwrap()
        .validate()
        .is_ok());
    assert!(serde_json::from_value::<AccountUpdate>(input(31))
        .unwrap()
        .validate()
        .is_ok());
}
