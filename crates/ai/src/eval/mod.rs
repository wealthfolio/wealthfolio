//! Assertion helpers for stream-event ordering + guardrail compliance,
//! plus `GoldenScenario` definitions for common portfolio workflows.
//!
//! **Status:** no harness wires these into a runner that drives `ChatService`
//! against a stub LLM. The helpers + scenarios sit ready for a future
//! mocked-agent runner. Today, behavior regressions are covered by the
//! `live_evals` framework (real LLM); code-flow regressions by integration
//! tests under `crates/ai/tests/`.
//!
//! # Running the helper tests
//!
//! ```bash
//! cargo test -p wealthfolio-ai eval:: -- --nocapture
//! ```

mod harness;
mod scenarios;

pub use harness::*;
pub use scenarios::*;
