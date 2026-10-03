//! Shared test support for the calculation path: the in-memory
//! repository/service doubles and the scenario fixture schema the
//! coordinator tests run over. Nothing here is compiled into production
//! builds.

/// The engine's scenario generator (standard library only), shared so the
/// app parity test runs over the same generated corpus as the kernel laws.
#[path = "../../../portfolio-engine/tests/support/generate.rs"]
pub mod generate;
pub mod in_memory;
pub mod scenario;
