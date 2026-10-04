//! Skip reason tracking for provider selection diagnostics.

use crate::models::ProviderId;

/// Why a provider was skipped during fetch.
#[derive(Clone, Debug)]
pub enum SkipReason {
    /// Provider doesn't support this instrument kind (Equity/Crypto/Fx/Metal).
    InstrumentKindMismatch,

    /// Provider's coverage doesn't include this MIC.
    MicNotCovered { mic: Option<String> },

    /// Provider doesn't allow mic=None and instrument has no MIC.
    UnknownMicRejected,

    /// Provider's quote currency filter doesn't match (for metals).
    QuoteCurrencyMismatch { expected: String },

    /// Circuit breaker is open for this provider.
    CircuitBreakerOpen,

    /// Rate limiter blocked.
    RateLimited,

    /// Symbol resolution failed.
    ResolutionFailed { message: String },

    /// Provider doesn't support latest quotes (for latest fetch).
    LatestNotSupported,

    /// Provider doesn't support historical quotes (for historical fetch).
    HistoricalNotSupported,

    /// The security is assigned to a custom provider, which serves it alone.
    AssignedToCustomProvider,
}

/// Record of a single provider attempt during a fetch.
#[derive(Clone, Debug)]
pub struct ProviderAttempt {
    pub provider_id: ProviderId,
    pub skipped: Option<SkipReason>,
    pub error: Option<String>,
    pub success: bool,
}

/// Detailed result of a fetch operation with skip diagnostics.
#[derive(Clone, Debug, Default)]
pub struct FetchDiagnostics {
    pub attempts: Vec<ProviderAttempt>,
    /// Provider whose error the fetch returned, when a provider's error was returned.
    pub error_provider: Option<ProviderId>,
}

impl FetchDiagnostics {
    pub fn new() -> Self {
        Self {
            attempts: Vec::new(),
            error_provider: None,
        }
    }

    pub fn record_skip(&mut self, provider_id: ProviderId, reason: SkipReason) {
        self.attempts.push(ProviderAttempt {
            provider_id,
            skipped: Some(reason),
            error: None,
            success: false,
        });
    }

    pub fn record_error(&mut self, provider_id: ProviderId, error: String) {
        self.attempts.push(ProviderAttempt {
            provider_id,
            skipped: None,
            error: Some(error),
            success: false,
        });
    }

    pub fn record_success(&mut self, provider_id: ProviderId) {
        self.attempts.push(ProviderAttempt {
            provider_id,
            skipped: None,
            error: None,
            success: true,
        });
    }

    /// Summary for logging/debugging.
    pub fn summary(&self) -> String {
        self.attempts
            .iter()
            .map(|a| {
                if a.success {
                    format!("{}: SUCCESS", a.provider_id)
                } else if let Some(skip) = &a.skipped {
                    format!("{}: SKIPPED ({:?})", a.provider_id, skip)
                } else if let Some(err) = &a.error {
                    format!("{}: ERROR ({})", a.provider_id, err)
                } else {
                    format!("{}: UNKNOWN", a.provider_id)
                }
            })
            .collect::<Vec<_>>()
            .join(" -> ")
    }

    /// Check if any provider succeeded.
    pub fn has_success(&self) -> bool {
        self.attempts.iter().any(|a| a.success)
    }

    /// Get all skip reasons.
    pub fn skip_reasons(&self) -> Vec<(&ProviderId, &SkipReason)> {
        self.attempts
            .iter()
            .filter_map(|a| a.skipped.as_ref().map(|s| (&a.provider_id, s)))
            .collect()
    }

    /// Get all errors.
    pub fn errors(&self) -> Vec<(&ProviderId, &str)> {
        self.attempts
            .iter()
            .filter_map(|a| a.error.as_ref().map(|e| (&a.provider_id, e.as_str())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use super::*;

    #[test]
    fn test_diagnostics_summary() {
        let mut diag = FetchDiagnostics::new();
        diag.record_skip(Cow::Borrowed("YAHOO"), SkipReason::CircuitBreakerOpen);
        diag.record_error(Cow::Borrowed("ALPHA"), "Timeout".to_string());
        diag.record_success(Cow::Borrowed("MARKETDATA"));

        let summary = diag.summary();
        assert!(summary.contains("YAHOO: SKIPPED"));
        assert!(summary.contains("ALPHA: ERROR"));
        assert!(summary.contains("MARKETDATA: SUCCESS"));
    }

    #[test]
    fn test_has_success() {
        let mut diag = FetchDiagnostics::new();
        diag.record_skip(Cow::Borrowed("YAHOO"), SkipReason::CircuitBreakerOpen);
        assert!(!diag.has_success());

        diag.record_success(Cow::Borrowed("ALPHA"));
        assert!(diag.has_success());
    }

    #[test]
    fn test_skip_reasons() {
        let mut diag = FetchDiagnostics::new();
        diag.record_skip(Cow::Borrowed("A"), SkipReason::CircuitBreakerOpen);
        diag.record_skip(Cow::Borrowed("B"), SkipReason::HistoricalNotSupported);
        diag.record_success(Cow::Borrowed("C"));

        let reasons = diag.skip_reasons();
        assert_eq!(reasons.len(), 2);
    }
}
