//! Wealthfolio portfolio engine: a pure, deterministic calculation kernel.
//!
//! Facts in (activities, quotes, FX, observed snapshots, policy), values out
//! (positions, lots, valuations, performance). No I/O, no clock, no locks, no
//! async. See `docs/architecture/portfolio-engine.md`; what it must produce in
//! the boundary cases is `docs/architecture/portfolio-engine-rules.md`.
//!
//! Stages: [`normalize`] → [`compile`] → [`resolve_surfaces`] → [`project`]
//! → [`value`] → [`measure_account`] / [`measure_scope`]. Every stage is a
//! total function of its arguments; imperfect data becomes [`Diagnostic`]s,
//! an unusable request becomes an [`EngineError`]. [`Engine`] runs them over
//! one set of facts; the stage functions stay public for chunked, resumed and
//! stored-row runs. Everything else is private: the public surface is this
//! file plus [`model`].

mod arith;
mod compile;
mod diagnostics;
mod engine;
mod error;
mod impact;
mod measure;
pub mod model;
mod normalize;
mod project;
mod resolve;
mod scope;
mod value;

pub use compile::{compile, CompiledLedger};
pub use diagnostics::{Diagnostic, DiagnosticCode, Severity};
pub use engine::Engine;
pub use error::EngineError;
pub use impact::{impact, FactChange, Impact, BEGINNING};
pub use measure::{
    measure_account, measure_price_series, measure_scope, MeasureInputs, MeasureProfile,
};
pub use normalize::{
    fx_conflicts, normalize, normalize_fx_rates, normalize_quotes, FxConflict, Normalized,
    FX_CONFLICT_TOLERANCE,
};
pub use project::lot_records;
pub use project::{project, project_accounts};
pub use resolve::{
    group_splits, resolve_surfaces, split_quantity_factor, FxResolver, FxSurface, QuoteSurface,
    ResolvedSurfaces, SplitEvent, SplitRow,
};
pub use scope::{facts_needed, FactsRequest};
pub use value::{aggregate_scope, effects, value, value_window, Resolved, ValueInputs, Window};
