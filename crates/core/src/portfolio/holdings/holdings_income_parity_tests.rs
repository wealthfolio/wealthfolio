// Compare the actual holdings read with engine attribution, without adding an
// asset-income projection. EventEffect::source joins synthetic DRIP legs back to
// their original activity; unassigned account income is deliberately excluded.
mod income_parity {
    use super::*;
    use crate::activities::ActivityRepositoryTrait;
    use crate::portfolio::coordinator::rows;
    use crate::portfolio::projection::ActivityIssueKind;

    fn income(kind: &str, amount: Decimal, currency: &str) -> Activity {
        test_income_activity(
            "income",
            "account",
            Some(ASSET_ID),
            kind,
            amount,
            currency,
            NaiveDate::from_ymd_opt(2025, 1, 10).unwrap(),
        )
    }

    fn fx(from: &str, to: &str, rate: Decimal, day: &str) -> ExchangeRate {
        ExchangeRate {
            id: format!("{from}-{to}-{day}"),
            from_currency: from.into(),
            to_currency: to.into(),
            rate,
            source: "MANUAL".into(),
            timestamp: format!("{day}T00:00:00Z").parse().unwrap(),
        }
    }

    // Use persisted rejection/lot/disposal inputs, exactly as engine-backed
    // reads do. Changing the requested base currency gives an independent local
    // attribution result; no holdings income helper participates in the oracle.
    async fn engine_income(
        fixture: &Fixture,
        accounts: &[Account],
        currency: &str,
    ) -> Option<Decimal> {
        engine_attribution(fixture, accounts, currency, true).await
    }

    async fn engine_attribution(
        fixture: &Fixture,
        accounts: &[Account],
        currency: &str,
        asset_only: bool,
    ) -> Option<Decimal> {
        let ids: Vec<_> = accounts.iter().map(|a| a.id.clone()).collect();
        let sources = FactSources {
            accounts: Arc::new(InMemoryAccountRepository::new(accounts.to_vec())),
            activities: fixture.activities.clone(),
            assets: fixture.assets.clone(),
            quotes: fixture.quotes.clone(),
            fx_rates: fixture.fx_repo.clone(),
            snapshots: fixture.snapshots.clone(),
            projections: fixture.store.clone(),
        };
        let as_of = fixture.now.date_naive();
        let engine = rows::measure_engine(&sources, &ids, currency, "UTC", as_of).unwrap();
        let rejected = rows::stored_rejections(&sources, &engine).unwrap();
        let mut lots = Vec::new();
        let mut disposals = Vec::new();
        for id in &ids {
            lots.extend(fixture.lots.get_all_lots_for_account(id).await.unwrap());
            disposals.extend(
                fixture
                    .lots
                    .get_lot_disposals_for_account(id)
                    .await
                    .unwrap(),
            );
        }
        let activities = fixture.activities.get_activities().unwrap();
        engine
            .effects(
                &rows::stored_disposals(&disposals),
                &rows::stored_lots(&lots),
                &rejected,
            )
            .events
            .iter()
            .filter(|event| {
                event.date <= as_of && ids.iter().any(|id| id == event.account.as_str())
            })
            .filter(|event| {
                !asset_only
                    || activities.iter().any(|a| {
                        a.id == event.source.as_str() && a.asset_id.as_deref() == Some(ASSET_ID)
                    })
            })
            .try_fold(Decimal::ZERO, |sum, event| {
                event.income.map(|amount| sum + amount)
            })
    }

    async fn assert_parity(
        fixture: &Fixture,
        accounts: &[Account],
        holdings: &HoldingsService,
        expected: MonetaryValue,
        include_closed: bool,
    ) -> Holding {
        let ids: Vec<_> = accounts.iter().map(|a| a.id.clone()).collect();
        let scope = holdings
            .get_holdings_scope(&ids, "CAD", "scope", include_closed)
            .await
            .unwrap();
        assert!(
            scope.incomplete_accounts.is_empty(),
            "{:?}",
            scope.incomplete_accounts
        );
        let holding = scope
            .holdings
            .into_iter()
            .find(|h| h.instrument.as_ref().is_some_and(|i| i.id == ASSET_ID))
            .expect("asset remains readable");
        assert_eq!(holding.income, Some(expected.clone()));
        assert_eq!(
            engine_income(fixture, accounts, &holding.local_currency).await,
            expected.local
        );
        assert_eq!(engine_income(fixture, accounts, "CAD").await, expected.base);
        holding
    }

    #[tokio::test]
    async fn income_parity_activity_semantics_in_both_tracking_modes() {
        // Explicit expected values prevent two implementations sharing a mistake
        // from being mistaken for proof of the accounting contract.
        for mode in [TrackingMode::Transactions, TrackingMode::Holdings] {
            for (kind, subtype, expected) in [
                ("DIVIDEND", None, dec!(13)),
                ("INTEREST", None, dec!(13)),
                ("DIVIDEND", Some("DRIP"), dec!(13)),
                ("DIVIDEND", Some("RETURN_OF_CAPITAL"), Decimal::ZERO),
                ("ADJUSTMENT", Some("RETURN_OF_CAPITAL"), dec!(-10)),
                ("ADJUSTMENT", Some("NOTIONAL_DISTRIBUTION"), dec!(10)),
            ] {
                let mut event = income(kind, dec!(10), "CAD");
                event.subtype = subtype.map(str::to_owned);
                if matches!(kind, "DIVIDEND" | "INTEREST") && subtype != Some("RETURN_OF_CAPITAL") {
                    event.fee = Some(dec!(1));
                    event.tax = Some(dec!(2));
                }
                if subtype == Some("DRIP") {
                    event.quantity = Some(dec!(0.1));
                    event.unit_price = Some(dec!(100));
                }
                let accounts = vec![account("account", "CAD", mode)];
                let mut fixture =
                    Fixture::new(vec![buy("account", "CAD", dec!(100)), event], vec![]);
                let _clock = crate::utils::clock::freeze(fixture.now);
                let (coordinator, holdings, snapshots) = fixture.services(accounts.clone());
                if mode == TrackingMode::Holdings {
                    let today = fixture.now;
                    fixture.now = "2025-01-02T12:00:00Z".parse().unwrap();
                    fixture
                        .save_holding(&snapshots, &accounts[0], dec!(100))
                        .await;
                    fixture.now = today;
                }
                run(&coordinator).await;
                assert_parity(
                    &fixture,
                    &accounts,
                    &holdings,
                    money(expected, expected),
                    false,
                )
                .await;
            }
        }
    }

    #[tokio::test]
    async fn income_parity_uses_event_date_and_cross_currency_paths() {
        let mut event = income("DIVIDEND", dec!(10), "EUR");
        event.tax = Some(dec!(2));
        event.fee = Some(dec!(1));
        let accounts = vec![account("account", "USD", TrackingMode::Transactions)];
        let fixture = Fixture::with_quote(
            vec![buy("account", "USD", dec!(100)), event],
            vec![
                fx("EUR", "USD", dec!(1.2), "2025-01-10"),
                fx("USD", "CAD", dec!(1.5), "2025-01-10"),
                fx("EUR", "USD", dec!(2), "2025-01-15"),
                fx("USD", "CAD", dec!(3), "2025-01-15"),
            ],
            "USD",
            dec!(110),
        );
        let _clock = crate::utils::clock::freeze(fixture.now);
        let (coordinator, holdings, _) = fixture.services(accounts.clone());
        run(&coordinator).await;
        assert_parity(
            &fixture,
            &accounts,
            &holdings,
            money(dec!(15.6), dec!(23.4)),
            false,
        )
        .await;
    }

    #[tokio::test]
    async fn income_parity_distinguishes_missing_fx_from_zero_income() {
        for amount in [Decimal::ZERO, dec!(10)] {
            let accounts = vec![account("account", "USD", TrackingMode::Transactions)];
            let fixture = Fixture::with_quote(
                vec![
                    buy("account", "USD", dec!(100)),
                    income("DIVIDEND", amount, "USD"),
                ],
                vec![],
                "USD",
                dec!(110),
            );
            let _clock = crate::utils::clock::freeze(fixture.now);
            let (coordinator, holdings, _) = fixture.services(accounts.clone());
            run(&coordinator).await;
            assert_parity(
                &fixture,
                &accounts,
                &holdings,
                MonetaryValue {
                    local: Some(amount),
                    base: amount.is_zero().then_some(Decimal::ZERO),
                },
                false,
            )
            .await;
        }
    }

    #[tokio::test]
    async fn income_parity_normalizes_minor_units() {
        let accounts = vec![account("account", "GBP", TrackingMode::Transactions)];
        let fixture = Fixture::with_quote(
            vec![
                buy("account", "GBp", dec!(10000)),
                income("DIVIDEND", dec!(100), "GBp"),
            ],
            vec![
                fx("GBP", "CAD", dec!(2), "2025-01-10"),
                fx("GBP", "CAD", dec!(3), "2025-01-15"),
            ],
            "GBp",
            dec!(11000),
        );
        let _clock = crate::utils::clock::freeze(fixture.now);
        let (coordinator, holdings, _) = fixture.services(accounts.clone());
        run(&coordinator).await;
        let result = holding(&holdings, "account").await;
        assert_eq!(result.local_currency, "GBP");
        assert_eq!(result.income, Some(money(dec!(1), dec!(2))));
        assert_eq!(
            engine_income(&fixture, &accounts, "CAD").await,
            Some(dec!(2))
        );
        assert_eq!(
            engine_income(&fixture, &accounts, "GBP").await,
            Some(dec!(1))
        );
    }

    #[tokio::test]
    async fn income_parity_excludes_future_nonposted_and_unassigned_income() {
        let mut activities = vec![
            buy("account", "CAD", dec!(100)),
            income("DIVIDEND", dec!(10), "CAD"),
        ];
        for (index, status) in [
            ActivityStatus::Pending,
            ActivityStatus::Draft,
            ActivityStatus::Void,
        ]
        .into_iter()
        .enumerate()
        {
            let mut event = income("DIVIDEND", dec!(1000), "CAD");
            event.id = format!("excluded-{index}");
            event.status = status;
            activities.push(event);
        }
        let mut future = income("DIVIDEND", dec!(1000), "CAD");
        future.id = "future".into();
        future.activity_date = "2025-01-16T12:00:00Z".parse().unwrap();
        activities.push(future);
        let mut credit = income("CREDIT", dec!(1000), "CAD");
        credit.id = "unassigned-credit".into();
        credit.asset_id = None;
        // Explicitly internal: this is account income, not an external deposit.
        credit.metadata = Some(r#"{"flow":{"is_external":false}}"#.into());
        activities.push(credit);
        let accounts = vec![account("account", "CAD", TrackingMode::Transactions)];
        let fixture = Fixture::new(activities, vec![]);
        let _clock = crate::utils::clock::freeze(fixture.now);
        let (coordinator, holdings, _) = fixture.services(accounts.clone());
        run(&coordinator).await;
        assert_parity(
            &fixture,
            &accounts,
            &holdings,
            money(dec!(10), dec!(10)),
            false,
        )
        .await;
        assert_eq!(
            engine_attribution(&fixture, &accounts, "CAD", false).await,
            Some(dec!(1010))
        );
    }

    #[tokio::test]
    async fn income_parity_retains_income_on_closed_positions() {
        let mut sell = income("SELL", dec!(110), "CAD");
        sell.id = "close".into();
        sell.quantity = Some(dec!(1));
        sell.unit_price = Some(dec!(110));
        sell.activity_date = "2025-01-12T12:00:00Z".parse().unwrap();
        let accounts = vec![account("account", "CAD", TrackingMode::Transactions)];
        let fixture = Fixture::new(
            vec![
                buy("account", "CAD", dec!(100)),
                income("DIVIDEND", dec!(10), "CAD"),
                sell,
            ],
            vec![],
        );
        let _clock = crate::utils::clock::freeze(fixture.now);
        let (coordinator, holdings, _) = fixture.services(accounts.clone());
        run(&coordinator).await;
        assert!(
            assert_parity(
                &fixture,
                &accounts,
                &holdings,
                money(dec!(10), dec!(10)),
                true
            )
            .await
            .is_closed
        );
    }

    #[tokio::test]
    async fn income_parity_excludes_a_real_projection_rejection() {
        let mut rejected = income("ADJUSTMENT", dec!(1000), "CAD");
        rejected.id = "rejected-notional".into();
        rejected.subtype = Some("NOTIONAL_DISTRIBUTION".into());
        rejected.activity_date = "2025-01-01T12:00:00Z".parse().unwrap(); // no position yet
        let accounts = vec![account("account", "CAD", TrackingMode::Transactions)];
        let fixture = Fixture::new(
            vec![
                rejected,
                buy("account", "CAD", dec!(100)),
                income("DIVIDEND", dec!(10), "CAD"),
            ],
            vec![],
        );
        let _clock = crate::utils::clock::freeze(fixture.now);
        let (coordinator, holdings, _) = fixture.services(accounts.clone());
        run(&coordinator).await;
        let issues = fixture.store.activity_issues(&["account".into()]).unwrap();
        assert!(
            issues
                .iter()
                .any(|i| i.activity_id == "rejected-notional"
                    && i.kind == ActivityIssueKind::Rejected)
        );
        assert_parity(
            &fixture,
            &accounts,
            &holdings,
            money(dec!(10), dec!(10)),
            false,
        )
        .await;
    }
    #[tokio::test]
    async fn income_parity_aggregates_assets_across_accounts() {
        let accounts = vec![
            account("account", "USD", TrackingMode::Transactions),
            account("second", "USD", TrackingMode::Transactions),
        ];
        let first = income("DIVIDEND", dec!(10), "USD");
        let mut second = income("INTEREST", dec!(20), "USD");
        second.id = "second-income".into();
        second.account_id = "second".into();
        let fixture = Fixture::with_quote(
            vec![
                buy("account", "USD", dec!(100)),
                buy("second", "USD", dec!(100)),
                first,
                second,
            ],
            vec![
                fx("USD", "CAD", dec!(1.5), "2025-01-10"),
                fx("USD", "CAD", dec!(3), "2025-01-15"),
            ],
            "USD",
            dec!(110),
        );
        let _clock = crate::utils::clock::freeze(fixture.now);
        let (coordinator, holdings, _) = fixture.services(accounts.clone());
        run(&coordinator).await;
        assert_parity(
            &fixture,
            &accounts,
            &holdings,
            money(dec!(30), dec!(45)),
            false,
        )
        .await;
    }
}
