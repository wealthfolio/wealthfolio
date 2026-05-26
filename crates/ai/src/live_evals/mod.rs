//! Live-model eval framework — drives chat turns through a REAL LLM provider
//! (Ollama by default; cloud via `WF_EVAL_PROVIDER` / `WF_EVAL_MODEL`) and
//! asserts on the resulting tool-call trace.
//!
//! Distinct from:
//! - `crate::eval` (singular): assertion helpers (event ordering, guardrails)
//!   and `GoldenScenario` definitions waiting for a future stub-LLM harness.
//!   No runner today.
//! - `crates/ai/tests/`: unit + integration tests (schema/contract checks,
//!   no LLM at all).
//!
//! Live evals catch **real model drift** that the other layers can't.
//!
//! See `crates/ai/evals/README.md` for run instructions and TOML schema.
//! See `crates/ai/src/bin/eval.rs` for the runner binary.

#![cfg(feature = "test-utils")]

pub mod schema;
pub mod trace;

// The runner pulls in `regex` and `toml` for case execution; only available
// under the full `eval` feature (`test-utils` alone gives you the schema +
// trace types without the runner / loader).
#[cfg(feature = "eval")]
pub mod runner;
