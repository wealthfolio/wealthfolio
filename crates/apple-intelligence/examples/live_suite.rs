//! Runs the assistant's live eval suites against Apple Intelligence on this
//! Mac, through the same chat service the app uses.
//!
//!     cargo run -p wealthfolio-apple-intelligence --example eval
//!
//! Environment:
//!     WF_EVAL_SUITES  - comma-separated suite names, or `all`
//!                       (default: data_queries,safety — what the read tools cover)
//!     WF_EVAL_FILTER  - substring filter on case id
//!     WF_EVAL_TRIALS  - runs per case (default: 1)
//!
//! The eval binary in `crates/ai` cannot reach the device's model, which only
//! this crate links, so this entry point hands the model to the same runner.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Apple Intelligence evals need macOS.");
}

#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    use std::path::PathBuf;
    use std::process::ExitCode;

    use wealthfolio_ai::live_evals::runner::{run_case, JudgeConfig, RunnerConfig};
    use wealthfolio_ai::live_evals::schema::load_all_suites;
    use wealthfolio_ai::on_device::{OnDeviceModelStatus, ON_DEVICE_PROVIDER_ID};

    let Some(model) = wealthfolio_apple_intelligence::model() else {
        eprintln!("This system has no Apple Intelligence framework.");
        return ExitCode::from(2);
    };
    if model.status() != OnDeviceModelStatus::Available {
        eprintln!("Apple Intelligence is not available: {:?}", model.status());
        return ExitCode::from(2);
    }
    println!("context window: {} tokens", model.context_size());

    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let suites_wanted = var("WF_EVAL_SUITES").unwrap_or_else(|| "data_queries,safety".to_string());
    let filter = var("WF_EVAL_FILTER");
    let trials: u32 = var("WF_EVAL_TRIALS")
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);

    let cases_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ai/evals/cases");
    let suites = match load_all_suites(&cases_dir) {
        Ok(suites) => suites,
        Err(error) => {
            eprintln!("could not load {}: {error}", cases_dir.display());
            return ExitCode::from(2);
        }
    };

    let cfg = RunnerConfig {
        provider: ON_DEVICE_PROVIDER_ID.to_string(),
        model: "on-device".to_string(),
        provider_url: None,
        thinking: None,
        titles: true,
        listed_capabilities: None,
        judge: JudgeConfig {
            provider: ON_DEVICE_PROVIDER_ID.to_string(),
            model: None,
            provider_url: None,
        },
        on_device_model: Some(model),
    };

    let (mut passed, mut total) = (0u32, 0u32);
    for suite in &suites {
        let name = suite.name.as_deref().unwrap_or_default();
        if suites_wanted != "all" && !suites_wanted.split(',').any(|wanted| wanted.trim() == name) {
            continue;
        }
        println!("\n== {name}");
        for case in &suite.cases {
            if filter
                .as_deref()
                .is_some_and(|filter| !case.id.contains(filter))
            {
                continue;
            }
            for _ in 0..trials {
                let result = run_case(case, &cfg).await;
                total += 1;
                passed += u32::from(result.passed);
                let calls: Vec<String> = result
                    .trace
                    .tool_calls
                    .iter()
                    .map(|call| format!("{}{}", call.name, call.args))
                    .collect();
                println!(
                    "{} {:<52} {:>5.1}s  [{}]",
                    if result.passed { "PASS" } else { "FAIL" },
                    case.id,
                    result.wall_time.as_secs_f64(),
                    calls.join(", "),
                );
                for failure in &result.failures {
                    println!("       {:?}: {}", failure.kind, failure.message);
                }
                let answer: String = result.trace.final_text.chars().take(220).collect();
                println!("       > {}", answer.replace('\n', " "));
            }
        }
    }

    println!("\n{passed}/{total} passed");
    if passed == total {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
