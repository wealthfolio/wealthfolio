//! FX pairs on real SQLite: a new pair is stored upper-cased, so a code in
//! another case is rejected rather than inserted under a key the lookup can't
//! read back (#2188), and a pair already stored in lower case keeps working.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::fmt::Debug;
use std::sync::Arc;

use diesel::prelude::*;
use rust_decimal::Decimal;
use wealthfolio_core::fx::{FxError, FxService, FxServiceTrait, NewExchangeRate};
use wealthfolio_core::{Error, Result};
use wealthfolio_storage_sqlite::{db, fx::FxRepository, schema::assets, DbPool};

struct Fixture {
    fx: FxService,
    pool: Arc<DbPool>,
    _dir: common::TestDir,
}

fn fixture() -> Fixture {
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
    let fx = FxService::new(Arc::new(FxRepository::new(pool.clone(), writer)));
    fx.initialize().unwrap();
    Fixture {
        fx,
        pool,
        _dir: dir,
    }
}

fn fx_pairs(pool: &DbPool) -> Vec<Option<String>> {
    assets::table
        .filter(assets::kind.eq("FX"))
        .select(assets::instrument_key)
        .order(assets::instrument_key)
        .load(&mut db::get_connection(pool).unwrap())
        .unwrap()
}

fn manual_rate(from: &str, to: &str) -> NewExchangeRate {
    NewExchangeRate {
        from_currency: from.to_string(),
        to_currency: to.to_string(),
        rate: Decimal::new(101, 2),
        source: "MANUAL".to_string(),
    }
}

fn assert_invalid_code<T: Debug>(result: Result<T>, code: &str) {
    match result {
        Err(Error::Fx(FxError::InvalidCurrencyCode(rejected))) => assert_eq!(rejected, code),
        other => panic!("expected InvalidCurrencyCode({code}), got {other:?}"),
    }
}

#[tokio::test]
async fn new_pair_with_a_lower_case_code_is_rejected() {
    let fixture = fixture();

    assert_invalid_code(fixture.fx.register_currency_pair("eur", "USD").await, "eur");
    assert_invalid_code(
        fixture
            .fx
            .add_exchange_rate(manual_rate("USD", "usdt"))
            .await,
        "usdt",
    );

    assert!(fx_pairs(&fixture.pool).is_empty());
}

#[tokio::test]
async fn lower_case_code_is_rejected_when_the_upper_case_pair_exists() {
    let fixture = fixture();
    fixture
        .fx
        .register_currency_pair("EUR", "USD")
        .await
        .unwrap();

    assert_invalid_code(fixture.fx.register_currency_pair("eur", "USD").await, "eur");

    assert_eq!(fx_pairs(&fixture.pool), [Some("FX:EUR/USD".to_string())]);
}

#[tokio::test]
async fn pair_stored_in_lower_case_keeps_working() {
    let fixture = fixture();
    // Before the v2 asset model, pairs kept the case they were entered in
    // (`eurUSD=X`), and the migration carried it over.
    diesel::sql_query(
        "INSERT INTO assets (kind, quote_mode, quote_ccy, instrument_type, instrument_symbol)
         VALUES ('FX', 'MARKET', 'USD', 'FX', 'eur')",
    )
    .execute(&mut db::get_connection(&fixture.pool).unwrap())
    .unwrap();

    fixture
        .fx
        .register_currency_pair("eur", "USD")
        .await
        .unwrap();
    fixture
        .fx
        .add_exchange_rate(manual_rate("eur", "USD"))
        .await
        .unwrap();

    assert_eq!(fx_pairs(&fixture.pool), [Some("FX:eur/USD".to_string())]);
    assert_eq!(
        fixture
            .fx
            .convert_currency(Decimal::from(100), "eur", "USD")
            .unwrap(),
        Decimal::from(101)
    );
}
