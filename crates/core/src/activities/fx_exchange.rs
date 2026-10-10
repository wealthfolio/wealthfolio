//! Validation shared by activity writers and the persistence boundary.

use rust_decimal::Decimal;

use super::{ActivityError, ACTIVITY_TYPE_FX_EXCHANGE};
use crate::fx::currency::normalize_currency_code;

pub fn validate_fx_exchange(
    activity_type: &str,
    amount: Option<Decimal>,
    currency: &str,
    destination_amount: Option<Decimal>,
    destination_currency: Option<&str>,
    cash_only: bool,
) -> Result<(), ActivityError> {
    if activity_type != ACTIVITY_TYPE_FX_EXCHANGE {
        return if destination_amount.is_some() || destination_currency.is_some() {
            Err(ActivityError::InvalidData(
                "Destination cash fields are only supported for FX_EXCHANGE".into(),
            ))
        } else {
            Ok(())
        };
    }
    let valid_currency = |code: &str| {
        let code = code.trim();
        code.len() == 3 && code.bytes().all(|c| c.is_ascii_alphabetic())
    };
    let destination = destination_currency.unwrap_or_default();
    if !valid_currency(currency) || !valid_currency(destination) {
        return Err(ActivityError::InvalidData(
            "Currency exchange requires two valid currency codes".into(),
        ));
    }
    if normalize_currency_code(currency.trim())
        .eq_ignore_ascii_case(normalize_currency_code(destination.trim()))
    {
        return Err(ActivityError::InvalidData(
            "Currency exchange requires different currencies".into(),
        ));
    }
    if !amount.is_some_and(|v| v > Decimal::ZERO)
        || !destination_amount.is_some_and(|v| v > Decimal::ZERO)
    {
        return Err(ActivityError::InvalidData(
            "Currency exchange requires positive sent and received amounts".into(),
        ));
    }
    if !cash_only {
        return Err(ActivityError::InvalidData(
            "Currency exchange accepts final cash amounts only, not assets, charges or an FX override"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn fx_exchange_validates_native_cash_before_sign_normalization() {
        for (source, destination) in [("USD", "usd"), ("GBp", "GBP"), ("USD", ""), ("USD", "EURO")]
        {
            assert!(validate_fx_exchange(
                ACTIVITY_TYPE_FX_EXCHANGE,
                Some(dec!(100)),
                source,
                Some(dec!(92)),
                Some(destination),
                true
            )
            .is_err());
        }
        for (sent, received) in [(dec!(-1), dec!(92)), (dec!(100), Decimal::ZERO)] {
            assert!(validate_fx_exchange(
                ACTIVITY_TYPE_FX_EXCHANGE,
                Some(sent),
                "USD",
                Some(received),
                Some("EUR"),
                true
            )
            .is_err());
        }
        assert!(validate_fx_exchange(
            ACTIVITY_TYPE_FX_EXCHANGE,
            Some(dec!(100)),
            "USD",
            Some(dec!(92)),
            Some("EUR"),
            false
        )
        .is_err());
        assert!(validate_fx_exchange(
            "DEPOSIT",
            Some(dec!(100)),
            "USD",
            Some(dec!(92)),
            Some("EUR"),
            true
        )
        .is_err());
        assert!(validate_fx_exchange(
            ACTIVITY_TYPE_FX_EXCHANGE,
            Some(dec!(100)),
            "USD",
            Some(dec!(92)),
            Some("EUR"),
            true
        )
        .is_ok());
    }
}
