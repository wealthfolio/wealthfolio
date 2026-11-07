//! Data-quality channel (architecture §4.4): every degraded, missing, estimated, or
//! fallback input is reported here, attached to the event or day it affects.
//! Diagnostics are never turned into silent zeros and never dropped.

use chrono::NaiveDate;
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
    /// A conversion row that does not form a valid pair (rules R7.5): its
    /// event changes nothing, and the projection rejects it.
    InvalidConversion,
    /// Sell or transfer-out against a missing/empty position: cash only.
    NoPositionToReduce,
    /// FX conversion unavailable; the value is carried unconverted or skipped.
    FxUnavailable,
    /// Cash bucket went negative.
    NegativeCash,
    /// Quote carried forward from an earlier observation.
    CarriedQuote,
    /// FX rate resolved from an observation a week or more away from the
    /// valued day, in either direction (nearest-neighbour resolution).
    CarriedFxRate,
    /// No quote observation usable for the day.
    MissingQuote,
    /// Quote observation with a non-positive close; ignored.
    InvalidQuote,
    /// FX observation with a non-positive rate; ignored.
    InvalidFxRate,
    /// A magnitude outside the kernel range (`MAX_MAGNITUDE`): the input row
    /// was ignored, or the value it would produce was declined.
    ValueOutOfRange,
    /// Sell, transfer-out or expiry of more units than held: the held units
    /// were disposed and the excess has no lot.
    InsufficientQuantity,
    /// A pair observed in both directions on the same days with rates that
    /// disagree: each direction converts at its own observation.
    ConflictingFxRates,
}

/// Domain reasons carried with activity diagnostics. Values stay raw; consumers
/// choose the language and presentation. Persisted consumers retain the fallback
/// message when they encounter a reason their version does not understand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    content = "params",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum ActivityReason {
    MissingFxRate {
        from: String,
        to: String,
        date: NaiveDate,
    },
    CloseBuyWithoutShortPosition {
        asset: String,
    },
    SellShortIntentRequired {
        asset: String,
    },
    ConversionInsufficientHoldings {
        asset: String,
        requested: String,
        held: String,
    },
    ConversionCurrencyMismatch {
        from_asset: String,
        from_currency: String,
        to_asset: String,
        to_currency: String,
    },
    ReturnOfCapitalAmountRequired,
    SellWithoutPosition {
        asset: String,
    },
    InsufficientQuantity {
        action: String,
        asset: String,
        requested: String,
        held: String,
        excess: String,
    },
    MissingFinalCash,
}

/// A rejected activity's existing fallback message plus an optional domain reason.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub(crate) struct ActivityRejection {
    pub message: String,
    pub reason: Option<Box<ActivityReason>>,
}

impl ActivityRejection {
    pub fn with_reason(message: impl Into<String>, reason: ActivityReason) -> Self {
        Self {
            message: message.into(),
            reason: Some(Box::new(reason)),
        }
    }
}

impl From<String> for ActivityRejection {
    fn from(message: String) -> Self {
        Self {
            message,
            reason: None,
        }
    }
}

impl From<&str> for ActivityRejection {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub severity: Severity,
    /// Activity id, asset id, account id, or date the diagnostic points at.
    pub source: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ActivityReason>,
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
            reason: None,
        }
    }

    /// Attaches a typed activity reason without changing its outcome or severity.
    pub fn with_reason(mut self, reason: Option<ActivityReason>) -> Self {
        self.reason = reason;
        self
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
