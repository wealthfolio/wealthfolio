use super::*;

#[test]
fn get_exchange_rate_for_date_carries_past_rate_for_holiday_at_seven_days() {
    let quoted_date = NaiveDate::from_ymd_opt(2026, 5, 11).unwrap();
    let requested_date = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates
        .lock()
        .unwrap()
        .push(make_historical_rate(
            "USD",
            "EUR",
            Decimal::new(90, 2),
            quoted_date,
        ));
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let rate = service
        .get_exchange_rate_for_date("USD", "EUR", requested_date)
        .unwrap();
    assert_eq!(rate, Decimal::new(90, 2));
}

#[test]
fn get_exchange_rate_for_date_uses_past_when_future_is_closer() {
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates.lock().unwrap().extend([
        make_historical_rate(
            "USD",
            "EUR",
            Decimal::new(90, 2),
            NaiveDate::from_ymd_opt(2026, 5, 8).unwrap(),
        ),
        make_historical_rate(
            "USD",
            "EUR",
            Decimal::new(91, 2),
            NaiveDate::from_ymd_opt(2026, 5, 12).unwrap(),
        ),
    ]);
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let rate = service
        .get_exchange_rate_for_date("USD", "EUR", NaiveDate::from_ymd_opt(2026, 5, 11).unwrap())
        .unwrap();
    assert_eq!(rate, Decimal::new(90, 2));
}

#[test]
fn get_exchange_rate_for_date_errors_for_future_only_history() {
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates
        .lock()
        .unwrap()
        .push(make_historical_rate(
            "USD",
            "EUR",
            Decimal::new(90, 2),
            NaiveDate::from_ymd_opt(2026, 5, 20).unwrap(),
        ));
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let error = service
        .get_exchange_rate_for_date("USD", "EUR", NaiveDate::from_ymd_opt(2026, 5, 18).unwrap())
        .unwrap_err()
        .to_string();
    assert!(error.contains("future-only"));
}

#[test]
fn get_exchange_rate_for_date_errors_for_stale_history_without_latest_fallback() {
    let requested_date = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates
        .lock()
        .unwrap()
        .push(make_historical_rate(
            "USD",
            "EUR",
            Decimal::new(90, 2),
            NaiveDate::from_ymd_opt(2026, 5, 10).unwrap(),
        ));
    *repo.latest_rate.lock().unwrap() = Some(make_historical_rate(
        "USD",
        "EUR",
        Decimal::new(95, 2),
        requested_date,
    ));
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let error = service
        .get_exchange_rate_for_date("USD", "EUR", requested_date)
        .unwrap_err()
        .to_string();
    assert!(error.contains("stale"));
}

#[test]
fn get_exchange_rate_for_date_errors_for_nonpositive_history() {
    let date = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates
        .lock()
        .unwrap()
        .push(make_historical_rate("USD", "EUR", Decimal::ZERO, date));
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let error = service
        .get_exchange_rate_for_date("USD", "EUR", date)
        .unwrap_err()
        .to_string();
    assert!(error.contains("nonpositive"));
}

#[test]
fn get_exchange_rate_for_date_supports_inverse_and_triangulated_paths() {
    let date = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates.lock().unwrap().extend([
        make_historical_rate("EUR", "USD", Decimal::new(125, 2), date),
        make_historical_rate("USD", "CAD", Decimal::new(135, 2), date),
        make_historical_rate("CAD", "JPY", Decimal::new(110, 0), date),
    ]);
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let inverse = service
        .get_exchange_rate_for_date("USD", "EUR", date)
        .unwrap();
    assert_eq!(inverse, Decimal::new(8, 1));

    let triangulated = service
        .get_exchange_rate_for_date("USD", "JPY", date)
        .unwrap();
    assert_eq!(triangulated, Decimal::new(1485, 1));
}

#[test]
fn get_exchange_rate_for_date_rejects_stale_triangulated_edge() {
    let requested_date = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates.lock().unwrap().extend([
        make_historical_rate("USD", "CAD", Decimal::new(135, 2), requested_date),
        make_historical_rate(
            "CAD",
            "JPY",
            Decimal::new(110, 0),
            NaiveDate::from_ymd_opt(2026, 5, 10).unwrap(),
        ),
    ]);
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let error = service
        .get_exchange_rate_for_date("USD", "JPY", requested_date)
        .unwrap_err()
        .to_string();
    assert!(error.contains("stale"));
}

#[test]
fn get_exchange_rate_for_date_applies_minor_unit_normalization() {
    let date = NaiveDate::from_ymd_opt(2026, 5, 18).unwrap();
    let repo = Arc::new(MockFxRepository::default());
    repo.historical_rates
        .lock()
        .unwrap()
        .push(make_historical_rate(
            "GBP",
            "USD",
            Decimal::new(125, 2),
            date,
        ));
    let service = FxService::new(repo);
    service.initialize().unwrap();

    let pence_to_dollars = service
        .get_exchange_rate_for_date("GBp", "USD", date)
        .unwrap();
    assert_eq!(pence_to_dollars, Decimal::new(125, 4));

    let dollars_to_pence = service
        .get_exchange_rate_for_date("USD", "GBp", date)
        .unwrap();
    assert_eq!(dollars_to_pence, Decimal::new(8000, 2));
}
