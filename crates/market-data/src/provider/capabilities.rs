//! Provider capabilities and rate limiting configuration.
//!
//! This module defines structures for describing what a market data provider
//! can do and how it should be rate-limited.

use std::time::Duration;

use crate::models::{Coverage, InstrumentId, InstrumentKind};

/// Describes the capabilities of a market data provider.
///
/// Used by the registry to determine which providers can handle
/// specific instruments and request patterns.
#[derive(Clone, Copy, Debug)]
pub struct ProviderCapabilities {
    /// Instrument kinds this provider supports (e.g., Equity, Crypto, Fx, Metal).
    pub instrument_kinds: &'static [InstrumentKind],

    /// Market/exchange coverage restrictions.
    pub coverage: Coverage,

    /// Whether the provider supports fetching the latest (real-time) quote.
    pub supports_latest: bool,

    /// Whether the provider supports historical quote fetching.
    pub supports_historical: bool,

    /// Whether the provider supports symbol/asset search.
    pub supports_search: bool,

    /// Whether the provider supports fetching asset profiles.
    pub supports_profile: bool,

    /// Whether the provider supports fetching cash dividend events.
    pub supports_dividends: bool,
}

impl ProviderCapabilities {
    /// Check if this provider can handle the given instrument.
    ///
    /// Checks both instrument kind and coverage restrictions.
    pub fn supports_instrument(&self, inst: &InstrumentId) -> bool {
        // 1. Check instrument kind
        if !self.instrument_kinds.contains(&inst.instrument_kind()) {
            return false;
        }

        // 2. Check coverage restrictions
        self.coverage.supports(inst)
    }
}

/// Rate limiting configuration for a provider.
///
/// Controls how aggressively we can call a provider to avoid
/// hitting their rate limits and getting blocked.
#[derive(Clone, Copy, Debug)]
pub struct RateLimit {
    /// Maximum requests allowed per minute.
    pub requests_per_minute: u32,

    /// Maximum concurrent requests to this provider.
    pub max_concurrency: usize,

    /// Minimum delay between requests.
    pub min_delay: Duration,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            requests_per_minute: 60,
            max_concurrency: 5,
            min_delay: Duration::from_millis(100),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::sync::Arc;

    #[test]
    fn test_supports_instrument_kind_mismatch() {
        let caps = ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity],
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
            supports_dividends: false,
        };

        let crypto = InstrumentId::Crypto {
            base: Arc::from("BTC"),
            quote: Cow::Borrowed("USD"),
        };
        assert!(!caps.supports_instrument(&crypto));
    }

    #[test]
    fn test_supports_instrument_coverage_check() {
        let caps = ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity],
            coverage: Coverage::us_only_strict(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
            supports_dividends: false,
        };

        // US equity should be supported
        let us_equity = InstrumentId::Equity {
            ticker: Arc::from("AAPL"),
            mic: Some(Cow::Borrowed("XNAS")),
        };
        assert!(caps.supports_instrument(&us_equity));

        // Canadian equity should not be supported
        let ca_equity = InstrumentId::Equity {
            ticker: Arc::from("SHOP"),
            mic: Some(Cow::Borrowed("XTSE")),
        };
        assert!(!caps.supports_instrument(&ca_equity));
    }

    #[test]
    fn test_supports_instrument_unknown_mic() {
        // Strict coverage rejects unknown MIC
        let strict_caps = ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity],
            coverage: Coverage::us_only_strict(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
            supports_dividends: false,
        };

        let unknown_mic = InstrumentId::Equity {
            ticker: Arc::from("AAPL"),
            mic: None,
        };
        assert!(!strict_caps.supports_instrument(&unknown_mic));

        // Best-effort coverage accepts unknown MIC
        let best_effort_caps = ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity],
            coverage: Coverage::us_only_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
            supports_dividends: false,
        };
        assert!(best_effort_caps.supports_instrument(&unknown_mic));
    }
}
