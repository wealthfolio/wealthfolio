//! Labelled charge lines that break an activity's `fee` and `tax` totals down
//! into what a statement listed (commission, stamp duty, ...).
//!
//! The lines live in the activity's metadata under [`CHARGES_METADATA_KEY`].
//! They only describe the totals: every calculation keeps using `fee` and
//! `tax`, so a line is never counted on its own.

use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::ActivityError;
use crate::fx::currency::{get_normalization_rule, normalize_amount};
use crate::Result;

/// Metadata key that holds an activity's charge lines.
pub const CHARGES_METADATA_KEY: &str = "charges";

/// Which total a charge line belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityChargeCategory {
    Fee,
    Tax,
}

/// One labelled part of an activity's fee or tax, in the activity's currency.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCharge {
    pub category: ActivityChargeCategory,
    pub label: String,
    #[serde(
        serialize_with = "rust_decimal::serde::str::serialize",
        deserialize_with = "deserialize_amount"
    )]
    pub amount: Decimal,
}

/// Accepts the amount as a JSON string or number, like the activity's totals.
fn deserialize_amount<'de, D>(deserializer: D) -> std::result::Result<Decimal, D::Error>
where
    D: Deserializer<'de>,
{
    let text = match Value::deserialize(deserializer)? {
        Value::String(text) => text,
        Value::Number(number) => number.to_string(),
        _ => return Err(serde::de::Error::custom("a charge amount must be a number")),
    };
    let text = text.trim();
    let parsed = match text.split_once(['e', 'E']) {
        Some((base, _)) => {
            Decimal::from_str_exact(base).and_then(|_| Decimal::from_scientific(text))
        }
        None => Decimal::from_str_exact(text),
    };
    parsed.map_err(|_| serde::de::Error::custom("Invalid charge amount"))
}

// Command errors can be logged; never include statement values in them.
pub(crate) fn deserialize_import_charges<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Vec<ActivityCharge>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<Vec<ActivityCharge>>::deserialize(deserializer)
        .map_err(|_| serde::de::Error::custom("Invalid fee and tax lines"))
}

fn invalid(message: impl Into<String>) -> crate::Error {
    ActivityError::InvalidData(message.into()).into()
}

/// Removes the charge lines from a metadata blob. Returns `None` when the
/// blob had none, so callers can leave the stored metadata untouched.
pub(crate) fn without_charges(metadata: &str) -> Option<String> {
    match serde_json::from_str::<Value>(metadata) {
        Ok(Value::Object(mut map)) if map.contains_key(CHARGES_METADATA_KEY) => {
            map.remove(CHARGES_METADATA_KEY);
            Some(Value::Object(map).to_string())
        }
        _ => None,
    }
}

/// Checks and normalizes the charge lines in `metadata` for saving.
///
/// `input_currency` is the currency the lines were written in; lines in a
/// minor unit such as GBp are converted to the major unit the same way the
/// totals are. `fee` and `tax` are the totals as they will be stored (major
/// unit, unsigned). Lines must add up to both totals exactly; a mismatch is
/// rejected rather than adjusting either side. An empty or null list removes
/// the key. Metadata without the key is returned unchanged.
pub(crate) fn normalize_charges(
    metadata: Option<String>,
    input_currency: &str,
    fee: Option<Decimal>,
    tax: Option<Decimal>,
) -> Result<Option<String>> {
    let Some(text) = metadata else {
        return Ok(None);
    };
    let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(&text) else {
        return Ok(Some(text));
    };
    let Some(raw) = map.remove(CHARGES_METADATA_KEY) else {
        return Ok(Some(text));
    };
    let charges: Vec<ActivityCharge> = match raw {
        Value::Null => Vec::new(),
        raw => serde_json::from_value(raw).map_err(|_| invalid("Invalid fee and tax lines"))?,
    };
    if !charges.is_empty() {
        let charges = checked_charges(charges, input_currency, fee, tax)?;
        let value =
            serde_json::to_value(charges).map_err(|_| invalid("Invalid fee and tax lines"))?;
        map.insert(CHARGES_METADATA_KEY.to_string(), value);
    }
    Ok(Some(Value::Object(map).to_string()))
}

fn checked_charges(
    charges: Vec<ActivityCharge>,
    input_currency: &str,
    fee: Option<Decimal>,
    tax: Option<Decimal>,
) -> Result<Vec<ActivityCharge>> {
    let mut fee_sum = Decimal::ZERO;
    let mut tax_sum = Decimal::ZERO;
    let mut checked = Vec::with_capacity(charges.len());
    for charge in charges {
        let label = charge.label.trim();
        if label.is_empty() {
            return Err(invalid("Every fee and tax line needs a label"));
        }
        let (amount, _) = normalize_amount(charge.amount, input_currency);
        if get_normalization_rule(input_currency)
            .is_some_and(|rule| amount.checked_div(rule.factor) != Some(charge.amount))
        {
            return Err(invalid(
                "Charge amount loses precision in the activity currency",
            ));
        }
        match charge.category {
            ActivityChargeCategory::Fee => fee_sum = add_exact(fee_sum, amount)?,
            ActivityChargeCategory::Tax => tax_sum = add_exact(tax_sum, amount)?,
        }
        checked.push(ActivityCharge {
            category: charge.category,
            label: label.to_string(),
            amount,
        });
    }
    let fee = fee.unwrap_or(Decimal::ZERO);
    let tax = tax.unwrap_or(Decimal::ZERO);
    if fee_sum != fee {
        return Err(invalid("Fee lines must add up to the fee total"));
    }
    if tax_sum != tax {
        return Err(invalid("Tax lines must add up to the tax total"));
    }
    Ok(checked)
}

fn add_exact(sum: Decimal, amount: Decimal) -> Result<Decimal> {
    // Reversing the addition catches rounding when Decimal reduces the scale to fit.
    sum.checked_add(amount)
        .filter(|result| {
            result.checked_sub(sum) == Some(amount) && result.checked_sub(amount) == Some(sum)
        })
        .ok_or_else(|| invalid("Charge sum exceeds the supported decimal precision"))
}

/// Checks an import row using the same currency conversion as saving it.
pub(crate) fn check_import_charges(
    charges: Option<&[ActivityCharge]>,
    input_currency: &str,
    fee: Option<Decimal>,
    tax: Option<Decimal>,
) -> Result<()> {
    match charges {
        Some(charges) if !charges.is_empty() => checked_charges(
            charges.to_vec(),
            input_currency,
            fee.map(|fee| normalize_amount(fee.abs(), input_currency).0),
            tax.map(|tax| normalize_amount(tax.abs(), input_currency).0),
        )
        .map(|_| ()),
        _ => Ok(()),
    }
}

/// Adds import charge lines to the metadata an import row builds.
pub(crate) fn metadata_with_charges(
    metadata: Option<Value>,
    charges: Option<Vec<ActivityCharge>>,
) -> Option<Value> {
    let charges = charges.filter(|charges| !charges.is_empty());
    let Some(charges) = charges else {
        return metadata;
    };
    let mut map = match metadata {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.insert(
        CHARGES_METADATA_KEY.to_string(),
        serde_json::to_value(charges).unwrap_or(Value::Null),
    );
    Some(Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;
    use serde_json::json;

    fn fee_line(amount: Decimal) -> ActivityCharge {
        ActivityCharge {
            category: ActivityChargeCategory::Fee,
            label: "Commission".to_string(),
            amount,
        }
    }

    #[test]
    fn charge_errors_do_not_include_input_values() {
        for line in [
            json!({"category": "fee", "label": "Private label", "amount": "123.45invalid"}),
            json!({"category": "fee", "label": 123.45, "amount": "1"}),
            json!({"category": "Private category", "label": "Private label", "amount": "1"}),
        ] {
            let error = normalize_charges(
                Some(json!({"charges": [line]}).to_string()),
                "USD",
                Some(dec!(1)),
                None,
            )
            .unwrap_err()
            .to_string();
            assert!(error.ends_with("Invalid fee and tax lines"), "{error}");
        }
        for (category, expected) in [
            ("fee", "Fee lines must add up to the fee total"),
            ("tax", "Tax lines must add up to the tax total"),
        ] {
            let error = normalize_charges(
                Some(
                    json!({"charges": [{
                        "category": category, "label": "Private label", "amount": "123.45",
                    }]})
                    .to_string(),
                ),
                "USD",
                (category == "fee").then_some(dec!(1)),
                (category == "tax").then_some(dec!(2)),
            )
            .unwrap_err()
            .to_string();
            assert!(!error.contains("123.45"), "{error}");
            assert!(!error.contains("Private"), "{error}");
            assert!(error.ends_with(expected), "{error}");
        }
    }

    #[test]
    fn rejects_lossy_charge_amount_parsing() {
        for amount in [
            "0.00000000000000000000000000001",
            "10.0000000000000000000000000001",
            "10.0000000000000000000000000001e0",
        ] {
            assert!(
                serde_json::from_value::<ActivityCharge>(json!({
                    "category": "fee", "label": "Commission", "amount": amount,
                }))
                .is_err(),
                "{amount}"
            );
        }
        for amount in [json!("1.2e-2"), json!(0.012)] {
            let line: ActivityCharge = serde_json::from_value(json!({
                "category": "fee", "label": "Commission", "amount": amount,
            }))
            .unwrap();
            assert_eq!(line.amount, dec!(0.012));
        }
    }

    #[test]
    fn rejects_overflowing_or_lossy_charge_sums() {
        for amounts in [
            [Decimal::MAX, Decimal::ONE],
            [dec!(10), dec!(0.0000000000000000000000000001)],
        ] {
            assert!(
                check_import_charges(Some(&amounts.map(fee_line)), "", Some(amounts[0]), None,)
                    .is_err()
            );
        }
    }

    #[test]
    fn rejects_lossy_minor_unit_conversion() {
        for currency in ["GBp", "ZAc", "ILA", "USX", "KWF"] {
            assert!(
                checked_charges(
                    vec![fee_line(dec!(0.0000000000000000000000000001))],
                    currency,
                    Some(Decimal::ZERO),
                    None,
                )
                .is_err(),
                "{currency}"
            );
        }
    }

    #[test]
    fn matches_decimal_sums_exactly_and_keeps_rebates() {
        for (amounts, total) in [
            (vec![dec!(0.1), dec!(0.2)], dec!(0.3)),
            (vec![dec!(1), dec!(-1)], dec!(0)),
            (vec![dec!(0.1), dec!(-0.1), dec!(5), dec!(0.00)], dec!(5)),
            (
                vec![
                    dec!(3.3333333333333333333333333333),
                    dec!(6.6666666666666666666666666667),
                ],
                dec!(10),
            ),
        ] {
            let lines: Vec<_> = amounts.into_iter().map(fee_line).collect();
            assert!(check_import_charges(Some(&lines), "", Some(total), None).is_ok());
            assert!(
                check_import_charges(Some(&lines), "", Some(total + dec!(0.000000001)), None,)
                    .is_err()
            );
        }
    }
}
