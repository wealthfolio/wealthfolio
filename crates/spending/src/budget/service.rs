use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Utc};
use rust_decimal::Decimal;
use std::str::FromStr;
use uuid::Uuid;
use wealthfolio_core::accounts::{
    account_supports_purpose, AccountPurpose, AccountRepositoryTrait,
};
use wealthfolio_core::activities::ActivityRepositoryTrait;
use wealthfolio_core::taxonomies::{Category, TaxonomyServiceTrait};

use super::model::{
    BudgetCategoryRow, BudgetGroup, BudgetGroupRow, BudgetRolloverSetting,
    BudgetRolloverTargetType, BudgetSnapshot, BudgetSnapshotComputed, BudgetSnapshotState,
    BudgetTarget, BudgetTargetType, BudgetTotals, NewBudgetGroup, NewBudgetGroupAssignment,
    NewBudgetRolloverSetting, NewBudgetTarget, UpdateBudgetGroup,
};
use super::traits::BudgetRepositoryTrait;
use crate::activity_allocations::{
    allocations_for_taxonomy, group_assignments, group_splits, SplitsByActivity,
};
use crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait;
use crate::activity_classification::{activity_abs_amount, classify_activity, decimal_to_f64};
use crate::activity_splits::ActivitySplitRepositoryTrait;
use crate::error::SpendingError;
use crate::settings::SpendingSettingsService;

const SPENDING_TAXONOMY: &str = "spending_categories";
const INCOME_TAXONOMY: &str = "income_sources";
const SAVINGS_TAXONOMY: &str = "savings_categories";
const DEFAULT_PERIOD_KEY: &str = "default";
const OTHER_GROUP_KEY: &str = "other";

#[derive(Clone, Copy)]
struct DefaultGroup {
    id: &'static str,
    name: &'static str,
    key: &'static str,
    color: &'static str,
    icon: &'static str,
    sort_order: i32,
}

struct DefaultAssignment {
    id: &'static str,
    category_id: &'static str,
    group_key: &'static str,
}

const BUDGET_GROUP_NEEDS_ID: &str = "032ecb02-5912-42e8-9724-2cd566fc08d5";
const BUDGET_GROUP_WANTS_ID: &str = "a409e0d6-9152-49c8-a5b4-a147a8ac636e";
const BUDGET_GROUP_SAVINGS_ID: &str = "1fb6f2a3-3245-4702-83e8-ab116458d13e";
const BUDGET_GROUP_GIVING_ID: &str = "8cbd26c8-e3b2-4176-8c61-e5c11e10b808";
const BUDGET_GROUP_PERSONAL_ID: &str = "3ff71753-5dd5-4372-9ca2-63d8d9a04851";
const BUDGET_GROUP_OTHER_ID: &str = "6e25d097-0c73-4521-9407-d47e8dfb73e2";

const DEFAULT_GROUPS: [DefaultGroup; 6] = [
    DefaultGroup {
        id: BUDGET_GROUP_NEEDS_ID,
        name: "Needs",
        key: "needs",
        color: "#4F6B92",
        icon: "Home",
        sort_order: 1,
    },
    DefaultGroup {
        id: BUDGET_GROUP_WANTS_ID,
        name: "Wants",
        key: "wants",
        color: "#8E7CB3",
        icon: "Sparkles",
        sort_order: 2,
    },
    DefaultGroup {
        id: BUDGET_GROUP_SAVINGS_ID,
        name: "Savings",
        key: "savings",
        color: "#6B8E54",
        icon: "PiggyBank",
        sort_order: 3,
    },
    DefaultGroup {
        id: BUDGET_GROUP_GIVING_ID,
        name: "Giving",
        key: "giving",
        color: "#A35742",
        icon: "Gift",
        sort_order: 4,
    },
    DefaultGroup {
        id: BUDGET_GROUP_PERSONAL_ID,
        name: "Personal",
        key: "personal",
        color: "#B89A4C",
        icon: "User",
        sort_order: 5,
    },
    DefaultGroup {
        id: BUDGET_GROUP_OTHER_ID,
        name: "Other",
        key: "other",
        color: "#9C998E",
        icon: "MoreHorizontal",
        sort_order: 99,
    },
];

const DEFAULT_ASSIGNMENTS: [DefaultAssignment; 15] = [
    DefaultAssignment {
        id: "d36f8d92-36f8-4e07-b4b4-9e979ce8a9f4",
        category_id: "cat_housing",
        group_key: "needs",
    },
    DefaultAssignment {
        id: "c9a1ef0d-72b2-4f75-858d-5f48e5bc7626",
        category_id: "cat_groceries",
        group_key: "needs",
    },
    DefaultAssignment {
        id: "e9543a4c-dead-42f6-9e73-7343e8f43392",
        category_id: "cat_transport",
        group_key: "needs",
    },
    DefaultAssignment {
        id: "aa46cdeb-d224-4f3f-9ffb-f6331bafeade",
        category_id: "cat_health",
        group_key: "needs",
    },
    DefaultAssignment {
        id: "00769d66-fac3-45e9-9e98-1db5d4447bec",
        category_id: "cat_bills",
        group_key: "needs",
    },
    DefaultAssignment {
        id: "9eeaa7b8-aa98-4861-94d3-54650226d9cc",
        category_id: "cat_fees",
        group_key: "needs",
    },
    DefaultAssignment {
        id: "5ba8b7fa-bd44-456a-9165-dfdf554bfe10",
        category_id: "cat_education",
        group_key: "needs",
    },
    DefaultAssignment {
        id: "2f4bbcbd-8120-4fbe-ab4a-85f7c406e488",
        category_id: "cat_food",
        group_key: "wants",
    },
    DefaultAssignment {
        id: "39148a03-c9e9-40e4-867f-5949146b85b8",
        category_id: "cat_shopping",
        group_key: "wants",
    },
    DefaultAssignment {
        id: "c2721f07-e7b6-4c74-b449-f138a7d7dabf",
        category_id: "cat_entertainment",
        group_key: "wants",
    },
    DefaultAssignment {
        id: "5a2a7585-9f60-4a4b-9cbe-420432720f28",
        category_id: "cat_travel",
        group_key: "wants",
    },
    DefaultAssignment {
        id: "d48afe20-18d3-422e-bc26-bd16f4d9d78c",
        category_id: "cat_gifts",
        group_key: "giving",
    },
    DefaultAssignment {
        id: "2f46a6a5-dda6-41c7-b372-a0d4f2e571eb",
        category_id: "cat_savings",
        group_key: "savings",
    },
    DefaultAssignment {
        id: "dc8d3b07-dbc5-4134-bc31-9f65a7f726bc",
        category_id: "cat_personal",
        group_key: "personal",
    },
    DefaultAssignment {
        id: "fb622784-fb8a-497d-8b36-8eb8f347c222",
        category_id: "cat_other_expense",
        group_key: "other",
    },
];

type MonthActuals = HashMap<(String, String), Decimal>;

pub struct BudgetService {
    repo: Arc<dyn BudgetRepositoryTrait>,
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    account_repo: Arc<dyn AccountRepositoryTrait>,
    assignment_repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
    split_repo: Arc<dyn ActivitySplitRepositoryTrait>,
    spending_settings: Arc<SpendingSettingsService>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
}

impl BudgetService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repo: Arc<dyn BudgetRepositoryTrait>,
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        account_repo: Arc<dyn AccountRepositoryTrait>,
        assignment_repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        split_repo: Arc<dyn ActivitySplitRepositoryTrait>,
        spending_settings: Arc<SpendingSettingsService>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
    ) -> Self {
        Self {
            repo,
            activity_repo,
            account_repo,
            assignment_repo,
            split_repo,
            spending_settings,
            taxonomy_service,
            fx_service,
        }
    }

    pub async fn get(
        &self,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        let period_key = normalize_period_key(period_key, timezone)?;
        let settings = self.spending_settings.get().await?;
        if !settings.enabled {
            return Ok(BudgetSnapshot::empty(period_key, currency.to_string()));
        }

        self.ensure_system_groups().await?;
        let groups = self.repo.list_groups().await?;
        let assignments = self.repo.list_group_assignments().await?;
        let targets = self.repo.list_targets().await?;
        let rollover_settings = self.repo.list_rollover_settings().await?;

        let spending_categories = self.taxonomy_categories(SPENDING_TAXONOMY)?;
        let income_categories = self.taxonomy_categories(INCOME_TAXONOMY)?;
        let spending_category_meta = category_meta(&spending_categories);
        let income_meta = category_meta(&income_categories);
        let top_spending_categories = top_level_categories(&spending_categories);
        let top_income_categories = top_level_categories(&income_categories);

        let is_month_view = period_key != DEFAULT_PERIOD_KEY;
        let actuals_by_month = if is_month_view {
            let earliest_rollover_month = rollover_settings
                .iter()
                .filter(|s| s.enabled && s.start_month <= period_key)
                .map(|s| s.start_month.clone())
                .min()
                .unwrap_or_else(|| period_key.clone());
            self.actuals_by_month(
                &earliest_rollover_month,
                &period_key,
                &spending_category_meta,
                &income_meta,
                currency,
                timezone,
            )
            .await?
        } else {
            HashMap::new()
        };
        let current_actuals = actuals_by_month
            .get(&period_key)
            .cloned()
            .unwrap_or_default();

        let target_index = TargetIndex::new(&targets);
        let rollover_index = RolloverIndex::new(&rollover_settings);
        let group_by_key: HashMap<String, BudgetGroup> =
            groups.iter().map(|g| (g.key.clone(), g.clone())).collect();
        let other_group_id = group_by_key
            .get(OTHER_GROUP_KEY)
            .map(|g| g.id.clone())
            .ok_or_else(|| anyhow!("Missing Other budget group"))?;

        let assignment_by_category: HashMap<String, String> = assignments
            .iter()
            .filter(|a| a.taxonomy_id == SPENDING_TAXONOMY)
            .map(|a| (a.category_id.clone(), a.group_id.clone()))
            .collect();
        let group_for_category = |category_id: &str| -> String {
            resolve_group_for_category(
                category_id,
                &assignment_by_category,
                &spending_category_meta,
                &other_group_id,
            )
        };

        let mut rows_by_group: HashMap<String, Vec<BudgetCategoryRow>> = HashMap::new();
        for category in &top_spending_categories {
            let group_id = group_for_category(&category.id);
            let actual = current_actuals
                .get(&(SPENDING_TAXONOMY.to_string(), category.id.clone()))
                .copied()
                .unwrap_or(Decimal::ZERO);
            let target = target_index.effective_category_decimal(
                &period_key,
                SPENDING_TAXONOMY,
                &category.id,
            );
            let rollover = is_month_view
                .then(|| rollover_index.category(SPENDING_TAXONOMY, &category.id))
                .flatten();
            let (rollover_in, rollover_out, remaining) = if let Some(setting) = rollover {
                compute_rollover_for_month(
                    setting,
                    &period_key,
                    |month| {
                        target_index.effective_category_decimal(
                            month,
                            SPENDING_TAXONOMY,
                            &category.id,
                        )
                    },
                    |month| {
                        actuals_by_month
                            .get(month)
                            .and_then(|m| {
                                m.get(&(SPENDING_TAXONOMY.to_string(), category.id.clone()))
                            })
                            .copied()
                            .unwrap_or(Decimal::ZERO)
                    },
                )
            } else {
                (Decimal::ZERO, Decimal::ZERO, target - actual)
            };
            rows_by_group
                .entry(group_id.clone())
                .or_default()
                .push(BudgetCategoryRow {
                    taxonomy_id: SPENDING_TAXONOMY.to_string(),
                    category_id: category.id.clone(),
                    group_id: Some(group_id),
                    parent_id: category.parent_id.clone(),
                    name: category.name.clone(),
                    color: Some(category.color.clone()),
                    icon: category.icon.clone(),
                    target: decimal_to_f64(target),
                    actual: decimal_to_f64(actual),
                    rollover_in: decimal_to_f64(rollover_in),
                    rollover_out: decimal_to_f64(rollover_out),
                    remaining: decimal_to_f64(remaining),
                    overspent: remaining < Decimal::ZERO,
                    has_default_target: target_index
                        .has_default_category(SPENDING_TAXONOMY, &category.id),
                    has_month_override: target_index.has_month_category(
                        &period_key,
                        SPENDING_TAXONOMY,
                        &category.id,
                    ),
                    rollover_enabled: rollover.is_some(),
                });
        }

        let mut group_rows = Vec::with_capacity(groups.len());
        let mut spending_planned_total = Decimal::ZERO;
        let mut spending_actual_total = Decimal::ZERO;
        let mut spending_remaining_total = Decimal::ZERO;
        let mut group_buffer_total = Decimal::ZERO;
        let mut rollover_in_total = Decimal::ZERO;
        let mut rollover_out_total = Decimal::ZERO;
        for group in &groups {
            let mut categories = rows_by_group.remove(&group.id).unwrap_or_default();
            categories.sort_by(|a, b| a.name.cmp(&b.name));
            let category_ids = categories
                .iter()
                .map(|category| category.category_id.clone())
                .collect::<Vec<_>>();
            let category_target_total_decimal = category_ids
                .iter()
                .map(|category_id| {
                    target_index.effective_category_decimal(
                        &period_key,
                        SPENDING_TAXONOMY,
                        category_id,
                    )
                })
                .sum::<Decimal>();
            let actual_decimal = category_ids
                .iter()
                .map(|category_id| {
                    current_actuals
                        .get(&(SPENDING_TAXONOMY.to_string(), category_id.clone()))
                        .copied()
                        .unwrap_or(Decimal::ZERO)
                })
                .sum::<Decimal>();
            let buffer_decimal =
                target_index.effective_group_buffer_decimal(&period_key, &group.id);
            let planned_total_decimal = category_target_total_decimal + buffer_decimal;
            let category_target_total = decimal_to_f64(category_target_total_decimal);
            let actual = decimal_to_f64(actual_decimal);
            let buffer = decimal_to_f64(buffer_decimal);
            let planned_total = decimal_to_f64(planned_total_decimal);
            let rollover = is_month_view
                .then(|| rollover_index.group(&group.id))
                .flatten();
            let (rollover_in, rollover_out, remaining) = if let Some(setting) = rollover {
                compute_rollover_for_month(
                    setting,
                    &period_key,
                    |month| {
                        let child_total = category_ids
                            .iter()
                            .map(|category_id| {
                                target_index.effective_category_decimal(
                                    month,
                                    SPENDING_TAXONOMY,
                                    category_id,
                                )
                            })
                            .sum::<Decimal>();
                        child_total + target_index.effective_group_buffer_decimal(month, &group.id)
                    },
                    |month| {
                        category_ids
                            .iter()
                            .map(|category_id| {
                                actuals_by_month
                                    .get(month)
                                    .and_then(|m| {
                                        m.get(&(SPENDING_TAXONOMY.to_string(), category_id.clone()))
                                    })
                                    .copied()
                                    .unwrap_or(Decimal::ZERO)
                            })
                            .sum::<Decimal>()
                    },
                )
            } else {
                (
                    Decimal::ZERO,
                    Decimal::ZERO,
                    planned_total_decimal - actual_decimal,
                )
            };
            spending_planned_total += planned_total_decimal;
            spending_actual_total += actual_decimal;
            spending_remaining_total += remaining;
            group_buffer_total += buffer_decimal;
            rollover_in_total += rollover_in;
            rollover_out_total += rollover_out;
            group_rows.push(BudgetGroupRow {
                group: group.clone(),
                category_target_total,
                buffer,
                planned_total,
                actual,
                rollover_in: decimal_to_f64(rollover_in),
                rollover_out: decimal_to_f64(rollover_out),
                remaining: decimal_to_f64(remaining),
                overspent: remaining < Decimal::ZERO,
                rollover_enabled: rollover.is_some(),
                categories,
            });
        }
        group_rows.sort_by(|a, b| {
            a.group
                .sort_order
                .cmp(&b.group.sort_order)
                .then(a.group.name.cmp(&b.group.name))
        });

        let mut income_rows = Vec::with_capacity(top_income_categories.len());
        let mut income_planned_total = Decimal::ZERO;
        let mut income_actual_total = Decimal::ZERO;
        for category in &top_income_categories {
            let actual = current_actuals
                .get(&(INCOME_TAXONOMY.to_string(), category.id.clone()))
                .copied()
                .unwrap_or(Decimal::ZERO);
            let target =
                target_index.effective_category_decimal(&period_key, INCOME_TAXONOMY, &category.id);
            income_planned_total += target;
            income_actual_total += actual;
            income_rows.push(BudgetCategoryRow {
                taxonomy_id: INCOME_TAXONOMY.to_string(),
                category_id: category.id.clone(),
                group_id: None,
                parent_id: category.parent_id.clone(),
                name: category.name.clone(),
                color: Some(category.color.clone()),
                icon: category.icon.clone(),
                target: decimal_to_f64(target),
                actual: decimal_to_f64(actual),
                rollover_in: 0.0,
                rollover_out: 0.0,
                remaining: decimal_to_f64(target - actual),
                overspent: false,
                has_default_target: target_index
                    .has_default_category(INCOME_TAXONOMY, &category.id),
                has_month_override: target_index.has_month_category(
                    &period_key,
                    INCOME_TAXONOMY,
                    &category.id,
                ),
                rollover_enabled: false,
            });
        }
        income_rows.sort_by(|a, b| a.name.cmp(&b.name));

        let totals = BudgetTotals {
            spending_planned: decimal_to_f64(spending_planned_total),
            spending_actual: decimal_to_f64(spending_actual_total),
            spending_remaining: decimal_to_f64(spending_remaining_total),
            income_planned: decimal_to_f64(income_planned_total),
            income_actual: decimal_to_f64(income_actual_total),
            group_buffer: decimal_to_f64(group_buffer_total),
            rollover_in: decimal_to_f64(rollover_in_total),
            rollover_out: decimal_to_f64(rollover_out_total),
            overspent_count: group_rows.iter().filter(|g| g.overspent).count()
                + group_rows
                    .iter()
                    .flat_map(|g| &g.categories)
                    .filter(|c| c.overspent)
                    .count(),
        };
        let fx_as_of = if is_month_view {
            month_end(&period_key)
                .ok()
                .map(|date| date.date_naive().to_string())
        } else {
            None
        };

        Ok(BudgetSnapshot {
            state: BudgetSnapshotState {
                groups,
                group_assignments: assignments,
                targets,
                rollover_settings,
            },
            computed: BudgetSnapshotComputed {
                currency: currency.to_string(),
                period_key,
                fx_as_of,
                group_rows,
                ungrouped_rows: vec![],
                income_rows,
                totals,
            },
        })
    }

    pub async fn create_group(
        &self,
        input: NewBudgetGroup,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        self.repo
            .create_group(NewBudgetGroup {
                id: input.id,
                key: Some(format!("custom_{}", Uuid::new_v4())),
                name: input.name,
                color: input.color,
                icon: input.icon,
                sort_order: input.sort_order,
                is_system: false,
            })
            .await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn update_group(
        &self,
        id: &str,
        patch: UpdateBudgetGroup,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        self.repo.update_group(id, patch).await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn delete_group(
        &self,
        id: &str,
        reassign_to_group_id: &str,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        let groups = self.repo.list_groups().await?;
        let group = groups
            .iter()
            .find(|g| g.id == id)
            .ok_or_else(|| invalid_budget_input("Budget group not found"))?;
        if group.is_system {
            return Err(SpendingError::InvalidInput {
                message: "System budget groups cannot be deleted".to_string(),
            }
            .into());
        }
        if reassign_to_group_id == id {
            return Err(invalid_budget_input(
                "Cannot reassign categories to the group being deleted",
            ));
        }
        if !groups.iter().any(|g| g.id == reassign_to_group_id) {
            return Err(invalid_budget_input("Reassignment budget group not found"));
        }
        if self
            .repo
            .list_rollover_settings()
            .await?
            .into_iter()
            .any(|r| {
                matches!(r.target_type, BudgetRolloverTargetType::Group)
                    && r.group_id.as_deref() == Some(id)
            })
        {
            return Err(invalid_budget_input(
                "Delete the group's rollover setting before deleting the group",
            ));
        }
        let assignments = self.repo.list_group_assignments().await?;
        let reassignments = assignments
            .into_iter()
            .filter(|a| a.group_id == id)
            .map(|a| NewBudgetGroupAssignment {
                id: Some(a.id),
                group_id: reassign_to_group_id.to_string(),
                taxonomy_id: a.taxonomy_id,
                category_id: a.category_id,
            })
            .collect::<Vec<_>>();
        self.repo
            .delete_group_and_reassign(id, reassign_to_group_id, reassignments)
            .await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn assign_category_to_group(
        &self,
        category_id: String,
        group_id: String,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        self.repo
            .upsert_group_assignment(NewBudgetGroupAssignment {
                id: None,
                group_id,
                taxonomy_id: SPENDING_TAXONOMY.to_string(),
                category_id,
            })
            .await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn reset_groups(
        &self,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        let groups = self
            .repo
            .upsert_system_groups(default_group_inputs())
            .await?;
        let group_by_key: HashMap<String, String> =
            groups.into_iter().map(|g| (g.key, g.id)).collect();
        self.repo
            .upsert_system_group_assignments(default_assignment_inputs(&group_by_key))
            .await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn upsert_target(
        &self,
        target: NewBudgetTarget,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        validate_period_key(&target.period_key)?;
        validate_budget_target(&target)?;
        self.repo.upsert_target(target).await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn delete_target(
        &self,
        id: &str,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        self.repo.delete_target(id).await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn upsert_rollover_setting(
        &self,
        setting: NewBudgetRolloverSetting,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        validate_month_key(&setting.start_month)?;
        validate_rollover_setting(&setting)?;
        match setting.target_type {
            BudgetRolloverTargetType::Group if setting.enabled => {
                let group_id = setting
                    .group_id
                    .as_ref()
                    .ok_or_else(|| invalid_budget_input("Group rollover requires groupId"))?;
                let categories = self.categories_for_group(group_id).await?;
                self.repo
                    .disable_category_rollovers(SPENDING_TAXONOMY, &categories)
                    .await?;
            }
            BudgetRolloverTargetType::Category if setting.enabled => {
                let category_id = setting
                    .category_id
                    .as_ref()
                    .ok_or_else(|| invalid_budget_input("Category rollover requires categoryId"))?;
                let group_id = self.group_id_for_category(category_id).await?;
                let group_rollover_enabled = self
                    .repo
                    .list_rollover_settings()
                    .await?
                    .into_iter()
                    .any(|r| {
                        r.enabled
                            && matches!(r.target_type, BudgetRolloverTargetType::Group)
                            && r.group_id.as_deref() == Some(group_id.as_str())
                    });
                if group_rollover_enabled {
                    return Err(invalid_budget_input(
                        "Disable group rollover before enabling category rollover",
                    ));
                }
            }
            _ => {}
        }
        self.repo.upsert_rollover_setting(setting).await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn delete_rollover_setting(
        &self,
        id: &str,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        self.repo.delete_rollover_setting(id).await?;
        self.get(period_key, currency, timezone).await
    }

    pub async fn copy_period_targets(
        &self,
        source_period_key: &str,
        target_period_key: &str,
        overwrite: bool,
        currency: &str,
        timezone: &str,
    ) -> Result<BudgetSnapshot> {
        validate_period_key(source_period_key)?;
        validate_month_key(target_period_key)?;
        if source_period_key == target_period_key {
            return Err(invalid_budget_input("Source and target months must differ"));
        }
        self.repo
            .copy_period_targets(source_period_key, target_period_key, overwrite)
            .await?;
        self.get(Some(target_period_key.to_string()), currency, timezone)
            .await
    }

    async fn ensure_system_groups(&self) -> Result<()> {
        let existing_keys: HashSet<String> = self
            .repo
            .list_groups()
            .await?
            .into_iter()
            .map(|g| g.key)
            .collect();
        let missing = default_group_inputs()
            .into_iter()
            .filter(|g| {
                g.key
                    .as_ref()
                    .is_some_and(|key| !existing_keys.contains(key))
            })
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            self.repo.upsert_system_groups(missing).await?;
        }
        Ok(())
    }

    fn taxonomy_categories(&self, taxonomy_id: &str) -> Result<Vec<Category>> {
        Ok(self
            .taxonomy_service
            .get_taxonomy(taxonomy_id)?
            .map(|t| t.categories)
            .unwrap_or_default())
    }

    async fn categories_for_group(&self, group_id: &str) -> Result<Vec<String>> {
        let assignments = self.repo.list_group_assignments().await?;
        let categories = self.taxonomy_categories(SPENDING_TAXONOMY)?;
        let meta = category_meta(&categories);
        let groups = self.repo.list_groups().await?;
        let other_group_id = groups
            .into_iter()
            .find(|g| g.key == OTHER_GROUP_KEY)
            .map(|g| g.id)
            .ok_or_else(|| anyhow!("Missing Other budget group"))?;
        let assignment_by_category = assignments
            .into_iter()
            .filter(|a| a.taxonomy_id == SPENDING_TAXONOMY)
            .map(|a| (a.category_id, a.group_id))
            .collect::<HashMap<_, _>>();

        Ok(top_level_categories(&categories)
            .into_iter()
            .filter(|category| {
                resolve_group_for_category(
                    &category.id,
                    &assignment_by_category,
                    &meta,
                    &other_group_id,
                ) == group_id
            })
            .map(|category| category.id)
            .collect())
    }

    async fn group_id_for_category(&self, category_id: &str) -> Result<String> {
        let assignments = self.repo.list_group_assignments().await?;
        let categories = self.taxonomy_categories(SPENDING_TAXONOMY)?;
        let meta = category_meta(&categories);
        let groups = self.repo.list_groups().await?;
        let other_group_id = groups
            .iter()
            .find(|g| g.key == OTHER_GROUP_KEY)
            .map(|g| g.id.clone())
            .ok_or_else(|| anyhow!("Missing Other budget group"))?;
        let assignment_by_category = assignments
            .into_iter()
            .map(|a| (a.category_id, a.group_id))
            .collect::<HashMap<_, _>>();
        Ok(resolve_group_for_category(
            category_id,
            &assignment_by_category,
            &meta,
            &other_group_id,
        ))
    }

    /// `currency` is the FX target — every counted activity is converted to
    /// it at `end_period`'s month-end (snapshot-date convention, matches
    /// insight + monthly_report so per-month actuals reconcile with the
    /// broader dashboard numbers).
    /// `timezone` (IANA name, may be empty) drives per-month bucketing so a
    /// midnight-local activity on the first/last day of a month lands in the
    /// month the user perceives, not the UTC month.
    async fn actuals_by_month(
        &self,
        start_period: &str,
        end_period: &str,
        spending_meta: &HashMap<String, Category>,
        income_meta: &HashMap<String, Category>,
        currency: &str,
        timezone: &str,
    ) -> Result<HashMap<String, MonthActuals>> {
        let settings = self.spending_settings.get().await?;
        if !settings.enabled || settings.account_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let accounts = self
            .account_repo
            .list(None, Some(false), Some(&settings.account_ids))
            .map_err(|e| anyhow!(e.to_string()))?;
        let account_types: HashMap<String, String> = accounts
            .into_iter()
            .filter(|a| account_supports_purpose(&a.account_type, AccountPurpose::Spending))
            .map(|a| (a.id, a.account_type))
            .collect();
        if account_types.is_empty() {
            return Ok(HashMap::new());
        }
        let account_ids = account_types.keys().cloned().collect::<Vec<_>>();
        let (start, _) = local_month_bounds_utc(start_period, timezone)?;
        let (_, end) = local_month_bounds_utc(end_period, timezone)?;
        let activities = self
            .activity_repo
            .get_activities_by_account_ids_in_date_range(&account_ids, start, end)
            .map_err(|e| anyhow!(e.to_string()))?
            .into_iter()
            .collect::<Vec<_>>();
        let activity_ids = activities.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
        let assignments = self
            .assignment_repo
            .list_for_activities(&activity_ids)
            .await?;
        let assignments_by_activity = group_assignments(assignments);
        let splits_by_activity =
            group_splits(self.split_repo.list_for_activities(&activity_ids).await?);

        // FX: one as_of date for the entire window (end of the latest month
        // covered). Mirrors net_worth / insight snapshot convention so all
        // months in this window get the same rate per pair.
        let fx_as_of = local_month_end_date(end_period, timezone)?;
        let fx = self.fx_service.as_ref();
        let mut actuals: HashMap<String, MonthActuals> = HashMap::new();
        for activity in activities {
            let Some(account_type) = account_types.get(&activity.account_id) else {
                continue;
            };
            let classification = classify_activity(&activity, account_type);
            let amount = activity_abs_amount(&activity);
            let spending_native = classification.spending_amount(amount);
            let income_native = classification.income_amount(amount);
            if spending_native == Decimal::ZERO && income_native == Decimal::ZERO {
                continue;
            }
            // Bucket by user-local month so a midnight-local activity on
            // month boundaries lands in the month the user perceives,
            // mirroring insight::compute_by_month.
            let month = period_key_for_date_in_tz(activity.activity_date, timezone);
            let month_actuals = actuals.entry(month).or_default();
            add_allocated_actuals(
                month_actuals,
                &activity.id,
                SPENDING_TAXONOMY,
                spending_native,
                spending_meta,
                &assignments_by_activity,
                &splits_by_activity,
                fx,
                &activity.currency,
                currency,
                fx_as_of,
            );
            add_allocated_actuals(
                month_actuals,
                &activity.id,
                INCOME_TAXONOMY,
                income_native,
                income_meta,
                &assignments_by_activity,
                &splits_by_activity,
                fx,
                &activity.currency,
                currency,
                fx_as_of,
            );
        }
        Ok(actuals)
    }
}

#[allow(clippy::too_many_arguments)]
fn add_allocated_actuals(
    month_actuals: &mut MonthActuals,
    activity_id: &str,
    taxonomy_id: &str,
    amount: Decimal,
    meta: &HashMap<String, Category>,
    assignments_by_activity: &crate::activity_allocations::AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
    fx: &dyn wealthfolio_core::fx::FxServiceTrait,
    from_currency: &str,
    target_currency: &str,
    fx_as_of: NaiveDate,
) {
    for allocation in allocations_for_taxonomy(
        activity_id,
        taxonomy_id,
        amount,
        assignments_by_activity,
        splits_by_activity,
    ) {
        let amount = fx_to_target(
            fx,
            allocation.amount,
            from_currency,
            target_currency,
            fx_as_of,
        )
        .unwrap_or(Decimal::ZERO);
        if amount == Decimal::ZERO {
            continue;
        }
        let top_id = top_category_id(&allocation.category_id, meta);
        *month_actuals
            .entry((taxonomy_id.to_string(), top_id))
            .or_insert(Decimal::ZERO) += amount;
    }
}

pub(crate) struct TargetIndex<'a> {
    targets: &'a [BudgetTarget],
}

impl<'a> TargetIndex<'a> {
    pub(crate) fn new(targets: &'a [BudgetTarget]) -> Self {
        Self { targets }
    }

    pub(crate) fn effective_category_decimal(
        &self,
        period: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Decimal {
        self.month_category(period, taxonomy_id, category_id)
            .or_else(|| self.default_category(taxonomy_id, category_id))
            .map(parse_amount)
            .unwrap_or(Decimal::ZERO)
    }

    pub(crate) fn effective_group_buffer_decimal(&self, period: &str, group_id: &str) -> Decimal {
        self.month_group_buffer(period, group_id)
            .or_else(|| self.default_group_buffer(group_id))
            .map(parse_amount)
            .unwrap_or(Decimal::ZERO)
    }

    pub(crate) fn has_default_category(&self, taxonomy_id: &str, category_id: &str) -> bool {
        self.default_category(taxonomy_id, category_id).is_some()
    }

    pub(crate) fn has_month_category(
        &self,
        period: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> bool {
        self.month_category(period, taxonomy_id, category_id)
            .is_some()
    }

    pub(crate) fn has_month_group_buffer(&self, period: &str, group_id: &str) -> bool {
        self.month_group_buffer(period, group_id).is_some()
    }

    fn month_category(&self, period: &str, taxonomy_id: &str, category_id: &str) -> Option<&str> {
        self.targets
            .iter()
            .find(|t| {
                matches!(t.target_type, BudgetTargetType::Category)
                    && t.period_key == period
                    && t.taxonomy_id.as_deref() == Some(taxonomy_id)
                    && t.category_id.as_deref() == Some(category_id)
            })
            .map(|t| t.amount.as_str())
    }

    fn default_category(&self, taxonomy_id: &str, category_id: &str) -> Option<&str> {
        self.month_category(DEFAULT_PERIOD_KEY, taxonomy_id, category_id)
    }

    fn month_group_buffer(&self, period: &str, group_id: &str) -> Option<&str> {
        self.targets
            .iter()
            .find(|t| {
                matches!(t.target_type, BudgetTargetType::GroupBuffer)
                    && t.period_key == period
                    && t.group_id.as_deref() == Some(group_id)
            })
            .map(|t| t.amount.as_str())
    }

    fn default_group_buffer(&self, group_id: &str) -> Option<&str> {
        self.month_group_buffer(DEFAULT_PERIOD_KEY, group_id)
    }
}

struct RolloverIndex<'a> {
    settings: &'a [BudgetRolloverSetting],
}

impl<'a> RolloverIndex<'a> {
    fn new(settings: &'a [BudgetRolloverSetting]) -> Self {
        Self { settings }
    }

    fn category(&self, taxonomy_id: &str, category_id: &str) -> Option<&'a BudgetRolloverSetting> {
        self.settings.iter().find(|s| {
            s.enabled
                && matches!(s.target_type, BudgetRolloverTargetType::Category)
                && s.taxonomy_id.as_deref() == Some(taxonomy_id)
                && s.category_id.as_deref() == Some(category_id)
        })
    }

    fn group(&self, group_id: &str) -> Option<&'a BudgetRolloverSetting> {
        self.settings.iter().find(|s| {
            s.enabled
                && matches!(s.target_type, BudgetRolloverTargetType::Group)
                && s.group_id.as_deref() == Some(group_id)
        })
    }
}

fn compute_rollover_for_month(
    setting: &BudgetRolloverSetting,
    period_key: &str,
    target_for_month: impl Fn(&str) -> Decimal,
    actual_for_month: impl Fn(&str) -> Decimal,
) -> (Decimal, Decimal, Decimal) {
    if setting.start_month.as_str() > period_key {
        let target = target_for_month(period_key);
        let actual = actual_for_month(period_key);
        return (Decimal::ZERO, Decimal::ZERO, target - actual);
    }
    let mut carry = parse_amount(&setting.starting_balance);
    for month in month_keys_between(&setting.start_month, period_key) {
        let rollover_in = carry;
        let target = target_for_month(&month);
        let actual = actual_for_month(&month);
        let rollover_out = rollover_in + target - actual;
        if month == period_key {
            return (rollover_in, rollover_out, rollover_in + target - actual);
        }
        carry = rollover_out;
    }
    (
        Decimal::ZERO,
        Decimal::ZERO,
        target_for_month(period_key) - actual_for_month(period_key),
    )
}

fn default_group_inputs() -> Vec<NewBudgetGroup> {
    DEFAULT_GROUPS
        .iter()
        .map(|g| NewBudgetGroup {
            id: Some(g.id.to_string()),
            name: g.name.to_string(),
            key: Some(g.key.to_string()),
            color: Some(g.color.to_string()),
            icon: Some(g.icon.to_string()),
            sort_order: Some(g.sort_order),
            is_system: true,
        })
        .collect()
}

fn default_assignment_inputs(
    group_by_key: &HashMap<String, String>,
) -> Vec<NewBudgetGroupAssignment> {
    DEFAULT_ASSIGNMENTS
        .iter()
        .filter_map(|assignment| {
            group_by_key
                .get(assignment.group_key)
                .map(|group_id| NewBudgetGroupAssignment {
                    id: Some(assignment.id.to_string()),
                    group_id: group_id.clone(),
                    taxonomy_id: if assignment.category_id == "cat_savings" {
                        SAVINGS_TAXONOMY
                    } else {
                        SPENDING_TAXONOMY
                    }
                    .to_string(),
                    category_id: assignment.category_id.to_string(),
                })
        })
        .collect()
}

pub(crate) fn category_meta(categories: &[Category]) -> HashMap<String, Category> {
    categories
        .iter()
        .map(|c| (c.id.clone(), c.clone()))
        .collect()
}

pub(crate) fn top_level_categories(categories: &[Category]) -> Vec<Category> {
    let mut categories = categories
        .iter()
        .filter(|c| c.parent_id.is_none())
        .cloned()
        .collect::<Vec<_>>();
    categories.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.name.cmp(&b.name)));
    categories
}

pub(crate) fn resolve_group_for_category(
    category_id: &str,
    assignment_by_category: &HashMap<String, String>,
    category_meta: &HashMap<String, Category>,
    other_group_id: &str,
) -> String {
    let mut current = Some(category_id.to_string());
    while let Some(id) = current {
        if let Some(group_id) = assignment_by_category.get(&id) {
            return group_id.clone();
        }
        current = category_meta.get(&id).and_then(|c| c.parent_id.clone());
    }
    other_group_id.to_string()
}

pub(crate) fn top_category_id(category_id: &str, meta: &HashMap<String, Category>) -> String {
    let mut current = category_id.to_string();
    // Guard against a corrupted taxonomy with a cyclic parent_id chain: bound
    // the walk to a depth far above any realistic hierarchy depth (the seeded
    // taxonomies are 2 levels deep). Without the bound, a `parent_id` loop
    // would hang the entire request thread.
    const MAX_DEPTH: usize = 32;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(current.clone());
    for _ in 0..MAX_DEPTH {
        match meta.get(&current).and_then(|c| c.parent_id.clone()) {
            Some(parent_id) if !seen.contains(&parent_id) => {
                seen.insert(parent_id.clone());
                current = parent_id;
            }
            _ => break,
        }
    }
    current
}

/// Parse a string-encoded decimal amount. Garbage input degrades to
/// 0.0 (callers treat that as "no budget set"), but log a warning so a
/// corrupted row is at least visible in operator logs.
fn parse_amount(value: &str) -> Decimal {
    match Decimal::from_str(value) {
        Ok(n) => n,
        Err(_) => {
            log::warn!(
                "budget parse_amount: ignoring non-numeric amount {:?} (treating as 0.0)",
                value
            );
            Decimal::ZERO
        }
    }
}

fn validate_decimal_amount(value: &str, field_name: &str) -> Result<()> {
    Decimal::from_str(value)
        .map(|_| ())
        .map_err(|_| invalid_budget_input(&format!("Invalid {field_name} amount")))
}

fn normalize_period_key(period_key: Option<String>, timezone: &str) -> Result<String> {
    match period_key {
        Some(key) if key == DEFAULT_PERIOD_KEY => Ok(key),
        Some(key) => {
            validate_month_key(&key)?;
            Ok(key)
        }
        None => Ok(period_key_for_date_in_tz(Utc::now(), timezone)),
    }
}

fn validate_period_key(period_key: &str) -> Result<()> {
    if period_key == DEFAULT_PERIOD_KEY {
        Ok(())
    } else {
        validate_month_key(period_key)
    }
}

fn validate_budget_target(target: &NewBudgetTarget) -> Result<()> {
    validate_decimal_amount(&target.amount, "budget target")?;

    match target.target_type {
        BudgetTargetType::Category => {
            if target.taxonomy_id.as_deref().unwrap_or_default().is_empty()
                || target.category_id.as_deref().unwrap_or_default().is_empty()
                || target.group_id.is_some()
            {
                return Err(invalid_budget_input(
                    "Category target requires taxonomyId and categoryId only",
                ));
            }
        }
        BudgetTargetType::GroupBuffer => {
            if target.group_id.as_deref().unwrap_or_default().is_empty()
                || target.taxonomy_id.is_some()
                || target.category_id.is_some()
            {
                return Err(invalid_budget_input(
                    "Group buffer target requires groupId only",
                ));
            }
        }
    }
    Ok(())
}

fn validate_rollover_setting(setting: &NewBudgetRolloverSetting) -> Result<()> {
    validate_decimal_amount(&setting.starting_balance, "rollover starting balance")?;

    match setting.target_type {
        BudgetRolloverTargetType::Category => {
            if setting.taxonomy_id.as_deref() != Some(SPENDING_TAXONOMY)
                || setting
                    .category_id
                    .as_deref()
                    .unwrap_or_default()
                    .is_empty()
                || setting.group_id.is_some()
            {
                return Err(invalid_budget_input(
                    "Category rollover requires spending taxonomyId and categoryId only",
                ));
            }
        }
        BudgetRolloverTargetType::Group => {
            if setting.group_id.as_deref().unwrap_or_default().is_empty()
                || setting.taxonomy_id.is_some()
                || setting.category_id.is_some()
            {
                return Err(invalid_budget_input("Group rollover requires groupId only"));
            }
        }
    }
    Ok(())
}

fn invalid_budget_input(message: &str) -> anyhow::Error {
    SpendingError::InvalidInput {
        message: message.to_string(),
    }
    .into()
}

fn validate_month_key(period_key: &str) -> Result<()> {
    if period_key.len() != 7 {
        return Err(invalid_budget_input("Invalid budget period key"));
    }
    if &period_key[4..5] != "-" {
        return Err(invalid_budget_input("Invalid budget period key"));
    }
    let year = period_key[0..4]
        .parse::<i32>()
        .map_err(|_| invalid_budget_input("Invalid budget period key"))?;
    let month = period_key[5..7]
        .parse::<u32>()
        .map_err(|_| invalid_budget_input("Invalid budget period key"))?;
    if !(1..=12).contains(&month) {
        return Err(invalid_budget_input("Invalid budget period key"));
    }
    NaiveDate::from_ymd_opt(year, month, 1)
        .ok_or_else(|| invalid_budget_input("Invalid budget period key"))?;
    Ok(())
}

fn period_key_for_date_in_tz(date: DateTime<Utc>, timezone: &str) -> String {
    let d = wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(date, timezone);
    format!("{:04}-{:02}", d.year(), d.month())
}

/// Convert a native amount to the budget's target currency at `as_of`.
/// Mirrors `insight::service::fx_to_target` and `analytics::service::fx_to_target`
/// — same convention (one rate per report, snapshot-date style) so all three
/// services agree. Same-currency short-circuit; on FxService error, returns
/// None so callers exclude the native amount instead of mixing currencies into
/// the target total.
fn fx_to_target(
    fx: &dyn wealthfolio_core::fx::FxServiceTrait,
    amount: Decimal,
    from: &str,
    to: &str,
    as_of: NaiveDate,
) -> Option<Decimal> {
    if amount == Decimal::ZERO || from == to || from.is_empty() {
        return Some(amount);
    }
    match fx.convert_currency_for_date(amount, from, to, as_of) {
        Ok(converted) => Some(converted),
        Err(e) => {
            log::warn!(
                "spending budget FX conversion {}→{} on {} failed ({}); excluding native amount",
                from,
                to,
                as_of,
                e,
            );
            None
        }
    }
}

fn month_end(period_key: &str) -> Result<DateTime<Utc>> {
    let (year, month) = parse_month(period_key)?;
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    Ok(Utc
        .with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0)
        .single()
        .ok_or_else(|| invalid_budget_input("Invalid budget period key"))?
        - chrono::Duration::milliseconds(1))
}

fn local_month_bounds_utc(
    period_key: &str,
    timezone: &str,
) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let (year, month) = parse_month(period_key)?;
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let tz = wealthfolio_core::utils::time_utils::parse_user_timezone_or_default(timezone);
    let start = tz
        .with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .earliest()
        .ok_or_else(|| invalid_budget_input("Invalid budget period key"))?
        .with_timezone(&Utc);
    let next_start = tz
        .with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0)
        .earliest()
        .ok_or_else(|| invalid_budget_input("Invalid budget period key"))?
        .with_timezone(&Utc);
    Ok((start, next_start - chrono::Duration::nanoseconds(1)))
}

fn local_month_end_date(period_key: &str, timezone: &str) -> Result<NaiveDate> {
    let (_, end) = local_month_bounds_utc(period_key, timezone)?;
    Ok(wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(end, timezone))
}

fn month_keys_between(start: &str, end: &str) -> Vec<String> {
    let Ok((mut year, mut month)) = parse_month(start) else {
        return Vec::new();
    };
    let Ok((end_year, end_month)) = parse_month(end) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while year < end_year || (year == end_year && month <= end_month) {
        out.push(format!("{:04}-{:02}", year, month));
        if month == 12 {
            year += 1;
            month = 1;
        } else {
            month += 1;
        }
    }
    out
}

fn parse_month(period_key: &str) -> Result<(i32, u32)> {
    validate_month_key(period_key)?;
    let year = period_key[0..4]
        .parse()
        .map_err(|_| invalid_budget_input("Invalid budget period key"))?;
    let month = period_key[5..7]
        .parse()
        .map_err(|_| invalid_budget_input("Invalid budget period key"))?;
    Ok((year, month))
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, NaiveDateTime};

    use super::*;

    fn ts() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    }

    fn target(
        period_key: &str,
        target_type: BudgetTargetType,
        taxonomy_id: Option<&str>,
        category_id: Option<&str>,
        group_id: Option<&str>,
        amount: &str,
    ) -> BudgetTarget {
        BudgetTarget {
            id: format!(
                "{}-{}-{}",
                period_key,
                category_id.or(group_id).unwrap_or("target"),
                amount
            ),
            period_key: period_key.to_string(),
            target_type,
            taxonomy_id: taxonomy_id.map(str::to_string),
            category_id: category_id.map(str::to_string),
            group_id: group_id.map(str::to_string),
            amount: amount.to_string(),
            created_at: ts(),
            updated_at: ts(),
        }
    }

    fn rollover_setting(start_month: &str, starting_balance: &str) -> BudgetRolloverSetting {
        BudgetRolloverSetting {
            id: "rollover".to_string(),
            target_type: BudgetRolloverTargetType::Category,
            taxonomy_id: Some(SPENDING_TAXONOMY.to_string()),
            category_id: Some("cat_groceries".to_string()),
            group_id: None,
            enabled: true,
            start_month: start_month.to_string(),
            starting_balance: starting_balance.to_string(),
            created_at: ts(),
            updated_at: ts(),
        }
    }

    #[test]
    fn seeded_groups_use_savings_label() {
        let names = DEFAULT_GROUPS.iter().map(|g| g.name).collect::<Vec<_>>();

        assert!(names.contains(&"Savings"));
        assert!(!names.contains(&"Saving & Investment"));
        assert!(!names.contains(&"Saving & Investments"));
    }

    #[test]
    fn seeded_budget_group_sync_ids_are_uuids() {
        for group in DEFAULT_GROUPS {
            uuid::Uuid::parse_str(group.id).unwrap();
        }
        for assignment in DEFAULT_ASSIGNMENTS {
            uuid::Uuid::parse_str(assignment.id).unwrap();
        }
    }

    #[test]
    fn default_savings_assignment_uses_savings_taxonomy() {
        let group_by_key = DEFAULT_GROUPS
            .iter()
            .map(|g| (g.key.to_string(), g.id.to_string()))
            .collect::<HashMap<_, _>>();
        let assignments = default_assignment_inputs(&group_by_key);
        let savings = assignments
            .iter()
            .find(|a| a.category_id == "cat_savings")
            .expect("seeded savings assignment");

        assert_eq!(savings.taxonomy_id, SAVINGS_TAXONOMY);
    }

    #[test]
    fn validates_budget_target_decimal_amount() {
        let target = NewBudgetTarget {
            id: None,
            period_key: DEFAULT_PERIOD_KEY.to_string(),
            target_type: BudgetTargetType::Category,
            taxonomy_id: Some(SPENDING_TAXONOMY.to_string()),
            category_id: Some("cat_groceries".to_string()),
            group_id: None,
            amount: "not-a-number".to_string(),
        };

        assert!(validate_budget_target(&target).is_err());
    }

    #[test]
    fn validates_rollover_starting_balance_decimal_amount() {
        let setting = NewBudgetRolloverSetting {
            id: None,
            target_type: BudgetRolloverTargetType::Category,
            taxonomy_id: Some(SPENDING_TAXONOMY.to_string()),
            category_id: Some("cat_groceries".to_string()),
            group_id: None,
            enabled: true,
            start_month: "2026-01".to_string(),
            starting_balance: "bad-balance".to_string(),
        };

        assert!(validate_rollover_setting(&setting).is_err());
    }

    #[test]
    fn target_index_uses_sparse_month_overrides_over_defaults() {
        let targets = vec![
            target(
                DEFAULT_PERIOD_KEY,
                BudgetTargetType::Category,
                Some(SPENDING_TAXONOMY),
                Some("cat_groceries"),
                None,
                "200",
            ),
            target(
                "2026-03",
                BudgetTargetType::Category,
                Some(SPENDING_TAXONOMY),
                Some("cat_groceries"),
                None,
                "300",
            ),
            target(
                DEFAULT_PERIOD_KEY,
                BudgetTargetType::GroupBuffer,
                None,
                None,
                Some(BUDGET_GROUP_NEEDS_ID),
                "500",
            ),
        ];
        let index = TargetIndex::new(&targets);

        assert_eq!(
            index.effective_category_decimal("2026-03", SPENDING_TAXONOMY, "cat_groceries"),
            Decimal::new(300, 0)
        );
        assert_eq!(
            index.effective_category_decimal("2026-04", SPENDING_TAXONOMY, "cat_groceries"),
            Decimal::new(200, 0)
        );
        assert_eq!(
            index.effective_category_decimal("2026-04", SPENDING_TAXONOMY, "cat_travel"),
            Decimal::ZERO
        );
        assert_eq!(
            index.effective_group_buffer_decimal("2026-04", BUDGET_GROUP_NEEDS_ID),
            Decimal::new(500, 0)
        );
        assert!(index.has_default_category(SPENDING_TAXONOMY, "cat_groceries"));
        assert!(index.has_month_category("2026-03", SPENDING_TAXONOMY, "cat_groceries"));
    }

    #[test]
    fn rollover_ignores_months_before_future_start_month() {
        let setting = rollover_setting("2026-06", "25");

        let (rollover_in, rollover_out, remaining) = compute_rollover_for_month(
            &setting,
            "2026-05",
            |_| Decimal::new(100, 0),
            |_| Decimal::new(40, 0),
        );

        assert_eq!(rollover_in, Decimal::ZERO);
        assert_eq!(rollover_out, Decimal::ZERO);
        assert_eq!(remaining, Decimal::new(60, 0));
    }

    #[test]
    fn rollover_recomputes_multi_year_chain_from_start_month() {
        let setting = rollover_setting("2025-01", "10");

        let (rollover_in, rollover_out, remaining) = compute_rollover_for_month(
            &setting,
            "2026-05",
            |_| Decimal::new(100, 0),
            |month| match month {
                "2025-01" => Decimal::new(25, 0),
                "2026-05" => Decimal::new(40, 0),
                _ => Decimal::ZERO,
            },
        );

        assert_eq!(rollover_in, Decimal::new(1585, 0));
        assert_eq!(rollover_out, Decimal::new(1645, 0));
        assert_eq!(remaining, Decimal::new(1645, 0));
    }

    #[test]
    fn missing_target_with_spending_creates_negative_remaining() {
        let setting = rollover_setting("2026-05", "0");

        let (rollover_in, rollover_out, remaining) = compute_rollover_for_month(
            &setting,
            "2026-05",
            |_| Decimal::ZERO,
            |_| Decimal::new(30, 0),
        );

        assert_eq!(rollover_in, Decimal::ZERO);
        assert_eq!(rollover_out, Decimal::new(-30, 0));
        assert_eq!(remaining, Decimal::new(-30, 0));
    }

    #[test]
    fn refund_month_increases_remaining() {
        let setting = rollover_setting("2026-05", "0");

        let (rollover_in, rollover_out, remaining) = compute_rollover_for_month(
            &setting,
            "2026-05",
            |_| Decimal::new(100, 0),
            |_| Decimal::new(-25, 0),
        );

        assert_eq!(rollover_in, Decimal::ZERO);
        assert_eq!(rollover_out, Decimal::new(125, 0));
        assert_eq!(remaining, Decimal::new(125, 0));
    }

    #[test]
    fn month_keys_are_strictly_validated() {
        assert!(validate_period_key(DEFAULT_PERIOD_KEY).is_ok());
        assert!(validate_period_key("2026-05").is_ok());
        assert!(validate_period_key("2026-13").is_err());
        assert!(validate_period_key("2026-5").is_err());
    }

    #[test]
    fn local_month_bounds_follow_user_timezone() {
        let (start, end) = local_month_bounds_utc("2026-05", "America/Toronto").unwrap();

        assert_eq!(start.to_rfc3339(), "2026-05-01T04:00:00+00:00");
        assert_eq!(end.to_rfc3339(), "2026-06-01T03:59:59.999999999+00:00");
        assert_eq!(
            period_key_for_date_in_tz(start - chrono::Duration::milliseconds(1), "America/Toronto"),
            "2026-04"
        );
        assert_eq!(
            period_key_for_date_in_tz(start, "America/Toronto"),
            "2026-05"
        );
        assert_eq!(period_key_for_date_in_tz(end, "America/Toronto"), "2026-05");
    }

    #[test]
    fn local_month_end_date_uses_user_calendar_date() {
        assert_eq!(
            local_month_end_date("2026-05", "America/Toronto").unwrap(),
            NaiveDate::from_ymd_opt(2026, 5, 31).unwrap()
        );
        assert_eq!(
            local_month_end_date("2026-05", "Asia/Tokyo").unwrap(),
            NaiveDate::from_ymd_opt(2026, 5, 31).unwrap()
        );
    }
}
