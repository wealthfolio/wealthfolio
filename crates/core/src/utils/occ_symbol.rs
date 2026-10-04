//! OCC (Options Clearing Corporation) symbol parser and builder.
//!
//! The OCC option symbol format is a standardized 21-character string:
//! - Characters 1-6: Root symbol (underlying), left-justified, space-padded
//! - Characters 7-12: Expiration date (YYMMDD)
//! - Character 13: Option type (C = Call, P = Put)
//! - Characters 14-21: Strike price (5 integer + 3 decimal digits, no decimal point)
//!
//! Example: "AAPL  240119C00195000" means:
//! - Underlying: AAPL
//! - Expiration: January 19, 2024
//! - Type: Call
//! - Strike: $195.00

use chrono::NaiveDate;
use rust_decimal::Decimal;
use thiserror::Error;

/// Errors that can occur when parsing OCC symbols
#[derive(Debug, Error, PartialEq)]
pub enum OccSymbolError {
    #[error("Symbol too short: expected at least 15 characters, got {0}")]
    TooShort(usize),

    #[error("Symbol too long: expected at most 21 characters, got {0}")]
    TooLong(usize),

    #[error("Invalid expiration date: {0}")]
    InvalidExpirationDate(String),

    #[error("Invalid option type '{0}': expected 'C' for Call or 'P' for Put")]
    InvalidOptionType(char),

    #[error("Invalid strike price: {0}")]
    InvalidStrikePrice(String),

    #[error("Empty underlying symbol")]
    EmptyUnderlying,

    #[error("Symbol contains non-ASCII characters")]
    NonAscii,
}

/// Represents the option type (Call or Put)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionType {
    Call,
    Put,
}

impl OptionType {
    /// Returns the OCC character for this option type
    pub fn as_char(&self) -> char {
        match self {
            OptionType::Call => 'C',
            OptionType::Put => 'P',
        }
    }

    /// Returns the full name of the option type
    pub fn as_str(&self) -> &'static str {
        match self {
            OptionType::Call => "CALL",
            OptionType::Put => "PUT",
        }
    }
}

impl TryFrom<char> for OptionType {
    type Error = OccSymbolError;

    fn try_from(c: char) -> std::result::Result<Self, Self::Error> {
        match c.to_ascii_uppercase() {
            'C' => Ok(OptionType::Call),
            'P' => Ok(OptionType::Put),
            _ => Err(OccSymbolError::InvalidOptionType(c)),
        }
    }
}

impl std::fmt::Display for OptionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Parsed components of an OCC option symbol
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedOccSymbol {
    /// The underlying stock symbol (e.g., "AAPL", "MSFT")
    pub underlying: String,
    /// The expiration date
    pub expiration: NaiveDate,
    /// Call or Put
    pub option_type: OptionType,
    /// Strike price in dollars
    pub strike_price: Decimal,
}

impl ParsedOccSymbol {
    /// Create a new ParsedOccSymbol
    pub fn new(
        underlying: impl Into<String>,
        expiration: NaiveDate,
        option_type: OptionType,
        strike_price: Decimal,
    ) -> Self {
        Self {
            underlying: underlying.into(),
            expiration,
            option_type,
            strike_price,
        }
    }

    /// Build an OCC symbol string from the parsed components
    pub fn to_occ_symbol(&self) -> String {
        build_occ_symbol(
            &self.underlying,
            self.expiration,
            self.option_type,
            self.strike_price,
        )
    }

    /// Returns the expiration date formatted as YYYY-MM-DD
    pub fn expiration_iso(&self) -> String {
        self.expiration.format("%Y-%m-%d").to_string()
    }
}

/// Parse an OCC option symbol into its components.
///
/// Accepts both the full 21-character format with spaces and a compact format
/// without spaces (minimum 15 characters for 1-char underlying).
pub fn parse_occ_symbol(symbol: &str) -> std::result::Result<ParsedOccSymbol, OccSymbolError> {
    let symbol = symbol.trim();
    // OCC symbols are ASCII, so the byte offsets below are character offsets.
    if !symbol.is_ascii() {
        return Err(OccSymbolError::NonAscii);
    }
    let len = symbol.len();

    if len < 15 {
        return Err(OccSymbolError::TooShort(len));
    }

    if len > 21 {
        return Err(OccSymbolError::TooLong(len));
    }

    // Work backwards from the end since the strike, type, and date have fixed lengths
    // Strike: last 8 characters
    // Type: 1 character before strike
    // Date: 6 characters before type
    // Underlying: everything before date

    let strike_str = &symbol[len - 8..];
    let option_type_char = symbol
        .chars()
        .nth(len - 9)
        .expect("an ASCII symbol of 15+ bytes has 15+ characters");
    let date_str = &symbol[len - 15..len - 9];
    let underlying = symbol[..len - 15].trim();

    if underlying.is_empty() {
        return Err(OccSymbolError::EmptyUnderlying);
    }

    // Parse expiration date (YYMMDD)
    let expiration = parse_expiration_date(date_str)?;

    // Parse option type
    let option_type = OptionType::try_from(option_type_char)?;

    // Parse strike price (8 digits: 5 integer + 3 decimal)
    let strike_price = parse_strike_price(strike_str)?;

    Ok(ParsedOccSymbol {
        underlying: underlying.to_uppercase(),
        expiration,
        option_type,
        strike_price,
    })
}

/// Build an OCC symbol string from components.
///
/// Returns the compact format (no space padding) which is compatible with
/// Yahoo Finance and other market data providers.
pub fn build_occ_symbol(
    underlying: &str,
    expiration: NaiveDate,
    option_type: OptionType,
    strike_price: Decimal,
) -> String {
    let underlying_upper = underlying.to_uppercase();

    // Format expiration: YYMMDD
    let date_str = expiration.format("%y%m%d").to_string();

    // Format strike: multiply by 1000 and format as 8-digit integer
    let strike_scaled = strike_price * Decimal::from(1000);
    let strike_int = strike_scaled
        .trunc()
        .to_string()
        .parse::<u64>()
        .unwrap_or(0);
    let strike_str = format!("{:08}", strike_int);

    format!(
        "{}{}{}{}",
        underlying_upper,
        date_str,
        option_type.as_char(),
        strike_str
    )
}

/// Parse an expiration date in YYMMDD format.
fn parse_expiration_date(date_str: &str) -> std::result::Result<NaiveDate, OccSymbolError> {
    if date_str.len() != 6 {
        return Err(OccSymbolError::InvalidExpirationDate(format!(
            "Expected 6 characters, got {}",
            date_str.len()
        )));
    }

    let year: i32 = date_str[0..2]
        .parse()
        .map_err(|_| OccSymbolError::InvalidExpirationDate(date_str.to_string()))?;
    let month: u32 = date_str[2..4]
        .parse()
        .map_err(|_| OccSymbolError::InvalidExpirationDate(date_str.to_string()))?;
    let day: u32 = date_str[4..6]
        .parse()
        .map_err(|_| OccSymbolError::InvalidExpirationDate(date_str.to_string()))?;

    let full_year = 2000 + year;

    NaiveDate::from_ymd_opt(full_year, month, day)
        .ok_or_else(|| OccSymbolError::InvalidExpirationDate(date_str.to_string()))
}

/// Parse a strike price from the 8-digit OCC format.
/// The format is 5 integer digits + 3 decimal digits.
fn parse_strike_price(strike_str: &str) -> std::result::Result<Decimal, OccSymbolError> {
    if strike_str.len() != 8 {
        return Err(OccSymbolError::InvalidStrikePrice(format!(
            "Expected 8 characters, got {}",
            strike_str.len()
        )));
    }

    let strike_int: u64 = strike_str
        .parse()
        .map_err(|_| OccSymbolError::InvalidStrikePrice(strike_str.to_string()))?;

    let strike_decimal = Decimal::from(strike_int) / Decimal::from(1000);
    Ok(strike_decimal)
}

/// Normalize a compact broker option symbol (e.g. Fidelity's `-MU270115C600`)
/// into standard OCC format (`MU270115C00600000`).
///
/// Returns `None` if the symbol doesn't match the compact pattern or is already
/// a standard OCC symbol.
///
/// The expected compact format (after stripping a leading `-`):
///   `{underlying}{YYMMDD}{C|P}{strike}` where strike is a plain integer
///   (e.g. `600` meaning $600).
pub fn normalize_option_symbol(symbol: &str) -> Option<String> {
    // Strip leading dash (Fidelity convention)
    let s = symbol.trim().strip_prefix('-').unwrap_or(symbol.trim());

    if s.is_empty() {
        return None;
    }

    // Already a standard OCC symbol? Re-emit in compact (no spaces) form
    // to prevent identity fragmentation between space-padded ("AAPL  261218C00240000")
    // and compact ("AAPL261218C00240000") formats.
    if looks_like_occ_symbol(s) {
        // Parse and rebuild to strip spaces and normalize case
        return parse_occ_symbol(s).ok().map(|p| p.to_occ_symbol());
    }

    // Find the boundary where alpha prefix (underlying) ends and digits begin.
    // The underlying must be at least 1 char.
    let alpha_end = s.find(|c: char| c.is_ascii_digit())?;
    if alpha_end == 0 {
        return None;
    }

    let underlying = &s[..alpha_end];
    let rest = &s[alpha_end..]; // YYMMDD + C/P + strike

    // Need at least 6 digits (date) + 1 char (C/P) + 1 digit (strike) = 8
    if rest.len() < 8 {
        return None;
    }

    let date_str = rest.get(..6)?;
    if !date_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    let type_char = rest.chars().nth(6)?;
    if !matches!(type_char.to_ascii_uppercase(), 'C' | 'P') {
        return None;
    }

    let strike_str = &rest[7..];
    if strike_str.is_empty() || !strike_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    // Validate the date is parseable
    parse_expiration_date(date_str).ok()?;

    // Convert strike: plain integer dollars → multiply by 1000, pad to 8 digits
    let strike_val: u64 = strike_str.parse().ok()?;
    let strike_scaled = strike_val * 1000;
    let strike_padded = format!("{:08}", strike_scaled);

    if strike_padded.len() > 8 {
        return None;
    }

    Some(format!(
        "{}{}{}{}",
        underlying.to_uppercase(),
        date_str,
        type_char.to_ascii_uppercase(),
        strike_padded
    ))
}

/// Check if a symbol looks like an OCC option symbol.
///
/// This is a heuristic check that looks for the characteristic pattern
/// of an OCC symbol without fully parsing it.
pub fn looks_like_occ_symbol(symbol: &str) -> bool {
    let symbol = symbol.trim();
    let len = symbol.len();

    // ASCII, 15-21 characters
    if !symbol.is_ascii() || !(15..=21).contains(&len) {
        return false;
    }

    // Check that the option type character (9th from end) is C or P
    let type_char = symbol.chars().nth(len - 9);
    if !matches!(type_char, Some('C') | Some('c') | Some('P') | Some('p')) {
        return false;
    }

    // Check that the strike portion (last 8 chars) is all digits
    if !symbol[len - 8..].chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    // Check that the date portion (6 chars before type) is all digits
    if !symbol[len - 15..len - 9]
        .chars()
        .all(|c| c.is_ascii_digit())
    {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn test_parse_standard_occ_symbol() {
        let parsed = parse_occ_symbol("AAPL  240119C00195000").unwrap();
        assert_eq!(parsed.underlying, "AAPL");
        assert_eq!(
            parsed.expiration,
            NaiveDate::from_ymd_opt(2024, 1, 19).unwrap()
        );
        assert_eq!(parsed.option_type, OptionType::Call);
        assert_eq!(parsed.strike_price, dec!(195.000));
    }

    #[test]
    fn test_parse_compact_occ_symbol() {
        let parsed = parse_occ_symbol("AAPL240119C00195000").unwrap();
        assert_eq!(parsed.underlying, "AAPL");
        assert_eq!(
            parsed.expiration,
            NaiveDate::from_ymd_opt(2024, 1, 19).unwrap()
        );
        assert_eq!(parsed.option_type, OptionType::Call);
        assert_eq!(parsed.strike_price, dec!(195.000));
    }

    #[test]
    fn test_parse_put_option() {
        let parsed = parse_occ_symbol("MSFT  240315P00400000").unwrap();
        assert_eq!(parsed.underlying, "MSFT");
        assert_eq!(
            parsed.expiration,
            NaiveDate::from_ymd_opt(2024, 3, 15).unwrap()
        );
        assert_eq!(parsed.option_type, OptionType::Put);
        assert_eq!(parsed.strike_price, dec!(400.000));
    }

    #[test]
    fn test_parse_fractional_strike() {
        let parsed = parse_occ_symbol("SPY   240119C00052500").unwrap();
        assert_eq!(parsed.strike_price, dec!(52.500));
    }

    #[test]
    fn test_parse_small_strike() {
        let parsed = parse_occ_symbol("F     240119P00002500").unwrap();
        assert_eq!(parsed.underlying, "F");
        assert_eq!(parsed.strike_price, dec!(2.500));
    }

    #[test]
    fn test_parse_large_strike() {
        let parsed = parse_occ_symbol("AMZN  240119C05000000").unwrap();
        assert_eq!(parsed.strike_price, dec!(5000.000));
    }

    #[test]
    fn test_parse_single_char_underlying() {
        let parsed = parse_occ_symbol("X     240119C00025000").unwrap();
        assert_eq!(parsed.underlying, "X");
    }

    #[test]
    fn test_parse_lowercase() {
        let parsed = parse_occ_symbol("aapl  240119c00195000").unwrap();
        assert_eq!(parsed.underlying, "AAPL");
        assert_eq!(parsed.option_type, OptionType::Call);
    }

    #[test]
    fn test_build_occ_symbol() {
        let symbol = build_occ_symbol(
            "AAPL",
            NaiveDate::from_ymd_opt(2024, 1, 19).unwrap(),
            OptionType::Call,
            dec!(195.00),
        );
        assert_eq!(symbol, "AAPL240119C00195000");
    }

    #[test]
    fn test_build_put_symbol() {
        let symbol = build_occ_symbol(
            "MSFT",
            NaiveDate::from_ymd_opt(2024, 3, 15).unwrap(),
            OptionType::Put,
            dec!(400.00),
        );
        assert_eq!(symbol, "MSFT240315P00400000");
    }

    #[test]
    fn test_build_fractional_strike() {
        let symbol = build_occ_symbol(
            "SPY",
            NaiveDate::from_ymd_opt(2024, 1, 19).unwrap(),
            OptionType::Call,
            dec!(52.50),
        );
        assert_eq!(symbol, "SPY240119C00052500");
    }

    #[test]
    fn test_roundtrip() {
        let original = "NVDA250117P00850000";
        let parsed = parse_occ_symbol(original).unwrap();
        let rebuilt = parsed.to_occ_symbol();
        assert_eq!(original, rebuilt);
    }

    #[test]
    fn test_parse_spaced_roundtrip_to_compact() {
        let spaced = "NVDA  250117P00850000";
        let parsed = parse_occ_symbol(spaced).unwrap();
        let rebuilt = parsed.to_occ_symbol();
        assert_eq!(rebuilt, "NVDA250117P00850000");
    }

    #[test]
    fn test_normalize_padded_five_char_root() {
        // Five-character roots leave only a single space of padding, so
        // a 21-character "GOOGL 260116C00200000" must still normalize.
        let normalized = normalize_option_symbol("GOOGL 260116C00200000").unwrap();
        assert_eq!(normalized, "GOOGL260116C00200000");
    }

    #[test]
    fn test_looks_like_occ_symbol() {
        assert!(looks_like_occ_symbol("AAPL  240119C00195000"));
        assert!(looks_like_occ_symbol("AAPL240119C00195000"));
        assert!(looks_like_occ_symbol("X     240119P00025000"));

        // Not OCC symbols
        assert!(!looks_like_occ_symbol("AAPL"));
        assert!(!looks_like_occ_symbol("AAPL 240119X00195000")); // Invalid type
        assert!(!looks_like_occ_symbol("too short"));
        assert!(!looks_like_occ_symbol("WAAAAYTOOOOOOOOLONG240119C00195000"));
    }

    #[test]
    fn test_error_too_short() {
        let result = parse_occ_symbol("AAPL240119C001");
        assert!(matches!(result, Err(OccSymbolError::TooShort(_))));
    }

    #[test]
    fn test_error_too_long() {
        let result = parse_occ_symbol("TOOLONG240119C00195000X");
        assert!(matches!(result, Err(OccSymbolError::TooLong(_))));
    }

    #[test]
    fn test_error_invalid_option_type() {
        let result = parse_occ_symbol("AAPL  240119X00195000");
        assert!(matches!(
            result,
            Err(OccSymbolError::InvalidOptionType('X'))
        ));
    }

    #[test]
    fn test_error_invalid_date() {
        let result = parse_occ_symbol("AAPL  241319C00195000"); // Month 13
        assert!(matches!(
            result,
            Err(OccSymbolError::InvalidExpirationDate(_))
        ));
    }

    #[test]
    fn test_error_invalid_strike() {
        let result = parse_occ_symbol("AAPL  240119C001950XX");
        assert!(matches!(result, Err(OccSymbolError::InvalidStrikePrice(_))));
    }

    #[test]
    fn test_option_type_display() {
        assert_eq!(OptionType::Call.to_string(), "CALL");
        assert_eq!(OptionType::Put.to_string(), "PUT");
    }

    #[test]
    fn test_expiration_iso() {
        let parsed = parse_occ_symbol("AAPL  240119C00195000").unwrap();
        assert_eq!(parsed.expiration_iso(), "2024-01-19");
    }

    #[test]
    fn test_normalize_fidelity_call() {
        assert_eq!(
            normalize_option_symbol("-MU270115C600"),
            Some("MU270115C00600000".to_string())
        );
    }

    #[test]
    fn test_normalize_fidelity_call_fractional() {
        assert_eq!(
            normalize_option_symbol("-MU270115C560"),
            Some("MU270115C00560000".to_string())
        );
    }

    #[test]
    fn test_normalize_fidelity_put() {
        assert_eq!(
            normalize_option_symbol("-X270115P25"),
            Some("X270115P00025000".to_string())
        );
    }

    #[test]
    fn test_normalize_no_dash() {
        // Should also work without leading dash
        assert_eq!(
            normalize_option_symbol("MU270115C600"),
            Some("MU270115C00600000".to_string())
        );
    }

    #[test]
    fn test_normalize_already_standard_occ() {
        // Standard OCC symbol should return the compact form
        assert_eq!(
            normalize_option_symbol("MU270115C00600000"),
            Some("MU270115C00600000".to_string())
        );
    }

    #[test]
    fn test_normalize_space_padded_occ() {
        // Space-padded OCC symbol should be normalized to compact form
        assert_eq!(
            normalize_option_symbol("AAPL  261218C00240000"),
            Some("AAPL261218C00240000".to_string())
        );
    }

    #[test]
    fn test_normalize_plain_equity() {
        // Regular equity symbol should return None
        assert_eq!(normalize_option_symbol("AAPL"), None);
    }

    // Each input below puts a byte offset the parsers cut at inside a
    // multi-byte character.

    #[test]
    fn test_parse_non_ascii_symbol() {
        assert_eq!(
            parse_occ_symbol("Société Générale"),
            Err(OccSymbolError::NonAscii)
        );
    }

    #[test]
    fn test_looks_like_non_ascii_symbol() {
        assert!(!looks_like_occ_symbol("CAFÉ PÂTÉ CRÈME"));
    }

    #[test]
    fn test_normalize_non_ascii_symbol() {
        assert_eq!(normalize_option_symbol("Fonds 2024 Été"), None);
    }

    #[test]
    fn test_normalize_keeps_non_ascii_underlying() {
        // Only the date cut is guarded; a non-ASCII underlying normalizes as before
        assert_eq!(
            normalize_option_symbol("-ÉDF270115C600"),
            Some("ÉDF270115C00600000".to_string())
        );
    }
}
