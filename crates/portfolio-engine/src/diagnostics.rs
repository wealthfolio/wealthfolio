//! Data-quality channel (architecture §4.4): every degraded, missing, estimated, or
//! fallback input is reported here, attached to the event or day it affects.
//! Diagnostics are never turned into silent zeros and never dropped.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    /// Informational: behavior worth knowing about (e.g. a carried quote).
    Info,
    /// Result computed with a fallback or a degraded input.
    Warning,
    /// Input rejected; the affected activity contributed nothing.
    Error,
}

/// Stable machine-readable codes. Add variants; never rename them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticCode {
    /// Activity currency was empty; the account currency was used.
    MissingCurrency,
    /// Activity type or override is outside the closed vocabulary.
    UnknownActivityType,
    /// Subtype is not in the canonical vocabulary; treated as absent.
    UnknownSubtype,
    /// Posted row that requires final cash but stores none: zero cash effect.
    MissingFinalCash,
    /// Transfer group could not be paired (leg count, asset or quantity mismatch).
    InvalidTransferGroup,
    /// Transfer with no valid pair and no explicit external marker.
    UnknownTransferBoundary,
    /// Activity references an account not in the facts.
    UnknownAccount,
    /// Activity references an asset not in the facts.
    UnknownAsset,
    /// SPLIT without a positive ratio; ignored.
    InvalidSplitRatio,
    /// Activity was rejected by the projection (message says why).
    ActivityRejected,
    /// Sell or transfer-out against a missing/empty position: cash only.
    NoPositionToReduce,
    /// FX conversion unavailable; the value is carried unconverted or skipped.
    FxUnavailable,
    /// Cash bucket went negative.
    NegativeCash,
    /// Quote carried forward from an earlier observation.
    CarriedQuote,
    /// No quote observation usable for the day.
    MissingQuote,
    /// Quote observation with a non-positive close; ignored.
    InvalidQuote,
    /// FX observation with a non-positive rate; ignored.
    InvalidFxRate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub severity: Severity,
    /// Activity id, asset id, account id, or date the diagnostic points at.
    pub source: String,
    pub message: String,
}

impl Diagnostic {
    pub fn new(
        code: DiagnosticCode,
        severity: Severity,
        source: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            severity,
            source: source.into(),
            message: message.into(),
        }
    }

    pub fn warning(
        code: DiagnosticCode,
        source: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::new(code, Severity::Warning, source, message)
    }

    pub fn error(
        code: DiagnosticCode,
        source: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::new(code, Severity::Error, source, message)
    }

    pub fn info(
        code: DiagnosticCode,
        source: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::new(code, Severity::Info, source, message)
    }
}
