//! Live-model eval runner.
//!
//! Reads TOML eval suites from `crates/ai/evals/cases/`, runs each case
//! through `ChatService` against the configured LLM provider (Ollama by
//! default, model = `gemma4:e4b` unless `WF_EVAL_MODEL` is set), and reports
//! pass/fail per case.
//!
//! Build/run:
//!     cargo run -p wealthfolio-ai --bin eval --features eval
//!
//! Environment:
//!     WF_EVAL_PROVIDER       - rig provider id (default: ollama)
//!     WF_EVAL_MODEL          - model name      (default: gemma4:e4b)
//!     WF_EVAL_PROVIDER_URL   - provider base URL (default: http://localhost:11434 for ollama)
//!     WF_EVAL_FILTER         - substring filter on case id
//!     WF_EVAL_CASES_DIR      - override cases directory
//!
//! See `crates/ai/README.md` and `crates/ai/evals/README.md` for full docs.

use std::path::PathBuf;
use std::process::ExitCode;

use wealthfolio_ai::live_evals::runner::{is_blocking, run_case, AssertionFailure, RunnerConfig};
use wealthfolio_ai::live_evals::schema::{load_all_suites, Severity};

/// Default model when WF_EVAL_MODEL isn't set. Pinned here so the suite is
/// reproducible against a specific local model — change at one site.
/// Override at runtime: `WF_EVAL_MODEL=other-model cargo run --bin eval --features eval`.
const DEFAULT_MODEL: &str = "gemma4:e4b";

#[tokio::main]
async fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cases_dir = std::env::var("WF_EVAL_CASES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // Crate dir is the parent of the binary's target/. We resolve via CARGO_MANIFEST_DIR
            // when available (cargo run sets it), otherwise fall back to ./crates/ai/evals/cases.
            std::env::var("CARGO_MANIFEST_DIR")
                .map(|m| PathBuf::from(m).join("evals").join("cases"))
                .unwrap_or_else(|_| PathBuf::from("crates/ai/evals/cases"))
        });

    let filter = std::env::var("WF_EVAL_FILTER").ok();
    let cfg = RunnerConfig::from_env(DEFAULT_MODEL);

    println!("==> Live eval run");
    println!("    provider: {}", cfg.provider);
    println!("    model:    {}", cfg.model);
    if let Some(url) = &cfg.provider_url {
        println!("    url:      {url}");
    }
    println!("    cases:    {}", cases_dir.display());
    if let Some(f) = &filter {
        println!("    filter:   {f}");
    }
    println!();

    let suites = match load_all_suites(&cases_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Failed to load suites: {e}");
            return ExitCode::from(2);
        }
    };

    let mut total = 0usize;
    let mut passed = 0usize;
    let mut blocking_failures = 0usize;
    let mut soft_failures = 0usize;

    for suite in &suites {
        let suite_name = suite.name.as_deref().unwrap_or("(unnamed)");
        println!("=== Suite: {} ===", suite_name);
        if suite.cases.is_empty() {
            println!("    (no cases)\n");
            continue;
        }
        for case in &suite.cases {
            if let Some(f) = &filter {
                if !case.id.contains(f.as_str()) {
                    continue;
                }
            }
            total += 1;
            let result = run_case(case, &cfg).await;
            if result.passed {
                passed += 1;
                println!("  ✓ {}  [{:?}]", case.id, case.severity);
            } else {
                if is_blocking(&result) {
                    blocking_failures += 1;
                } else {
                    soft_failures += 1;
                }
                let icon = if matches!(case.severity, Severity::P0) {
                    "✗"
                } else {
                    "·"
                };
                println!(
                    "  {} {}  [{:?}]  ({} failure(s))",
                    icon,
                    case.id,
                    case.severity,
                    result.failures.len()
                );
                println!("      \"{}\"", case.description);
                for AssertionFailure { kind, message } in &result.failures {
                    println!("      - [{:?}] {}", kind, message);
                }
                let trace_summary = if result.trace.tool_calls.is_empty() {
                    "(no tool calls)".to_string()
                } else {
                    result
                        .trace
                        .tool_calls
                        .iter()
                        .map(|c| c.name.as_str())
                        .collect::<Vec<_>>()
                        .join(" → ")
                };
                println!("      trace: {trace_summary}");
            }
        }
        println!();
    }

    println!("==> {}/{} passed", passed, total);
    if blocking_failures > 0 {
        println!("    {} P0 failure(s) — blocking", blocking_failures);
    }
    if soft_failures > 0 {
        println!("    {} P1/P2 failure(s) — non-blocking", soft_failures);
    }

    if blocking_failures > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}
