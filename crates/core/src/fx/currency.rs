use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct CurrencyNormalizationRule {
    pub major_code: &'static str,
    pub factor: Decimal,
    pub label: &'static str,
}

static CURRENCY_RULES: OnceLock<HashMap<&'static str, CurrencyNormalizationRule>> = OnceLock::new();

fn get_rules() -> &'static HashMap<&'static str, CurrencyNormalizationRule> {
    CURRENCY_RULES.get_or_init(|| {
        let mut map = HashMap::new();

        map.insert(
            "GBp",
            CurrencyNormalizationRule {
                major_code: "GBP",
                factor: dec!(0.01),
                label: "Pence",
            },
        );

        map.insert(
            "GBX",
            CurrencyNormalizationRule {
                major_code: "GBP",
                factor: dec!(0.01),
                label: "Pence",
            },
        );
        map.insert(
            "KWF",
            CurrencyNormalizationRule {
                major_code: "KWD",
                factor: dec!(0.001),
                label: "Kuwaiti Fils",
            },
        );
        map.insert(
            "ZAc",
            CurrencyNormalizationRule {
                major_code: "ZAR",
                factor: dec!(0.01),
                label: "SA Cents",
            },
        );

        map.insert(
            "ZAC",
            CurrencyNormalizationRule {
                major_code: "ZAR",
                factor: dec!(0.01),
                label: "SA Cents",
            },
        );

        map.insert(
            "ILA",
            CurrencyNormalizationRule {
                major_code: "ILS",
                factor: dec!(0.01),
                label: "Agorot",
            },
        );

        map.insert(
            "USX",
            CurrencyNormalizationRule {
                major_code: "USD",
                factor: dec!(0.01),
                label: "US Cents",
            },
        );

        map
    })
}

/// Returns the normalization rule for a given currency code, if one exists.
pub fn get_normalization_rule(code: &str) -> Option<&'static CurrencyNormalizationRule> {
    get_rules().get(code)
}

/// Converts an amount from its potentially minor unit into its major unit equivalent
/// and returns the normalized major currency code.
pub fn normalize_amount(amount: Decimal, currency: &str) -> (Decimal, &str) {
    if let Some(rule) = get_normalization_rule(currency) {
        (amount * rule.factor, rule.major_code)
    } else {
        (amount, currency)
    }
}

/// Returns the major currency code for FX lookups without mutating the amount.
pub fn normalize_currency_code(currency: &str) -> &str {
    if let Some(rule) = get_normalization_rule(currency) {
        rule.major_code
    } else {
        currency
    }
}

/// Returns the multiplier to convert an amount expressed in the normalized major unit
/// back into the requested (potentially minor) currency.
pub fn denormalization_multiplier(currency: &str) -> Decimal {
    if let Some(rule) = get_normalization_rule(currency) {
        Decimal::ONE / rule.factor
    } else {
        Decimal::ONE
    }
}

/// Resolves currency from a priority list of candidates.
/// Returns the first non-empty candidate, or "USD" as the ultimate fallback.
pub fn resolve_currency(candidates: &[&str]) -> String {
    candidates
        .iter()
        .find(|c| !c.trim().is_empty())
        .map(|c| c.to_string())
        .unwrap_or_else(|| "USD".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ila_to_ils() {
        let (amount, currency) = normalize_amount(dec!(12345), "ILA");

        assert_eq!(amount, dec!(123.45));
        assert_eq!(currency, "ILS");
        assert_eq!(normalize_currency_code("ILA"), "ILS");
        assert_eq!(denormalization_multiplier("ILA"), dec!(100));
    }

    #[test]
    fn normalizes_kwf_to_kwd() {
        let (amount, currency) = normalize_amount(dec!(987), "KWF");

        assert_eq!(amount, dec!(0.987));
        assert_eq!(currency, "KWD");
        assert_eq!(normalize_currency_code("KWF"), "KWD");
        assert_eq!(denormalization_multiplier("KWF"), dec!(1000));
    }

    #[test]
    fn normalizes_usx_to_usd() {
        let (amount, currency) = normalize_amount(dec!(9876), "USX");

        assert_eq!(amount, dec!(98.76));
        assert_eq!(currency, "USD");
        assert_eq!(normalize_currency_code("USX"), "USD");
        assert_eq!(denormalization_multiplier("USX"), dec!(100));
    }
}
