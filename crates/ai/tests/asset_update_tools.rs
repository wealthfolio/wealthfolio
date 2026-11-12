//! Asset update tools (#2467) against the mock environment: what is sent to
//! storage, which provider is asked, and what blocks a commit.

#![cfg(feature = "test-utils")]
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};
use wealthfolio_agent_tools::tools::asset_update::{CommitAssetUpdate, PrepareAssetUpdate};
use wealthfolio_agent_tools::AgentTool;
use wealthfolio_ai::env::test_env::{
    MockAccountService, MockAssetService, MockEnvironment, MockHoldingsService, MockQuoteService,
};
use wealthfolio_core::accounts::{Account, TrackingMode};
use wealthfolio_core::assets::{Asset, AssetKind, InstrumentType, QuoteMode};
use wealthfolio_core::quotes::{ProviderInfo, ResolvedQuote};

fn provider(id: &str, enabled: bool) -> ProviderInfo {
    ProviderInfo {
        id: id.to_string(),
        name: id.to_string(),
        description: None,
        url: None,
        enabled,
        priority: 1,
        logo_filename: None,
        capabilities: None,
        requires_api_key: false,
        has_api_key: true,
        asset_count: 0,
        error_count: 0,
        last_synced_at: None,
        last_sync_error: None,
        unique_errors: Vec::new(),
        provider_type: Some("builtin".to_string()),
    }
}

/// AMZN on XNAS stored with EUR quotes, as in #2467.
fn amazon(quote_mode: QuoteMode) -> Asset {
    Asset {
        id: "amzn".to_string(),
        kind: AssetKind::Investment,
        name: Some("Amazon".to_string()),
        display_code: Some("AMZN".to_string()),
        notes: Some("bought through work".to_string()),
        is_active: true,
        quote_mode,
        quote_ccy: "EUR".to_string(),
        instrument_type: Some(InstrumentType::Equity),
        instrument_symbol: Some("AMZN".to_string()),
        instrument_exchange_mic: Some("XNAS".to_string()),
        provider_config: Some(json!({
            "preferred_provider": "YAHOO",
            "overrides": { "YAHOO": { "type": "equity_symbol", "symbol": "AMZN" } },
            "kept_key": 1
        })),
        ..Default::default()
    }
}

struct Fixture {
    env: Arc<MockEnvironment>,
    assets: Arc<MockAssetService>,
    quotes: Arc<MockQuoteService>,
}

fn fixture(asset: Asset, resolved_currency: Option<&str>, conflict: Option<Asset>) -> Fixture {
    fixture_with(asset, resolved_currency, conflict, false)
}

fn fixture_with(
    asset: Asset,
    resolved_currency: Option<&str>,
    conflict: Option<Asset>,
    edited_after_first_read: bool,
) -> Fixture {
    let assets = Arc::new(MockAssetService {
        assets: vec![asset],
        conflicting_asset: conflict,
        edited_after_first_read,
        ..Default::default()
    });
    let quotes = Arc::new(MockQuoteService {
        providers: vec![
            provider("YAHOO", true),
            provider("ALPHA_VANTAGE", false),
            provider("METAL_PRICE_API", true),
        ],
        resolved_quote: ResolvedQuote {
            currency: resolved_currency.map(str::to_string),
            price: Some(rust_decimal::Decimal::new(18512, 2)),
            resolved_provider_id: Some("YAHOO".to_string()),
        },
        ..Default::default()
    });
    let mut env = MockEnvironment::new();
    env.asset_service = assets.clone();
    env.quote_service = quotes.clone();
    Fixture {
        env: Arc::new(env),
        assets,
        quotes,
    }
}

async fn prepare(fixture: &Fixture, args: Value) -> Value {
    PrepareAssetUpdate
        .call(fixture.env.clone(), args)
        .await
        .unwrap()
        .content
}

async fn commit(fixture: &Fixture, args: Value) -> Value {
    CommitAssetUpdate
        .call(fixture.env.clone(), args)
        .await
        .unwrap()
        .content
}

#[tokio::test]
async fn a_disabled_provider_gets_no_request_and_blocks_the_commit() {
    let fixture = fixture(amazon(QuoteMode::Market), Some("USD"), None);
    let args = json!({ "assetId": "amzn", "preferredProvider": "ALPHA_VANTAGE" });

    let preview = prepare(&fixture, args.clone()).await;
    assert_eq!(preview["ready"], false, "{preview}");
    assert!(
        preview["errors"][0].as_str().unwrap().contains("disabled"),
        "{preview}"
    );
    let committed = commit(&fixture, args).await;
    assert_eq!(committed["committed"], false, "{committed}");

    assert_eq!(fixture.quotes.resolve_calls.load(Ordering::SeqCst), 0);
    assert!(fixture.assets.profile_updates.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_currency_the_provider_does_not_quote_is_refused() {
    let fixture = fixture(amazon(QuoteMode::Market), Some("USD"), None);
    let args = json!({ "assetId": "amzn", "quoteCurrency": "chf" });

    let preview = prepare(&fixture, args.clone()).await;
    assert_eq!(preview["ready"], false, "{preview}");
    assert_eq!(preview["providerCheck"]["currency"], "USD", "{preview}");
    assert!(
        preview["errors"][0]
            .as_str()
            .unwrap()
            .contains("in USD, not CHF"),
        "{preview}"
    );
    let committed = commit(&fixture, args).await;
    assert_eq!(committed["committed"], false, "{committed}");
    assert!(fixture.assets.profile_updates.lock().unwrap().is_empty());
    // The preview always asks the provider; the commit asks again.
    assert_eq!(fixture.quotes.resolve_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_partial_update_sends_back_every_field_storage_would_clear() {
    let fixture = fixture(amazon(QuoteMode::Market), Some("USD"), None);
    let args = json!({ "assetId": "amzn", "quoteCurrency": "USD", "keepHistory": true });

    let preview = prepare(&fixture, args.clone()).await;
    assert_eq!(preview["ready"], true, "{preview}");
    assert_eq!(preview["replaceHistory"], false, "{preview}");
    assert_eq!(
        preview["changes"],
        json!([{ "field": "quoteCurrency", "before": "EUR", "after": "USD" }]),
        "{preview}"
    );

    let committed = commit(&fixture, args).await;
    assert_eq!(committed["committed"], true, "{committed}");
    assert!(committed.get("historyReplaced").is_none(), "{committed}");
    let updates = fixture.assets.profile_updates.lock().unwrap();
    let (asset_id, profile) = &updates[0];
    assert_eq!(asset_id, "amzn");
    assert_eq!(profile.quote_ccy.as_deref(), Some("USD"));
    assert_eq!(profile.name.as_deref(), Some("Amazon"));
    assert_eq!(profile.display_code.as_deref(), Some("AMZN"));
    assert_eq!(profile.notes, "bought through work");
    assert_eq!(profile.quote_mode, Some(QuoteMode::Market));
    assert_eq!(profile.kind, Some(AssetKind::Investment));
    assert_eq!(profile.instrument_symbol.as_deref(), Some("AMZN"));
    assert_eq!(profile.instrument_exchange_mic.as_deref(), Some("XNAS"));
    assert_eq!(
        profile.provider_config,
        amazon(QuoteMode::Market).provider_config
    );
    assert!(
        profile.metadata.is_none(),
        "metadata is preserved by omission"
    );
}

#[tokio::test]
async fn a_currency_fix_replaces_the_provider_history_by_default() {
    let fixture = fixture(amazon(QuoteMode::Market), Some("USD"), None);
    let args = json!({ "assetId": "amzn", "quoteCurrency": "USD" });

    let preview = prepare(&fixture, args.clone()).await;
    assert_eq!(preview["replaceHistory"], true, "{preview}");
    let committed = commit(&fixture, args).await;
    assert_eq!(committed["committed"], true, "{committed}");
    // The mock quote service cannot reset; the attempt is reported, the
    // profile update stays.
    assert_eq!(committed["historyError"]["assetId"], "amzn", "{committed}");
    assert_eq!(fixture.assets.profile_updates.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn provider_changes_keep_other_config_and_symbol_overrides() {
    let fixture = fixture(amazon(QuoteMode::Market), Some("EUR"), None);
    let committed = commit(
        &fixture,
        json!({
            "assetId": "amzn",
            "providerSymbol": { "provider": "YAHOO", "symbol": "AMZN.DE" },
            "keepHistory": true
        }),
    )
    .await;
    assert_eq!(committed["committed"], true, "{committed}");
    let updates = fixture.assets.profile_updates.lock().unwrap();
    assert_eq!(
        updates[0].1.provider_config,
        Some(json!({
            "preferred_provider": "YAHOO",
            "overrides": { "YAHOO": { "type": "equity_symbol", "symbol": "AMZN.DE" } },
            "kept_key": 1
        }))
    );
}

#[tokio::test]
async fn a_listing_another_asset_has_blocks_before_any_provider_request() {
    let twin = Asset {
        id: "amzn-xlon".to_string(),
        display_code: Some("AMZN".to_string()),
        ..amazon(QuoteMode::Market)
    };
    let fixture = fixture(amazon(QuoteMode::Market), Some("USD"), Some(twin));
    let preview = prepare(
        &fixture,
        json!({ "assetId": "amzn", "exchangeMic": "xlon" }),
    )
    .await;
    assert_eq!(preview["ready"], false, "{preview}");
    assert_eq!(preview["conflict"]["assetId"], "amzn-xlon", "{preview}");
    assert_eq!(fixture.quotes.resolve_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn manual_assets_change_without_asking_a_provider() {
    let fixture = fixture(amazon(QuoteMode::Manual), None, None);
    let committed = commit(
        &fixture,
        json!({ "assetId": "amzn", "quoteCurrency": "USD" }),
    )
    .await;
    assert_eq!(committed["committed"], true, "{committed}");
    assert!(committed.get("historyError").is_none(), "{committed}");
    assert_eq!(fixture.quotes.resolve_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn bad_requests_are_refused_before_any_service_call() {
    let fixture = fixture(amazon(QuoteMode::Market), Some("USD"), None);
    for args in [
        json!({ "assetId": "amzn" }),
        json!({ "assetId": "amzn", "quoteCurrency": "dollars" }),
        json!({ "assetId": "missing", "quoteCurrency": "USD" }),
        json!({ "assetId": "amzn", "name": "Renamed" }),
    ] {
        assert!(
            PrepareAssetUpdate
                .call(fixture.env.clone(), args.clone())
                .await
                .is_err(),
            "{args}"
        );
    }
    assert_eq!(fixture.quotes.resolve_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_provider_check_uses_symbol_overrides_without_a_preferred_provider() {
    let asset = Asset {
        provider_config: Some(json!({
            "overrides": { "YAHOO": { "type": "equity_symbol", "symbol": "AMZN.DE" } }
        })),
        ..amazon(QuoteMode::Market)
    };
    let fixture = fixture(asset, Some("USD"), None);
    prepare(
        &fixture,
        json!({ "assetId": "amzn", "quoteCurrency": "USD" }),
    )
    .await;
    let asked = fixture.quotes.resolved_assets.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].quote_ccy, "USD");
    assert_eq!(
        asked[0].provider_config,
        Some(json!({
            "overrides": { "YAHOO": { "type": "equity_symbol", "symbol": "AMZN.DE" } }
        }))
    );
}

#[tokio::test]
async fn metal_symbols_are_stored_with_their_quote_currency() {
    let gold = Asset {
        id: "gold".to_string(),
        kind: AssetKind::Investment,
        quote_ccy: "USD".to_string(),
        quote_mode: QuoteMode::Market,
        instrument_type: Some(InstrumentType::Metal),
        instrument_symbol: Some("XAU".to_string()),
        ..Default::default()
    };
    let fixture = fixture(gold, Some("USD"), None);
    let committed = commit(
        &fixture,
        json!({
            "assetId": "gold",
            "providerSymbol": { "provider": "METAL_PRICE_API", "symbol": "XAU" },
            "keepHistory": true
        }),
    )
    .await;
    assert_eq!(committed["committed"], true, "{committed}");
    let updates = fixture.assets.profile_updates.lock().unwrap();
    assert_eq!(
        updates[0].1.provider_config,
        Some(json!({
            "overrides": {
                "METAL_PRICE_API": { "type": "metal_symbol", "symbol": "XAU", "quote": "USD" }
            }
        }))
    );
}

#[tokio::test]
async fn an_edit_during_the_provider_check_is_not_overwritten() {
    let fixture = fixture_with(amazon(QuoteMode::Market), Some("USD"), None, true);
    let committed = commit(
        &fixture,
        json!({ "assetId": "amzn", "quoteCurrency": "USD", "keepHistory": true }),
    )
    .await;
    assert_eq!(committed["committed"], false, "{committed}");
    assert!(
        committed["errors"][0]
            .as_str()
            .unwrap()
            .contains("changed while it was being checked"),
        "{committed}"
    );
    assert!(fixture.assets.profile_updates.lock().unwrap().is_empty());
}

#[tokio::test]
async fn switching_to_market_asks_the_provider_and_refuses_another_currency() {
    let mismatch = fixture(amazon(QuoteMode::Manual), Some("USD"), None);
    let args = json!({ "assetId": "amzn", "quoteMode": "MARKET" });
    let preview = prepare(&mismatch, args.clone()).await;
    assert_eq!(preview["ready"], false, "{preview}");
    assert!(
        preview["errors"][0]
            .as_str()
            .unwrap()
            .contains("in USD, not EUR"),
        "{preview}"
    );
    let committed = commit(&mismatch, args).await;
    assert_eq!(committed["committed"], false, "{committed}");
    assert!(mismatch.assets.profile_updates.lock().unwrap().is_empty());

    let silent = fixture(amazon(QuoteMode::Manual), None, None);
    let preview = prepare(&silent, json!({ "assetId": "amzn", "quoteMode": "MARKET" })).await;
    assert_eq!(preview["ready"], false, "{preview}");
    assert!(
        preview["errors"][0]
            .as_str()
            .unwrap()
            .starts_with("YAHOO returned no quote for AMZN on XNAS;"),
        "{preview}"
    );

    // Without a preferred provider, the message must not read as a double negative.
    let unrouted = Asset {
        provider_config: None,
        ..amazon(QuoteMode::Manual)
    };
    let preview = prepare(
        &fixture(unrouted, None, None),
        json!({ "assetId": "amzn", "quoteMode": "MARKET" }),
    )
    .await;
    assert_eq!(
        preview["errors"][0],
        "No enabled provider returned a quote for AMZN on XNAS; check the symbol, exchange and provider",
        "{preview}"
    );
}

#[tokio::test]
async fn pence_codes_match_each_other_but_not_pounds() {
    let lse = || Asset {
        quote_ccy: "GBP".to_string(),
        instrument_exchange_mic: Some("XLON".to_string()),
        ..amazon(QuoteMode::Market)
    };
    let fixture = fixture(lse(), Some("GBp"), None);
    let preview = prepare(
        &fixture,
        json!({ "assetId": "amzn", "quoteCurrency": "GBX" }),
    )
    .await;
    assert_eq!(preview["ready"], true, "{preview}");

    let fixture = fixture_with(
        Asset {
            quote_ccy: "GBX".to_string(),
            ..lse()
        },
        Some("GBp"),
        None,
        false,
    );
    let preview = prepare(
        &fixture,
        json!({ "assetId": "amzn", "quoteCurrency": "GBP" }),
    )
    .await;
    assert_eq!(preview["ready"], false, "{preview}");
}

#[tokio::test]
async fn accounts_whose_holdings_cannot_be_read_are_reported() {
    let ts = chrono::NaiveDate::from_ymd_opt(2024, 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    let account = Account {
        id: "broker".to_string(),
        name: "Broker".to_string(),
        account_type: "SECURITIES".to_string(),
        group: None,
        currency: "USD".to_string(),
        is_default: false,
        is_active: true,
        created_at: ts,
        updated_at: ts,
        platform_id: None,
        account_number: None,
        meta: None,
        provider: None,
        provider_account_id: None,
        is_archived: false,
        tracking_mode: TrackingMode::Transactions,
    };
    let base = fixture(amazon(QuoteMode::Market), Some("USD"), None);
    let mut env = MockEnvironment::new();
    env.asset_service = base.assets.clone();
    env.quote_service = base.quotes.clone();
    env.account_service = Arc::new(MockAccountService {
        accounts: vec![account],
    });
    env.holdings_service = Arc::new(MockHoldingsService {
        incomplete_account_ids: vec!["broker".to_string()],
        ..Default::default()
    });
    let fixture = Fixture {
        env: Arc::new(env),
        ..base
    };
    let preview = prepare(
        &fixture,
        json!({ "assetId": "amzn", "quoteCurrency": "USD" }),
    )
    .await;
    assert_eq!(
        preview["incompleteAccountIds"],
        json!(["broker"]),
        "{preview}"
    );
    assert!(
        preview["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("could not be read")),
        "{preview}"
    );
}

#[tokio::test]
async fn an_override_of_the_wrong_type_can_be_repaired_with_the_same_symbol() {
    let gold = Asset {
        id: "gold".to_string(),
        kind: AssetKind::Investment,
        quote_ccy: "USD".to_string(),
        quote_mode: QuoteMode::Market,
        instrument_type: Some(InstrumentType::Metal),
        instrument_symbol: Some("XAU".to_string()),
        provider_config: Some(json!({
            "overrides": { "METAL_PRICE_API": { "type": "equity_symbol", "symbol": "XAU" } }
        })),
        ..Default::default()
    };
    let fixture = fixture(gold, Some("USD"), None);
    let preview = prepare(
        &fixture,
        json!({
            "assetId": "gold",
            "providerSymbol": { "provider": "METAL_PRICE_API", "symbol": "XAU" }
        }),
    )
    .await;
    assert_eq!(
        preview["changes"][0]["field"], "providerOverrides",
        "{preview}"
    );
    assert_eq!(
        preview["changes"][0]["after"]["METAL_PRICE_API"]["type"], "metal_symbol",
        "{preview}"
    );
    assert_eq!(preview["replaceHistory"], true, "{preview}");
}

#[tokio::test]
async fn switching_back_to_market_replaces_the_provider_history() {
    let fixture = fixture(amazon(QuoteMode::Manual), Some("EUR"), None);
    let preview = prepare(
        &fixture,
        json!({ "assetId": "amzn", "quoteMode": "MARKET" }),
    )
    .await;
    assert_eq!(preview["ready"], true, "{preview}");
    assert_eq!(preview["replaceHistory"], true, "{preview}");
    let kept = prepare(
        &fixture,
        json!({ "assetId": "amzn", "quoteMode": "MARKET", "keepHistory": true }),
    )
    .await;
    assert_eq!(kept["replaceHistory"], false, "{kept}");
}

#[tokio::test]
async fn a_crypto_asset_can_move_to_a_stablecoin_quote() {
    let btc = Asset {
        id: "btc".to_string(),
        kind: AssetKind::Investment,
        quote_ccy: "USD".to_string(),
        quote_mode: QuoteMode::Market,
        instrument_type: Some(InstrumentType::Crypto),
        instrument_symbol: Some("BTC".to_string()),
        ..Default::default()
    };
    let fixture = fixture(btc, Some("USDT"), None);
    let preview = prepare(
        &fixture,
        json!({ "assetId": "btc", "quoteCurrency": "USDT" }),
    )
    .await;
    assert_eq!(preview["ready"], true, "{preview}");
}
