//! Every tunable of the calculation, explicit and serialized. v1 values codify
//! current behavior (architecture §4.2).

use chrono::NaiveDate;
use chrono_tz::Tz;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use super::scalar::Currency;
use crate::error::EngineError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Policy {
    pub base_currency: Currency,
    /// UTC instants become user-local business dates through this zone,
    /// exactly once, in `normalize`.
    pub timezone: Tz,
    /// "Today" is DATA, never a clock read. Valuations end here.
    pub as_of: NaiveDate,
    /// Minor-unit rule table (data, not code): `GBp`→`GBP` ×0.01, …
    pub minor_units: Vec<MinorUnitRule>,
    pub cost_basis: CostBasisMethod,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MinorUnitRule {
    pub minor: String,
    pub major: String,
    pub factor: Decimal,
    /// `GBp` is case-sensitive (`gbp` is not pence); `GBX`/`KWF`/`ILA`/`USX`
    /// match any case; `ZAc` matches exactly or as `ZAC`.
    pub case_sensitive: bool,
}

/// v1 supports FIFO only; LIFO and pooled average cost are designed-in
/// roadmap items (architecture §2, scope boundaries).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CostBasisMethod {
    #[default]
    Fifo,
}

impl Policy {
    pub fn new(base_currency: Currency, timezone: Tz, as_of: NaiveDate) -> Self {
        Self {
            base_currency,
            timezone,
            as_of,
            minor_units: default_minor_units(),
            cost_basis: CostBasisMethod::Fifo,
        }
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        for rule in &self.minor_units {
            if rule.factor <= Decimal::ZERO {
                return Err(EngineError::InvalidPolicy(format!(
                    "minor-unit rule {} has non-positive factor",
                    rule.minor
                )));
            }
            if rule.minor == rule.major {
                return Err(EngineError::InvalidPolicy(format!(
                    "minor-unit rule {} maps a currency onto itself",
                    rule.minor
                )));
            }
        }
        Ok(())
    }

    /// The rule whose minor code matches `code` under the rule's case policy.
    pub fn minor_unit_rule(&self, code: &str) -> Option<&MinorUnitRule> {
        let trimmed = code.trim();
        self.minor_units.iter().find(|rule| {
            if rule.case_sensitive {
                rule.minor == trimmed
            } else {
                rule.minor.eq_ignore_ascii_case(trimmed)
            }
        })
    }

    /// Major code plus the multiplier that turns a minor-unit amount into
    /// major units (`GBp 250` → `GBP`, ×0.01). Identity for major codes.
    pub fn normalize_currency<'a>(&'a self, code: &'a str) -> (&'a str, Decimal) {
        match self.minor_unit_rule(code) {
            Some(rule) => (rule.major.as_str(), rule.factor),
            None => (code, Decimal::ONE),
        }
    }

    pub fn major_currency<'a>(&'a self, code: &'a str) -> &'a str {
        self.normalize_currency(code).0
    }
}

/// Today's table (architecture §4.2). New minor unit = data change, not a release.
pub fn default_minor_units() -> Vec<MinorUnitRule> {
    let rule = |minor: &str, major: &str, factor: Decimal, case_sensitive: bool| MinorUnitRule {
        minor: minor.to_string(),
        major: major.to_string(),
        factor,
        case_sensitive,
    };
    let cent = Decimal::new(1, 2);
    vec![
        rule("GBp", "GBP", cent, true),
        rule("GBX", "GBP", cent, false),
        rule("KWF", "KWD", Decimal::new(1, 3), false),
        rule("ZAc", "ZAR", cent, true),
        rule("ZAC", "ZAR", cent, false),
        rule("ILA", "ILS", cent, false),
        rule("USX", "USD", cent, false),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn policy() -> Policy {
        Policy::new(
            Currency::parse("USD").unwrap(),
            chrono_tz::UTC,
            NaiveDate::from_ymd_opt(2025, 3, 5).unwrap(),
        )
    }

    #[test]
    fn minor_units_follow_case_rules() {
        let policy = policy();
        assert_eq!(policy.normalize_currency("GBp"), ("GBP", dec!(0.01)));
        assert_eq!(policy.normalize_currency("gbp"), ("gbp", dec!(1)));
        assert_eq!(policy.normalize_currency("gbx"), ("GBP", dec!(0.01)));
        assert_eq!(policy.normalize_currency("KWF"), ("KWD", dec!(0.001)));
        assert_eq!(policy.normalize_currency("ZAc"), ("ZAR", dec!(0.01)));
        assert_eq!(policy.normalize_currency("ZAC"), ("ZAR", dec!(0.01)));
        assert_eq!(policy.normalize_currency("USD"), ("USD", dec!(1)));
    }

    #[test]
    fn policy_rejects_self_mapping_rules() {
        let mut policy = policy();
        policy.minor_units.push(MinorUnitRule {
            minor: "USD".into(),
            major: "USD".into(),
            factor: dec!(1),
            case_sensitive: false,
        });
        assert!(policy.validate().is_err());
    }
}
