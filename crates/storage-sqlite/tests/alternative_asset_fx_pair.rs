#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
//! An alternative asset or liability valued in another currency than the base
//! one registers its FX pair when it is created, as an account does, so its
//! values convert into the base currency.
mod common;

use std::sync::{Arc, RwLock};

use chrono::NaiveDate;
use diesel::RunQueryDsl;
use rust_decimal::Decimal;
use wealthfolio_core::assets::{
    AlternativeAssetService, AlternativeAssetServiceTrait, AssetKind, AssetRepositoryTrait,
    CreateAlternativeAssetRequest,
};
use wealthfolio_core::fx::{FxService, FxServiceTrait, NewExchangeRate};
use wealthfolio_core::quotes::QuoteService;
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_core::Result;
use wealthfolio_storage_sqlite::{
    activities::ActivityRepository,
    assets::{AlternativeAssetRepository, AssetRepository},
    db,
    fx::FxRepository,
    market_data::{MarketDataRepository, QuoteSyncStateRepository},
};

struct NoSecrets;

impl SecretStore for NoSecrets {
    fn get_secret(&self, _: &str) -> Result<Option<String>> {
        panic!("Creating an asset must not access credentials")
    }
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        panic!("Creating an asset must not access credentials")
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        panic!("Creating an asset must not access credentials")
    }
}

fn liability(currency: &str) -> CreateAlternativeAssetRequest {
    CreateAlternativeAssetRequest {
        kind: AssetKind::Liability,
        name: format!("Mortgage in {currency}"),
        currency: currency.to_string(),
        current_value: Decimal::new(250_000, 0),
        value_date: NaiveDate::from_ymd_opt(2026, 1, 31).unwrap(),
        purchase_price: None,
        purchase_date: None,
        metadata: None,
        linked_asset_id: None,
        loan: None,
    }
}

#[tokio::test]
async fn a_non_base_liability_registers_its_fx_pair_and_converts() {
    let dir = common::TestDir::new();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    // Registering a pair stores it; nothing is fetched.
    diesel::sql_query("UPDATE market_data_providers SET enabled=0")
        .execute(&mut db::get_connection(&pool).unwrap())
        .unwrap();
    let (writer, _task) = db::write_actor::spawn_writer_with_sync_state(
        (*pool).clone(),
        Arc::new(|| {}),
        Arc::default(),
    )
    .unwrap();
    let assets = Arc::new(AssetRepository::new(pool.clone(), writer.clone()));
    let market_data = Arc::new(MarketDataRepository::new(pool.clone(), writer.clone()));
    let quotes = Arc::new(
        QuoteService::new(
            market_data.clone(),
            Arc::new(QuoteSyncStateRepository::new(pool.clone(), writer.clone())),
            market_data,
            assets.clone(),
            Arc::new(ActivityRepository::new(pool.clone(), writer.clone())),
            Arc::new(NoSecrets),
        )
        .await
        .unwrap(),
    );
    let fx = Arc::new(FxService::new(Arc::new(FxRepository::new(
        pool.clone(),
        writer.clone(),
    ))));
    fx.initialize().unwrap();
    let service = AlternativeAssetService::new(
        Arc::new(AlternativeAssetRepository::new(
            pool.clone(),
            writer.clone(),
        )),
        assets.clone(),
        quotes,
    )
    .with_fx_registration(fx.clone(), Arc::new(RwLock::new("USD".to_string())));

    let fx_pairs = || {
        let mut pairs: Vec<(String, String)> = assets
            .list()
            .unwrap()
            .into_iter()
            .filter(|asset| asset.kind == AssetKind::Fx)
            .map(|asset| (asset.instrument_symbol.unwrap_or_default(), asset.quote_ccy))
            .collect();
        pairs.sort();
        pairs
    };

    // A liability in the base currency needs no pair.
    service
        .create_alternative_asset(liability("USD"))
        .await
        .unwrap();
    assert!(fx_pairs().is_empty(), "{:?}", fx_pairs());

    service
        .create_alternative_asset(liability("EUR"))
        .await
        .unwrap();
    assert_eq!(fx_pairs(), vec![("EUR".to_string(), "USD".to_string())]);

    // Once the pair has a rate, the liability's value converts.
    fx.add_exchange_rate(NewExchangeRate {
        from_currency: "EUR".to_string(),
        to_currency: "USD".to_string(),
        rate: Decimal::new(11, 1),
        source: "MANUAL".to_string(),
    })
    .await
    .unwrap();
    assert_eq!(
        fx.convert_currency(Decimal::new(250_000, 0), "EUR", "USD")
            .unwrap(),
        Decimal::new(275_000, 0)
    );

    // A second asset in that currency reuses the pair.
    service
        .create_alternative_asset(liability("EUR"))
        .await
        .unwrap();
    assert_eq!(fx_pairs().len(), 1);
}
