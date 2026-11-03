//! Manual quotes on two devices: the outbox rows that saving, editing and
//! deleting them on one device write, and those rows replayed on the other.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
mod common;

use std::sync::Arc;

use chrono::{NaiveDate, Utc};
use diesel::prelude::*;
use rust_decimal::Decimal;
use wealthfolio_core::assets::{AssetKind, AssetRepositoryTrait, NewAsset, QuoteMode};
use wealthfolio_core::quotes::{Quote, QuoteService, QuoteServiceTrait};
use wealthfolio_core::secrets::SecretStore;
use wealthfolio_core::sync::{SyncEntity, SyncOperation, SyncOutboxEvent};
use wealthfolio_core::Result;
use wealthfolio_storage_sqlite::schema::quotes;
use wealthfolio_storage_sqlite::{
    activities::ActivityRepository,
    assets::AssetRepository,
    db,
    market_data::{MarketDataRepository, QuoteDB, QuoteSyncStateRepository},
    sync::app_sync::AppSyncRepository,
};

const PENSION: &str = "pension";
const JUNE: &str = "2026-06-30";
const OCTOBER: &str = "2026-10-01";
const VALUATION_ID: &str = "0b8a5a54-6c1e-4d6b-9a37-3f0c5e2d9b11";

struct NoSecrets;

impl SecretStore for NoSecrets {
    fn get_secret(&self, _: &str) -> Result<Option<String>> {
        panic!("Manual quotes must not access credentials")
    }
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        panic!("Manual quotes must not access credentials")
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        panic!("Manual quotes must not access credentials")
    }
}

struct Device {
    quotes: QuoteService<
        MarketDataRepository,
        QuoteSyncStateRepository,
        MarketDataRepository,
        AssetRepository,
        ActivityRepository,
    >,
    sync: AppSyncRepository,
    pool: Arc<db::DbPool>,
    _dir: common::TestDir,
}

/// A device holding the manually valued pension asset.
async fn device() -> Device {
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
    assets
        .create(NewAsset {
            id: Some(PENSION.into()),
            kind: AssetKind::Other,
            name: Some("DB Pension".into()),
            display_code: Some("PENSION".into()),
            is_active: true,
            quote_mode: QuoteMode::Manual,
            quote_ccy: "GBP".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let sync = AppSyncRepository::new(pool.clone(), writer);
    let device = Device {
        quotes,
        sync,
        pool,
        _dir: dir,
    };
    push(&device).await;
    device
}

fn quote(id: &str, date: &str, source: &str, close: i64) -> Quote {
    let close = Decimal::new(close, 0);
    Quote {
        id: id.into(),
        asset_id: PENSION.into(),
        timestamp: NaiveDate::parse_from_str(date, "%Y-%m-%d")
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
        currency: "GBP".into(),
        data_source: source.into(),
        created_at: Utc::now(),
        notes: None,
    }
}

fn manual_id(date: &str) -> String {
    format!("{PENSION}_{date}_MANUAL")
}

/// The device's pending quote events, oldest first, as the next push sends
/// them; all its pending events are then marked sent.
async fn push(device: &Device) -> Vec<SyncOutboxEvent> {
    let events = device.sync.list_pending_outbox(1_000).unwrap();
    device
        .sync
        .mark_outbox_sent(events.iter().map(|e| e.event_id.clone()).collect())
        .await
        .unwrap();
    events
        .into_iter()
        .filter(|e| e.entity == SyncEntity::Quote)
        .collect()
}

fn ops(events: &[SyncOutboxEvent]) -> Vec<(SyncOperation, &str)> {
    events
        .iter()
        .map(|e| (e.op, e.entity_id.as_str()))
        .collect()
}

/// Replays events on the device in one pull batch, numbered from `seq`.
async fn pull(device: &Device, events: &[SyncOutboxEvent], seq: i64) -> usize {
    device
        .sync
        .apply_remote_events_lww_batch(
            events
                .iter()
                .zip(seq..)
                .map(|(e, seq)| {
                    (
                        e.entity,
                        e.entity_id.clone(),
                        e.op,
                        e.event_id.clone(),
                        e.client_timestamp.clone(),
                        seq,
                        serde_json::from_str(&e.payload).unwrap(),
                    )
                })
                .collect(),
        )
        .await
        .unwrap()
}

fn rows(device: &Device) -> Vec<QuoteDB> {
    quotes::table
        .filter(quotes::asset_id.eq(PENSION))
        .order(quotes::id)
        .select(QuoteDB::as_select())
        .load(&mut db::get_connection(&device.pool).unwrap())
        .unwrap()
}

/// The day from which the portfolio revalues the pension's holders.
fn revalue_from(device: &Device) -> Option<String> {
    #[derive(QueryableByName)]
    struct Marker {
        #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
        dirty_from: Option<String>,
    }
    diesel::sql_query("SELECT dirty_from FROM projection_state WHERE scope = 'q:' || ?")
        .bind::<diesel::sql_types::Text, _>(PENSION)
        .get_result::<Marker>(&mut db::get_connection(&device.pool).unwrap())
        .optional()
        .unwrap()
        .and_then(|marker| marker.dirty_from)
}

/// What a projection run does once it has revalued.
fn consume_markers(device: &Device) {
    diesel::sql_query("DELETE FROM projection_state")
        .execute(&mut db::get_connection(&device.pool).unwrap())
        .unwrap();
}

#[tokio::test]
async fn history_table_add_edit_and_delete_sync_their_manual_id() {
    let (sender, receiver) = (device().await, device().await);
    let id = manual_id(OCTOBER);

    // A row added in the table carries the grid's own id until it is saved.
    sender
        .quotes
        .update_quote(quote("20261001_PENSION", OCTOBER, "MANUAL", 158_000))
        .await
        .unwrap();
    let added = push(&sender).await;
    assert_eq!(ops(&added), [(SyncOperation::Create, id.as_str())]);

    sender
        .quotes
        .update_quote(quote(&id, OCTOBER, "MANUAL", 158_100))
        .await
        .unwrap();
    let edited = push(&sender).await;
    assert_eq!(ops(&edited), [(SyncOperation::Update, id.as_str())]);

    assert_eq!(pull(&receiver, &[added, edited].concat(), 1).await, 2);
    assert_eq!(rows(&receiver), rows(&sender));
    assert_eq!(rows(&receiver)[0].close, "158100");

    sender.quotes.delete_quote(&id).await.unwrap();
    let deleted = push(&sender).await;
    assert_eq!(ops(&deleted), [(SyncOperation::Delete, id.as_str())]);

    assert_eq!(pull(&receiver, &deleted, 3).await, 1);
    assert!(rows(&receiver).is_empty());
}

#[tokio::test]
async fn provider_quotes_write_no_outbox_rows() {
    let sender = device().await;
    let id = format!("{PENSION}_{JUNE}_YAHOO");

    sender
        .quotes
        .add_quote(&quote(&id, JUNE, "YAHOO", 100))
        .await
        .unwrap();
    sender
        .quotes
        .bulk_upsert_quotes(vec![
            quote(&id, JUNE, "YAHOO", 101),
            quote(&format!("{PENSION}_{OCTOBER}_YAHOO"), OCTOBER, "YAHOO", 102),
        ])
        .await
        .unwrap();
    sender.quotes.delete_quote(&id).await.unwrap();

    assert_eq!(rows(&sender).len(), 1);
    assert!(push(&sender).await.is_empty());
}

#[tokio::test]
async fn editing_a_valuation_in_the_history_table_writes_its_delete_then_the_manual_create() {
    let sender = device().await;

    // The Update valuation dialog saves under a fresh UUID.
    sender
        .quotes
        .add_quote(&quote(VALUATION_ID, JUNE, "MANUAL", 150_000))
        .await
        .unwrap();
    assert_eq!(
        ops(&push(&sender).await),
        [(SyncOperation::Create, VALUATION_ID)]
    );

    sender
        .quotes
        .update_quote(quote(VALUATION_ID, JUNE, "MANUAL", 158_100))
        .await
        .unwrap();
    assert_eq!(
        ops(&push(&sender).await),
        [
            (SyncOperation::Delete, VALUATION_ID),
            (SyncOperation::Create, manual_id(JUNE).as_str()),
        ]
    );
}

#[tokio::test]
async fn an_edited_valuation_reaches_the_other_device_in_one_batch() {
    edited_valuation_reaches_the_other_device(false).await;
}

#[tokio::test]
async fn an_edited_valuation_reaches_the_other_device_across_batches() {
    edited_valuation_reaches_the_other_device(true).await;
}

async fn edited_valuation_reaches_the_other_device(split: bool) {
    let (sender, receiver) = (device().await, device().await);
    sender
        .quotes
        .add_quote(&quote(VALUATION_ID, JUNE, "MANUAL", 150_000))
        .await
        .unwrap();
    assert_eq!(pull(&receiver, &push(&sender).await, 1).await, 1);
    assert_eq!(rows(&receiver), rows(&sender));
    consume_markers(&receiver);

    sender
        .quotes
        .update_quote(quote(VALUATION_ID, JUNE, "MANUAL", 158_100))
        .await
        .unwrap();
    let edit = push(&sender).await;
    let applied = if split {
        let (delete, create) = edit.split_at(1);
        let applied = pull(&receiver, delete, 2).await;
        assert!(rows(&receiver).is_empty());
        consume_markers(&receiver);
        applied + pull(&receiver, create, 3).await
    } else {
        pull(&receiver, &edit, 2).await
    };

    // The replacement takes the deleted row's asset, day and source.
    assert_eq!(applied, 2);
    let received = rows(&receiver);
    assert_eq!(received, rows(&sender));
    assert_eq!(
        (received[0].id.as_str(), received[0].close.as_str()),
        (manual_id(JUNE).as_str(), "158100")
    );
    assert_eq!(revalue_from(&receiver).as_deref(), Some(JUNE));
}

#[tokio::test]
async fn a_history_row_deleted_then_added_again_reaches_the_other_device() {
    let (sender, receiver) = (device().await, device().await);
    let id = manual_id(OCTOBER);
    sender
        .quotes
        .update_quote(quote("20261001_PENSION", OCTOBER, "MANUAL", 158_000))
        .await
        .unwrap();
    assert_eq!(pull(&receiver, &push(&sender).await, 1).await, 1);
    sender.quotes.delete_quote(&id).await.unwrap();
    assert_eq!(pull(&receiver, &push(&sender).await, 2).await, 1);
    assert!(rows(&receiver).is_empty());

    // The day's id comes back with the re-entered value.
    sender
        .quotes
        .update_quote(quote("20261001_PENSION", OCTOBER, "MANUAL", 158_100))
        .await
        .unwrap();
    let added = push(&sender).await;
    assert_eq!(ops(&added), [(SyncOperation::Create, id.as_str())]);
    assert_eq!(pull(&receiver, &added, 3).await, 1);
    assert_eq!(rows(&receiver), rows(&sender));
}

#[tokio::test]
async fn a_history_row_moved_to_another_day_and_back_reaches_the_other_device() {
    let (sender, receiver) = (device().await, device().await);
    let (june, october) = (manual_id(JUNE), manual_id(OCTOBER));
    sender
        .quotes
        .update_quote(quote("20260630_PENSION", JUNE, "MANUAL", 150_000))
        .await
        .unwrap();
    assert_eq!(pull(&receiver, &push(&sender).await, 1).await, 1);

    // A row whose date changes is saved under the new day's id.
    sender
        .quotes
        .update_quote(quote(&june, OCTOBER, "MANUAL", 150_000))
        .await
        .unwrap();
    let moved = push(&sender).await;
    assert_eq!(
        ops(&moved),
        [
            (SyncOperation::Delete, june.as_str()),
            (SyncOperation::Create, october.as_str()),
        ]
    );
    assert_eq!(pull(&receiver, &moved, 2).await, 2);

    sender
        .quotes
        .update_quote(quote(&october, JUNE, "MANUAL", 150_000))
        .await
        .unwrap();
    let back = push(&sender).await;
    assert_eq!(
        ops(&back),
        [
            (SyncOperation::Delete, october.as_str()),
            (SyncOperation::Create, june.as_str()),
        ]
    );
    assert_eq!(pull(&receiver, &back, 4).await, 2);
    assert_eq!(rows(&receiver), rows(&sender));
    assert_eq!(rows(&receiver)[0].id, june);
}
