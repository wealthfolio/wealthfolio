//! ISIN (International Securities Identification Number) validation.
//!
//! An ISIN is a 12-character alphanumeric code:
//! - Characters 1-2: ISO 3166-1 alpha-2 country code (e.g., US, DE, GB)
//! - Characters 3-11: National Securities Identifying Number (NSIN), alphanumeric
//! - Character 12: Check digit (Luhn algorithm on digit-converted string)
//!
//! Example: "US0378331005" (Apple Inc.)

/// Parsed components of an ISIN
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedIsin {
    /// ISO 3166-1 alpha-2 country code (e.g., "US", "DE", "GB")
    pub country_code: String,
    /// National Securities Identifying Number (9 alphanumeric characters)
    pub nsin: String,
    /// Luhn check digit (0-9)
    pub check_digit: u8,
}

/// Errors that can occur when parsing ISINs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IsinError {
    /// ISIN must be exactly 12 characters
    InvalidLength(usize),
    /// First two characters must be alphabetic (country code)
    InvalidCountryCode(String),
    /// Characters 3-11 must be alphanumeric
    InvalidNsin,
    /// Character 12 must be a digit
    InvalidCheckDigitFormat,
    /// Luhn check digit validation failed
    CheckDigitMismatch { expected: u8, actual: u8 },
}

impl std::fmt::Display for IsinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IsinError::InvalidLength(len) => {
                write!(f, "ISIN must be exactly 12 characters, got {}", len)
            }
            IsinError::InvalidCountryCode(cc) => {
                write!(
                    f,
                    "Invalid country code '{}': must be 2 uppercase letters",
                    cc
                )
            }
            IsinError::InvalidNsin => {
                write!(f, "NSIN (characters 3-11) must be alphanumeric")
            }
            IsinError::InvalidCheckDigitFormat => {
                write!(f, "Check digit (character 12) must be a digit")
            }
            IsinError::CheckDigitMismatch { expected, actual } => {
                write!(
                    f,
                    "Check digit mismatch: expected {}, got {}",
                    expected, actual
                )
            }
        }
    }
}

impl std::error::Error for IsinError {}

/// Parse and validate an ISIN string.
///
/// Validates format (length, country code, alphanumeric NSIN) and
/// verifies the Luhn check digit.
pub fn parse_isin(s: &str) -> Result<ParsedIsin, IsinError> {
    let s = s.trim();
    if !s.is_ascii() {
        return Err(IsinError::InvalidNsin);
    }
    let s = s.to_uppercase();
    let len = s.len();

    if len != 12 {
        return Err(IsinError::InvalidLength(len));
    }

    let country_code = &s[0..2];
    if !country_code.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(IsinError::InvalidCountryCode(country_code.to_string()));
    }

    let nsin = &s[2..11];
    if !nsin.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(IsinError::InvalidNsin);
    }

    let Some(actual_check) = s.chars().nth(11).and_then(|c| c.to_digit(10)) else {
        return Err(IsinError::InvalidCheckDigitFormat);
    };
    let actual_check = actual_check as u8;

    // Compute expected check digit using Luhn on the first 11 characters
    let expected_check = compute_isin_check_digit(&s[0..11]);

    if expected_check != actual_check {
        return Err(IsinError::CheckDigitMismatch {
            expected: expected_check,
            actual: actual_check,
        });
    }

    Ok(ParsedIsin {
        country_code: country_code.to_string(),
        nsin: nsin.to_string(),
        check_digit: actual_check,
    })
}

/// Quick heuristic check if a string looks like an ISIN.
///
/// Checks format only (length, country code pattern, alphanumeric body, digit check).
/// Does NOT verify the Luhn check digit — use `parse_isin()` for full validation.
pub fn looks_like_isin(s: &str) -> bool {
    let s = s.trim();
    if s.len() != 12 {
        return false;
    }

    let bytes = s.as_bytes();

    // First 2 chars: uppercase letters
    if !bytes[0].is_ascii_alphabetic() || !bytes[1].is_ascii_alphabetic() {
        return false;
    }

    // Characters 3-11: alphanumeric
    for &b in &bytes[2..11] {
        if !b.is_ascii_alphanumeric() {
            return false;
        }
    }

    // Character 12: digit
    bytes[11].is_ascii_digit()
}

/// Compute the ISIN Luhn check digit for the first 11 characters.
///
/// The algorithm:
/// 1. Convert each character to digits (A=10, B=11, ..., Z=35, 0-9 stay as-is)
/// 2. Concatenate all digits into a single string
/// 3. Apply the Luhn algorithm to get the check digit
pub fn compute_isin_check_digit(first_11: &str) -> u8 {
    // Step 1: Convert characters to digit string
    let mut digits = Vec::new();
    for c in first_11.chars() {
        if let Some(digit) = c.to_digit(10) {
            digits.push(digit as u8);
        } else if c.is_ascii_alphabetic() {
            let val = c.to_ascii_uppercase() as u8 - b'A' + 10;
            digits.push(val / 10);
            digits.push(val % 10);
        }
    }

    // Step 2: Apply Luhn algorithm
    // Process from right to left, doubling every second digit
    let mut sum = 0u32;
    for (i, &d) in digits.iter().rev().enumerate() {
        let mut val = d as u32;
        // Double every other digit starting from the rightmost (index 0 = not doubled, 1 = doubled, etc.)
        if i % 2 == 0 {
            val *= 2;
            if val > 9 {
                val -= 9;
            }
        }
        sum += val;
    }

    ((10 - (sum % 10)) % 10) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_us_isin() {
        // Apple Inc.
        let result = parse_isin("US0378331005").unwrap();
        assert_eq!(result.country_code, "US");
        assert_eq!(result.nsin, "037833100");
        assert_eq!(result.check_digit, 5);
    }

    #[test]
    fn test_valid_de_isin() {
        // Siemens AG
        let result = parse_isin("DE0007236101").unwrap();
        assert_eq!(result.country_code, "DE");
        assert_eq!(result.check_digit, 1);
    }

    #[test]
    fn test_valid_gb_isin() {
        // Vodafone Group
        let result = parse_isin("GB00BH4HKS39").unwrap();
        assert_eq!(result.country_code, "GB");
        assert_eq!(result.check_digit, 9);
    }

    #[test]
    fn test_valid_us_treasury() {
        // US Treasury
        let result = parse_isin("US912810TH14").unwrap();
        assert_eq!(result.country_code, "US");
        assert_eq!(result.check_digit, 4);
    }

    #[test]
    fn test_lowercase_accepted() {
        let result = parse_isin("us0378331005").unwrap();
        assert_eq!(result.country_code, "US");
    }

    #[test]
    fn test_invalid_check_digit() {
        let result = parse_isin("US0378331009");
        assert!(matches!(result, Err(IsinError::CheckDigitMismatch { .. })));
    }

    #[test]
    fn test_too_short() {
        let result = parse_isin("US037833100");
        assert!(matches!(result, Err(IsinError::InvalidLength(11))));
    }

    #[test]
    fn test_too_long() {
        let result = parse_isin("US03783310055");
        assert!(matches!(result, Err(IsinError::InvalidLength(13))));
    }

    #[test]
    fn test_invalid_country_code() {
        let result = parse_isin("120378331005");
        assert!(matches!(result, Err(IsinError::InvalidCountryCode(_))));
    }

    #[test]
    fn test_non_ascii_isin_is_rejected_without_panicking() {
        assert!(matches!(
            parse_isin("USé12345678"),
            Err(IsinError::InvalidNsin)
        ));
    }

    #[test]
    fn test_looks_like_isin() {
        assert!(looks_like_isin("US0378331005"));
        assert!(looks_like_isin("DE0007236101"));
        assert!(looks_like_isin("GB00BH4HKS39"));

        // Not ISINs
        assert!(!looks_like_isin("AAPL"));
        assert!(!looks_like_isin("US037833100")); // too short
        assert!(!looks_like_isin("12ABCDEFGH05")); // numeric country code
        assert!(!looks_like_isin("US037833100X")); // non-digit check
    }

    #[test]
    fn test_whitespace_trimmed() {
        let result = parse_isin("  US0378331005  ").unwrap();
        assert_eq!(result.country_code, "US");
    }
}
