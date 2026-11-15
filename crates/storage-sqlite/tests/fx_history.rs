//! Historical FX reads retain every observation used by a captured holdings view.
#![allow(clippy::unwrap_used, reason = "test code")]
mod common;

use diesel::prelude::*;
use diesel::sql_types::{Nullable, Text};
use rust_decimal::Decimal;
use wealthfolio_core::fx::currency_converter::CurrencyConverter;
use wealthfolio_storage_sqlite::{db, fx::FxRepository};

#[tokio::test]
async fn historical_rates_preserve_pairs_sources_dates_and_direct_observations() {
    let dir = common::TestDir::new();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    let writer = db::write_actor::spawn_writer((*pool).clone()).unwrap();
    let repo = FxRepository::new(pool.clone(), writer);
    let mut conn = db::get_connection(&pool).unwrap();
    for (id, kind, from, to) in [
        ("eur", "FX", Some("EUR"), "USD"),
        ("inverse", "FX", Some("USD"), "EUR"),
        ("stock", "INVESTMENT", Some("STOCK"), "USD"),
        ("unknown", "FX", None, "USD"),
    ] {
        diesel::sql_query(
            "INSERT INTO assets (id, kind, instrument_symbol, quote_ccy, quote_mode) \
             VALUES (?, ?, ?, ?, 'MANUAL')",
        )
        .bind::<Text, _>(id)
        .bind::<Text, _>(kind)
        .bind::<Nullable<Text>, _>(from)
        .bind::<Text, _>(to)
        .execute(&mut conn)
        .unwrap();
    }
    // Deliberately insert out of time order. Non-FX quotes are excluded, while
    // invalid rates and a missing pair symbol retain their existing fallbacks.
    for (id, asset, day, rate, source, timestamp) in [
        (
            "later",
            "eur",
            "2025-01-03",
            "1.25",
            "MANUAL",
            "2025-01-03T12:00:00Z",
        ),
        (
            "earlier",
            "eur",
            "2025-01-01",
            "1.10",
            "YAHOO",
            "2025-01-01T14:00:00+02:00",
        ),
        (
            "inverse",
            "inverse",
            "2025-01-01",
            "0.8",
            "MANUAL",
            "2025-01-01T12:00:00Z",
        ),
        (
            "stock",
            "stock",
            "2025-01-01",
            "100",
            "MANUAL",
            "2025-01-01T12:00:00Z",
        ),
        (
            "invalid",
            "unknown",
            "2025-01-01",
            "invalid",
            "MANUAL",
            "2025-01-01T12:00:00Z",
        ),
    ] {
        diesel::sql_query(
            "INSERT INTO quotes (id, asset_id, day, close, source, currency, timestamp, created_at) \
             VALUES (?, ?, ?, ?, ?, 'USD', ?, datetime('now'))",
        )
        .bind::<Text, _>(id)
        .bind::<Text, _>(asset)
        .bind::<Text, _>(day)
        .bind::<Text, _>(rate)
        .bind::<Text, _>(source)
        .bind::<Text, _>(timestamp)
        .execute(&mut conn)
        .unwrap();
    }

    let rates = repo.get_all_historical_exchange_rates().unwrap();
    let observations: Vec<_> = rates
        .iter()
        .map(|r| {
            (
                r.id.as_str(),
                r.from_currency.as_str(),
                r.to_currency.as_str(),
                r.rate,
                r.source.as_str(),
                r.timestamp.to_rfc3339(),
            )
        })
        .collect();
    assert_eq!(
        observations,
        vec![
            (
                "eur",
                "EUR",
                "USD",
                Decimal::new(110, 2),
                "YAHOO",
                "2025-01-01T12:00:00+00:00".into()
            ),
            (
                "eur",
                "EUR",
                "USD",
                Decimal::new(125, 2),
                "MANUAL",
                "2025-01-03T12:00:00+00:00".into()
            ),
            (
                "inverse",
                "USD",
                "EUR",
                Decimal::new(8, 1),
                "MANUAL",
                "2025-01-01T12:00:00+00:00".into()
            ),
            (
                "unknown",
                "",
                "USD",
                Decimal::ZERO,
                "MANUAL",
                "2025-01-01T12:00:00+00:00".into()
            ),
        ]
    );
    let converter = CurrencyConverter::new(rates).unwrap();
    let day = chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
    assert_eq!(
        converter.get_rate("EUR", "USD", day).unwrap(),
        Decimal::new(110, 2)
    );
    assert_eq!(
        converter.get_rate("USD", "EUR", day).unwrap(),
        Decimal::new(8, 1)
    );
}
