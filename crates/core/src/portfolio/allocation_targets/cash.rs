use rust_decimal::Decimal;

use crate::portfolio::{
    allocation::TaxonomyHoldingContributions,
    holdings::{Holding, HoldingType},
};

fn deployable_cash_category_ids(taxonomy_id: &str) -> &'static [&'static str] {
    match taxonomy_id {
        "asset_classes" => &["CASH"],
        // Cash rolls up to CASH_FX in the system taxonomy. Keep CASH as a
        // fallback for tests or missing hierarchy metadata.
        "instrument_type" => &["CASH_FX", "CASH"],
        _ => &[],
    }
}

pub(super) fn has_deployable_cash_categories(taxonomy_id: &str) -> bool {
    !deployable_cash_category_ids(taxonomy_id).is_empty()
}

pub(super) fn is_deployable_cash_category(taxonomy_id: &str, category_id: &str) -> bool {
    deployable_cash_category_ids(taxonomy_id).contains(&category_id)
}

pub(super) fn deployable_cash_from_contributions(
    taxonomy_id: &str,
    contributions: &TaxonomyHoldingContributions,
) -> Option<Decimal> {
    let category_ids = deployable_cash_category_ids(taxonomy_id);
    if category_ids.is_empty() {
        return None;
    }

    Some(
        contributions
            .contributions
            .iter()
            .filter(|c| {
                c.holding_type == HoldingType::Cash
                    && is_deployable_cash_category(taxonomy_id, &c.category_id)
            })
            .map(|c| c.value)
            .sum(),
    )
}

pub(super) fn tracked_cash(holdings: &[Holding]) -> Decimal {
    holdings
        .iter()
        .filter(|h| h.holding_type == HoldingType::Cash)
        .map(|h| h.market_value.base)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portfolio::allocation::HoldingAllocationContribution;
    use rust_decimal_macros::dec;

    fn contributions(
        taxonomy_id: &str,
        rows: Vec<HoldingAllocationContribution>,
    ) -> TaxonomyHoldingContributions {
        let total_value = rows.iter().map(|row| row.value).sum();
        TaxonomyHoldingContributions {
            taxonomy_id: taxonomy_id.to_string(),
            taxonomy_name: taxonomy_id.to_string(),
            total_value,
            currency: "USD".to_string(),
            contributions: rows,
        }
    }

    fn contribution(
        category_id: &str,
        holding_type: HoldingType,
        value: Decimal,
    ) -> HoldingAllocationContribution {
        HoldingAllocationContribution {
            id: format!("holding:{category_id}"),
            holding_id: format!("holding-{category_id}"),
            asset_id: format!("asset-{category_id}"),
            account_id: "acc".to_string(),
            source_account_ids: vec![],
            symbol: category_id.to_string(),
            name: category_id.to_string(),
            holding_type,
            quantity: Decimal::ONE,
            category_id: category_id.to_string(),
            category_name: category_id.to_string(),
            category_color: "#000000".to_string(),
            value,
        }
    }

    #[test]
    fn asset_class_cash_must_be_in_cash_sleeve() {
        let tagged_cash = contributions(
            "asset_classes",
            vec![contribution("FIXED_INCOME", HoldingType::Cash, dec!(1000))],
        );
        let default_cash = contributions(
            "asset_classes",
            vec![contribution("CASH", HoldingType::Cash, dec!(500))],
        );

        assert_eq!(
            deployable_cash_from_contributions("asset_classes", &tagged_cash),
            Some(Decimal::ZERO)
        );
        assert_eq!(
            deployable_cash_from_contributions("asset_classes", &default_cash),
            Some(dec!(500))
        );
        assert!(is_deployable_cash_category("asset_classes", "CASH"));
        assert!(!is_deployable_cash_category(
            "asset_classes",
            "FIXED_INCOME"
        ));
    }

    #[test]
    fn instrument_type_uses_cash_fx_rollup() {
        let contributions = contributions(
            "instrument_type",
            vec![contribution("CASH_FX", HoldingType::Cash, dec!(250))],
        );

        assert_eq!(
            deployable_cash_from_contributions("instrument_type", &contributions),
            Some(dec!(250))
        );
    }

    #[test]
    fn non_cash_taxonomy_falls_back_to_tracked_cash() {
        let contributions = contributions(
            "industries_gics",
            vec![contribution("45", HoldingType::Security, dec!(1000))],
        );

        assert_eq!(
            deployable_cash_from_contributions("industries_gics", &contributions),
            None
        );
    }
}
