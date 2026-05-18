//! Exchange metadata lookups.
//!
//! This module provides lookup functions for exchange information
//! such as names, currencies, and currency-to-exchange mappings.
//! Data is loaded from `exchanges.json` via the exchange registry.

use super::exchange_registry::REGISTRY;

/// Get the friendly exchange name for a MIC code.
pub fn mic_to_exchange_name(mic: &str) -> Option<&'static str> {
    REGISTRY.name_by_mic.get(mic).copied()
}

/// Get the primary currency for a MIC code.
pub fn mic_to_currency(mic: &str) -> Option<&'static str> {
    REGISTRY.currency_by_mic.get(mic).copied()
}

/// Get the IANA timezone name for a MIC code.
pub fn mic_to_timezone(mic: &str) -> Option<&'static str> {
    REGISTRY.timezone_by_mic.get(mic).copied()
}

/// Get the market close time (hour, minute) for a MIC code.
pub fn mic_to_market_close(mic: &str) -> Option<(u8, u8)> {
    REGISTRY.close_by_mic.get(mic).copied()
}

/// Get the list of preferred exchanges for a given currency.
pub fn exchanges_for_currency(currency: &str) -> &'static [&'static str] {
    REGISTRY
        .currency_priority_slices
        .get(currency)
        .copied()
        .unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mic_to_exchange_name() {
        assert_eq!(mic_to_exchange_name("XNYS"), Some("NYSE"));
        assert_eq!(mic_to_exchange_name("XNAS"), Some("NASDAQ"));
        assert_eq!(mic_to_exchange_name("XTSE"), Some("TSX"));
        assert_eq!(mic_to_exchange_name("XNEO"), Some("Cboe Canada"));
        assert_eq!(mic_to_exchange_name("XLON"), Some("LSE"));
        assert_eq!(mic_to_exchange_name("CXE"), Some("Cboe UK"));
        assert_eq!(mic_to_exchange_name("XETR"), Some("XETRA"));
        assert_eq!(mic_to_exchange_name("UNKNOWN"), None);
    }

    #[test]
    fn test_mic_to_currency() {
        assert_eq!(mic_to_currency("XNYS"), Some("USD"));
        assert_eq!(mic_to_currency("XNAS"), Some("USD"));
        assert_eq!(mic_to_currency("XTSE"), Some("CAD"));
        assert_eq!(mic_to_currency("XLON"), Some("GBp")); // LSE quotes in pence
        assert_eq!(mic_to_currency("CXE"), Some("GBP"));
        assert_eq!(mic_to_currency("XTAE"), Some("ILA"));
        assert_eq!(mic_to_currency("XETR"), Some("EUR"));
        assert_eq!(mic_to_currency("XTKS"), Some("JPY"));
        assert_eq!(mic_to_currency("UNKNOWN"), None);
    }

    #[test]
    fn test_exchanges_for_currency() {
        let us_exchanges = exchanges_for_currency("USD");
        assert!(us_exchanges.contains(&"XNYS"));
        assert!(us_exchanges.contains(&"XNAS"));

        let ca_exchanges = exchanges_for_currency("CAD");
        assert!(ca_exchanges.contains(&"XTSE"));
        assert!(ca_exchanges.contains(&"XTSX"));

        let unknown = exchanges_for_currency("XYZ");
        assert!(unknown.is_empty());

        let ila_exchanges = exchanges_for_currency("ILA");
        assert!(ila_exchanges.contains(&"XTAE"));
    }
}
