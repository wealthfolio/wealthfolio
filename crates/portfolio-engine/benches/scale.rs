//! SCALE-01 (architecture §5): the six stages over a generated portfolio — 10
//! accounts, 40 assets, five years of daily quotes and ~20k activities.
//! Run with `cargo bench -p wealthfolio-portfolio-engine`.

use std::time::Duration;

use chrono::{NaiveDate, TimeZone, Utc};
use criterion::{criterion_group, criterion_main, Criterion};
use rust_decimal::Decimal;
use wealthfolio_portfolio_engine::model::*;
use wealthfolio_portfolio_engine::{
    compile, lot_records, measure_scope, normalize, project, resolve_surfaces, value, FxResolver,
    MeasureInputs, MeasureProfile, Resolved, ValueInputs, Window,
};

const ACCOUNTS: usize = 10;
const ASSETS: usize = 40;
const YEARS: i64 = 5;
const ACTIVITIES: usize = 20_000;

fn generated_facts() -> RawFacts {
    let start = NaiveDate::from_ymd_opt(2020, 1, 1).unwrap();
    let as_of = NaiveDate::from_ymd_opt(2020 + YEARS as i32, 1, 1).unwrap();
    let days = (as_of - start).num_days();
    let policy = Policy::new(Currency::parse("USD").unwrap(), chrono_tz::Tz::UTC, as_of);
    let accounts = (0..ACCOUNTS)
        .map(|i| RawAccount {
            id: format!("acc-{i}"),
            currency: if i % 3 == 0 { "CAD" } else { "USD" }.to_string(),
            account_type: "SECURITIES".to_string(),
            tracking_mode: "TRANSACTIONS".to_string(),
            is_archived: false,
        })
        .collect::<Vec<_>>();
    let assets = (0..ASSETS)
        .map(|i| RawAsset {
            id: format!("asset-{i}"),
            quote_currency: if i % 4 == 0 { "CAD" } else { "USD" }.to_string(),
            kind: "INVESTMENT".to_string(),
            instrument_type: Some("EQUITY".to_string()),
            contract_multiplier: None,
        })
        .collect::<Vec<_>>();

    // Deterministic pseudo-random stream.
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };

    let mut activities = Vec::with_capacity(ACTIVITIES + ACCOUNTS);
    for (i, account) in accounts.iter().enumerate() {
        activities.push(RawActivity {
            id: format!("dep-{i}"),
            account_id: account.id.clone(),
            asset_id: None,
            activity_type: "DEPOSIT".to_string(),
            activity_type_override: None,
            subtype: None,
            status: "POSTED".to_string(),
            timestamp: Utc.from_utc_datetime(&start.and_hms_opt(9, 0, 0).unwrap()),
            created_at: Utc.from_utc_datetime(&start.and_hms_opt(9, 0, 0).unwrap()),
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::from(5_000_000)),
            fee: None,
            tax: None,
            currency: account.currency.clone(),
            fx_rate: None,
            source_group_id: None,
            external_transfer: None,
            source_system: Some("CSV".to_string()),
            is_user_modified: false,
            updated_at: Utc.from_utc_datetime(&start.and_hms_opt(9, 0, 0).unwrap()),
        });
    }
    for n in 0..ACTIVITIES {
        let r = next();
        let account = &accounts[(r % ACCOUNTS as u64) as usize];
        let asset = &assets[((r >> 8) % ASSETS as u64) as usize];
        let day = start + chrono::Duration::days(((r >> 16) % days as u64) as i64);
        let side = if (r >> 40) % 3 == 0 { "SELL" } else { "BUY" };
        let quantity = Decimal::from(1 + (r >> 48) % 50);
        let price = Decimal::from(50 + (r >> 20) % 200);
        let timestamp = Utc.from_utc_datetime(&day.and_hms_opt(10, 0, 0).unwrap())
            + chrono::Duration::seconds(n as i64 % 3600);
        activities.push(RawActivity {
            id: format!("act-{n}"),
            account_id: account.id.clone(),
            asset_id: Some(asset.id.clone()),
            activity_type: side.to_string(),
            activity_type_override: None,
            subtype: None,
            status: "POSTED".to_string(),
            timestamp,
            created_at: timestamp,
            quantity: Some(quantity),
            unit_price: Some(price),
            amount: Some(quantity * price + Decimal::from(5)),
            fee: Some(Decimal::from(5)),
            tax: None,
            currency: asset.quote_currency.clone(),
            fx_rate: None,
            source_group_id: None,
            external_transfer: None,
            source_system: Some("CSV".to_string()),
            is_user_modified: false,
            updated_at: timestamp,
        });
    }

    let mut quotes = Vec::with_capacity(ASSETS * days as usize);
    for (i, asset) in assets.iter().enumerate() {
        let mut price = Decimal::from(100 + i as i64);
        for d in 0..days {
            let day = start + chrono::Duration::days(d);
            let drift = Decimal::from((next() % 7) as i64) - Decimal::from(3);
            price = (price + drift / Decimal::from(10)).max(Decimal::ONE);
            quotes.push(RawQuote {
                asset_id: asset.id.clone(),
                day,
                close: price,
                currency: asset.quote_currency.clone(),
                source: "GENERATED".to_string(),
            });
        }
    }
    let fx_rates = (0..days)
        .map(|d| RawFxRate {
            from: "USD".to_string(),
            to: "CAD".to_string(),
            day: start + chrono::Duration::days(d),
            rate: Decimal::new(130 + (d % 20), 2),
        })
        .collect();

    RawFacts {
        policy,
        accounts,
        assets,
        activities,
        quotes,
        fx_rates,
        observed_snapshots: Vec::new(),
    }
}

fn run_pipeline(raw: RawFacts) -> usize {
    let normalized = normalize(raw).expect("normalize");
    let facts = normalized.facts;
    let ledger = compile(&facts);
    let range = DateRange {
        start: facts.activities.iter().map(|a| a.date).min().unwrap(),
        end: facts.policy.as_of,
    };
    let surfaces = resolve_surfaces(&facts, range);
    let fx = FxResolver {
        surface: &surfaces.fx,
        policy: &facts.policy,
    };
    let bundle = project(&ledger, &facts, &fx, None, range).expect("project");
    let resolved = Resolved {
        facts: &facts,
        ledger: &ledger,
        surfaces: &surfaces,
        range,
    };
    let series = value(&ValueInputs {
        resolved,
        bundle: &bundle,
    });
    let lots = lot_records(&bundle, &facts, &fx);
    let measure_inputs = MeasureInputs {
        resolved,
        series: &series,
        lots: &lots,
        disposals: &bundle.disposals,
    };
    let scope: Vec<AccountId> = facts.accounts.keys().cloned().collect();
    let result = measure_scope(
        &measure_inputs,
        "portfolio",
        &scope,
        Window::default(),
        MeasureProfile::Full,
    )
    .unwrap();
    series.values().map(|s| s.days.len()).sum::<usize>() + result.series.len()
}

fn scale_01(c: &mut Criterion) {
    let raw = generated_facts();
    let mut group = c.benchmark_group("SCALE-01");
    group.sample_size(10);
    group.measurement_time(Duration::from_secs(20));
    group.bench_function("five_stages_20k_activities", |b| {
        b.iter(|| run_pipeline(raw.clone()))
    });
    group.finish();
}

criterion_group!(benches, scale_01);
criterion_main!(benches);
