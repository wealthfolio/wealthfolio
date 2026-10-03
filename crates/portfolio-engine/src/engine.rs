//! The kernel's entry point (architecture §4.3): facts in, results out.
//!
//! [`Engine::new`] normalises, compiles and resolves the facts once over the
//! range every stage must cover; projections, valuations, lot read models and
//! performance are then derived on request. The stage functions stay public
//! for the runs an engine does not cover alone: chunked folds and resumes from
//! a checkpoint, revaluing stored keyframes, and measuring stored rows.

use std::collections::{BTreeMap, BTreeSet};

use crate::compile::{compile, CompiledLedger};
use crate::diagnostics::Diagnostic;
use crate::error::EngineError;
use crate::measure::MeasureInputs;
use crate::model::*;
use crate::normalize::normalize;
use crate::project::{lot_records, project};
use crate::resolve::{resolve_surfaces, FxResolver, ResolvedSurfaces};
use crate::value::{effects, value, Resolved, ValueInputs};

#[derive(Debug, Clone)]
pub struct Engine {
    facts: CanonicalFacts,
    ledger: CompiledLedger,
    surfaces: ResolvedSurfaces,
    range: DateRange,
    normalize_diagnostics: Vec<Diagnostic>,
}

impl Engine {
    /// The range runs from the earliest activity's business date (or `as_of`
    /// when there is none, or when every activity is later) to `as_of`.
    pub fn new(raw: RawFacts) -> Result<Self, EngineError> {
        let normalized = normalize(raw)?;
        let facts = normalized.facts;
        let as_of = facts.policy.as_of;
        let start = facts
            .activities
            .iter()
            .map(|a| a.date)
            .min()
            .unwrap_or(as_of)
            .min(as_of);
        let range = DateRange { start, end: as_of };
        let ledger = compile(&facts);
        let surfaces = resolve_surfaces(&facts, range);
        Ok(Self {
            facts,
            ledger,
            surfaces,
            range,
            normalize_diagnostics: normalized.diagnostics,
        })
    }

    pub fn facts(&self) -> &CanonicalFacts {
        &self.facts
    }

    pub fn ledger(&self) -> &CompiledLedger {
        &self.ledger
    }

    pub fn surfaces(&self) -> &ResolvedSurfaces {
        &self.surfaces
    }

    pub fn range(&self) -> DateRange {
        self.range
    }

    /// Data problems found while normalising (compile's are on the ledger).
    pub fn normalize_diagnostics(&self) -> &[Diagnostic] {
        &self.normalize_diagnostics
    }

    pub fn fx(&self) -> FxResolver<'_> {
        FxResolver {
            surface: &self.surfaces.fx,
            policy: &self.facts.policy,
        }
    }

    pub fn resolved(&self) -> Resolved<'_> {
        Resolved {
            facts: &self.facts,
            ledger: &self.ledger,
            surfaces: &self.surfaces,
            range: self.range,
        }
    }

    /// The fold from genesis over the whole range.
    pub fn project(&self) -> Result<ProjectionBundle, EngineError> {
        self.project_from(None, self.range)
    }

    /// The fold over `range`, resumed from `start` (the state at the day
    /// before `range.start`) when given.
    pub fn project_from(
        &self,
        start: Option<ProjectionState>,
        range: DateRange,
    ) -> Result<ProjectionBundle, EngineError> {
        project(&self.ledger, &self.facts, &self.fx(), start, range)
    }

    pub fn value(&self, bundle: &ProjectionBundle) -> BTreeMap<AccountId, ValuationSeries> {
        value(&ValueInputs {
            resolved: self.resolved(),
            bundle,
            lots: None,
        })
    }

    pub fn lots(&self, bundle: &ProjectionBundle) -> Vec<LotRecord> {
        lot_records(bundle, &self.facts, &self.fx())
    }

    /// Every event priced once for scope aggregation and `measure`;
    /// `disposals` supply the removed-lot basis of unquoted outbound
    /// transfers and `rejected` the activities the fold left out (computed
    /// or stored).
    pub fn effects(
        &self,
        disposals: &[LotDisposal],
        lots: &[LotRecord],
        rejected: &BTreeSet<ActivityId>,
    ) -> Effects {
        effects(&self.resolved(), disposals, lots, rejected)
    }

    /// The inputs `measure_account` and `measure_scope` read: the priced
    /// events plus valuation series, lots and disposals (computed or stored).
    pub fn measure_inputs<'a>(
        &self,
        series: &'a BTreeMap<AccountId, ValuationSeries>,
        lots: &'a [LotRecord],
        disposals: &'a [LotDisposal],
        rejected: &BTreeSet<ActivityId>,
    ) -> MeasureInputs<'a> {
        MeasureInputs {
            effects: self.effects(disposals, lots, rejected),
            series,
            lots,
            disposals,
        }
    }
}
