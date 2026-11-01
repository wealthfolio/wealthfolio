//! Settings updates on real SQLite: a rejected update, including one with an
//! invalid base currency, changes neither the base currency nor its FX pairs,
//! and one that fails to save keeps the old base currency.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use diesel::prelude::*;
use serde_json::json;
use wealthfolio_core::events::MockDomainEventSink;
use wealthfolio_core::fx::FxService;
use wealthfolio_core::settings::{SettingsService, SettingsServiceTrait, SettingsUpdate};
use wealthfolio_storage_sqlite::{
    db, fx::FxRepository, schema::assets, settings::SettingsRepository, DbPool,
};

struct Fixture {
    settings: SettingsService,
    pool: Arc<DbPool>,
    events: MockDomainEventSink,
    _dir: common::TestDir,
}

async fn fixture() -> Fixture {
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
    let events = MockDomainEventSink::new();
    let fx = FxService::new(Arc::new(FxRepository::new(pool.clone(), writer.clone())))
        .with_event_sink(Arc::new(events.clone()));
    let settings = SettingsService::new(
        Arc::new(SettingsRepository::new(pool.clone(), writer)),
        Arc::new(fx),
    );
    // A CAD account needs an FX pair to every new base currency.
    diesel::sql_query("INSERT INTO accounts (id, name, currency) VALUES ('cad', 'CAD', 'CAD')")
        .execute(&mut db::get_connection(&pool).unwrap())
        .unwrap();
    settings
        .update_settings(&update(json!({"baseCurrency": "USD", "timezone": "UTC"})))
        .await
        .unwrap();
    events.clear();
    Fixture {
        settings,
        pool,
        events,
        _dir: dir,
    }
}

fn update(value: serde_json::Value) -> SettingsUpdate {
    serde_json::from_value(value).unwrap()
}

fn fx_pairs(pool: &DbPool) -> Vec<Option<String>> {
    assets::table
        .filter(assets::kind.eq("FX"))
        .select(assets::instrument_key)
        .order(assets::instrument_key)
        .load(&mut db::get_connection(pool).unwrap())
        .unwrap()
}

fn assert_unchanged(fixture: &Fixture) {
    let settings = fixture.settings.get_settings().unwrap();
    assert_eq!(settings.base_currency, "USD");
    assert_eq!(settings.timezone, "UTC");
}

#[tokio::test]
async fn rejected_update_keeps_the_base_currency_and_registers_no_fx_pair() {
    let fixture = fixture().await;
    assert_eq!(fx_pairs(&fixture.pool), [Some("FX:CAD/USD".to_string())]);

    let rejected = update(json!({"baseCurrency": "EUR", "timezone": "Mars/Olympus"}));
    assert!(fixture.settings.update_settings(&rejected).await.is_err());

    assert_unchanged(&fixture);
    assert_eq!(fx_pairs(&fixture.pool), [Some("FX:CAD/USD".to_string())]);
    assert!(fixture.events.events().is_empty());

    let accepted = update(json!({"baseCurrency": "EUR", "timezone": "Europe/Paris"}));
    fixture.settings.update_settings(&accepted).await.unwrap();
    let settings = fixture.settings.get_settings().unwrap();
    assert_eq!(settings.base_currency, "EUR");
    assert_eq!(settings.timezone, "Europe/Paris");
    assert_eq!(
        fx_pairs(&fixture.pool),
        [
            Some("FX:CAD/EUR".to_string()),
            Some("FX:CAD/USD".to_string()),
            Some("FX:USD/EUR".to_string())
        ]
    );
}

#[tokio::test]
async fn failed_save_keeps_the_base_currency() {
    let fixture = fixture().await;
    diesel::sql_query(
        "CREATE TRIGGER fail_timezone BEFORE INSERT ON app_settings \
         WHEN NEW.setting_key = 'timezone' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    )
    .execute(&mut db::get_connection(&fixture.pool).unwrap())
    .unwrap();

    let failing = update(json!({"baseCurrency": "EUR", "timezone": "Europe/Paris"}));
    assert!(fixture.settings.update_settings(&failing).await.is_err());

    assert_unchanged(&fixture);
}

#[tokio::test]
async fn invalid_base_currency_is_rejected_before_any_fx_pair_is_registered() {
    let fixture = fixture().await;

    for invalid in ["", "usd", "GBp", "GBX", "USDT", "NOT A CURRENCY"] {
        let rejected = update(json!({"baseCurrency": invalid}));
        assert!(
            fixture.settings.update_settings(&rejected).await.is_err(),
            "{invalid:?} was accepted"
        );
    }

    assert_unchanged(&fixture);
    assert_eq!(fx_pairs(&fixture.pool), [Some("FX:CAD/USD".to_string())]);
    assert!(fixture.events.events().is_empty());
}

#[tokio::test]
async fn saved_invalid_base_currency_is_rejected_when_sent_again() {
    let fixture = fixture().await;
    diesel::sql_query(
        "UPDATE app_settings SET setting_value = 'usd' WHERE setting_key = 'base_currency'",
    )
    .execute(&mut db::get_connection(&fixture.pool).unwrap())
    .unwrap();

    let resent = update(json!({"baseCurrency": "usd", "timezone": "Europe/Paris"}));
    assert!(fixture.settings.update_settings(&resent).await.is_err());

    let settings = fixture.settings.get_settings().unwrap();
    assert_eq!(settings.base_currency, "usd");
    assert_eq!(settings.timezone, "UTC");
}
