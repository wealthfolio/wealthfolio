use crate::utils::stable_id;

pub(super) fn activity_taxonomy_assignment_id(activity_id: &str, taxonomy_id: &str) -> String {
    stable_id("activity_taxonomy_assignment", &[activity_id, taxonomy_id])
}

pub(super) fn budget_group_assignment_id(taxonomy_id: &str, category_id: &str) -> String {
    stable_id("budget_group_assignment", &[taxonomy_id, category_id])
}

pub(super) fn budget_target_id(
    period_key: &str,
    target_type: &str,
    taxonomy_id: Option<&str>,
    category_id: Option<&str>,
    group_id: Option<&str>,
) -> String {
    match target_type {
        "category" => stable_id(
            "budget_target:category",
            &[
                period_key,
                taxonomy_id.unwrap_or(""),
                category_id.unwrap_or(""),
            ],
        ),
        "group_buffer" => stable_id(
            "budget_target:group_buffer",
            &[period_key, group_id.unwrap_or("")],
        ),
        _ => stable_id("budget_target", &[period_key, target_type]),
    }
}

pub(super) fn budget_rollover_setting_id(
    target_type: &str,
    taxonomy_id: Option<&str>,
    category_id: Option<&str>,
    group_id: Option<&str>,
) -> String {
    match target_type {
        "category" => stable_id(
            "budget_rollover_setting:category",
            &[taxonomy_id.unwrap_or(""), category_id.unwrap_or("")],
        ),
        "group" => stable_id("budget_rollover_setting:group", &[group_id.unwrap_or("")]),
        _ => stable_id("budget_rollover_setting", &[target_type]),
    }
}

pub(super) fn preset_categorization_rule_id(preset_id: &str, preset_rule_key: &str) -> String {
    stable_id(
        "spending_categorization_rule:preset",
        &[preset_id, preset_rule_key],
    )
}

pub(crate) fn preset_rule_deletion_id(preset_id: &str, preset_rule_key: &str) -> String {
    stable_id(
        "spending_preset_rule_deletion",
        &[preset_id, preset_rule_key],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn singleton_ids_are_stable() {
        assert_eq!(
            budget_target_id(
                "2026-05",
                "category",
                Some("spending_categories"),
                Some("cat_food"),
                None,
            ),
            budget_target_id(
                "2026-05",
                "category",
                Some("spending_categories"),
                Some("cat_food"),
                None,
            )
        );
    }
}
