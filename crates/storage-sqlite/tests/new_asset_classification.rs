//! Classification of an asset created from a `NewAsset` payload, as the
//! holdings CSV import creates its pending assets before saving snapshots.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use diesel::prelude::*;
use wealthfolio_core::assets::{AssetService, AssetServiceTrait, NewAsset};
use wealthfolio_core::quotes::QuoteService;
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_core::taxonomies::{TaxonomyService, TaxonomyServiceTrait};
use wealthfolio_core::Result;
use wealthfolio_storage_sqlite::{
    activities::ActivityRepository,
    assets::AssetRepository,
    db,
    market_data::{MarketDataRepository, QuoteSyncStateRepository},
    taxonomies::TaxonomyRepository,
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

/// Creates the asset the JSON payload describes and returns its
/// (instrument type, asset class) assignments.
async fn create_and_classify(payload: serde_json::Value) -> (Vec<String>, Vec<String>) {
    let dir = common::TestDir::new();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
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
    let quotes = QuoteService::new(
        market_data.clone(),
        Arc::new(QuoteSyncStateRepository::new(pool.clone(), writer.clone())),
        market_data,
        assets.clone(),
        Arc::new(ActivityRepository::new(pool.clone(), writer.clone())),
        Arc::new(NoSecrets),
    )
    .await
    .unwrap();
    let taxonomies = Arc::new(TaxonomyService::new(Arc::new(TaxonomyRepository::new(
        pool.clone(),
        writer,
    ))));
    let service =
        AssetService::with_taxonomy_service(assets, Arc::new(quotes), taxonomies.clone()).unwrap();

    // Both runtimes deserialize the request body into `NewAsset` unchanged.
    let new_asset: NewAsset = serde_json::from_value(payload).unwrap();
    let asset = service.create_asset(new_asset).await.unwrap();

    let assignments = taxonomies.get_asset_assignments(&asset.id).unwrap();
    let categories = |taxonomy: &str| {
        assignments
            .iter()
            .filter(|a| a.taxonomy_id == taxonomy)
            .map(|a| a.category_id.clone())
            .collect::<Vec<_>>()
    };
    (categories("instrument_type"), categories("asset_classes"))
}

fn bond_fund(label: Option<&str>) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "kind": "INVESTMENT",
        "name": "Example Corporate Bond Fund",
        "displayCode": "INFZ00000003",
        "instrumentSymbol": "INFZ00000003",
        "isActive": true,
        "quoteMode": "MANUAL",
        "quoteCcy": "INR",
        "instrumentType": "EQUITY"
    });
    if let Some(label) = label {
        payload["instrumentTypeLabel"] = label.into();
    }
    payload
}

#[tokio::test]
async fn a_new_asset_labelled_as_a_mutual_fund_is_classified_as_one() {
    let (instrument_types, asset_classes) =
        create_and_classify(bond_fund(Some("MUTUALFUND"))).await;

    assert_eq!(instrument_types, ["FUND_MUTUAL"]);
    assert_eq!(asset_classes, ["FIXED_INCOME"]);
}

#[tokio::test]
async fn a_new_asset_without_a_label_is_classified_by_its_instrument_type() {
    let (instrument_types, asset_classes) = create_and_classify(bond_fund(None)).await;

    assert_eq!(instrument_types, ["STOCK_COMMON"]);
    assert_eq!(asset_classes, ["EQUITY"]);
}

#[tokio::test]
async fn a_label_that_contradicts_the_instrument_type_is_ignored() {
    let mut payload = bond_fund(Some("MUTUALFUND"));
    payload["instrumentType"] = "CRYPTO".into();

    let (instrument_types, asset_classes) = create_and_classify(payload).await;

    assert_eq!(instrument_types, ["CRYPTO_NATIVE"]);
    assert_eq!(asset_classes, ["DIGITAL_ASSETS"]);
}

#[tokio::test]
async fn a_label_without_an_instrument_type_still_classifies() {
    let mut payload = bond_fund(Some("MUTUALFUND"));
    payload.as_object_mut().unwrap().remove("instrumentType");

    let (instrument_types, asset_classes) = create_and_classify(payload).await;

    assert_eq!(instrument_types, ["FUND_MUTUAL"]);
    assert_eq!(asset_classes, ["FIXED_INCOME"]);
}
