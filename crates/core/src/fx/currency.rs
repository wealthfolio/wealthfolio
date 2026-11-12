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
    let rules = get_rules();
    rules.get(code).or_else(|| {
        normalization_rule_key(code)
            .filter(|key| *key != code)
            .and_then(|key| rules.get(key))
    })
}

fn normalization_rule_key(code: &str) -> Option<&'static str> {
    let trimmed = code.trim();
    if trimmed == "GBp" {
        return Some("GBp");
    }
    if trimmed.eq_ignore_ascii_case("GBX") {
        return Some("GBX");
    }
    if trimmed.eq_ignore_ascii_case("KWF") {
        return Some("KWF");
    }
    if trimmed == "ZAc" || trimmed.eq_ignore_ascii_case("ZAC") {
        return Some("ZAc");
    }
    if trimmed.eq_ignore_ascii_case("ILA") {
        return Some("ILA");
    }
    if trimmed.eq_ignore_ascii_case("USX") {
        return Some("USX");
    }
    None
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

/// Cryptocurrency codes the app recognizes. Dollar-pegged stablecoins (USDT,
/// USDC, DAI, ...) are deliberately left out: they behave like USD.
const CRYPTO_CURRENCY_CODES: &[&str] = &[
    "BTC", "ETH", "XRP", "LTC", "BCH", "ADA", "DOT", "LINK", "XLM", "DOGE", "UNI", "SOL", "AVAX",
    "MATIC", "ATOM", "ALGO", "VET", "FIL", "TRX", "ETC", "XMR", "AAVE", "MKR", "COMP", "SNX",
    "YFI", "SUSHI", "CRV",
];

/// Whether a currency or bare symbol code (any case) is a cryptocurrency.
pub fn is_crypto_currency(code: &str) -> bool {
    let code = code.trim();
    CRYPTO_CURRENCY_CODES
        .iter()
        .any(|crypto| crypto.eq_ignore_ascii_case(code))
}

pub fn currency_fraction_digits(currency: &str) -> u32 {
    match normalize_currency_code(currency)
        .to_ascii_uppercase()
        .as_str()
    {
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX"
        | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        "CLF" | "UYW" => 4,
        // The two-decimal fiat default would make one "minor unit" of a
        // crypto currency worth real money and silently canonicalize genuine
        // differences. Stablecoins keep the fiat default, exactly as USD.
        code if is_crypto_currency(code) => 8,
        _ => 2,
    }
}

/// One minor unit of the currency (1 × 10^-fraction_digits). Callers derive
/// their own tolerance from it - e.g. half a unit for rounding equivalence.
pub fn currency_minor_unit(currency: &str) -> Decimal {
    Decimal::new(1, currency_fraction_digits(currency))
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
    fn minor_unit_follows_currency_fraction_digits() {
        assert_eq!(currency_minor_unit("USD"), dec!(0.01));
        assert_eq!(currency_minor_unit("JPY"), dec!(1));
        assert_eq!(currency_minor_unit("UYI"), dec!(1));
        assert_eq!(currency_minor_unit("KWD"), dec!(0.001));
        assert_eq!(currency_minor_unit("UYW"), dec!(0.0001));
        // Crypto currencies must not inherit the fiat two-decimal default -
        // a 0.005 BTC tolerance would silently rewrite totals.
        assert_eq!(currency_minor_unit("BTC"), dec!(0.00000001));
        assert_eq!(currency_minor_unit("ETH"), dec!(0.00000001));
        assert_eq!(currency_minor_unit("SOL"), dec!(0.00000001));
        assert_eq!(currency_minor_unit("DOGE"), dec!(0.00000001));
        // Dollar-pegged stablecoins keep cent precision, like USD.
        assert_eq!(currency_minor_unit("USDT"), dec!(0.01));
        assert_eq!(currency_minor_unit("USDC"), dec!(0.01));
        // Minor-unit aliases resolve to their major code first.
        assert_eq!(currency_minor_unit("GBp"), dec!(0.01));
    }

    #[test]
    fn recognizes_crypto_currency_codes_in_any_case() {
        assert!(is_crypto_currency("BTC"));
        assert!(is_crypto_currency("eth"));
        assert!(is_crypto_currency(" SOL "));
        assert!(!is_crypto_currency("USD"));
        assert!(!is_crypto_currency("USDT"));
        assert!(!is_crypto_currency(""));
    }

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

    #[test]
    fn normalizes_minor_currency_alias_casing_without_treating_gbp_as_pence() {
        let (amount, currency) = normalize_amount(dec!(85), "GBx");

        assert_eq!(amount, dec!(0.85));
        assert_eq!(currency, "GBP");
        assert_eq!(normalize_currency_code("gbx"), "GBP");

        let (amount, currency) = normalize_amount(dec!(85), "gbp");

        assert_eq!(amount, dec!(85));
        assert_eq!(currency, "gbp");
    }
}
