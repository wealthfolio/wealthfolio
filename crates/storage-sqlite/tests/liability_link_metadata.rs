use std::sync::Arc;

use diesel::RunQueryDsl;
use serde_json::json;
use wealthfolio_core::assets::{
    AlternativeAssetService, AlternativeAssetServiceTrait, AssetKind, AssetRepositoryTrait,
    LinkLiabilityRequest, NewAsset, QuoteMode,
};
use wealthfolio_core::quotes::QuoteService;
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
async fn linking_and_relinking_preserve_persisted_mortgage_metadata() {
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
    let service = AlternativeAssetService::new(
        Arc::new(AlternativeAssetRepository::new(
            pool.clone(),
            writer.clone(),
        )),
        assets.clone(),
        Arc::new(quotes),
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
}
