#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use std::sync::Arc;

use diesel::RunQueryDsl;
use rust_decimal::Decimal;
use serde_json::json;
use wealthfolio_core::assets::loan::{
    event_entries, BalanceEdit, LoanAction, LoanEvent, LoanFrequency, LoanRecord, LoanUpdate,
    RENEWAL_MATURITY_KEY,
};
use wealthfolio_core::assets::{
    AlternativeAssetRepositoryTrait, AlternativeAssetService, AlternativeAssetServiceTrait,
    AssetKind, AssetRepositoryTrait, NewAsset, QuoteMode,
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
        panic!("Loan actions must not access credentials")
    }
    fn set_secret(&self, _: &str, _: &str) -> Result<()> {
        panic!("Loan actions must not access credentials")
    }
    fn delete_secret(&self, _: &str) -> Result<()> {
        panic!("Loan actions must not access credentials")
    }
}

struct Fixture {
    service: AlternativeAssetService,
    repository: Arc<AlternativeAssetRepository>,
    assets: Arc<AssetRepository>,
    quotes: Arc<dyn QuoteServiceTrait>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn metadata(&self) -> serde_json::Value {
        self.assets.get_by_id("mortgage").unwrap().metadata.unwrap()
    }

    fn balances(&self) -> Vec<(String, Decimal, Option<String>)> {
        self.quotes
            .get_historical_quotes("mortgage")
            .unwrap()
            .into_iter()
            .map(|q| (q.timestamp.date_naive().to_string(), q.close, q.notes))
            .collect()
    }
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let access = db::DbAccess::plaintext(dir.path().join("app.db").to_str().unwrap());
    access.prepare().unwrap();
    access.run_migrations().unwrap();
    let pool = access.create_pool().unwrap();
    // No providers or network are needed for local loan writes.
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
    let repository = Arc::new(AlternativeAssetRepository::new(
        pool.clone(),
        writer.clone(),
    ));
    let service = AlternativeAssetService::new(repository.clone(), assets.clone(), quotes.clone());
    assets
        .create(NewAsset {
            id: Some("mortgage".into()),
            kind: AssetKind::Liability,
            name: Some("Mortgage".into()),
            is_active: true,
            quote_mode: QuoteMode::Manual,
            quote_ccy: "CAD".into(),
            metadata: Some(json!({
                "sub_type": "mortgage",
                "loan_projection": json!({"version":1,"annualRate":0,"paymentAmount":100,"frequency":"monthly","firstPaymentDate":"2026-02-01","amortizationEndDate":"2030-01-01"}).to_string(),
            })),
            ..Default::default()
        })
        .await
        .unwrap();
    let value = Decimal::new(5000, 0);
    quotes
        .add_quote(&Quote {
            id: "mortgage_2026-01-01_MANUAL".into(),
            asset_id: "mortgage".into(),
            timestamp: "2026-01-01T00:00:00Z".parse().unwrap(),
            open: value,
            high: value,
            low: value,
            close: value,
            adjclose: value,
            currency: "CAD".into(),
            data_source: "MANUAL".into(),
            created_at: chrono::Utc::now(),
            ..Default::default()
        })
        .await
        .unwrap();
    Fixture {
        service,
        repository,
        assets,
        quotes,
        _dir: dir,
    }
}

fn renewal(frequency: Option<LoanFrequency>, payment: Option<f64>) -> LoanAction {
    LoanAction::Renew {
        date: "2026-03-10".parse().unwrap(),
        annual_rate: 3.0,
        payment_amount: payment,
        frequency,
        interest_method: None,
        term_end_date: Some("2031-03-10".parse().unwrap()),
        balance: Some(4700.0),
    }
}

#[tokio::test]
async fn a_renewal_writes_its_balance_and_terms_together_or_not_at_all() {
    let loan = fixture().await;
    let before = (loan.metadata(), loan.balances());

    let refused = loan
        .service
        .apply_loan_action("mortgage", renewal(Some(LoanFrequency::Biweekly), None))
        .await
        .unwrap_err();
    assert_eq!(refused.to_string(), "LOAN_PAYMENT_REQUIRED");
    assert_eq!((loan.metadata(), loan.balances()), before);

    let result = loan
        .service
        .apply_loan_action(
            "mortgage",
            renewal(Some(LoanFrequency::Biweekly), Some(60.0)),
        )
        .await
        .unwrap();
    assert!(result.balances_changed);
    let metadata = loan.metadata();
    let events: Vec<_> = event_entries(&metadata)
        .iter()
        .filter_map(LoanEvent::parse)
        .collect();
    assert!(matches!(
        events[..],
        [LoanEvent::Renewal {
            frequency: Some(LoanFrequency::Biweekly),
            ..
        }]
    ));
    assert_eq!(metadata[RENEWAL_MATURITY_KEY], "2031-03-10");
    assert_eq!(metadata["sub_type"], "mortgage");
    let renewal_day = loan.balances();
    let renewal_day = renewal_day
        .iter()
        .find(|(day, ..)| day == "2026-03-10")
        .unwrap();
    assert_eq!(renewal_day.1, Decimal::new(4700, 0));
    assert_eq!(
        renewal_day.2.as_deref(),
        Some("loan_event|type=balance_correction")
    );
}

#[tokio::test]
async fn each_action_builds_on_what_is_stored() {
    let loan = fixture().await;
    for day in ["2026-04-10", "2026-05-10"] {
        let result = loan
            .service
            .apply_loan_action(
                "mortgage",
                LoanAction::ExtraRepayment {
                    date: day.parse().unwrap(),
                    amount: 100.0,
                },
            )
            .await
            .unwrap();
        assert!(!result.balances_changed);
    }
    let dates: Vec<_> = event_entries(&loan.metadata())
        .iter()
        .filter_map(LoanEvent::parse)
        .map(|event| event.date().to_string())
        .collect();
    assert_eq!(dates, ["2026-04-10", "2026-05-10"]);
}

#[tokio::test]
async fn moving_a_balance_replaces_it_in_one_change() {
    let loan = fixture().await;
    loan.service
        .apply_loan_action(
            "mortgage",
            LoanAction::EditBalance {
                quote_id: "mortgage_2026-01-01_MANUAL".into(),
                replacement: Some(BalanceEdit {
                    date: "2026-01-15".parse().unwrap(),
                    balance: 4900.0,
                    note: "Statement".into(),
                }),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        loan.balances(),
        [(
            "2026-01-15".to_string(),
            Decimal::new(4900, 0),
            Some("Statement".to_string())
        )]
    );
}

#[tokio::test]
async fn loan_actions_only_apply_to_liabilities() {
    let loan = fixture().await;
    loan.assets
        .create(NewAsset {
            id: Some("home".into()),
            kind: AssetKind::Property,
            name: Some("Home".into()),
            is_active: true,
            quote_mode: QuoteMode::Manual,
            quote_ccy: "CAD".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(loan
        .service
        .apply_loan_action(
            "home",
            LoanAction::Close {
                date: "2026-03-01".parse().unwrap()
            }
        )
        .await
        .is_err());
}

#[tokio::test]
async fn a_write_that_fails_after_the_metadata_change_leaves_the_loan_untouched() {
    let loan = fixture().await;
    let before = (loan.metadata(), loan.balances());
    let result = loan
        .repository
        .update_loan(
            "mortgage",
            Box::new(|record: &LoanRecord| {
                let mut metadata = record.metadata.clone();
                metadata["sub_type"] = json!("auto");
                // A quote for an asset that does not exist fails its foreign key
                // after the metadata row has already been updated.
                let mut orphan = record.balances[0].clone();
                orphan.asset_id = "missing".into();
                orphan.id = "missing_2026-01-02_MANUAL".into();
                Ok(LoanUpdate {
                    metadata: Some(metadata),
                    save_balances: vec![orphan],
                    delete_balances: vec![],
                })
            }),
        )
        .await;
    let error = result.unwrap_err().to_string();
    assert!(error.contains("FOREIGN KEY"), "{error}");
    assert_eq!((loan.metadata(), loan.balances()), before);
}

#[tokio::test]
async fn confirming_a_day_with_a_creation_quote_replaces_it() {
    let loan = fixture().await;
    // Creation records its opening balance under a random id at midday UTC.
    let value = Decimal::new(4800, 0);
    loan.quotes
        .add_quote(&Quote {
            id: "6f0c8a52-3c1e-4c55-9d8e-1b7f0e1c2d3a".into(),
            asset_id: "mortgage".into(),
            timestamp: "2026-01-20T12:00:00Z".parse().unwrap(),
            open: value,
            high: value,
            low: value,
            close: value,
            adjclose: value,
            currency: "CAD".into(),
            data_source: "MANUAL".into(),
            created_at: chrono::Utc::now(),
            ..Default::default()
        })
        .await
        .unwrap();
    loan.service
        .apply_loan_action(
            "mortgage",
            LoanAction::ConfirmBalance {
                date: "2026-01-20".parse().unwrap(),
                balance: 4750.0,
            },
        )
        .await
        .unwrap();
    let on_day: Vec<_> = loan
        .balances()
        .into_iter()
        .filter(|(day, ..)| day == "2026-01-20")
        .collect();
    assert_eq!(on_day.len(), 1);
    assert_eq!(on_day[0].1, Decimal::new(4750, 0));
}
