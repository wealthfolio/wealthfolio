//! Reviewed quote imports on real SQLite: the preview's outcome for each row,
//! the manual quotes the import saves, and the one recalculation event per
//! saving batch.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use std::sync::Arc;

use chrono::{Duration, NaiveDate, Utc};
use diesel::RunQueryDsl;
use rust_decimal::Decimal;
use wealthfolio_core::assets::{AssetKind, AssetRepositoryTrait, NewAsset, QuoteMode};
use wealthfolio_core::events::{DomainEvent, MockDomainEventSink};
use wealthfolio_core::quotes::{
    ImportValidationStatus, Quote, QuoteImportOutcome, QuoteImportRow, QuoteService,
    QuoteServiceTrait, QuoteStore,
};
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
        panic!("Quote imports must not access credentials")
    }
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        panic!("Quote imports must not access credentials")
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        panic!("Quote imports must not access credentials")
    }
}

struct Fixture {
    quotes: QuoteService<
        MarketDataRepository,
        QuoteSyncStateRepository,
        MarketDataRepository,
        AssetRepository,
        ActivityRepository,
    >,
    store: Arc<MarketDataRepository>,
    events: MockDomainEventSink,
    _dir: tempfile::TempDir,
}

const FUND: &str = "fund";
const HOUSE: &str = "house";

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    // Previews and imports read and write local quotes only.
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
    let events = MockDomainEventSink::new();
    let quotes = QuoteService::new(
        market_data.clone(),
        Arc::new(QuoteSyncStateRepository::new(pool.clone(), writer.clone())),
        market_data.clone(),
        assets.clone(),
        Arc::new(ActivityRepository::new(pool.clone(), writer.clone())),
        Arc::new(NoSecrets),
    )
    .await
    .unwrap()
    .with_event_sink(Arc::new(events.clone()));
    for (id, kind) in [(FUND, AssetKind::Investment), (HOUSE, AssetKind::Property)] {
        assets
            .create(NewAsset {
                id: Some(id.into()),
                kind,
                name: Some(id.into()),
                display_code: Some(id.to_uppercase()),
                is_active: true,
                quote_mode: QuoteMode::Manual,
                quote_ccy: "EUR".into(),
                ..Default::default()
            })
            .await
            .unwrap();
    }
    Fixture {
        quotes,
        store: market_data,
        events,
        _dir: dir,
    }
}

fn day(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}

fn stored(id: &str, date: &str, source: &str, close: i64) -> Quote {
    let close = Decimal::new(close, 0);
    Quote {
        id: id.into(),
        asset_id: FUND.into(),
        timestamp: day(date).and_hms_opt(12, 0, 0).unwrap().and_utc(),
        open: close,
        high: close,
        low: close,
        close,
        adjclose: close,
        volume: Decimal::ZERO,
        currency: "EUR".into(),
        data_source: source.into(),
        created_at: Utc::now(),
        notes: None,
    }
}

fn row(asset_id: &str, date: &str, close: Decimal, overwrite: bool) -> QuoteImportRow {
    QuoteImportRow {
        asset_id: asset_id.into(),
        date: date.into(),
        close,
        currency: "EUR".into(),
        overwrite,
    }
}

impl Fixture {
    /// The quote valuations use for `date`.
    fn effective(&self, date: &str) -> Option<Quote> {
        self.quotes
            .get_historical_quotes(FUND)
            .unwrap()
            .into_iter()
            .find(|quote| quote.timestamp.date_naive() == day(date))
    }

    /// Every stored row for `date`, whatever its source.
    fn rows_on(&self, date: &str) -> Vec<(String, Decimal)> {
        let mut rows: Vec<_> = self
            .store
            .find_duplicate_quotes(FUND, day(date))
            .unwrap()
            .into_iter()
            .map(|quote| (quote.data_source, quote.close))
            .collect();
        rows.sort();
        rows
    }

    /// Import the rows the preview would write, as `commit_quote_import` does.
    async fn commit(&self, rows: &[QuoteImportRow]) -> Vec<QuoteImportOutcome> {
        let previews = self.quotes.preview_quote_import(rows).unwrap();
        let writes: Vec<_> = rows
            .iter()
            .zip(&previews)
            .filter(|(_, preview)| preview.outcome.writes())
            .collect();
        if !writes.is_empty() {
            let overwrite = writes.iter().any(|(_, preview)| preview.existing.is_some());
            let imported = self
                .quotes
                .import_quotes(
                    writes.iter().map(|(row, _)| row.to_import()).collect(),
                    overwrite,
                )
                .await
                .unwrap();
            assert!(imported
                .iter()
                .all(|quote| quote.validation_status == ImportValidationStatus::Valid));
        }
        previews
            .into_iter()
            .map(|preview| preview.outcome)
            .collect()
    }
}

#[tokio::test]
async fn preview_reports_each_rows_outcome_without_writing() {
    let fixture = fixture().await;
    fixture
        .quotes
        .add_quote(&stored(
            "fund_2026-06-30_MANUAL",
            "2026-06-30",
            "MANUAL",
            100,
        ))
        .await
        .unwrap();
    fixture
        .quotes
        .add_quote(&stored("fund_2026-06-29_YAHOO", "2026-06-29", "YAHOO", 99))
        .await
        .unwrap();
    fixture
        .quotes
        .add_quote(&stored(
            "fund_2026-06-26_MANUAL",
            "2026-06-26",
            "MANUAL",
            97,
        ))
        .await
        .unwrap();
    fixture.events.clear();

    let tomorrow = (Utc::now().date_naive() + Duration::days(1)).to_string();
    let mut usd = row(FUND, "2026-06-24", Decimal::new(10, 0), false);
    usd.currency = "USD".into();
    let rows = [
        row(FUND, "2026-06-28", Decimal::new(101, 0), false),
        // Same value at another scale: already stored.
        row(FUND, "2026-06-30", Decimal::new(10000, 2), false),
        // A different provider price without overwrite.
        row(FUND, "2026-06-29", Decimal::new(98, 0), false),
        row(FUND, "2026-06-26", Decimal::new(96, 0), true),
        row("missing", "2026-06-25", Decimal::new(10, 0), false),
        row(HOUSE, "2026-06-25", Decimal::new(10, 0), false),
        row(FUND, "2026-13-01", Decimal::new(10, 0), false),
        row(FUND, &tomorrow, Decimal::new(10, 0), false),
        row(FUND, "2026-06-23", Decimal::ZERO, false),
        usd,
        row(FUND, "2026-06-28", Decimal::new(101, 0), false),
    ];
    let previews = fixture.quotes.preview_quote_import(&rows).unwrap();
    let outcomes: Vec<_> = previews.iter().map(|preview| preview.outcome).collect();
    use QuoteImportOutcome::*;
    assert_eq!(
        outcomes,
        vec![
            Create, Skip, Conflict, Update, Invalid, Invalid, Invalid, Invalid, Invalid, Invalid,
            Invalid
        ]
    );

    assert_eq!(previews[0].asset.as_ref().unwrap().id, FUND);
    assert!(previews[0].existing.is_none());
    assert_eq!(previews[1].existing.as_ref().unwrap().data_source, "MANUAL");
    let conflict = &previews[2];
    assert_eq!(conflict.existing.as_ref().unwrap().data_source, "YAHOO");
    assert_eq!(
        conflict.existing.as_ref().unwrap().close,
        Decimal::new(99, 0)
    );
    assert!(conflict.errors[0].contains("set overwrite"), "{conflict:?}");
    let expected_errors = [
        (4, "Asset not found"),
        (5, "Only investment assets"),
        (6, "Invalid date"),
        (7, "in the future"),
        (8, "greater than 0"),
        (9, "does not match the asset's quote currency 'EUR'"),
        (10, "Duplicate of row 0"),
    ];
    for (index, message) in expected_errors {
        assert!(
            previews[index]
                .errors
                .iter()
                .any(|error| error.contains(message)),
            "row {index}: {:?}",
            previews[index].errors
        );
    }

    // Previews write nothing and queue no recalculation.
    assert!(fixture.events.is_empty());
    assert!(fixture.effective("2026-06-28").is_none());
    assert_eq!(
        fixture.effective("2026-06-26").unwrap().close,
        Decimal::new(97, 0)
    );
}

#[tokio::test]
async fn import_emits_one_event_per_saving_batch_and_repeats_as_skips() {
    let fixture = fixture().await;
    let rows = [
        row(FUND, "2026-06-29", Decimal::new(10125, 2), false),
        row(FUND, "2026-06-30", Decimal::new(102, 0), false),
    ];

    use QuoteImportOutcome::*;
    assert_eq!(fixture.commit(&rows).await, vec![Create, Create]);
    assert!(matches!(
        fixture.events.events().as_slice(),
        [DomainEvent::PriceHistoryChanged]
    ));
    let saved = fixture.effective("2026-06-29").unwrap();
    assert_eq!(saved.data_source, "MANUAL");
    assert_eq!(saved.close, Decimal::new(10125, 2));

    // The same rows again change nothing and queue nothing.
    fixture.events.clear();
    assert_eq!(fixture.commit(&rows).await, vec![Skip, Skip]);
    assert!(fixture.events.is_empty());

    // A batch that saves nothing (the quote exists, no overwrite) emits nothing.
    let unchanged = fixture
        .quotes
        .import_quotes(
            vec![row(FUND, "2026-06-30", Decimal::ONE, false).to_import()],
            false,
        )
        .await
        .unwrap();
    assert!(matches!(
        unchanged[0].validation_status,
        ImportValidationStatus::Warning(_)
    ));
    assert!(fixture.events.is_empty());
    assert_eq!(
        fixture.effective("2026-06-30").unwrap().close,
        Decimal::new(102, 0)
    );
}

#[tokio::test]
async fn overwrite_replaces_manual_and_shadows_provider_quotes() {
    let fixture = fixture().await;
    fixture
        .quotes
        .add_quote(&stored("20260629_FUND", "2026-06-29", "MANUAL", 100))
        .await
        .unwrap();
    fixture
        .quotes
        .add_quote(&stored("fund_2026-06-30_YAHOO", "2026-06-30", "YAHOO", 99))
        .await
        .unwrap();
    fixture.events.clear();

    // Without overwrite both rows conflict and nothing changes.
    let rows = [
        row(FUND, "2026-06-29", Decimal::new(105, 0), false),
        row(FUND, "2026-06-30", Decimal::new(104, 0), false),
    ];
    use QuoteImportOutcome::*;
    assert_eq!(fixture.commit(&rows).await, vec![Conflict, Conflict]);
    assert!(fixture.events.is_empty());
    assert_eq!(
        fixture.rows_on("2026-06-29"),
        [("MANUAL".into(), Decimal::new(100, 0))]
    );

    let rows = rows.map(|mut row| {
        row.overwrite = true;
        row
    });
    assert_eq!(fixture.commit(&rows).await, vec![Update, Update]);
    assert_eq!(fixture.events.len(), 1);
    // The manual quote is replaced in place, not duplicated.
    assert_eq!(
        fixture.rows_on("2026-06-29"),
        [("MANUAL".into(), Decimal::new(105, 0))]
    );
    // The provider quote stays beneath the manual one valuations use.
    let effective = fixture.effective("2026-06-30").unwrap();
    assert_eq!(
        (effective.data_source.as_str(), effective.close),
        ("MANUAL", Decimal::new(104, 0))
    );
    let both = [
        ("MANUAL".into(), Decimal::new(104, 0)),
        ("YAHOO".into(), Decimal::new(99, 0)),
    ];
    assert_eq!(fixture.rows_on("2026-06-30"), both);

    // A later provider sync for that day does not displace the manual quote.
    fixture
        .quotes
        .bulk_upsert_quotes(vec![stored(
            "fund_2026-06-30_YAHOO",
            "2026-06-30",
            "YAHOO",
            98,
        )])
        .await
        .unwrap();
    assert_eq!(fixture.rows_on("2026-06-30"), both);
}

/// A statement price equal to the provider's is still saved as a manual quote,
/// so a later provider revision of that day cannot move the valuation.
#[tokio::test]
async fn equal_provider_price_is_saved_as_manual() {
    let fixture = fixture().await;
    fixture
        .quotes
        .add_quote(&stored("fund_2026-06-29_YAHOO", "2026-06-29", "YAHOO", 99))
        .await
        .unwrap();
    fixture.events.clear();
    let rows = [row(FUND, "2026-06-29", Decimal::new(99, 0), false)];

    let preview = fixture.quotes.preview_quote_import(&rows).unwrap();
    assert_eq!(preview[0].outcome, QuoteImportOutcome::Create);
    assert_eq!(preview[0].existing.as_ref().unwrap().data_source, "YAHOO");

    use QuoteImportOutcome::*;
    assert_eq!(fixture.commit(&rows).await, vec![Create]);
    assert_eq!(fixture.events.len(), 1);
    let pinned = [
        ("MANUAL".into(), Decimal::new(99, 0)),
        ("YAHOO".into(), Decimal::new(99, 0)),
    ];
    assert_eq!(fixture.rows_on("2026-06-29"), pinned);

    // A provider revision of that day is skipped beneath the manual quote.
    fixture
        .quotes
        .bulk_upsert_quotes(vec![stored(
            "fund_2026-06-29_YAHOO",
            "2026-06-29",
            "YAHOO",
            97,
        )])
        .await
        .unwrap();
    assert_eq!(fixture.rows_on("2026-06-29"), pinned);

    fixture.events.clear();
    assert_eq!(fixture.commit(&rows).await, vec![Skip]);
    assert!(fixture.events.is_empty());
}

/// Activities, manual snapshots and alternative assets write single quotes;
/// a recalculation of every account from them would escalate their targeted
/// jobs, so only batch imports emit.
#[tokio::test]
async fn single_quote_writes_emit_no_events() {
    let fixture = fixture().await;
    let quote = fixture
        .quotes
        .add_quote(&stored(
            "fund_2026-06-29_MANUAL",
            "2026-06-29",
            "MANUAL",
            100,
        ))
        .await
        .unwrap();
    let mut changed = quote.clone();
    changed.close = Decimal::new(101, 0);
    fixture.quotes.update_quote(changed).await.unwrap();
    fixture.quotes.delete_quote(&quote.id).await.unwrap();
    assert!(fixture.events.is_empty(), "{:?}", fixture.events.events());
}
