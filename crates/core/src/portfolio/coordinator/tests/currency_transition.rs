use super::*;

/// A base-currency setting change invalidates every historical row. A forced
/// genesis rebuild must replace the old base amounts and flow conversions on
/// every date, rather than leaving rows calculated under the old setting.
#[tokio::test]
async fn switching_base_currency_rebuilds_all_historical_rows_and_flows() {
    let mut facts = scenario("EDGE-FX-03").facts();
    let mut later_deposit = facts.activities[0].clone();
    later_deposit.id = "later-deposit".to_string();
    // Keep the flow on the fixture's nearest dated quote under either FX policy.
    later_deposit.activity_date += chrono::Duration::days(1);
    later_deposit.amount = Some(dec!(200));
    let flow_day = later_deposit.activity_date.date_naive();
    facts.activities.push(later_deposit);
    let harness = harness(facts.clone()).await;
    let first = harness
        .coordinator
        .run_job(request(), &SilentObserver)
        .await
        .unwrap();
    assert!(first.failures.is_empty(), "{:?}", first.failures);

    let before = harness.rows("acc-1");
    assert!(!before.is_empty());
    assert!(before.iter().all(|row| row.base_currency == "USD"));
    assert!(before
        .iter()
        .any(|row| row.net_contribution_base == dec!(700)));
    let before_dates: Vec<_> = before.iter().map(|row| row.valuation_date).collect();
    assert_eq!(
        before
            .iter()
            .find(|row| row.valuation_date == flow_day)
            .unwrap()
            .external_inflow_base,
        dec!(140)
    );
    let scope = vec!["acc-1".to_string()];
    let (_, before_performance) = scope_reads(&harness, &scope).await;
    assert!(before_performance
        .returns
        .twr
        .is_some_and(|value| value != Decimal::ZERO));

    *harness.base_currency.write().unwrap() = "CAD".to_string();
    let report = harness
        .coordinator
        .run_job(
            PortfolioJobRequest {
                force_full: true,
                ..request()
            },
            &SilentObserver,
        )
        .await
        .unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert_eq!(
        plan_of(&report, "acc-1"),
        Some(RebuildPlan::Refold { from: GENESIS })
    );

    let after = harness.rows("acc-1");
    assert_eq!(
        before_dates,
        after
            .iter()
            .map(|row| row.valuation_date)
            .collect::<Vec<_>>()
    );
    for row in &after {
        assert_eq!(row.base_currency, "CAD");
        assert_eq!(row.fx_rate_to_base, Decimal::ONE);
        assert_eq!(row.cash_balance_base, row.cash_balance);
        assert_eq!(
            row.investment_market_value_base,
            row.investment_market_value
        );
        assert_eq!(row.total_value_base, row.total_value);
        assert_eq!(row.cost_basis_base, row.cost_basis);
        assert_eq!(row.book_basis_base, row.book_basis);
        assert_eq!(row.net_contribution_base, row.net_contribution);
    }
    let deposit_day = facts.activities[0].activity_date.date_naive();
    let deposit = after
        .iter()
        .find(|row| row.valuation_date == deposit_day)
        .expect("deposit valuation");
    assert_eq!(deposit.net_contribution_base, dec!(1000));
    // Opening capital is the performance baseline, not an external flow.
    assert_eq!(deposit.external_inflow_base, Decimal::ZERO);
    assert_eq!(
        after
            .iter()
            .find(|row| row.valuation_date == flow_day)
            .unwrap()
            .external_inflow_base,
        dec!(200)
    );
    let (history, after_performance) = scope_reads(&harness, &scope).await;
    assert!(history
        .unwrap()
        .iter()
        .all(|row| row.base_currency == "CAD"));
    assert_eq!(after_performance.returns.twr, Some(Decimal::ZERO));
    assert_ne!(
        before_performance.returns.twr,
        after_performance.returns.twr
    );
    assert!(harness.projections.pending_markers().unwrap().is_empty());
}
