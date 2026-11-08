//! Symbol search on real SQLite: which existing assets it reports as exactly
//! what the query names. The local search matches substrings of symbols and
//! names, so only the identity and alias lookups count as exact (#2405).
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use diesel::RunQueryDsl;
use wealthfolio_core::assets::{AssetKind, AssetRepositoryTrait, InstrumentType, NewAsset};
use wealthfolio_core::quotes::{search_result_matches_query, QuoteService, QuoteServiceTrait};
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
        Ok(None)
    }
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        panic!("Symbol search must not store credentials")
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        panic!("Symbol search must not delete credentials")
    }
}

type Quotes = QuoteService<
    MarketDataRepository,
    QuoteSyncStateRepository,
    MarketDataRepository,
    AssetRepository,
    ActivityRepository,
>;

/// A quote service over local assets only: every provider is disabled, so the
/// search makes no outbound request.
async fn service(dir: &common::TestDir, assets: Vec<NewAsset>) -> Quotes {
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
    let asset_repo = Arc::new(AssetRepository::new(pool.clone(), writer.clone()));
    for asset in assets {
        asset_repo.create(asset).await.unwrap();
    }
    let market_data = Arc::new(MarketDataRepository::new(pool.clone(), writer.clone()));
    QuoteService::new(
        market_data.clone(),
        Arc::new(QuoteSyncStateRepository::new(pool.clone(), writer.clone())),
        market_data,
        asset_repo,
        Arc::new(ActivityRepository::new(pool, writer)),
        Arc::new(NoSecrets),
    )
    .await
    .unwrap()
}

fn equity(id: &str, symbol: &str, name: &str) -> NewAsset {
    NewAsset {
        id: Some(id.into()),
        kind: AssetKind::Investment,
        name: Some(name.into()),
        display_code: Some(symbol.into()),
        is_active: true,
        quote_ccy: "USD".into(),
        instrument_type: Some(InstrumentType::Equity),
        instrument_symbol: Some(symbol.into()),
        instrument_exchange_mic: Some("XNYS".into()),
        ..Default::default()
    }
}

/// Whether the search returned `asset_id` and counts it as what `query` names.
async fn matches(quotes: &Quotes, query: &str, asset_id: &str) -> bool {
    let results = quotes
        .search_symbol_with_currency(query, None)
        .await
        .unwrap();
    let result = results
        .iter()
        .find(|result| result.existing_asset_id.as_deref() == Some(asset_id))
        .unwrap_or_else(|| panic!("search for {query} did not return {asset_id}: {results:?}"));
    search_result_matches_query(result, query)
}

#[tokio::test]
async fn provider_alias_is_an_exact_match() {
    let dir = common::TestDir::new();
    let mut acme = equity("acme", "ACME", "Acme Corp");
    acme.provider_config = Some(serde_json::json!({
        "preferred_provider": "YAHOO",
        "overrides": { "YAHOO": { "type": "equity_symbol", "symbol": "ACME-OLD" } }
    }));
    let quotes = service(&dir, vec![acme]).await;

    assert!(matches(&quotes, "ACME-OLD", "acme").await);
    assert!(matches(&quotes, "ACME", "acme").await);
    // Part of the symbol is a substring hit, not the asset.
    assert!(!matches(&quotes, "ACM", "acme").await);
}

#[tokio::test]
async fn isin_in_a_name_is_not_an_exact_match() {
    let dir = common::TestDir::new();
    let note = equity("note", "ZZNOTE", "Note on US0378331005");
    let quotes = service(&dir, vec![note]).await;

    assert!(!matches(&quotes, "US0378331005", "note").await);
}
