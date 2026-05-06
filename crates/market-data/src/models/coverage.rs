//! Provider market coverage restrictions.

use super::InstrumentId;

/// Provider market coverage restrictions.
///
/// Uses static slices for zero-allocation in capabilities().
/// Linear search is fine for small MIC lists (typically <10 items).
///
/// Default = "supports all instruments globally".
#[derive(Clone, Copy, Debug, Default)]
pub struct Coverage {
    /// If Some, only equities from these MICs are supported.
    pub equity_mic_allow: Option<&'static [&'static str]>,

    /// If Some, equities from these MICs are explicitly rejected.
    pub equity_mic_deny: Option<&'static [&'static str]>,

    /// Whether to accept equities with `mic = None` (unknown venue).
    pub allow_unknown_mic: bool,

    /// If Some, only Metal instruments quoted in these currencies are supported.
    /// Note: Only applies to Metal instruments; FX/Crypto ignore this.
    pub metal_quote_ccy_allow: Option<&'static [&'static str]>,
}

/// Linear contains check for static slices.
#[inline]
fn slice_contains(list: &[&'static str], value: &str) -> bool {
    list.contains(&value)
}

impl Coverage {
    /// Check if this coverage supports the given instrument.
    pub fn supports(&self, inst: &InstrumentId) -> bool {
        match inst {
            InstrumentId::Equity { mic, .. } => {
                // Check deny list first
                if let Some(deny) = self.equity_mic_deny {
                    if mic.as_deref().is_some_and(|m| slice_contains(deny, m)) {
                        return false;
                    }
                }

                // Handle allowlist + mic=None case
                match (self.equity_mic_allow, mic.as_deref()) {
                    (Some(allow), Some(m)) => slice_contains(allow, m),
                    (Some(_), None) => self.allow_unknown_mic,
                    (None, Some(_)) => true,
                    (None, None) => self.allow_unknown_mic,
                }
            }

            // FX: No currency filtering (providers can convert internally)
            InstrumentId::Fx { .. } => true,

            // Crypto: No currency filtering
            InstrumentId::Crypto { .. } => true,

            // Metal: Apply quote currency filter
            InstrumentId::Metal { quote, .. } => self
                .metal_quote_ccy_allow
                .is_none_or(|a| slice_contains(a, quote.as_ref())),

            // Options: No geographic filtering (OCC symbols are US-only for now)
            InstrumentId::Option { .. } => true,

            // Bonds: No geographic filtering (ISIN-based routing handled by resolver)
            InstrumentId::Bond { .. } => true,
        }
    }

    /// US exchanges only, strict mode (rejects mic=None).
    pub const fn us_only_strict() -> Self {
        Self {
            equity_mic_allow: Some(&["XNYS", "XNAS", "XASE", "BATS", "ARCX"]),
            equity_mic_deny: None,
            allow_unknown_mic: false,
            metal_quote_ccy_allow: None,
        }
    }

    /// US exchanges only, best-effort mode (accepts mic=None).
    pub const fn us_only_best_effort() -> Self {
        Self {
            equity_mic_allow: Some(&["XNYS", "XNAS", "XASE", "BATS", "ARCX"]),
            equity_mic_deny: None,
            allow_unknown_mic: true,
            metal_quote_ccy_allow: None,
        }
    }

    /// North American exchanges (US + Canada), strict mode.
    pub const fn north_america_strict() -> Self {
        Self {
            equity_mic_allow: Some(&["XNYS", "XNAS", "XASE", "BATS", "ARCX", "XTSE", "XTSX"]),
            equity_mic_deny: None,
            allow_unknown_mic: false,
            metal_quote_ccy_allow: None,
        }
    }

    /// North American exchanges (US + Canada), best-effort mode.
    pub const fn north_america_best_effort() -> Self {
        Self {
            equity_mic_allow: Some(&["XNYS", "XNAS", "XASE", "BATS", "ARCX", "XTSE", "XTSX"]),
            equity_mic_deny: None,
            allow_unknown_mic: true,
            metal_quote_ccy_allow: None,
        }
    }

    /// Global coverage, strict mode (rejects mic=None).
    pub const fn global_strict() -> Self {
        Self {
            equity_mic_allow: None,
            equity_mic_deny: None,
            allow_unknown_mic: false,
            metal_quote_ccy_allow: None,
        }
    }

    /// Global coverage, best-effort mode (accepts mic=None).
    pub const fn global_best_effort() -> Self {
        Self {
            equity_mic_allow: None,
            equity_mic_deny: None,
            allow_unknown_mic: true,
            metal_quote_ccy_allow: None,
        }
    }

    /// Deutsche Boerse exchanges (Xetra + Frankfurt floor).
    /// Accepts mic=None so ISIN-only entries (no exchange set) can fall back to BF.
    pub const fn dach_exchanges() -> Self {
        Self {
            equity_mic_allow: Some(&["XETR", "XFRA"]),
            equity_mic_deny: None,
            allow_unknown_mic: true,
            metal_quote_ccy_allow: None,
        }
    }

    /// Metals only, any quote currency.
    ///
    /// MetalPriceAPI accepts any ISO-4217 base in `?base=…`, so we don't
    /// restrict the metal asset's quote currency at the registry layer.
    pub const fn metals_any_currency() -> Self {
        Self {
            equity_mic_allow: None,
            equity_mic_deny: None,
            allow_unknown_mic: false,
            metal_quote_ccy_allow: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::sync::Arc;

    use super::*;

    #[test]
    fn test_us_strict_allows_nasdaq() {
        let coverage = Coverage::us_only_strict();
        let inst = InstrumentId::Equity {
            ticker: Arc::from("AAPL"),
            mic: Some(Cow::Borrowed("XNAS")),
        };
        assert!(coverage.supports(&inst));
    }

    #[test]
    fn test_us_strict_rejects_toronto() {
        let coverage = Coverage::us_only_strict();
        let inst = InstrumentId::Equity {
            ticker: Arc::from("SHOP"),
            mic: Some(Cow::Borrowed("XTSE")),
        };
        assert!(!coverage.supports(&inst));
    }

    #[test]
    fn test_us_strict_rejects_unknown_mic() {
        let coverage = Coverage::us_only_strict();
        let inst = InstrumentId::Equity {
            ticker: Arc::from("AAPL"),
            mic: None,
        };
        assert!(!coverage.supports(&inst));
    }

    #[test]
    fn test_us_best_effort_allows_unknown_mic() {
        let coverage = Coverage::us_only_best_effort();
        let inst = InstrumentId::Equity {
            ticker: Arc::from("AAPL"),
            mic: None,
        };
        assert!(coverage.supports(&inst));
    }

    #[test]
    fn test_global_strict_rejects_unknown_mic() {
        let coverage = Coverage::global_strict();
        let inst = InstrumentId::Equity {
            ticker: Arc::from("AAPL"),
            mic: None,
        };
        assert!(!coverage.supports(&inst));
    }

    #[test]
    fn test_metal_any_currency_accepts_eur() {
        let coverage = Coverage::metals_any_currency();
        let inst = InstrumentId::Metal {
            code: Arc::from("XAU"),
            quote: Cow::Borrowed("EUR"),
        };
        assert!(coverage.supports(&inst));
    }

    #[test]
    fn test_metal_any_currency_accepts_usd() {
        let coverage = Coverage::metals_any_currency();
        let inst = InstrumentId::Metal {
            code: Arc::from("XAU"),
            quote: Cow::Borrowed("USD"),
        };
        assert!(coverage.supports(&inst));
    }

    #[test]
    fn test_metal_any_currency_accepts_chf() {
        let coverage = Coverage::metals_any_currency();
        let inst = InstrumentId::Metal {
            code: Arc::from("XAU"),
            quote: Cow::Borrowed("CHF"),
        };
        assert!(coverage.supports(&inst));
    }

    #[test]
    fn test_fx_ignores_quote_currency_filter() {
        let coverage = Coverage::metals_any_currency();
        let inst = InstrumentId::Fx {
            base: Cow::Borrowed("EUR"),
            quote: Cow::Borrowed("GBP"),
        };
        assert!(coverage.supports(&inst));
    }

    #[test]
    fn test_dach_allows_unknown_mic() {
        let coverage = Coverage::dach_exchanges();
        let inst = InstrumentId::Equity {
            ticker: Arc::from("DE0007164600"),
            mic: None,
        };
        assert!(coverage.supports(&inst));
    }

    #[test]
    fn test_dach_rejects_non_dach_mic() {
        let coverage = Coverage::dach_exchanges();
        let inst = InstrumentId::Equity {
            ticker: Arc::from("AAPL"),
            mic: Some(Cow::Borrowed("XNAS")),
        };
        assert!(!coverage.supports(&inst));
    }

    #[test]
    fn test_coverage_is_const() {
        const _: Coverage = Coverage::us_only_strict();
        const _: Coverage = Coverage::global_best_effort();
        const _: Coverage = Coverage::metals_any_currency();
    }
}
