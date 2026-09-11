//! Wealthfolio portfolio engine: a pure, deterministic calculation kernel.
//!
//! Facts in (activities, quotes, FX, observed snapshots, policy), values out
//! (positions, lots, valuations, performance). No I/O, no clock, no locks, no
//! async. See `docs/architecture/portfolio-engine.md`.
//!
//! Stages: [`normalize`] → [`compile`] → resolve → project → value → measure.
//! Every stage is a total function of its arguments; imperfect data becomes
//! [`Diagnostic`]s, an unusable request becomes an [`EngineError`].

pub mod compile;
pub mod diagnostics;
pub mod error;
pub mod measure;
pub mod model;
pub mod normalize;
pub mod project;
pub mod resolve;
pub mod scope;
pub mod value;

pub use compile::{compile, CompiledLedger};
pub use diagnostics::{Diagnostic, DiagnosticCode, Severity};
pub use error::EngineError;
pub use measure::{
    measure_account, measure_price_series, measure_scope, MeasureInputs, MeasureProfile,
};
pub use normalize::{normalize, Normalized};
pub use project::lot_records;
pub use project::project;
pub use resolve::{resolve_surfaces, FxResolver, FxSurface, QuoteSurface, ResolvedSurfaces};
pub use scope::{facts_needed, FactsRequest};
pub use value::{aggregate_scope, value, Resolved, ValueInputs, Window};
