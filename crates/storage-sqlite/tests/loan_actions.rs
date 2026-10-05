#![allow(clippy::unwrap_used, clippy::panic, reason = "test code")]
use std::sync::Arc;

use chrono::NaiveDate;
use diesel::RunQueryDsl;
use rust_decimal::Decimal;
use serde_json::json;
use wealthfolio_core::activities::ActivityRepositoryTrait;
use wealthfolio_core::assets::loan::{
    event_entries, BalanceEdit, LoanAction, LoanEvent, LoanFrequency, LoanRecord, LoanSchedule,
    LoanSetup, LoanTerms, LoanUpdate, PaymentLink, PaymentTarget, PAYMENT_ACCOUNT_KEY,
    RENEWAL_MATURITY_KEY,
};
use wealthfolio_core::assets::{
    AlternativeAssetRepositoryTrait, AlternativeAssetService, AlternativeAssetServiceTrait,
    AssetKind, AssetRepositoryTrait, CreateAlternativeAssetRequest, NewAsset, QuoteMode,
    UpdateAssetDetailsRequest,
};
use wealthfolio_core::events::{DomainEvent, MockDomainEventSink};
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
    pool: Arc<db::DbPool>,
    activities: ActivityRepository,
    service: AlternativeAssetService,
    events: MockDomainEventSink,
    repository: Arc<AlternativeAssetRepository>,
    assets: Arc<AssetRepository>,
    quotes: Arc<dyn QuoteServiceTrait>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn execute(&self, statement: &str) {
        diesel::sql_query(statement)
            .execute(&mut db::get_connection(&self.pool).unwrap())
            .unwrap();
    }

    fn add_account(&self, id: &str, account_type: &str) {
        self.execute(&format!(
            "INSERT INTO accounts (id, name, account_type, currency, is_default, is_active, \
             created_at, updated_at, is_archived, tracking_mode) VALUES ('{id}', '{id}', \
             '{account_type}', 'CAD', 0, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0, \
             'NOT_SET')"
        ));
    }

    fn add_withdrawal(&self, id: &str, account: &str, day: &str, amount: &str, tag: Option<&str>) {
        let mut metadata = json!({ "flow": { "is_external": true } });
        if let Some(loan) = tag {
            metadata["loan_payment"] = json!({ "loan_id": loan });
        }
        self.execute(&format!(
            "INSERT INTO activities (id, account_id, activity_type, status, activity_date, \
             amount, currency, metadata, is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('{id}', '{account}', 'WITHDRAWAL', 'POSTED', '{day}T12:00:00Z', '{amount}', \
             'CAD', '{metadata}', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        ));
    }

    fn holding_balance(&self) -> Decimal {
        self.service
            .get_alternative_holdings()
            .unwrap()
            .into_iter()
            .find(|holding| holding.id == "mortgage")
            .unwrap()
            .market_value
            .abs()
    }

    fn activity_metadata(&self, id: &str) -> serde_json::Value {
        self.activities.get_activity(id).unwrap().metadata.unwrap()
    }

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
    let events = MockDomainEventSink::new();
    let service = AlternativeAssetService::new(repository.clone(), assets.clone(), quotes.clone())
        .with_event_sink(Arc::new(events.clone()));
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
        activities: ActivityRepository::new(pool.clone(), writer.clone()),
        pool,
        service,
        events,
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

#[tokio::test]
async fn a_tagged_withdrawal_lowers_the_loan_in_holdings_and_in_actions() {
    use rust_decimal::prelude::ToPrimitive;
    let loan = fixture().await;
    loan.add_account("chequing", "CASH");
    let before = loan.holding_balance();
    // March's instalment of 100 plus 500 of extra principal.
    loan.add_withdrawal("pay", "chequing", "2026-03-01", "600", Some("mortgage"));
    assert_eq!(before - loan.holding_balance(), Decimal::new(500, 0));
    // Loan actions check repayments against the same lowered balance.
    let refused = loan
        .service
        .apply_loan_action(
            "mortgage",
            LoanAction::ExtraRepayment {
                date: chrono::Utc::now().date_naive(),
                amount: (before - Decimal::new(400, 0)).to_f64().unwrap(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.to_string(), "LOAN_AMOUNT_EXCEEDS_BALANCE");
}

#[tokio::test]
async fn a_tag_on_a_withdrawal_that_does_not_qualify_is_ignored() {
    let loan = fixture().await;
    loan.add_account("card", "CREDIT_CARD");
    let before = loan.holding_balance();
    loan.add_withdrawal("card-pay", "card", "2026-03-01", "600", Some("mortgage"));
    assert_eq!(loan.holding_balance(), before);
}

#[tokio::test]
async fn linking_a_withdrawal_makes_it_a_payment_and_unlinking_undoes_it() {
    let loan = fixture().await;
    loan.add_account("chequing", "CASH");
    loan.add_withdrawal("pay", "chequing", "2026-03-01", "600", None);
    let before = loan.holding_balance();
    loan.service
        .link_loan_payment(
            "pay",
            PaymentLink::Link {
                loan_id: "mortgage".into(),
                escrow: None,
                applies_to: Some(PaymentTarget::Extra),
                replace_event: false,
            },
        )
        .await
        .unwrap();
    assert_eq!(before - loan.holding_balance(), Decimal::new(600, 0));
    let metadata = loan.activity_metadata("pay");
    assert_eq!(metadata["flow"]["is_external"], true);
    assert_eq!(metadata["loan_payment"]["applies_to"], "extra");
    assert_eq!(loan.service.get_loan_payments("mortgage").unwrap().len(), 1);
    // The rewritten withdrawal's account is recalculated like any activity edit.
    let changed = |events: Vec<DomainEvent>| {
        events
            .into_iter()
            .filter_map(|event| match event {
                DomainEvent::ActivitiesChanged {
                    account_ids,
                    earliest_activity_at_utc,
                    ..
                } => Some((
                    account_ids,
                    earliest_activity_at_utc.map(|at| at.date_naive()),
                )),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let day = NaiveDate::from_ymd_opt(2026, 3, 1);
    assert_eq!(
        changed(loan.events.events()),
        vec![(vec!["chequing".to_string()], day)]
    );

    loan.events.clear();
    loan.service
        .link_loan_payment("pay", PaymentLink::Unlink)
        .await
        .unwrap();
    assert_eq!(loan.holding_balance(), before);
    assert!(loan.activity_metadata("pay").get("loan_payment").is_none());
    assert_eq!(
        changed(loan.events.events()),
        vec![(vec!["chequing".to_string()], day)]
    );

    // Unlinking again writes nothing, so nothing is recalculated.
    loan.events.clear();
    loan.service
        .link_loan_payment("pay", PaymentLink::Unlink)
        .await
        .unwrap();
    assert!(loan.events.is_empty());
}

#[tokio::test]
async fn a_withdrawal_that_cannot_pay_the_loan_is_not_linked() {
    let loan = fixture().await;
    loan.add_account("card", "CREDIT_CARD");
    loan.add_withdrawal("card-pay", "card", "2026-03-01", "600", None);
    let refused = loan
        .service
        .link_loan_payment(
            "card-pay",
            PaymentLink::Link {
                loan_id: "mortgage".into(),
                escrow: None,
                applies_to: None,
                replace_event: false,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.to_string(), "LOAN_PAYMENT_NOT_ELIGIBLE");
    assert!(loan
        .activity_metadata("card-pay")
        .get("loan_payment")
        .is_none());
}

/// The fixture loan's terms as entered in Edit loan details.
fn loan_setup(account: Option<&str>) -> LoanSetup {
    LoanSetup {
        original_amount: Some(5_000.0),
        origination_date: NaiveDate::from_ymd_opt(2026, 1, 1),
        interest_rate: Some(0.0),
        schedule: Some(LoanSchedule {
            frequency: LoanFrequency::Monthly,
            interest_method: Default::default(),
            first_payment_date: NaiveDate::from_ymd_opt(2026, 2, 1),
            amortization_months: None,
            last_payment_date: NaiveDate::from_ymd_opt(2030, 1, 1),
            payment_amount: Some(100.0),
            renewal_maturity: None,
            payment_account_id: account.map(str::to_string),
            escrow_amount: None,
        }),
    }
}

#[tokio::test]
async fn only_a_cash_account_in_the_loans_currency_can_be_paid_from() {
    let loan = fixture().await;
    loan.add_account("chequing", "CASH");
    loan.add_account("card", "CREDIT_CARD");
    let set = |account: Option<&str>| LoanAction::SetTerms(loan_setup(account));
    loan.service
        .apply_loan_action("mortgage", set(Some("chequing")))
        .await
        .unwrap();
    assert_eq!(loan.metadata()[PAYMENT_ACCOUNT_KEY], "chequing");
    loan.add_account("usd", "CASH");
    loan.execute("UPDATE accounts SET currency = 'USD' WHERE id = 'usd'");
    loan.add_account("closed", "CASH");
    loan.execute("UPDATE accounts SET is_archived = 1 WHERE id = 'closed'");
    loan.add_account("inactive", "CASH");
    loan.execute("UPDATE accounts SET is_active = 0 WHERE id = 'inactive'");
    for account in ["card", "usd", "closed", "inactive", "missing"] {
        let refused = loan
            .service
            .apply_loan_action("mortgage", set(Some(account)))
            .await
            .unwrap_err();
        assert_eq!(
            refused.to_string(),
            "LOAN_PAYMENT_ACCOUNT_INVALID",
            "{account}"
        );
    }
    assert_eq!(loan.metadata()[PAYMENT_ACCOUNT_KEY], "chequing");
    loan.service
        .apply_loan_action("mortgage", set(None))
        .await
        .unwrap();
    assert!(loan.metadata().get(PAYMENT_ACCOUNT_KEY).is_none());
}

#[tokio::test]
async fn the_general_details_update_refuses_loan_fields_and_writes_nothing() {
    let loan = fixture().await;
    let before = loan.metadata();
    let update = |key: &str, value: &str| UpdateAssetDetailsRequest {
        asset_id: "mortgage".into(),
        name: Some("Renamed".into()),
        notes: None,
        metadata: Some([(key.to_string(), Some(value.to_string()))].into()),
    };
    for key in [
        "interest_rate",
        "loan_projection",
        "tracking_mode",
        "loan_events",
    ] {
        let refused = loan
            .service
            .update_asset_details(update(key, "x"))
            .await
            .unwrap_err();
        assert_eq!(refused.to_string(), "LOAN_FIELDS_READ_ONLY", "{key}");
    }
    assert_eq!(loan.metadata(), before);
    assert_eq!(
        loan.assets.get_by_id("mortgage").unwrap().name.as_deref(),
        Some("Mortgage")
    );
    // Other details still save there.
    loan.service
        .update_asset_details(update("sub_type", "heloc"))
        .await
        .unwrap();
    assert_eq!(loan.metadata()["sub_type"], "heloc");
}

#[tokio::test]
async fn creating_a_liability_takes_its_loan_from_a_setup() {
    let loan = fixture().await;
    let liabilities = || {
        loan.assets
            .list()
            .unwrap()
            .into_iter()
            .filter(|asset| asset.kind == AssetKind::Liability)
            .count()
    };
    let origination = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
    let create = |metadata: serde_json::Value, setup: LoanSetup, value_date: NaiveDate| {
        CreateAlternativeAssetRequest {
            kind: AssetKind::Liability,
            name: "Car loan".into(),
            currency: "CAD".into(),
            current_value: Decimal::new(20_000, 0),
            value_date,
            purchase_price: None,
            purchase_date: None,
            metadata: Some(metadata),
            linked_asset_id: None,
            loan: Some(setup),
        }
    };
    let solved = || {
        let mut setup = loan_setup(None);
        setup.original_amount = Some(20_000.0);
        setup.interest_rate = Some(6.0);
        let schedule = setup.schedule.as_mut().unwrap();
        schedule.payment_amount = None;
        schedule.last_payment_date = None;
        schedule.amortization_months = Some(60);
        setup
    };
    let before = liabilities();
    let refusals = [
        (
            create(json!({ "loan_projection": "{}" }), solved(), origination),
            "LOAN_FIELDS_READ_ONLY",
        ),
        (
            create(json!({}), solved(), origination.pred_opt().unwrap()),
            "LOAN_BALANCE_BEFORE_ORIGINATION",
        ),
        (
            create(json!({}), loan_setup(Some("chequing")), origination),
            "LOAN_PAYMENT_ACCOUNT_INVALID",
        ),
        (
            create(
                json!({}),
                LoanSetup {
                    interest_rate: Some(101.0),
                    ..solved()
                },
                origination,
            ),
            "LOAN_RATE_INVALID",
        ),
    ];
    for (request, code) in refusals {
        let refused = loan
            .service
            .create_alternative_asset(request)
            .await
            .unwrap_err();
        assert_eq!(refused.to_string(), code);
    }
    assert_eq!(liabilities(), before, "a refused creation writes nothing");

    let created = loan
        .service
        .create_alternative_asset(create(
            json!({ "sub_type": "auto_loan" }),
            solved(),
            origination,
        ))
        .await
        .unwrap();
    let metadata = loan
        .assets
        .get_by_id(&created.asset_id)
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(metadata["sub_type"], "auto_loan");
    assert_eq!(metadata["original_amount"], "20000");
    assert_eq!(metadata["origination_date"], "2026-01-01");
    let terms = LoanTerms::read(&metadata).unwrap();
    assert_eq!(
        terms.amortization_end_date,
        NaiveDate::from_ymd_opt(2031, 1, 1)
    );
    assert!(terms.payment_amount > 0.0, "the payment is solved");
}

#[tokio::test]
async fn deleting_the_loan_untags_its_payments_and_keeps_the_withdrawals() {
    let loan = fixture().await;
    loan.add_account("chequing", "CASH");
    loan.add_withdrawal("pay", "chequing", "2026-03-01", "600", Some("mortgage"));
    loan.service
        .delete_alternative_asset("mortgage")
        .await
        .unwrap();
    let metadata = loan.activity_metadata("pay");
    assert!(metadata.get("loan_payment").is_none());
    assert_eq!(metadata["flow"]["is_external"], true);
}

#[tokio::test]
async fn replacing_a_recorded_extra_repayment_with_its_withdrawal_counts_it_once() {
    let loan = fixture().await;
    loan.add_account("chequing", "CASH");
    // Regular payments carry escrow; the replaced extra repayment does not.
    let mut setup = loan_setup(None);
    setup.schedule.as_mut().unwrap().escrow_amount = Some(50.0);
    loan.service
        .apply_loan_action("mortgage", LoanAction::SetTerms(setup))
        .await
        .unwrap();
    // Mid-month, away from any instalment.
    let day = NaiveDate::from_ymd_opt(2026, 3, 15).unwrap();
    loan.service
        .apply_loan_action(
            "mortgage",
            LoanAction::ExtraRepayment {
                date: day,
                amount: 600.0,
            },
        )
        .await
        .unwrap();
    let with_event = loan.holding_balance();
    loan.add_withdrawal("pay", "chequing", "2026-03-15", "600", None);
    let link = |replace_event| PaymentLink::Link {
        loan_id: "mortgage".into(),
        escrow: None,
        applies_to: None,
        replace_event,
    };

    let refused = loan
        .service
        .link_loan_payment("pay", link(false))
        .await
        .unwrap_err();
    assert_eq!(refused.to_string(), "LOAN_PAYMENT_DUPLICATES_EVENT");
    assert!(loan.activity_metadata("pay").get("loan_payment").is_none());
    assert_eq!(event_entries(&loan.metadata()).len(), 1);

    loan.service
        .link_loan_payment("pay", link(true))
        .await
        .unwrap();
    assert!(event_entries(&loan.metadata()).is_empty());
    assert_eq!(
        loan.activity_metadata("pay")["loan_payment"]["applies_to"],
        "extra"
    );
    // The same 600 now comes from the withdrawal instead of the event.
    assert_eq!(loan.holding_balance(), with_event);

    // Recording it again as an event is refused: the withdrawal already paid it.
    let again = loan
        .service
        .apply_loan_action(
            "mortgage",
            LoanAction::ExtraRepayment {
                date: day,
                amount: 600.0,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(again.to_string(), "LOAN_EXTRA_ALREADY_LINKED");
}
