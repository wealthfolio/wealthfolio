//! Asks Apple Intelligence questions about a seeded portfolio through the
//! app's chat service and checks each answer against the seeded data.
//!
//!     cargo run -p wealthfolio-apple-intelligence --example live_probes
//!
//! Environment:
//!     WF_PROBE_HOLDINGS - how many holdings to seed (default: 12). Raise it
//!                         to see how large a portfolio the model's context
//!                         window holds.
//!     WF_PROBE_TRIALS   - runs per question (default: 1)
//!     WF_PROBE_FILTER   - only questions containing this text (`a|b` for either)

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Apple Intelligence probes need macOS.");
}

#[cfg(target_os = "macos")]
mod probes {
    use std::collections::HashMap;
    use std::sync::{Arc, RwLock};
    use std::time::Instant;

    use chrono::NaiveDate;
    use futures::StreamExt;
    use rust_decimal::Decimal;
    use wealthfolio_ai::env::test_env::{
        MockAccountService, MockCashActivityService, MockEnvironment, MockHoldingsService,
        MockSettingsService,
    };
    use wealthfolio_ai::live_evals::trace::ToolTrace;
    use wealthfolio_ai::on_device::{OnDeviceModel, ON_DEVICE_PROVIDER_ID};
    use wealthfolio_ai::provider_model::{
        AI_PROVIDER_SETTINGS_KEY, AI_PROVIDER_SETTINGS_SCHEMA_VERSION,
    };
    use wealthfolio_ai::types::{ChatModelConfig, MessageAttachment, SendMessageRequest};
    use wealthfolio_ai::{ChatConfig, ChatService};
    use wealthfolio_core::accounts::Account;
    use wealthfolio_core::assets::InstrumentType;
    use wealthfolio_core::holdings::{Holding, HoldingType, Instrument, MonetaryValue};
    use wealthfolio_spending::cash_activities::SpendingContext;
    use wealthfolio_spending::insight::{
        InsightServiceTrait, SpendingInsight, SpendingInsightRequest,
    };

    /// The seeded accounts, as (id, name).
    const ACCOUNTS: &[(&str, &str)] = &[
        ("acc-brokerage", "Brokerage"),
        ("acc-retirement", "Retirement"),
    ];

    const NAMES: &[(&str, &str)] = &[
        ("VTI", "Vanguard Total Stock Market ETF"),
        ("AAPL", "Apple Inc."),
        ("MSFT", "Microsoft Corporation"),
        ("SHOP", "Shopify Inc."),
        ("XEQT", "iShares Core Equity ETF Portfolio"),
        ("NVDA", "NVIDIA Corporation"),
        ("BND", "Vanguard Total Bond Market ETF"),
        ("TD", "Toronto-Dominion Bank"),
        ("KO", "Coca-Cola Company"),
        ("AMZN", "Amazon.com Inc."),
        ("GOOGL", "Alphabet Inc."),
        ("JNJ", "Johnson & Johnson"),
    ];

    /// Holding `index` of the seeded portfolio. The first is the largest and
    /// the fourth (SHOP) is the only one at a loss, so answers can be checked.
    fn holding(index: usize) -> Holding {
        let (symbol, name) = match NAMES.get(index) {
            Some((symbol, name)) => ((*symbol).to_string(), (*name).to_string()),
            None => (format!("TKR{index}"), format!("Sample Company {index}")),
        };
        let value = Decimal::from(41_500 - 1_150 * i64::try_from(index).unwrap_or(0));
        let gain = if index == 3 {
            Decimal::from(-2_240)
        } else {
            Decimal::from(900 + 75 * i64::try_from(index).unwrap_or(0))
        };
        let cost = value - gain;
        let both = |amount: Decimal| MonetaryValue::new(amount, amount);
        Holding {
            id: format!("holding-{index}"),
            account_id: if index.is_multiple_of(2) {
                "acc-brokerage"
            } else {
                "acc-retirement"
            }
            .to_string(),
            holding_type: HoldingType::Security,
            is_closed: false,
            instrument: Some(Instrument {
                id: format!("asset-{index}"),
                symbol,
                name: Some(name),
                currency: "USD".to_string(),
                notes: None,
                pricing_mode: "MARKET".to_string(),
                preferred_provider: None,
                exchange_mic: Some("XNAS".to_string()),
                instrument_type: Some(InstrumentType::Equity),
                classifications: None,
            }),
            asset_kind: None,
            quantity: Decimal::from(100),
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            local_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            translate_observed_basis: false,
            fx_rate: None,
            market_value: both(value),
            cost_basis: Some(both(cost)),
            price: Some(value / Decimal::from(100)),
            purchase_price: None,
            unrealized_gain: Some(both(gain)),
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: Some(both(gain)),
            total_gain_pct: None,
            income: None,
            total_return: Some(both(gain)),
            total_return_pct: None,
            return_basis: Some(both(cost)),
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: None,
            as_of_date: NaiveDate::from_ymd_opt(2026, 11, 10).expect("a real date"),
            metadata: None,
            source_account_ids: Vec::new(),
        }
    }

    fn account(id: &str, name: &str) -> Account {
        Account {
            id: id.to_string(),
            name: name.to_string(),
            account_type: "SECURITIES".to_string(),
            currency: "USD".to_string(),
            is_active: true,
            is_archived: false,
            ..Account::default()
        }
    }

    fn environment(model: Arc<dyn OnDeviceModel>, holdings: usize) -> MockEnvironment {
        let mut env = MockEnvironment::new();
        env.on_device_model = Some(model);
        env.account_service = Arc::new(MockAccountService {
            accounts: ACCOUNTS
                .iter()
                .map(|(id, name)| account(id, name))
                .collect(),
        });
        env.holdings_service = Arc::new(MockHoldingsService {
            holdings: (0..holdings).map(holding).collect(),
            incomplete_account_ids: Vec::new(),
        });
        let settings = serde_json::json!({
            "schemaVersion": AI_PROVIDER_SETTINGS_SCHEMA_VERSION,
            "providers": { ON_DEVICE_PROVIDER_ID: { "enabled": true } },
        });
        env.settings_service = Arc::new(MockSettingsService {
            settings: RwLock::new(HashMap::from([(
                AI_PROVIDER_SETTINGS_KEY.to_string(),
                settings.to_string(),
            )])),
        });
        env.cash_activity_service = Arc::new(MockCashActivityService {
            context: SpendingContext {
                enabled: true,
                account_ids: vec!["acc-brokerage".to_string()],
                excluded_category_ids: Vec::new(),
            },
            ..MockCashActivityService::default()
        });
        env.spending_insight_service = Some(Arc::new(FixedInsight));
        env
    }

    /// November to date, whatever window is asked: Rent on Sunday the 1st is
    /// the largest day and category, and Saturday the 7th the next day.
    struct FixedInsight;

    #[async_trait::async_trait]
    impl InsightServiceTrait for FixedInsight {
        async fn compute(
            &self,
            _: SpendingInsightRequest,
            _: &str,
            _: &str,
        ) -> anyhow::Result<SpendingInsight> {
            Ok(serde_json::from_value(spending_insight())?)
        }
    }

    /// (date, category, amount) of each day's spending.
    const SPENDING: &[(&str, &str, f64)] = &[
        ("2026-11-01", "Rent", 1800.0),
        ("2026-11-02", "Groceries", 35.0),
        ("2026-11-06", "Restaurants", 95.0),
        ("2026-11-07", "Groceries", 160.0),
        ("2026-11-07", "Shopping", 220.0),
        ("2026-11-10", "Transport", 60.0),
        ("2026-11-11", "Restaurants", 40.0),
    ];

    fn spending_insight() -> serde_json::Value {
        use serde_json::json;
        let total: f64 = SPENDING.iter().map(|(_, _, amount)| amount).sum();
        let mut categories: Vec<(&str, f64)> = Vec::new();
        let mut days: Vec<(&str, f64)> = Vec::new();
        for (date, category, amount) in SPENDING {
            match categories.iter_mut().find(|(name, _)| name == category) {
                Some((_, sum)) => *sum += amount,
                None => categories.push((category, *amount)),
            }
            match days.iter_mut().find(|(day, _)| day == date) {
                Some((_, sum)) => *sum += amount,
                None => days.push((date, *amount)),
            }
        }
        let amount = |total: f64| json!({ "total": total, "monthlyBreakdown": [] });
        let period = |start: &str, end: &str| json!({ "start": start, "end": end, "months": [&start[..7]], "dayCount": 12 });
        json!({
            "period": period("2026-11-01T00:00:00Z", "2026-11-12T23:59:59Z"),
            "prior": period("2026-10-20T00:00:00Z", "2026-10-31T23:59:59Z"),
            "currency": "USD",
            "headline": {
                "spent": total, "income": 4200.0, "netCashflow": 4200.0 - total,
                "budget": 0.0, "remaining": 0.0, "priorSpent": 2050.0,
                "deltaVsPriorPct": total / 2050.0 - 1.0,
                "pace": { "dailyAvg": 0.0, "daysElapsed": 12, "daysRemaining": 0,
                          "projectedSpend": total, "expectedSpendToDate": 0.0 },
                "status": "on_track"
            },
            "groups": [{
                "group": { "id": "g1", "name": "Spending", "key": "spending", "sortOrder": 0,
                           "isSystem": true, "createdAt": "2026-01-01T00:00:00",
                           "updatedAt": "2026-01-01T00:00:00" },
                "budget": amount(0.0), "buffer": amount(0.0), "spent": total,
                "priorSpent": 2050.0, "remaining": 0.0, "overspent": false,
                "pctOfTotalSpent": 1.0,
                "categories": categories.iter().map(|(name, spent)| json!({
                    "taxonomyId": "spending_categories", "categoryId": name.to_lowercase(),
                    "name": name, "budget": amount(0.0), "spent": spent, "priorSpent": 0.0,
                    "remaining": 0.0, "overspent": false, "pctOfTotalSpent": spent / total,
                    "txnCount": 1
                })).collect::<Vec<_>>()
            }],
            "uncategorized": { "spent": 0.0, "priorSpent": 0.0, "txnCount": 0 },
            "byDay": days.iter().map(|(date, spent)| json!({
                "date": date, "spent": spent, "income": 0.0
            })).collect::<Vec<_>>(),
            "byDayByCategory": [],
            "byMonth": [{ "month": "2026-11", "spent": total, "income": 4200.0 }]
        })
    }

    struct Probe {
        question: &'static str,
        /// The answer must contain one of these, ignoring case.
        expect_any: &'static [&'static str],
        /// Tools that must not be called.
        forbid_tools: bool,
    }

    const PROBES: &[Probe] = &[
        Probe {
            question: "What is my biggest holding?",
            expect_any: &["VTI", "Vanguard Total Stock"],
            forbid_tools: false,
        },
        Probe {
            question: "Which of my holdings is at a loss?",
            expect_any: &["SHOP", "Shopify"],
            forbid_tools: false,
        },
        Probe {
            question: "How much is my Apple position worth?",
            expect_any: &["40,350", "40350"],
            forbid_tools: false,
        },
        Probe {
            question: "How many accounts do I have, and what are they called?",
            expect_any: &["Brokerage"],
            forbid_tools: false,
        },
        Probe {
            question: "Quelle est ma plus grosse position ?",
            expect_any: &["VTI", "Vanguard Total Stock"],
            forbid_tools: false,
        },
        Probe {
            question: "Hi! What can you help me with?",
            expect_any: &["holdings", "accounts", "portfolio", "allocation"],
            forbid_tools: true,
        },
        Probe {
            question: "hello",
            expect_any: &[""],
            forbid_tools: true,
        },
        Probe {
            question: "thanks!",
            expect_any: &[""],
            forbid_tools: true,
        },
        Probe {
            question: "What is a dividend?",
            expect_any: &["dividend"],
            forbid_tools: true,
        },
        Probe {
            question: "Do I hold any Tesla?",
            expect_any: &["no", "don't", "not"],
            forbid_tools: false,
        },
        Probe {
            question: "Should I sell my Shopify shares?",
            expect_any: &["cannot", "can't", "can’t", "not able", "unable"],
            forbid_tools: false,
        },
        Probe {
            question: "record buy 3 shares of Apple at 340 yesterday",
            expect_any: &["draft", "review"],
            forbid_tools: false,
        },
        Probe {
            question: "I sold 10 MSFT at 410 today in my Brokerage account",
            expect_any: &["draft", "review"],
            forbid_tools: false,
        },
        Probe {
            question: "Record a $500 deposit to Retirement on 2026-11-03",
            expect_any: &["draft", "review"],
            forbid_tools: false,
        },
        Probe {
            question: "record this activity",
            expect_any: &["draft", "review"],
            forbid_tools: false,
        },
        Probe {
            question: "What does this image show?",
            expect_any: &["AAPL", "Apple"],
            forbid_tools: false,
        },
        Probe {
            question: "When do I spend the most?",
            expect_any: &["sunday", "november 1", "nov 1", "11-01"],
            forbid_tools: false,
        },
        Probe {
            question: "What's my biggest expense this month?",
            expect_any: &["rent"],
            forbid_tools: false,
        },
        Probe {
            question: "How much have I spent so far this month?",
            expect_any: &["2,410", "2410"],
            forbid_tools: false,
        },
        Probe {
            question: "¿En qué gasto más dinero?",
            expect_any: &["rent", "alquiler"],
            forbid_tools: false,
        },
    ];

    /// For a question, the tool that must be called and what its arguments
    /// must contain.
    const REQUIRED_CALLS: &[(&str, &str, &[&str])] = &[
        (
            "record buy 3 shares of Apple at 340 yesterday",
            "record_activity",
            &[
                "\"BUY\"",
                "\"quantity\":3",
                "\"unitPrice\":340",
                "2026-11-1",
            ],
        ),
        (
            "I sold 10 MSFT at 410 today in my Brokerage account",
            "record_activity",
            &["\"SELL\"", "MSFT", "\"quantity\":10", "\"unitPrice\":410"],
        ),
        (
            "Record a $500 deposit to Retirement on 2026-11-03",
            "record_activity",
            &["\"DEPOSIT\"", "500", "2026-11-03", "Retirement"],
        ),
        (
            "record this activity",
            "record_activity",
            &[
                "\"BUY\"",
                "AAPL",
                "\"quantity\":3",
                "\"unitPrice\":340",
                "2026-11-11",
            ],
        ),
        (
            "When do I spend the most?",
            "get_spending_insight",
            &["startDate", "endDate"],
        ),
        (
            "What's my biggest expense this month?",
            "get_spending_insight",
            &["\"startDate\":\"2026-11-01\""],
        ),
        (
            "How much have I spent so far this month?",
            "get_spending_insight",
            &["\"startDate\":\"2026-11-01\""],
        ),
        (
            "¿En qué gasto más dinero?",
            "get_spending_insight",
            &["startDate"],
        ),
    ];

    /// Questions sent with the image at `WF_PROBE_IMAGE`, a broker's
    /// confirmation of a buy of 3 AAPL at 340.00 on 2026-11-11. They are
    /// skipped without one.
    const IMAGE_QUESTIONS: &[&str] = &["record this activity", "What does this image show?"];

    /// The account the image names.
    const IMAGE_ACCOUNT: &str = "Brokerage";

    /// Lowercase phrases that claim a draft was made.
    const DRAFT_CLAIMS: &[&str] = &[
        "draft is ready",
        "draft ready",
        "ready to draft",
        "ready to record",
        "record this draft",
        "i'll record",
    ];

    fn image_attachment(path: &str) -> Option<MessageAttachment> {
        use base64::Engine;
        let bytes = std::fs::read(path).ok()?;
        Some(MessageAttachment {
            name: "confirmation.png".to_string(),
            content_type: "image/png".to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    pub async fn run() -> std::process::ExitCode {
        use std::process::ExitCode;

        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

        let Some(model) = wealthfolio_apple_intelligence::model() else {
            eprintln!("This system has no Apple Intelligence framework.");
            return ExitCode::from(2);
        };
        let var = |name: &str| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.parse().ok())
        };
        let holdings: usize = var("WF_PROBE_HOLDINGS").unwrap_or(12);
        let trials: usize = var("WF_PROBE_TRIALS").unwrap_or(1);
        println!(
            "context window: {} tokens, {holdings} holdings seeded",
            model.context_size()
        );

        let (mut passed, mut total) = (0, 0);
        let filter = std::env::var("WF_PROBE_FILTER").ok();
        let image = std::env::var("WF_PROBE_IMAGE")
            .ok()
            .and_then(|path| image_attachment(&path));
        for probe in PROBES {
            if filter
                .as_deref()
                .is_some_and(|filter| !filter.split('|').any(|part| probe.question.contains(part)))
            {
                continue;
            }
            let attachments = if IMAGE_QUESTIONS.contains(&probe.question) {
                let Some(image) = &image else {
                    println!("\nSKIP (no WF_PROBE_IMAGE)  {}", probe.question);
                    continue;
                };
                Some(vec![image.clone()])
            } else {
                None
            };
            for _ in 0..trials {
                let mut error_code = None;
                let env = Arc::new(environment(model.clone(), holdings));
                let service = ChatService::new(env, ChatConfig::default());
                let started = Instant::now();
                let mut trace = ToolTrace::default();
                let request = SendMessageRequest {
                    thread_id: None,
                    content: probe.question.to_string(),
                    attachments: attachments.clone(),
                    config: Some(ChatModelConfig {
                        provider: Some(ON_DEVICE_PROVIDER_ID.to_string()),
                        model: Some("on-device".to_string()),
                        thinking: None,
                    }),
                    provider_id: None,
                    model_id: None,
                    allowed_tools: None,
                    parent_message_id: None,
                };
                match service.send_message(request).await {
                    Ok(mut stream) => {
                        while let Some(event) = stream.next().await {
                            if let wealthfolio_ai::AiStreamEvent::Error { code, .. } = &event {
                                error_code = Some(code.clone());
                            }
                            trace.ingest(&event);
                        }
                    }
                    Err(error) => {
                        trace.had_error = true;
                        trace.error_message = Some(error.to_string());
                    }
                }

                let answer = trace.final_text.to_lowercase();
                let ok = !trace.had_error
                    && probe
                        .expect_any
                        .iter()
                        .any(|expected| answer.contains(&expected.to_lowercase()))
                    && !(probe.forbid_tools && !trace.tool_calls.is_empty())
                    && REQUIRED_CALLS
                        .iter()
                        .filter(|(question, ..)| *question == probe.question)
                        .all(|(_, tool, parts)| {
                            trace.tool_calls.iter().any(|call| {
                                let args = call.args.to_string();
                                call.name == *tool && parts.iter().all(|part| args.contains(part))
                            })
                        })
                    // No answer claims a draft that was never made.
                    && (trace.tool_calls.iter().any(|call| call.name == "record_activity")
                        || !DRAFT_CLAIMS.iter().any(|claim| answer.contains(claim)))
                    // A draft's account is one the user named, by its id or
                    // name, in words or in the image; an account the user
                    // never named stays empty.
                    && trace
                        .tool_calls
                        .iter()
                        .filter(|call| call.name == "record_activity")
                        .all(|call| {
                            let given = call.args["account"].as_str().unwrap_or_default();
                            let named_by = |name: &str| {
                                probe.question.contains(name)
                                    || (attachments.is_some() && name == IMAGE_ACCOUNT)
                            };
                            let named = ACCOUNTS.iter().any(|(_, name)| named_by(name));
                            (given.is_empty() && !named)
                                || ACCOUNTS.iter().any(|(id, name)| {
                                    named_by(name)
                                        && (given.eq_ignore_ascii_case(id)
                                            || given.eq_ignore_ascii_case(name))
                                })
                        });
                total += 1;
                passed += usize::from(ok);

                let calls: Vec<String> = trace
                    .tool_calls
                    .iter()
                    .map(|call| {
                        let size = trace
                            .tool_results
                            .get(&call.id)
                            .map_or(0, |result| result.data.to_string().len());
                        format!("{}{} -> {size} bytes", call.name, call.args)
                    })
                    .collect();
                println!(
                    "\n{} {:.1}s  {}",
                    if ok { "PASS" } else { "FAIL" },
                    started.elapsed().as_secs_f64(),
                    probe.question
                );
                println!("     tools: [{}]", calls.join(", "));
                if let Some(error) = &trace.error_message {
                    println!(
                        "     error: {} {error}",
                        error_code.as_deref().unwrap_or("-")
                    );
                }
                let shown: String = trace.final_text.chars().take(400).collect();
                println!("     > {}", shown.replace('\n', " "));
            }
        }

        println!("\n{passed}/{total} passed");
        if passed == total {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        }
    }
}

#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    probes::run().await
}
