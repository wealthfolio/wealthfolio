//! Confirmation of provider profiles against the instrument that was requested.
//!
//! When the resolver has no suffix for a venue it falls back to the bare ticker
//! ([`ResolutionSource::RulesFallback`]). That symbol encodes no venue, so the
//! provider is free to answer with a different listing under the same ticker -
//! and nothing downstream can tell the difference, because a profile for the
//! wrong instrument is perfectly well-formed and the classifier maps it
//! faithfully. Measured on Cboe Canada: `FEQT` came back as a US mutual fund.
//!
//! This module is the check that was missing. It runs only on fallback
//! resolutions - a suffixed symbol already pins the venue - and asks the
//! returned profile to confirm either the exchange or the currency requested.
//! A profile that confirms neither is rejected rather than stored.

use std::fmt;

use crate::models::{AssetProfile, InstrumentId, QuoteContext};

use super::exchange_suffixes::yahoo_exchange_to_mic;
use super::traits::ResolutionSource;

/// Why a returned profile could not be trusted for the instrument requested.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProfileMismatch {
    /// The provider answered for a listing on a different exchange.
    Exchange {
        /// MIC that was asked for.
        requested: String,
        /// MIC the provider answered with.
        returned: String,
    },
    /// The provider answered for a listing in a different currency.
    Currency {
        /// Currency expected for the requested instrument.
        requested: String,
        /// Currency the provider answered with.
        returned: String,
    },
    /// The provider reported neither exchange nor currency, so a guessed symbol
    /// cannot be confirmed either way.
    Unconfirmable {
        /// MIC that was asked for.
        requested: String,
    },
}

impl fmt::Display for ProfileMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exchange {
                requested,
                returned,
            } => write!(
                f,
                "is listed on {} but {} was requested",
                returned, requested
            ),
            Self::Currency {
                requested,
                returned,
            } => write!(f, "is priced in {} but {} was expected", returned, requested),
            Self::Unconfirmable { requested } => write!(
                f,
                "reports neither exchange nor currency, so a bare-ticker lookup for {} cannot be confirmed",
                requested
            ),
        }
    }
}

/// Confirm a provider profile describes the instrument that was requested.
///
/// Returns `Ok(())` for any resolution whose symbol already encoded the venue -
/// an override, or a rules resolution with a real suffix. Only a
/// [`ResolutionSource::RulesFallback`] is checked, because only there is the
/// symbol a guess.
pub fn check_profile(
    context: &QuoteContext,
    source: ResolutionSource,
    profile: &AssetProfile,
) -> Result<(), ProfileMismatch> {
    if source != ResolutionSource::RulesFallback {
        return Ok(());
    }

    let InstrumentId::Equity { mic: Some(mic), .. } = &context.instrument else {
        return Ok(());
    };

    // Exchange is the direct answer: either the provider names the venue we
    // asked for or it names a different one.
    if let Some(returned) = profile.exchange.as_deref().and_then(yahoo_exchange_to_mic) {
        return if returned.eq_ignore_ascii_case(mic) {
            Ok(())
        } else {
            Err(ProfileMismatch::Exchange {
                requested: mic.to_string(),
                returned: returned.into_owned(),
            })
        };
    }

    // No venue we recognise. Currency is weaker - it cannot separate two
    // listings in the same currency - but it does separate a CAD listing from
    // the US one a bare ticker lands on, which is the failure this exists for.
    match (
        context.currency_hint.as_deref(),
        profile.currency.as_deref(),
    ) {
        (Some(expected), Some(returned)) if same_currency(expected, returned) => Ok(()),
        (Some(expected), Some(returned)) => Err(ProfileMismatch::Currency {
            requested: expected.to_string(),
            returned: returned.to_string(),
        }),
        _ => Err(ProfileMismatch::Unconfirmable {
            requested: mic.to_string(),
        }),
    }
}

/// Compare currency codes, treating a market's minor unit as its major unit.
///
/// Yahoo quotes the LSE in `GBp` and Tel Aviv in `ILA`; an asset carrying `GBP`
/// or `ILS` is the same money on the same listing, not a different instrument.
fn same_currency(a: &str, b: &str) -> bool {
    major_unit(a) == major_unit(b)
}

fn major_unit(code: &str) -> String {
    let upper = code.trim().to_ascii_uppercase();
    match upper.as_str() {
        "GBX" | "GBP" => "GBP".to_string(),
        "ILA" | "ILS" => "ILS".to_string(),
        "ZAC" | "ZAR" => "ZAR".to_string(),
        _ => upper,
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::sync::Arc;

    use super::*;

    fn context(mic: Option<&'static str>, currency: Option<&'static str>) -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("FEQT"),
                mic: mic.map(Cow::Borrowed),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: currency.map(Cow::Borrowed),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    fn profile(exchange: Option<&str>, currency: Option<&str>) -> AssetProfile {
        AssetProfile {
            name: Some("First Equities Corp".to_string()),
            exchange: exchange.map(str::to_string),
            currency: currency.map(str::to_string),
            ..Default::default()
        }
    }

    /// The measured case: FEQT on Cboe Canada, resolved to a bare ticker,
    /// answered by a US listing that the classifier then mapped faithfully.
    #[test]
    fn rejects_a_profile_from_a_different_exchange() {
        let result = check_profile(
            &context(Some("NEOE"), Some("CAD")),
            ResolutionSource::RulesFallback,
            &profile(Some("NGM"), Some("USD")),
        );

        assert_eq!(
            result,
            Err(ProfileMismatch::Exchange {
                requested: "NEOE".to_string(),
                returned: "XNAS".to_string(),
            })
        );
    }

    #[test]
    fn rejects_a_profile_in_a_different_currency() {
        let result = check_profile(
            &context(Some("NEOE"), Some("CAD")),
            ResolutionSource::RulesFallback,
            &profile(None, Some("USD")),
        );

        assert_eq!(
            result,
            Err(ProfileMismatch::Currency {
                requested: "CAD".to_string(),
                returned: "USD".to_string(),
            })
        );
    }

    /// A guess that comes back with nothing to check is still a guess.
    #[test]
    fn rejects_a_profile_that_confirms_nothing() {
        let result = check_profile(
            &context(Some("NEOE"), Some("CAD")),
            ResolutionSource::RulesFallback,
            &profile(None, None),
        );

        assert_eq!(
            result,
            Err(ProfileMismatch::Unconfirmable {
                requested: "NEOE".to_string(),
            })
        );
    }

    #[test]
    fn accepts_a_profile_that_confirms_the_currency() {
        assert_eq!(
            check_profile(
                &context(Some("NEOE"), Some("CAD")),
                ResolutionSource::RulesFallback,
                &profile(None, Some("CAD")),
            ),
            Ok(())
        );
    }

    /// Yahoo quotes the LSE in pence. Same listing, not a mismatch.
    #[test]
    fn accepts_a_minor_unit_of_the_expected_currency() {
        assert_eq!(
            check_profile(
                &context(Some("XLON"), Some("GBP")),
                ResolutionSource::RulesFallback,
                &profile(None, Some("GBp")),
            ),
            Ok(())
        );
    }

    /// A suffixed symbol already pins the venue, so nothing is second-guessed -
    /// this is what keeps the check off the path every resolved asset takes.
    #[test]
    fn leaves_a_resolved_symbol_alone() {
        assert_eq!(
            check_profile(
                &context(Some("XTSE"), Some("CAD")),
                ResolutionSource::Rules,
                &profile(Some("NGM"), Some("USD")),
            ),
            Ok(())
        );
    }

    #[test]
    fn leaves_an_override_alone() {
        assert_eq!(
            check_profile(
                &context(Some("XTSE"), Some("CAD")),
                ResolutionSource::Override,
                &profile(Some("NGM"), Some("USD")),
            ),
            Ok(())
        );
    }

    /// No MIC means no venue was asked for, so there is nothing to contradict.
    #[test]
    fn leaves_an_instrument_without_a_venue_alone() {
        assert_eq!(
            check_profile(
                &context(None, Some("USD")),
                ResolutionSource::RulesFallback,
                &profile(None, None),
            ),
            Ok(())
        );
    }
}
