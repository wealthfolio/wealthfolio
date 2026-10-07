use super::*;
use crate::assets::loan::{calculate_loan, LoanTerms};

fn date(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn schedule(frequency: LoanFrequency) -> LoanSchedule {
    LoanSchedule {
        frequency,
        interest_method: InterestMethod::NominalPeriodic,
        first_payment_date: Some(date("2026-02-01")),
        amortization_months: Some(300),
        last_payment_date: None,
        payment_amount: Some(1_000.0),
        renewal_maturity: None,
        payment_account_id: None,
        escrow_amount: None,
    }
}

fn setup(schedule: Option<LoanSchedule>) -> LoanSetup {
    LoanSetup {
        original_amount: Some(200_000.0),
        origination_date: Some(date("2026-01-01")),
        interest_rate: Some(5.0),
        schedule,
    }
}

fn terms(metadata: &Value) -> LoanTerms {
    LoanTerms::read(metadata).expect("stored terms are valid")
}

#[test]
fn a_calculated_loan_stores_its_terms_from_the_entered_months() {
    let stored = json!({ "sub_type": "mortgage", "tracking_mode": "manual" });
    let next = apply_loan_setup(&stored, &setup(Some(schedule(LoanFrequency::Monthly)))).unwrap();
    assert_eq!(next["sub_type"], "mortgage");
    assert!(next.get(TRACKING_MODE_KEY).is_none());
    assert_eq!(next[ORIGINAL_AMOUNT_KEY], "200000");
    assert_eq!(next[ORIGINATION_DATE_KEY], "2026-01-01");
    assert_eq!(next[INTEREST_RATE_KEY], "5");
    // Stored as JSON text, like every loan field written before.
    assert!(next[LOAN_PROJECTION_KEY].is_string());
    let stored = terms(&next);
    assert_eq!(stored.payment_amount, 1_000.0);
    assert_eq!(stored.first_payment_date, date("2026-02-01"));
    assert_eq!(stored.amortization_end_date, Some(date("2051-01-01")));

    let biweekly =
        apply_loan_setup(&json!({}), &setup(Some(schedule(LoanFrequency::Biweekly)))).unwrap();
    // 25 years of 26 payments: the 650th falls 649 fortnights after the first.
    assert_eq!(
        terms(&biweekly).amortization_end_date,
        date("2026-02-01").checked_add_days(chrono::Days::new(649 * 14))
    );
}

#[test]
fn the_preview_is_what_saving_stores() {
    let entered = setup(Some(schedule(LoanFrequency::Monthly)));
    let preview = preview_loan_terms(&entered, &json!({})).unwrap().unwrap();
    assert_eq!(
        preview,
        LoanSchedulePreview {
            first_payment_date: date("2026-02-01"),
            last_payment_date: date("2051-01-01"),
            payment_count: 300,
            payment_amount: 1_000.0,
        }
    );
    let next = apply_loan_setup(&json!({}), &entered).unwrap();
    assert_eq!(
        terms(&next).amortization_end_date,
        Some(preview.last_payment_date)
    );
    assert_eq!(preview_loan_terms(&setup(None), &json!({})).unwrap(), None);
}

#[test]
fn monthly_payments_keep_the_first_payment_day_clamped_in_shorter_months() {
    let mut entered = schedule(LoanFrequency::Monthly);
    entered.first_payment_date = Some(date("2026-01-31"));
    entered.amortization_months = Some(2);
    let mut loan = setup(Some(entered));
    loan.origination_date = Some(date("2025-12-31"));
    let preview = preview_loan_terms(&loan, &json!({})).unwrap().unwrap();
    assert_eq!(preview.last_payment_date, date("2026-02-28"));
    assert_eq!(preview.payment_count, 2);
}

#[test]
fn the_first_payment_defaults_to_one_period_after_origination() {
    for (frequency, first) in [
        (LoanFrequency::Monthly, "2026-02-01"),
        (LoanFrequency::Biweekly, "2026-01-15"),
    ] {
        let mut entered = schedule(frequency);
        entered.first_payment_date = None;
        let preview = preview_loan_terms(&setup(Some(entered)), &json!({}))
            .unwrap()
            .unwrap();
        assert_eq!(preview.first_payment_date, date(first));
    }
}

#[test]
fn a_stored_off_cadence_end_is_kept_while_the_months_match() {
    let stored = apply_loan_setup(
        &json!({}),
        &setup(Some(LoanSchedule {
            amortization_months: None,
            last_payment_date: Some(date("2051-01-15")),
            ..schedule(LoanFrequency::Monthly)
        })),
    )
    .unwrap();
    let same = apply_loan_setup(&stored, &setup(Some(schedule(LoanFrequency::Monthly)))).unwrap();
    assert_eq!(terms(&same).amortization_end_date, Some(date("2051-01-15")));

    let mut shorter = schedule(LoanFrequency::Monthly);
    shorter.amortization_months = Some(240);
    let changed = apply_loan_setup(&stored, &setup(Some(shorter))).unwrap();
    assert_eq!(
        terms(&changed).amortization_end_date,
        Some(date("2046-01-01"))
    );
}

#[test]
fn an_omitted_payment_is_solved_to_settle_the_loan_by_its_last_payment() {
    for frequency in [
        LoanFrequency::Monthly,
        LoanFrequency::Biweekly,
        LoanFrequency::AcceleratedBiweekly,
    ] {
        let mut entered = schedule(frequency);
        entered.payment_amount = None;
        let loan = setup(Some(entered));
        let metadata = apply_loan_setup(&json!({}), &loan).unwrap();
        let stored = terms(&metadata);
        let calculation = calculate_loan(&LoanCalculationRequest {
            metadata,
            balances: Vec::new(),
            as_of: date("2026-01-01"),
            payments: Vec::new(),
        })
        .unwrap();
        assert_eq!(calculation.residual_balance, 0.0, "{frequency:?}");
        let payoff = calculation.payoff_date.unwrap();
        assert!(
            payoff <= stored.amortization_end_date.unwrap(),
            "{frequency:?}"
        );
        if frequency == LoanFrequency::AcceleratedBiweekly {
            let half_monthly = payment_amount(
                200_000.0,
                5.0,
                650,
                frequency,
                InterestMethod::NominalPeriodic,
            )
            .map(money)
            .unwrap();
            assert!(stored.payment_amount >= half_monthly);
        }
    }
}

#[test]
fn a_manual_loan_keeps_its_stored_schedule_for_later() {
    let stored =
        apply_loan_setup(&json!({}), &setup(Some(schedule(LoanFrequency::Monthly)))).unwrap();
    let manual = apply_loan_setup(&stored, &setup(None)).unwrap();
    assert_eq!(manual[TRACKING_MODE_KEY], "manual");
    assert_eq!(manual[LOAN_PROJECTION_KEY], stored[LOAN_PROJECTION_KEY]);

    let bare = LoanSetup {
        original_amount: None,
        origination_date: None,
        interest_rate: None,
        schedule: None,
    };
    let cleared = apply_loan_setup(&manual, &bare).unwrap();
    assert!(cleared.get(ORIGINAL_AMOUNT_KEY).is_none());
    assert!(cleared.get(INTEREST_RATE_KEY).is_none());
}

#[test]
fn paid_from_maturity_and_escrow_are_stored_with_the_schedule() {
    let mut entered = schedule(LoanFrequency::Monthly);
    entered.renewal_maturity = Some(date("2031-01-01"));
    entered.payment_account_id = Some("chequing".into());
    entered.escrow_amount = Some(250.004);
    let next = apply_loan_setup(&json!({}), &setup(Some(entered.clone()))).unwrap();
    assert_eq!(next[RENEWAL_MATURITY_KEY], "2031-01-01");
    assert_eq!(next[PAYMENT_ACCOUNT_KEY], "chequing");
    assert_eq!(next[ESCROW_AMOUNT_KEY], "250");

    entered.renewal_maturity = None;
    entered.payment_account_id = None;
    entered.escrow_amount = Some(0.0);
    let cleared = apply_loan_setup(&next, &setup(Some(entered))).unwrap();
    for key in [RENEWAL_MATURITY_KEY, PAYMENT_ACCOUNT_KEY, ESCROW_AMOUNT_KEY] {
        assert!(cleared.get(key).is_none(), "{key}");
    }
}

#[test]
fn each_rule_is_refused_with_its_own_code() {
    let check = |change: &dyn Fn(&mut LoanSetup)| {
        let mut loan = setup(Some(schedule(LoanFrequency::Monthly)));
        change(&mut loan);
        let refused = apply_loan_setup(&json!({}), &loan).unwrap_err();
        assert_eq!(preview_loan_terms(&loan, &json!({})).unwrap_err(), refused);
        refused
    };
    let with = |edit: fn(&mut LoanSchedule)| {
        move |loan: &mut LoanSetup| edit(loan.schedule.as_mut().unwrap())
    };
    assert_eq!(
        check(&|l| l.original_amount = None),
        LoanError::AmountRequired
    );
    assert_eq!(
        check(&|l| l.original_amount = Some(0.0)),
        LoanError::AmountRequired
    );
    assert_eq!(
        check(&|l| l.origination_date = None),
        LoanError::OriginationRequired
    );
    assert_eq!(
        check(&|l| l.interest_rate = Some(101.0)),
        LoanError::RateInvalid
    );
    assert_eq!(
        check(&with(|s| s.first_payment_date = Some(date("2026-01-01")))),
        LoanError::FirstPaymentBeforeOrigination
    );
    assert_eq!(
        check(&with(|s| s.amortization_months = Some(0))),
        LoanError::AmortizationInvalid
    );
    assert_eq!(
        check(&with(|s| s.amortization_months = None)),
        LoanError::AmortizationInvalid
    );
    assert_eq!(
        check(&with(|s| {
            s.amortization_months = None;
            s.last_payment_date = Some(date("2026-01-15"));
        })),
        LoanError::AmortizationInvalid
    );
    assert_eq!(
        check(&with(|s| s.renewal_maturity = Some(date("2026-01-01")))),
        LoanError::MaturityBeforeOrigination
    );
    assert_eq!(
        check(&with(|s| s.payment_amount = Some(0.0))),
        LoanError::PaymentAmountInvalid
    );
    assert_eq!(
        check(&with(|s| s.escrow_amount = Some(-1.0))),
        LoanError::Invalid
    );
    // Manual loans still check what was entered.
    let mut manual = setup(None);
    manual.interest_rate = Some(-1.0);
    assert_eq!(
        apply_loan_setup(&json!({}), &manual).unwrap_err(),
        LoanError::RateInvalid
    );
}

#[test]
fn an_omitted_rate_is_zero_percent() {
    let mut loan = setup(Some(schedule(LoanFrequency::Monthly)));
    loan.interest_rate = None;
    let next = apply_loan_setup(&json!({}), &loan).unwrap();
    assert!(next.get(INTEREST_RATE_KEY).is_none());
    assert_eq!(terms(&next).annual_rate, 0.0);
}

#[test]
fn setups_read_the_shape_the_frontend_sends() {
    let loan: LoanSetup = serde_json::from_value(json!({
        "originalAmount": 200000,
        "originationDate": "2026-01-01",
        "interestRate": 5,
        "schedule": {
            "frequency": "accelerated_biweekly",
            "interestMethod": "semiannual",
            "amortizationMonths": 300,
            "paymentAccountId": "chequing"
        }
    }))
    .unwrap();
    let schedule = loan.schedule.unwrap();
    assert_eq!(schedule.frequency, LoanFrequency::AcceleratedBiweekly);
    assert_eq!(schedule.interest_method, InterestMethod::Semiannual);
    assert_eq!(schedule.payment_amount, None);
    assert_eq!(schedule.payment_account_id.as_deref(), Some("chequing"));
}

/// Results of the TypeScript calendar this replaced, so saved end dates never move.
#[test]
fn the_calendar_matches_the_forms_it_replaced() {
    for (first, months, frequency, last, count) in [
        ("2026-01-31", 13, LoanFrequency::Monthly, "2027-01-31", 13),
        ("2024-02-29", 12, LoanFrequency::Monthly, "2025-01-29", 12),
        ("2026-08-30", 61, LoanFrequency::Monthly, "2031-08-30", 61),
        ("2026-12-31", 1, LoanFrequency::Biweekly, "2027-01-14", 2),
        (
            "2026-03-15",
            361,
            LoanFrequency::Biweekly,
            "2056-02-20",
            782,
        ),
        (
            "2026-02-28",
            1200,
            LoanFrequency::AcceleratedBiweekly,
            "2125-10-13",
            2600,
        ),
    ] {
        let mut entered = schedule(frequency);
        entered.first_payment_date = Some(date(first));
        entered.amortization_months = Some(months);
        let mut loan = setup(Some(entered));
        loan.origination_date = Some(date("2023-01-01"));
        let preview = preview_loan_terms(&loan, &json!({})).unwrap().unwrap();
        assert_eq!(
            (preview.last_payment_date, preview.payment_count),
            (date(last), count)
        );
    }
}

#[test]
fn an_end_past_the_last_payment_the_engine_reaches_is_refused() {
    for frequency in [LoanFrequency::Monthly, LoanFrequency::Biweekly] {
        let first = date("2026-02-01");
        let limit = payment_date(first, MAX_PAYMENTS - 1, frequency).unwrap();
        let ending = |last: NaiveDate| {
            setup(Some(LoanSchedule {
                amortization_months: None,
                last_payment_date: Some(last),
                ..schedule(frequency)
            }))
        };
        // On the last payment the engine reaches, the loan is valued.
        let saved = apply_loan_setup(&json!({}), &ending(limit)).unwrap();
        assert!(calculate_loan(&LoanCalculationRequest {
            metadata: saved,
            balances: Vec::new(),
            as_of: date("2026-01-01"),
            payments: Vec::new(),
        })
        .is_some());
        // A day later it would save but never value, so it is refused.
        let late = limit.succ_opt().unwrap();
        assert_eq!(
            apply_loan_setup(&json!({}), &ending(late)).unwrap_err(),
            LoanError::AmortizationInvalid
        );
    }
}

#[test]
fn an_end_given_both_as_a_date_and_as_months_is_refused() {
    let both = setup(Some(LoanSchedule {
        last_payment_date: Some(date("2031-01-01")),
        ..schedule(LoanFrequency::Monthly)
    }));
    assert_eq!(
        apply_loan_setup(&json!({}), &both).unwrap_err(),
        LoanError::Invalid
    );
    assert_eq!(
        preview_loan_terms(&both, &json!({})).unwrap_err(),
        LoanError::Invalid
    );
}
