use std::sync::Arc;

use diesel::RunQueryDsl;
use rust_decimal::Decimal;
use serde_json::json;
use wealthfolio_core::assets::{
    AlternativeAssetService, AlternativeAssetServiceTrait, AssetKind, AssetRepositoryTrait,
    LinkLiabilityRequest, NewAsset, QuoteMode,
};
use wealthfolio_core::quotes::{Quote, QuoteService, QuoteServiceTrait};
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_core::Result;
use wealthfolio_storage_sqlite::{
    activities::ActivityRepository,
    assets::{AlternativeAssetRepository, AssetRepository},
    db,
    market_data::{MarketDataRepository, QuoteSyncStateRepository},
};

struct NoSecrets;

impl SecretStore for NoSecrets {
    fn get_secret(&self, _: &str) -> Result<Option<String>> {
        panic!("Linking must not access credentials")
    }
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        panic!("Linking must not access credentials")
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        panic!("Linking must not access credentials")
    }
}

#[tokio::test]
async fn property_link_lifecycle_preserves_persisted_mortgage() {
    let dir = tempfile::tempdir().unwrap();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    // No providers or network are needed for this local asset operation.
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
    let quotes = Arc::new(quotes);
    let service = AlternativeAssetService::new(
        Arc::new(AlternativeAssetRepository::new(
            pool.clone(),
            writer.clone(),
        )),
        assets.clone(),
        quotes.clone(),
    );
    let original = json!({
        "sub_type": "mortgage",
        "original_amount": "500000",
        "origination_date": "2020-01-01",
        "purchase_price": "500000",
        "purchase_date": "2020-01-01",
        "custom": { "label": "keep me" },
    });
    for (id, kind, metadata) in [
        ("mortgage", AssetKind::Liability, Some(original.clone())),
        ("home", AssetKind::Property, None),
        ("other-home", AssetKind::Property, None),
    ] {
        assets
            .create(NewAsset {
                id: Some(id.into()),
                kind,
                name: Some(id.into()),
                is_active: true,
                quote_mode: QuoteMode::Manual,
                quote_ccy: "USD".into(),
                metadata,
                ..Default::default()
            })
            .await
            .unwrap();
    }

    for target in ["home", "other-home"] {
        service
            .link_liability(LinkLiabilityRequest {
                liability_id: "mortgage".into(),
                target_asset_id: target.into(),
            })
            .await
            .unwrap();
        // Read through a fresh repository after the write has committed.
        let reader = AssetRepository::new(pool.clone(), writer.clone());
        let persisted = reader.get_by_id("mortgage").unwrap();
        let mut expected = original.clone();
        expected["linked_asset_id"] = json!(target);
        assert_eq!(persisted.metadata, Some(expected));
    }

    // Deleting a linked property must only unlink the mortgage, preserving its
    // identity, details, balance, and valuation history.
    for (id, amount) in [("mortgage", 450000), ("other-home", 600000)] {
        for day in ["2026-01-01T12:00:00Z", "2026-02-01T12:00:00Z"] {
            let value = Decimal::new(amount, 0);
            quotes
                .add_quote(&Quote {
                    id: format!("{id}-{day}"),
                    asset_id: id.into(),
                    timestamp: day.parse().unwrap(),
                    open: value,
                    high: value,
                    low: value,
                    close: value,
                    adjclose: value,
                    currency: "USD".into(),
                    data_source: "MANUAL".into(),
                    created_at: chrono::Utc::now(),
                    ..Default::default()
                })
                .await
                .unwrap();
        }
    }
    let mortgage_before = assets.get_by_id("mortgage").unwrap();
    let history_before = quotes.get_historical_quotes("mortgage").unwrap();
    assert_eq!(history_before.len(), 2);
    service
        .delete_alternative_asset("other-home")
        .await
        .unwrap();

    let mortgage_after = assets.get_by_id("mortgage").unwrap();
    assert_eq!(mortgage_after.kind, AssetKind::Liability);
    assert_eq!(mortgage_after.name, mortgage_before.name);
    assert_eq!(mortgage_after.quote_ccy, mortgage_before.quote_ccy);
    assert_eq!(mortgage_after.is_active, mortgage_before.is_active);
    assert_eq!(mortgage_after.metadata, Some(original));
    assert_eq!(
        quotes.get_historical_quotes("mortgage").unwrap(),
        history_before
    );
    assert!(assets.get_by_id("other-home").is_err());
    assert!(quotes
        .get_historical_quotes("other-home")
        .unwrap()
        .is_empty());
    assert!(assets.get_by_id("home").is_ok());
}
