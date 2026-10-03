//! Loan action rules, carried over from the frontend handlers they replace.
use super::*;
use serde_json::json;

fn date(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn today() -> NaiveDate {
    date("2026-10-02")
}

fn terms() -> Value {
    json!({"version":1,"annualRate":0,"paymentAmount":100,"frequency":"monthly","firstPaymentDate":"2026-02-01","amortizationEndDate":"2027-01-01"})
}

fn record(metadata: Value, balances: &[(&str, f64, Option<&str>)]) -> LoanRecord {
    let mut record = LoanRecord {
        asset_id: "loan".into(),
        currency: "CAD".into(),
        metadata,
        balances: vec![],
        payments: vec![],
    };
    record.balances = balances
        .iter()
        .map(|(day, balance, notes)| {
            record
                .manual_quote(date(day), *balance, notes.map(str::to_string))
                .unwrap()
        })
        .collect();
    record
}

fn events(metadata: &Value) -> Vec<LoanEvent> {
    event_entries(metadata)
        .iter()
        .filter_map(LoanEvent::parse)
        .collect()
}

fn apply(record: &LoanRecord, action: LoanAction) -> Result<LoanUpdate, LoanError> {
    apply_loan_action(record, &action, today())
}

fn close(update: &LoanUpdate) -> Vec<(NaiveDate, f64, Option<String>)> {
    update
        .save_balances
        .iter()
        .map(|q| (day_of(q), q.close.to_f64().unwrap(), q.notes.clone()))
        .collect()
}

fn extra(day: &str, amount: f64) -> LoanEvent {
    LoanEvent::ExtraRepayment {
        effective_date: date(day),
        amount,
        note: None,
    }
}

fn renewal(day: &str, rate: f64, end: Option<&str>) -> LoanEvent {
    LoanEvent::Renewal {
        effective_date: date(day),
        annual_rate: rate,
        payment_amount: None,
        frequency: None,
        interest_method: None,
        term_end_date: end.map(date),
        note: None,
    }
}

fn with_events(mut metadata: Value, events: &[LoanEvent]) -> Value {
    metadata[LOAN_EVENTS_KEY] = json!(events);
    metadata
}

#[test]
fn an_extra_repayment_on_a_calculated_loan_is_a_dated_event() {
    let loan = record(
        json!({ "loan_projection": terms() }),
        &[("2026-04-01", 500.0, None)],
    );
    let update = apply(
        &loan,
        LoanAction::ExtraRepayment {
            date: date("2026-05-10"),
            amount: 100.0,
        },
    )
    .unwrap();
    assert_eq!(
        events(update.metadata.as_ref().unwrap()),
        vec![extra("2026-05-10", 100.0)]
    );
    assert!(!update.changes_balances());
}

#[test]
fn an_extra_repayment_on_a_manual_loan_records_the_new_balance() {
    let loan = record(
        json!({ "loan_projection": terms(), "tracking_mode": "manual" }),
        &[("2026-04-01", 500.0, None)],
    );
    let update = apply(
        &loan,
        LoanAction::ExtraRepayment {
            date: date("2026-04-02"),
            amount: 100.0,
        },
    )
    .unwrap();
    assert!(update.metadata.is_none());
    assert_eq!(
        close(&update),
        vec![(
            date("2026-04-02"),
            400.0,
            Some("loan_event|type=extra_repayment".into())
        )]
    );
}

#[test]
fn a_manual_repayment_uses_the_balance_on_its_own_day() {
    let manual = json!({ "tracking_mode": "manual" });
    let loan = record(
        manual.clone(),
        &[("2026-02-01", 1200.0, None), ("2026-03-01", 1000.0, None)],
    );
    let repay = LoanAction::ExtraRepayment {
        date: date("2026-02-28"),
        amount: 100.0,
    };
    assert_eq!(close(&apply(&loan, repay.clone()).unwrap())[0].1, 1100.0);
    // A later balance cannot fund an earlier repayment.
    let later_only = record(manual, &[("2026-03-01", 1000.0, None)]);
    assert_eq!(apply(&later_only, repay).unwrap_err(), LoanError::Invalid);
}

#[test]
fn a_calculated_loan_without_a_valuation_refuses_repayments() {
    let loan = record(json!({ "loan_projection": terms() }), &[]);
    let repay = LoanAction::ExtraRepayment {
        date: date("2026-02-28"),
        amount: 100.0,
    };
    assert_eq!(apply(&loan, repay).unwrap_err(), LoanError::Invalid);
}

#[test]
fn repayments_cannot_exceed_the_balance_on_their_date() {
    let loan = record(
        json!({ "loan_projection": terms() }),
        &[("2026-04-01", 500.0, None)],
    );
    let repay = LoanAction::ExtraRepayment {
        date: date("2026-05-10"),
        amount: 450.0,
    };
    assert_eq!(
        apply(&loan, repay).unwrap_err(),
        LoanError::AmountExceedsBalance
    );
}

#[test]
fn dated_actions_stay_between_origination_and_today() {
    let loan = record(
        json!({ "tracking_mode": "manual", "origination_date": "2026-01-01" }),
        &[("2026-01-01", 1000.0, None)],
    );
    let early = date("2025-12-31");
    // One day of tolerance for a device ahead of the settings timezone.
    let future = date("2026-10-04");
    for action in [
        LoanAction::ExtraRepayment {
            date: early,
            amount: 1.0,
        },
        LoanAction::ConfirmBalance {
            date: future,
            balance: 1.0,
        },
    ] {
        assert_eq!(apply(&loan, action).unwrap_err(), LoanError::Invalid);
    }
    assert_eq!(
        apply(&loan, LoanAction::Close { date: early }).unwrap_err(),
        LoanError::ClosureDateInvalid
    );
}

#[test]
fn closing_records_a_zero_closing_balance() {
    let loan = record(json!({}), &[("2026-04-01", 500.0, None)]);
    let update = apply(
        &loan,
        LoanAction::Close {
            date: date("2026-06-01"),
        },
    )
    .unwrap();
    assert_eq!(
        close(&update),
        vec![(date("2026-06-01"), 0.0, Some("loan_closed".into()))]
    );
    assert_eq!(update.save_balances[0].id, "loan_2026-06-01_MANUAL");
}

#[test]
fn confirmed_balances_keep_their_cents() {
    let loan = record(json!({}), &[]);
    let update = apply(
        &loan,
        LoanAction::ConfirmBalance {
            date: date("2026-06-01"),
            balance: 1234.56,
        },
    )
    .unwrap();
    assert_eq!(update.save_balances[0].close.to_string(), "1234.56");
    assert_eq!(
        update.save_balances[0].notes.as_deref(),
        Some("loan_event|type=balance_correction")
    );
}

fn mortgage() -> Value {
    json!({ "sub_type": "mortgage", "loan_projection": terms() })
}

fn renew(day: &str) -> LoanAction {
    LoanAction::Renew {
        date: date(day),
        annual_rate: 3.0,
        payment_amount: None,
        frequency: None,
        interest_method: None,
        term_end_date: None,
        balance: None,
    }
}

#[test]
fn a_renewal_stores_only_settings_that_change() {
    let loan = record(mortgage(), &[("2026-02-01", 1000.0, None)]);
    let mut action = renew("2026-03-10");
    if let LoanAction::Renew {
        frequency,
        interest_method,
        ..
    } = &mut action
    {
        *frequency = Some(LoanFrequency::Monthly);
        *interest_method = Some(InterestMethod::NominalPeriodic);
    }
    let update = apply(&loan, action).unwrap();
    assert_eq!(
        events(update.metadata.as_ref().unwrap()),
        vec![renewal("2026-03-10", 3.0, None)]
    );
}

#[test]
fn a_renewal_that_changes_frequency_needs_its_payment() {
    let loan = record(mortgage(), &[("2026-02-01", 1000.0, None)]);
    let mut action = renew("2026-03-10");
    if let LoanAction::Renew { frequency, .. } = &mut action {
        *frequency = Some(LoanFrequency::Biweekly);
    }
    assert_eq!(
        apply(&loan, action.clone()).unwrap_err(),
        LoanError::PaymentRequired
    );
    if let LoanAction::Renew { payment_amount, .. } = &mut action {
        *payment_amount = Some(50.0);
    }
    let update = apply(&loan, action).unwrap();
    assert!(matches!(
        events(update.metadata.as_ref().unwrap())[..],
        [LoanEvent::Renewal {
            frequency: Some(LoanFrequency::Biweekly),
            payment_amount: Some(_),
            ..
        }]
    ));
}

#[test]
fn a_renewal_letter_balance_is_a_confirmation_that_keeps_the_days_note() {
    let loan = record(mortgage(), &[("2026-03-10", 640.0, Some("Statement"))]);
    let mut action = renew("2026-03-10");
    if let LoanAction::Renew { balance, .. } = &mut action {
        *balance = Some(600.0);
    }
    let update = apply(&loan, action).unwrap();
    assert_eq!(
        close(&update),
        vec![(
            date("2026-03-10"),
            600.0,
            Some("loan_event|type=balance_correction|note=Statement".into())
        )]
    );
    assert_eq!(events(update.metadata.as_ref().unwrap()).len(), 1);
}

#[test]
fn only_the_latest_renewal_sets_the_maturity() {
    let mut metadata = with_events(
        mortgage(),
        &[renewal("2026-06-01", 4.0, Some("2029-06-01"))],
    );
    metadata[RENEWAL_MATURITY_KEY] = json!("2029-06-01");
    let loan = record(metadata, &[("2026-02-01", 1000.0, None)]);
    let with_end = |day: &str, end: &str| {
        let mut action = renew(day);
        if let LoanAction::Renew { term_end_date, .. } = &mut action {
            *term_end_date = Some(date(end));
        }
        action
    };
    let older = apply(&loan, with_end("2026-03-01", "2026-06-01")).unwrap();
    assert_eq!(older.metadata.unwrap()[RENEWAL_MATURITY_KEY], "2029-06-01");
    let latest = apply(&loan, with_end("2026-07-01", "2031-07-01")).unwrap();
    assert_eq!(latest.metadata.unwrap()[RENEWAL_MATURITY_KEY], "2031-07-01");
}

#[test]
fn only_renewable_loans_renew() {
    let car = record(
        json!({ "sub_type": "auto", "loan_projection": terms() }),
        &[("2026-02-01", 1000.0, None)],
    );
    assert_eq!(
        apply(&car, renew("2026-03-10")).unwrap_err(),
        LoanError::Invalid
    );
    let manual = record(
        json!({ "sub_type": "mortgage", "loan_projection": terms(), "tracking_mode": "manual" }),
        &[("2026-02-01", 1000.0, None)],
    );
    assert_eq!(
        apply(&manual, renew("2026-03-10")).unwrap_err(),
        LoanError::Invalid
    );
}

#[test]
fn recalculation_stores_the_engines_solved_payment() {
    let loan = record(
        json!({ "loan_projection": terms() }),
        &[("2026-04-01", 500.0, None)],
    );
    let update = apply(
        &loan,
        LoanAction::Recalculate {
            date: date("2026-04-01"),
            annual_rate: 0.0,
        },
    )
    .unwrap();
    let solved = recalculate_loan(&LoanRecalculationRequest {
        loan: LoanCalculationRequest {
            metadata: loan.metadata.clone(),
            balances: loan.balances.iter().map(LoanBalance::from).collect(),
            as_of: date("2026-04-01"),
            payments: loan.payments.clone(),
        },
        annual_rate: 0.0,
    })
    .unwrap();
    assert_eq!(
        events(update.metadata.as_ref().unwrap()),
        vec![
            LoanEvent::RateChange {
                effective_date: date("2026-04-01"),
                annual_rate: 0.0,
                note: None
            },
            LoanEvent::PaymentChange {
                effective_date: date("2026-04-01"),
                payment_amount: solved.payment_amount,
                note: None
            },
        ]
    );
}

fn edit(index: usize, original: LoanEvent, replacement: Option<LoanEvent>) -> LoanAction {
    LoanAction::EditEvent {
        index,
        original,
        replacement,
    }
}

#[test]
fn editing_one_event_keeps_same_day_siblings_and_unreadable_entries() {
    let first = extra("2026-03-01", 100.0);
    let sibling = extra("2026-03-01", 200.0);
    let metadata = json!({
        "loan_events": json!([first, {"legacy": true}, sibling]).to_string(),
        "untouched": "yes",
    });
    let loan = record(metadata, &[]);
    let update = apply(&loan, edit(1, sibling, Some(extra("2026-03-01", 250.0)))).unwrap();
    let next = update.metadata.unwrap();
    assert_eq!(events(&next), vec![first, extra("2026-03-01", 250.0)]);
    assert!(event_entries(&next).contains(&json!({"legacy": true})));
    assert_eq!(next["untouched"], "yes");
}

#[test]
fn stale_or_invalid_event_edits_are_refused() {
    let stored = extra("2026-03-01", 100.0);
    let loan = record(with_events(json!({}), std::slice::from_ref(&stored)), &[]);
    assert_eq!(
        apply(
            &loan,
            edit(0, extra("2026-03-01", 300.0), Some(stored.clone()))
        )
        .unwrap_err(),
        LoanError::EventChanged
    );
    assert_eq!(
        apply(
            &loan,
            edit(0, stored.clone(), Some(extra("2026-03-01", -1.0)))
        )
        .unwrap_err(),
        LoanError::Invalid
    );
    let empty = record(json!({}), &[]);
    assert_eq!(
        apply(&empty, edit(0, stored, None)).unwrap_err(),
        LoanError::EventMissing
    );
}

#[test]
fn editing_the_latest_renewal_moves_its_maturity_and_deleting_falls_back() {
    let first = renewal("2026-02-01", 4.0, Some("2029-02-01"));
    let later = renewal("2026-04-01", 4.0, Some("2030-04-01"));
    let mut metadata = with_events(json!({}), &[first, later.clone()]);
    metadata[RENEWAL_MATURITY_KEY] = json!("2030-04-01");
    let loan = record(metadata, &[]);
    let moved = apply(
        &loan,
        edit(
            1,
            later.clone(),
            Some(renewal("2026-04-01", 4.0, Some("2031-04-01"))),
        ),
    )
    .unwrap();
    assert_eq!(moved.metadata.unwrap()[RENEWAL_MATURITY_KEY], "2031-04-01");
    let deleted = apply(&loan, edit(1, later, None)).unwrap();
    assert_eq!(
        deleted.metadata.unwrap()[RENEWAL_MATURITY_KEY],
        "2029-02-01"
    );
}

#[test]
fn an_independently_set_maturity_survives_editing_an_older_renewal() {
    let first = renewal("2026-02-01", 4.0, Some("2029-02-01"));
    let mut metadata = with_events(json!({}), std::slice::from_ref(&first));
    metadata[RENEWAL_MATURITY_KEY] = json!("2035-01-01");
    let deleted = apply(&record(metadata, &[]), edit(0, first, None)).unwrap();
    assert_eq!(
        deleted.metadata.unwrap()[RENEWAL_MATURITY_KEY],
        "2035-01-01"
    );

    let old = renewal("2025-02-01", 4.0, None);
    let current = renewal("2026-02-01", 4.0, Some("2029-02-01"));
    let mut metadata = with_events(json!({}), &[old.clone(), current]);
    metadata[RENEWAL_MATURITY_KEY] = json!("2029-02-01");
    let update = apply(
        &record(metadata, &[]),
        edit(0, old, Some(renewal("2025-02-01", 4.0, Some("2026-02-01")))),
    )
    .unwrap();
    assert_eq!(update.metadata.unwrap()[RENEWAL_MATURITY_KEY], "2029-02-01");
}

#[test]
fn the_latest_renewal_can_add_and_drop_a_maturity() {
    let plain = renewal("2026-02-01", 4.0, None);
    let dated = renewal("2026-02-01", 4.0, Some("2029-02-01"));
    let loan = record(with_events(json!({}), std::slice::from_ref(&plain)), &[]);
    let added = apply(&loan, edit(0, plain.clone(), Some(dated.clone())))
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(added[RENEWAL_MATURITY_KEY], "2029-02-01");
    let dropped = apply(&record(added, &[]), edit(0, dated, Some(plain)))
        .unwrap()
        .metadata
        .unwrap();
    assert!(dropped.get(RENEWAL_MATURITY_KEY).is_none());
}

#[test]
fn an_edited_repayment_cannot_exceed_the_balance_without_it() {
    let recorded = extra("2026-05-10", 100.0);
    let loan = record(
        with_events(
            json!({ "loan_projection": terms() }),
            std::slice::from_ref(&recorded),
        ),
        &[("2026-04-01", 500.0, None)],
    );
    assert_eq!(
        apply(&loan, edit(0, recorded, Some(extra("2026-05-10", 1000.0)))).unwrap_err(),
        LoanError::AmountExceedsBalance
    );
}

fn balance_edit(quote_id: &str, replacement: Option<(&str, f64, &str)>) -> LoanAction {
    LoanAction::EditBalance {
        quote_id: quote_id.into(),
        replacement: replacement.map(|(day, balance, note)| BalanceEdit {
            date: date(day),
            balance,
            note: note.into(),
        }),
    }
}

#[test]
fn balance_edits_refuse_an_occupied_date_and_move_or_delete_only_their_quote() {
    let loan = record(
        json!({}),
        &[
            ("2026-03-01", 900.0, None),
            ("2026-04-01", 500.0, Some("loan_closed")),
        ],
    );
    let april = loan.balances[1].id.clone();
    assert_eq!(
        apply(&loan, balance_edit(&april, Some(("2026-03-01", 450.0, "")))).unwrap_err(),
        LoanError::BalanceDateTaken
    );
    let deleted = apply(&loan, balance_edit(&april, None)).unwrap();
    assert_eq!(deleted.delete_balances, vec![april.clone()]);
    assert!(deleted.save_balances.is_empty());

    let moved = apply(
        &loan,
        balance_edit(&april, Some(("2026-04-15", 450.0, "Bank"))),
    )
    .unwrap();
    assert_eq!(
        close(&moved),
        vec![(
            date("2026-04-15"),
            450.0,
            Some("loan_event|type=balance_correction|note=Bank".into())
        )]
    );
    assert_eq!(moved.delete_balances, vec![april.clone()]);

    let same_day = apply(&loan, balance_edit(&april, Some(("2026-04-01", 0.0, "")))).unwrap();
    assert_eq!(same_day.save_balances[0].id, april);
    assert!(same_day.delete_balances.is_empty());
    assert_eq!(
        same_day.save_balances[0].notes.as_deref(),
        Some("loan_closed")
    );
    assert_eq!(
        apply(&loan, balance_edit("gone", None)).unwrap_err(),
        LoanError::EventMissing
    );
}

#[test]
fn actions_read_the_shape_the_frontend_sends() {
    let action: LoanAction = serde_json::from_value(json!({
        "type": "renew", "date": "2026-03-10", "annualRate": 3, "termEndDate": "2029-03-10"
    }))
    .unwrap();
    assert!(matches!(
        action,
        LoanAction::Renew {
            payment_amount: None,
            term_end_date: Some(_),
            ..
        }
    ));
    let action: LoanAction = serde_json::from_value(json!({
        "type": "edit_event", "index": 0, "replacement": null,
        "original": {"type": "extra_repayment", "effectiveDate": "2026-03-01", "amount": 100, "note": ""}
    }))
    .unwrap();
    assert!(matches!(
        action,
        LoanAction::EditEvent {
            replacement: None,
            ..
        }
    ));
}

#[test]
fn a_date_one_day_ahead_of_the_settings_timezone_is_accepted() {
    let loan = record(json!({}), &[]);
    let ahead = LoanAction::ConfirmBalance {
        date: date("2026-10-03"),
        balance: 100.0,
    };
    assert!(apply(&loan, ahead).is_ok());
}

#[test]
fn a_backdated_renewal_inherits_the_settings_in_effect_on_its_date() {
    let mut projection = terms();
    projection["interestMethod"] = json!("semiannual");
    let later = LoanEvent::Renewal {
        effective_date: date("2026-06-10"),
        annual_rate: 3.0,
        payment_amount: None,
        frequency: Some(LoanFrequency::Biweekly),
        interest_method: Some(InterestMethod::Monthly),
        term_end_date: None,
        note: None,
    };
    let metadata = with_events(
        json!({ "sub_type": "mortgage", "loan_projection": projection }),
        std::slice::from_ref(&later),
    );
    let loan = record(metadata, &[("2026-02-01", 1000.0, None)]);
    let renew_with = |day: &str, frequency, method| LoanAction::Renew {
        date: date(day),
        annual_rate: 2.0,
        payment_amount: None,
        frequency: Some(frequency),
        interest_method: Some(method),
        term_end_date: None,
        balance: None,
    };
    let before = apply(
        &loan,
        renew_with(
            "2026-03-10",
            LoanFrequency::Monthly,
            InterestMethod::Semiannual,
        ),
    )
    .unwrap();
    assert_eq!(
        events(before.metadata.as_ref().unwrap())[0],
        renewal("2026-03-10", 2.0, None)
    );
    // The same day's recorded renewal already set biweekly and monthly compounding.
    let same_day = apply(
        &loan,
        renew_with(
            "2026-06-10",
            LoanFrequency::Biweekly,
            InterestMethod::Monthly,
        ),
    )
    .unwrap();
    assert_eq!(
        events(same_day.metadata.as_ref().unwrap())[1],
        renewal("2026-06-10", 2.0, None)
    );
    assert_eq!(
        apply(
            &loan,
            renew_with(
                "2026-03-10",
                LoanFrequency::Biweekly,
                InterestMethod::Semiannual
            )
        )
        .unwrap_err(),
        LoanError::PaymentRequired
    );
}

#[test]
fn edited_renewals_the_engine_would_discard_are_refused() {
    let stored = renewal("2026-02-01", 4.0, Some("2029-02-01"));
    let loan = record(with_events(json!({}), std::slice::from_ref(&stored)), &[]);
    for replacement in [
        renewal("2026-02-01", 101.0, Some("2029-02-01")),
        LoanEvent::Renewal {
            effective_date: date("2026-02-01"),
            annual_rate: 4.0,
            payment_amount: Some(0.001),
            frequency: None,
            interest_method: None,
            term_end_date: Some(date("2029-02-01")),
            note: None,
        },
    ] {
        assert_eq!(
            apply(&loan, edit(0, stored.clone(), Some(replacement))).unwrap_err(),
            LoanError::Invalid
        );
    }
}

#[test]
fn entries_another_reader_skips_do_not_shift_the_edited_event() {
    let repayment = extra("2026-02-01", 100.0);
    // The frontend hides a renewal with a malformed term end; the engine keeps it.
    let metadata = json!({ "loan_events": json!([
        {"type":"renewal","effectiveDate":"2026-01-01","annualRate":4,"termEndDate":"soon"},
        repayment,
    ]).to_string() });
    let update = apply(
        &record(metadata, &[]),
        edit(0, repayment, Some(extra("2026-02-01", 150.0))),
    )
    .unwrap();
    assert_eq!(
        events(update.metadata.as_ref().unwrap())[1],
        extra("2026-02-01", 150.0)
    );
}

#[test]
fn tracked_terms_the_engine_cannot_use_do_not_become_a_manual_balance() {
    let mut unusable = terms();
    unusable["paymentAmount"] = json!(0.001);
    let loan = record(
        json!({ "loan_projection": unusable }),
        &[("2026-04-01", 500.0, None)],
    );
    let repay = LoanAction::ExtraRepayment {
        date: date("2026-04-02"),
        amount: 100.0,
    };
    assert_eq!(apply(&loan, repay).unwrap_err(), LoanError::Invalid);
}

#[test]
fn an_unreadable_event_list_is_refused_rather_than_replaced() {
    let loan = record(
        json!({ "loan_projection": terms(), "loan_events": "not-json" }),
        &[("2026-04-01", 500.0, None)],
    );
    let repay = LoanAction::ExtraRepayment {
        date: date("2026-05-10"),
        amount: 100.0,
    };
    assert_eq!(apply(&loan, repay).unwrap_err(), LoanError::Invalid);
}
