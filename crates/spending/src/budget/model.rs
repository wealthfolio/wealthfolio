use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetGroup {
    pub id: String,
    pub name: String,
    pub key: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub is_system: bool,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBudgetGroup {
    pub id: Option<String>,
    pub name: String,
    pub key: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
    #[serde(default)]
    pub is_system: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBudgetGroup {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    pub icon: Option<Option<String>>,
    pub sort_order: Option<i32>,
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_budget_group_preserves_explicit_null_nullable_fields() {
        let patch: UpdateBudgetGroup = serde_json::from_value(serde_json::json!({
            "color": null,
            "icon": null
        }))
        .expect("deserialize patch");

        assert_eq!(patch.color, Some(None));
        assert_eq!(patch.icon, Some(None));
    }

    #[test]
    fn update_budget_group_keeps_omitted_nullable_fields_as_none() {
        let patch: UpdateBudgetGroup =
            serde_json::from_value(serde_json::json!({})).expect("deserialize patch");

        assert_eq!(patch.color, None);
        assert_eq!(patch.icon, None);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetGroupAssignment {
    pub id: String,
    pub group_id: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBudgetGroupAssignment {
    pub id: Option<String>,
    pub group_id: String,
    #[serde(default = "default_spending_taxonomy")]
    pub taxonomy_id: String,
    pub category_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetTargetType {
    Category,
    GroupBuffer,
}

impl BudgetTargetType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Category => "category",
            Self::GroupBuffer => "group_buffer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetTarget {
    pub id: String,
    pub period_key: String,
    pub target_type: BudgetTargetType,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    pub amount: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBudgetTarget {
    pub id: Option<String>,
    pub period_key: String,
    pub target_type: BudgetTargetType,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    pub amount: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetRolloverTargetType {
    Category,
    Group,
}

impl BudgetRolloverTargetType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Category => "category",
            Self::Group => "group",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetRolloverSetting {
    pub id: String,
    pub target_type: BudgetRolloverTargetType,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    pub enabled: bool,
    pub start_month: String,
    pub starting_balance: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBudgetRolloverSetting {
    pub id: Option<String>,
    pub target_type: BudgetRolloverTargetType,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub group_id: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub start_month: String,
    pub starting_balance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetCategoryRow {
    pub taxonomy_id: String,
    pub category_id: String,
    pub group_id: Option<String>,
    pub parent_id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub target: f64,
    pub actual: f64,
    pub rollover_in: f64,
    pub rollover_out: f64,
    pub remaining: f64,
    pub overspent: bool,
    pub has_default_target: bool,
    pub has_month_override: bool,
    pub rollover_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetGroupRow {
    pub group: BudgetGroup,
    pub category_target_total: f64,
    pub buffer: f64,
    pub planned_total: f64,
    pub actual: f64,
    pub rollover_in: f64,
    pub rollover_out: f64,
    pub remaining: f64,
    pub overspent: bool,
    pub rollover_enabled: bool,
    pub categories: Vec<BudgetCategoryRow>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetTotals {
    pub spending_planned: f64,
    pub spending_actual: f64,
    pub spending_remaining: f64,
    pub income_planned: f64,
    pub income_actual: f64,
    pub group_buffer: f64,
    pub rollover_in: f64,
    pub rollover_out: f64,
    pub overspent_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSnapshotState {
    pub groups: Vec<BudgetGroup>,
    pub group_assignments: Vec<BudgetGroupAssignment>,
    pub targets: Vec<BudgetTarget>,
    pub rollover_settings: Vec<BudgetRolloverSetting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSnapshotComputed {
    pub currency: String,
    pub period_key: String,
    pub fx_as_of: Option<String>,
    pub group_rows: Vec<BudgetGroupRow>,
    pub ungrouped_rows: Vec<BudgetCategoryRow>,
    pub income_rows: Vec<BudgetCategoryRow>,
    pub totals: BudgetTotals,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSnapshot {
    pub state: BudgetSnapshotState,
    pub computed: BudgetSnapshotComputed,
}

impl BudgetSnapshot {
    pub fn empty(period_key: String, currency: String) -> Self {
        Self {
            state: BudgetSnapshotState {
                groups: Vec::new(),
                group_assignments: Vec::new(),
                targets: Vec::new(),
                rollover_settings: Vec::new(),
            },
            computed: BudgetSnapshotComputed {
                currency,
                period_key,
                fx_as_of: None,
                group_rows: Vec::new(),
                ungrouped_rows: Vec::new(),
                income_rows: Vec::new(),
                totals: BudgetTotals::default(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CopyMonthRequest {
    pub source_period_key: String,
    pub target_period_key: String,
    #[serde(default)]
    pub overwrite: bool,
}

fn default_spending_taxonomy() -> String {
    "spending_categories".to_string()
}

fn default_enabled() -> bool {
    true
}
