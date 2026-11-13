//! Whether a change to an asset's values must recalculate accounts: always
//! for a listed asset, and for an alternative asset only once an account
//! holds it, since a transfer of it is priced from its values.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use chrono::{NaiveDate, Utc};
use diesel::prelude::*;
use rust_decimal::Decimal;
use wealthfolio_core::assets::{AssetKind, AssetRepositoryTrait, NewAsset, QuoteMode};
use wealthfolio_core::quotes::{Quote, QuoteService, QuoteServiceTrait};
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_core::Result;
use wealthfolio_storage_sqlite::{
    activities::ActivityRepository,
    assets::AssetRepository,
    db,
    market_data::{MarketDataRepository, QuoteSyncStateRepository},
};

struct NoSecrets;

impl SecretStore for NoSecrets {
    fn get_secret(&self, _: &str) -> Result<Option<String>> {
        panic!("Manual values must not access credentials")
    }
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        panic!("Manual values must not access credentials")
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        panic!("Manual values must not access credentials")
    }
}

fn manual_asset(id: &str, kind: AssetKind) -> NewAsset {
    NewAsset {
        id: Some(id.into()),
        kind,
        name: Some(id.into()),
        display_code: Some(id.to_uppercase()),
        is_active: true,
        quote_mode: QuoteMode::Manual,
        quote_ccy: "USD".into(),
        ..Default::default()
    }
}

fn value(asset_id: &str, close: i64) -> Quote {
    let close = Decimal::new(close, 0);
    Quote {
        id: String::new(),
        asset_id: asset_id.into(),
        timestamp: NaiveDate::from_ymd_opt(2026, 10, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_utc(),
        open: close,
        high: close,
        low: close,
        close,
        adjclose: close,
        volume: Decimal::ZERO,
        currency: "USD".into(),
        data_source: "MANUAL".into(),
        created_at: Utc::now(),
        notes: None,
    }
}

#[tokio::test]
async fn an_alternative_asset_feeds_account_values_once_an_account_holds_it() {
    let dir = common::TestDir::new();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    let (writer, _task) = db::write_actor::spawn_writer_with_sync_state(
        (*pool).clone(),
        Arc::new(|| {}),
        Arc::default(),
    )
    .unwrap();
    let assets = Arc::new(AssetRepository::new(pool.clone(), writer.clone()));
    let market_data = Arc::new(MarketDataRepository::new(pool.clone(), writer.clone()));
    let quotes = QuoteService::new(
        market_data.clone(),
        Arc::new(QuoteSyncStateRepository::new(pool.clone(), writer.clone())),
        market_data,
        assets.clone(),
        Arc::new(ActivityRepository::new(pool.clone(), writer)),
        Arc::new(NoSecrets),
    )
    .await
    .unwrap();
    assets
        .create(manual_asset("home", AssetKind::Property))
        .await
        .unwrap();
    assets
        .create(manual_asset("privco", AssetKind::Investment))
        .await
        .unwrap();
    let home_value = quotes
        .update_quote(value("home", 400_000))
        .await
        .unwrap()
        .id;

    assert!(quotes.prices_feed_account_values("privco"));
    assert!(!quotes.prices_feed_account_values("home"));
    assert!(!quotes.quote_feeds_account_values(&home_value));
    // What the server can't place keeps its recalculation.
    assert!(quotes.prices_feed_account_values("no-such-asset"));
    assert!(quotes.quote_feeds_account_values("no-such-value"));

    // An account takes the property in by transfer, priced from its values.
    diesel::sql_query(
        "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, \
         created_at, updated_at, is_archived, tracking_mode) VALUES ('estate', 'Estate', \
         'SECURITIES', 'USD', 0, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0, \
         'TRANSACTIONS')",
    )
    .execute(&mut db::get_connection(&pool).unwrap())
    .unwrap();
    diesel::sql_query(
        "INSERT INTO activities (id, account_id, asset_id, activity_type, status, \
         activity_date, quantity, unit_price, currency, is_user_modified, needs_review, \
         created_at, updated_at) VALUES ('in', 'estate', 'home', 'TRANSFER_IN', 'POSTED', \
         '2026-10-02T12:00:00Z', '1', '400000', 'USD', 0, 0, '2026-01-01T00:00:00Z', \
         '2026-01-01T00:00:00Z')",
    )
    .execute(&mut db::get_connection(&pool).unwrap())
    .unwrap();

    assert!(quotes.prices_feed_account_values("home"));
    assert!(quotes.quote_feeds_account_values(&home_value));
}
