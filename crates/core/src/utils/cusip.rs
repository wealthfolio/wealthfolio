//! CUSIP (Committee on Uniform Securities Identification Procedures) utilities.
//!
//! A CUSIP is a 9-character alphanumeric identifier:
//! - Characters 1-6: Issuer code (alphanumeric)
//! - Characters 7-8: Issue number (alphanumeric)
//! - Character 9: Check digit (modified Luhn)
//!
//! Example: "912810TH1" (US Treasury bond)

use super::isin::compute_isin_check_digit;

/// Errors from CUSIP parsing
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CusipError {
    InvalidLength(usize),
    InvalidCharacter,
    CheckDigitMismatch { expected: u8, actual: u8 },
}

impl std::fmt::Display for CusipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CusipError::InvalidLength(len) => {
                write!(f, "CUSIP must be exactly 9 characters, got {}", len)
            }
            CusipError::InvalidCharacter => {
                write!(f, "CUSIP must be alphanumeric")
            }
            CusipError::CheckDigitMismatch { expected, actual } => {
                write!(
                    f,
                    "Check digit mismatch: expected {}, got {}",
                    expected, actual
                )
            }
        }
    }
}

impl std::error::Error for CusipError {}

/// Compute the CUSIP check digit using the modified Luhn algorithm.
fn compute_cusip_check_digit(first_8: &str) -> u8 {
    let mut sum = 0u32;
    for (i, c) in first_8.chars().enumerate() {
        let val = if c.is_ascii_digit() {
            c.to_digit(10).unwrap()
        } else if c.is_ascii_alphabetic() {
            c.to_ascii_uppercase() as u32 - b'A' as u32 + 10
        } else {
            // *, @, # — not expected from broker exports
            match c {
                '*' => 36,
                '@' => 37,
                '#' => 38,
                _ => 0,
            }
        };

        // Double every other value (0-indexed: positions 1, 3, 5, 7)
        let val = if i % 2 == 1 { val * 2 } else { val };
        sum += val / 10 + val % 10;
    }

    ((10 - (sum % 10)) % 10) as u8
}

/// Parse and validate a 9-character CUSIP string.
pub fn parse_cusip(s: &str) -> Result<&str, CusipError> {
    let s = s.trim();
    if s.len() != 9 {
        return Err(CusipError::InvalidLength(s.len()));
    }

    if !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(CusipError::InvalidCharacter);
    }

    let expected = compute_cusip_check_digit(&s[..8]);
    let actual = s[8..9]
        .parse::<u8>()
        .map_err(|_| CusipError::InvalidCharacter)?;

    if expected != actual {
        return Err(CusipError::CheckDigitMismatch { expected, actual });
    }

    Ok(s)
}

/// Heuristic check: 9 alphanumeric characters with a digit as the last character.
/// Does NOT validate the check digit.
pub fn looks_like_cusip(s: &str) -> bool {
    let s = s.trim();
    s.len() == 9
        && s[..8].chars().all(|c| c.is_ascii_alphanumeric())
        && s.as_bytes()[8].is_ascii_digit()
}

/// Convert a CUSIP to an ISIN by prepending a country code (default "US")
/// and computing the ISIN check digit.
pub fn cusip_to_isin(cusip: &str, country_code: &str) -> String {
    let body = format!("{}{}", country_code, &cusip[..9]);
    let check = compute_isin_check_digit(&body);
    format!("{}{}", body, check)
}

/// Resolve only CUSIPs whose issuer establishes the country. Treasury CUSIPs
/// use the 912 issuer family, also recognized by US_TREASURY_CALC. Other CUSIPs
/// require an authoritative ISIN; trading currency cannot supply its prefix.
pub fn normalize_bond_identifier(symbol: &str) -> String {
    let upper = symbol.trim().to_uppercase();
    if upper.starts_with("912") && parse_cusip(&upper).is_ok() {
        cusip_to_isin(&upper, "US")
    } else {
        upper
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_us_treasury() {
        assert!(parse_cusip("912810TH1").is_ok());
    }

    #[test]
    fn test_parse_invalid_check_digit() {
        let result = parse_cusip("912810TH0");
        assert!(matches!(result, Err(CusipError::CheckDigitMismatch { .. })));
    }

    #[test]
    fn test_parse_too_short() {
        assert!(matches!(
            parse_cusip("912810TH"),
            Err(CusipError::InvalidLength(8))
        ));
    }

    #[test]
    fn test_looks_like_cusip() {
        assert!(looks_like_cusip("912810TH1"));
        assert!(!looks_like_cusip("AAPL"));
        assert!(!looks_like_cusip("US0378331005")); // ISIN, 12 chars
    }

    #[test]
    fn test_cusip_to_isin_us_treasury() {
        // 912810TH1 → US912810TH14
        let isin = cusip_to_isin("912810TH1", "US");
        assert_eq!(isin, "US912810TH14");
        // Verify the generated ISIN is valid
        assert!(crate::utils::isin::parse_isin(&isin).is_ok());
    }

    #[test]
    fn test_cusip_to_isin_apple() {
        // Apple CUSIP 037833100 → ISIN US0378331005
        let isin = cusip_to_isin("037833100", "US");
        assert_eq!(isin, "US0378331005");
        assert!(crate::utils::isin::parse_isin(&isin).is_ok());
    }
}
