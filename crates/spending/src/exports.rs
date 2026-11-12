//! Spending datasets of the data export: activity categories, budgets, rules
//! and events, read as stored rather than through the spending settings.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use wealthfolio_core::accounts::AccountServiceTrait;
use wealthfolio_core::exports::{ActivitySpendingColumns, ExportRecord, SpendingExportSource};
use wealthfolio_core::taxonomies::TaxonomyServiceTrait;

use crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait;
use crate::activity_events::ActivityEventsRepositoryTrait;
use crate::activity_splits::ActivitySplitRepositoryTrait;
use crate::analytics::{AnalyticsServiceTrait, EventSummariesRequest};
use crate::budget::model::{BudgetCategoryRow, BudgetRolloverSetting, BudgetTarget};
use crate::budget::model::{BudgetRolloverTargetType, BudgetTargetType};
use crate::budget::{BudgetRepositoryTrait, BudgetServiceTrait};
use crate::categorization_rules::CategorizationRulesServiceTrait;
use crate::events::EventsServiceTrait;
use crate::CalculationQuality;

/// Ids per repository call, under SQLite's parameter cap.
const ID_CHUNK: usize = 500;

fn core_error(error: anyhow::Error) -> wealthfolio_core::Error {
    wealthfolio_core::Error::Unexpected(error.to_string())
}

/// Category names as "Parent / Child" paths, by id.
struct CategoryPaths(HashMap<String, (String, Option<String>)>);

impl CategoryPaths {
    fn path(&self, id: &str) -> Option<String> {
        let (name, parent) = self.0.get(id)?;
        let mut path = name.clone();
        let mut next = parent.clone();
        // Taxonomies are shallow; the bound only guards against a cycle.
        for _ in 0..8 {
            let Some(parent_id) = next else { break };
            let Some((parent_name, grandparent)) = self.0.get(&parent_id) else {
                break;
            };
            path = format!("{parent_name} / {path}");
            next = grandparent.clone();
        }
        Some(path)
    }
}

pub struct SpendingDataExportSource {
    taxonomies: Arc<dyn TaxonomyServiceTrait>,
    accounts: Arc<dyn AccountServiceTrait>,
    assignments: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
    splits: Arc<dyn ActivitySplitRepositoryTrait>,
    activity_events: Arc<dyn ActivityEventsRepositoryTrait>,
    events: Arc<dyn EventsServiceTrait>,
    budgets: Arc<dyn BudgetRepositoryTrait>,
    budget_service: Arc<dyn BudgetServiceTrait>,
    analytics: Arc<dyn AnalyticsServiceTrait>,
    rules: Arc<dyn CategorizationRulesServiceTrait>,
}

impl SpendingDataExportSource {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        taxonomies: Arc<dyn TaxonomyServiceTrait>,
        accounts: Arc<dyn AccountServiceTrait>,
        assignments: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        splits: Arc<dyn ActivitySplitRepositoryTrait>,
        activity_events: Arc<dyn ActivityEventsRepositoryTrait>,
        events: Arc<dyn EventsServiceTrait>,
        budgets: Arc<dyn BudgetRepositoryTrait>,
        budget_service: Arc<dyn BudgetServiceTrait>,
        analytics: Arc<dyn AnalyticsServiceTrait>,
        rules: Arc<dyn CategorizationRulesServiceTrait>,
    ) -> Self {
        Self {
            taxonomies,
            accounts,
            assignments,
            splits,
            activity_events,
            events,
            budgets,
            budget_service,
            analytics,
            rules,
        }
    }

    fn category_paths(&self) -> wealthfolio_core::Result<CategoryPaths> {
        let mut paths = HashMap::new();
        for taxonomy in self.taxonomies.get_taxonomies_with_categories()? {
            for category in taxonomy.categories {
                paths.insert(category.id, (category.name, category.parent_id));
            }
        }
        Ok(CategoryPaths(paths))
    }

    async fn event_names(&self) -> wealthfolio_core::Result<HashMap<String, String>> {
        Ok(self
            .events
            .list_events()
            .await
            .map_err(core_error)?
            .into_iter()
            .map(|event| (event.id, event.name))
            .collect())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitCell {
    category: Option<String>,
    category_id: String,
    amount: rust_decimal::Decimal,
    note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BudgetRow {
    /// Empty for a rollover setting that has no budget amount.
    period_key: Option<String>,
    target_type: BudgetTargetType,
    category: Option<String>,
    category_id: Option<String>,
    group: Option<String>,
    group_id: Option<String>,
    amount: Option<String>,
    rollover_enabled: Option<bool>,
    rollover_start_month: Option<String>,
    rollover_starting_balance: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BudgetGroupRow {
    id: String,
    name: String,
    key: String,
    color: Option<String>,
    icon: Option<String>,
    sort_order: i32,
    is_system: bool,
    categories: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventRow {
    id: String,
    name: String,
    event_type: Option<String>,
    start_date: String,
    end_date: String,
    description: Option<String>,
    activity_count: usize,
    total_spent: Option<f64>,
    currency: String,
    /// Transactions left out of the total because no exchange rate was found.
    missing_fx_transactions: usize,
    missing_fx_currencies: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BudgetActualRow {
    month: String,
    kind: &'static str,
    group: Option<String>,
    category: String,
    category_id: String,
    budgeted: f64,
    spent: f64,
    rollover_in: f64,
    rollover_out: f64,
    remaining: f64,
    overspent: bool,
    currency: String,
    /// The month's transactions left out for want of an exchange rate.
    missing_fx_transactions: usize,
    missing_fx_currencies: String,
    /// On group rows: the amount budgeted for the group beyond its categories.
    group_buffer: Option<f64>,
}

#[async_trait]
impl SpendingExportSource for SpendingDataExportSource {
    async fn activity_spending(
        &self,
        activity_ids: &[String],
    ) -> wealthfolio_core::Result<HashMap<String, ActivitySpendingColumns>> {
        let paths = self.category_paths()?;
        let event_names = self.event_names().await?;
        let mut columns: HashMap<String, ActivitySpendingColumns> = HashMap::new();
        for chunk in activity_ids.chunks(ID_CHUNK) {
            let mut assignments = self
                .assignments
                .list_for_activities(chunk)
                .await
                .map_err(core_error)?;
            assignments
                .sort_by(|a, b| (&a.activity_id, -a.weight).cmp(&(&b.activity_id, -b.weight)));
            for assignment in assignments {
                let entry = columns.entry(assignment.activity_id.clone()).or_default();
                let name = paths
                    .path(&assignment.category_id)
                    .unwrap_or_else(|| assignment.category_id.clone());
                entry.category = Some(match entry.category.take() {
                    Some(existing) => format!("{existing}; {name}"),
                    None => name,
                });
                entry.category_id = Some(match entry.category_id.take() {
                    Some(existing) => format!("{existing}; {}", assignment.category_id),
                    None => assignment.category_id,
                });
            }

            let mut splits = self
                .splits
                .list_for_activities(chunk)
                .await
                .map_err(core_error)?;
            splits.sort_by(|a, b| {
                (&a.activity_id, a.sort_order).cmp(&(&b.activity_id, b.sort_order))
            });
            let mut by_activity: HashMap<String, Vec<SplitCell>> = HashMap::new();
            for split in splits {
                by_activity
                    .entry(split.activity_id.clone())
                    .or_default()
                    .push(SplitCell {
                        category: paths.path(&split.category_id),
                        category_id: split.category_id,
                        amount: split.amount,
                        note: split.note,
                    });
            }
            for (activity_id, cells) in by_activity {
                columns.entry(activity_id).or_default().splits =
                    Some(serde_json::to_value(cells).unwrap_or(Value::Null));
            }

            let tags = self
                .activity_events
                .list_for_activities(chunk)
                .await
                .map_err(core_error)?;
            for (activity_id, event_id) in tags {
                columns.entry(activity_id).or_default().event =
                    Some(event_names.get(&event_id).cloned().unwrap_or(event_id));
            }
        }
        Ok(columns)
    }

    async fn budget_rows(&self) -> wealthfolio_core::Result<Vec<ExportRecord>> {
        let paths = self.category_paths()?;
        let groups = self
            .budgets
            .list_groups()
            .await
            .map_err(core_error)?
            .into_iter()
            .map(|group| (group.id, group.name))
            .collect::<HashMap<_, _>>();
        let rollovers = self
            .budgets
            .list_rollover_settings()
            .await
            .map_err(core_error)?;
        let targets = self.budgets.list_targets().await.map_err(core_error)?;
        let rows = budget_rows_from(targets, &rollovers, &paths, &groups);
        ExportRecord::from_records(&rows)
    }

    async fn budget_group_rows(&self) -> wealthfolio_core::Result<Vec<ExportRecord>> {
        let paths = self.category_paths()?;
        let assignments = self
            .budgets
            .list_group_assignments()
            .await
            .map_err(core_error)?;
        let mut groups = self.budgets.list_groups().await.map_err(core_error)?;
        groups.sort_by_key(|group| group.sort_order);
        let rows = groups
            .into_iter()
            .map(|group| {
                let mut categories = assignments
                    .iter()
                    .filter(|assignment| assignment.group_id == group.id)
                    .map(|assignment| {
                        paths
                            .path(&assignment.category_id)
                            .unwrap_or_else(|| assignment.category_id.clone())
                    })
                    .collect::<Vec<_>>();
                categories.sort();
                BudgetGroupRow {
                    id: group.id,
                    name: group.name,
                    key: group.key,
                    color: group.color,
                    icon: group.icon,
                    sort_order: group.sort_order,
                    is_system: group.is_system,
                    categories: categories.join("; "),
                }
            })
            .collect::<Vec<_>>();
        ExportRecord::from_records(&rows)
    }

    async fn rule_rows(&self) -> wealthfolio_core::Result<Vec<ExportRecord>> {
        let paths = self.category_paths()?;
        let accounts = self
            .accounts
            .get_all_accounts()?
            .into_iter()
            .map(|account| (account.id, account.name))
            .collect::<HashMap<_, _>>();
        let mut rules = self.rules.list().await.map_err(core_error)?;
        rules.sort_by(|a, b| (a.priority, &a.name).cmp(&(b.priority, &b.name)));
        rules
            .iter()
            .map(|rule| {
                Ok(ExportRecord::from_record(rule)?
                    .with(
                        "category",
                        rule.category_id.as_deref().and_then(|id| paths.path(id)),
                    )
                    .with(
                        "accountName",
                        rule.account_id
                            .as_ref()
                            .and_then(|id| accounts.get(id).cloned()),
                    ))
            })
            .collect()
    }

    async fn budget_actual_rows(
        &self,
        months: &[String],
        currency: &str,
        timezone: &str,
    ) -> wealthfolio_core::Result<Vec<ExportRecord>> {
        let mut rows = Vec::new();
        for month in months {
            let snapshot = self
                .budget_service
                .get_readonly(Some(month.clone()), currency, timezone)
                .await
                .map_err(core_error)?;
            let computed = snapshot.computed;
            let row = |kind: &'static str, group: Option<String>, category: &BudgetCategoryRow| {
                BudgetActualRow {
                    month: computed.period_key.clone(),
                    kind,
                    group,
                    category: category.name.clone(),
                    category_id: category.category_id.clone(),
                    budgeted: category.target,
                    spent: category.actual,
                    rollover_in: category.rollover_in,
                    rollover_out: category.rollover_out,
                    remaining: category.remaining,
                    overspent: category.overspent,
                    currency: computed.currency.clone(),
                    missing_fx_transactions: computed.calculation_quality.missing_fx_transactions,
                    missing_fx_currencies: join_currencies(&computed.calculation_quality),
                    group_buffer: None,
                }
            };
            let grouped = computed.group_rows.iter().flat_map(|group| {
                group
                    .categories
                    .iter()
                    .map(move |category| (Some(group.group.name.clone()), category))
            });
            let ungrouped = computed
                .ungrouped_rows
                .iter()
                .map(|category| (None, category));
            // Each group's own totals: its buffer, planned amount and rollover.
            for group in &computed.group_rows {
                if group.planned_total != 0.0 || group.actual != 0.0 || group.rollover_in != 0.0 {
                    rows.push(BudgetActualRow {
                        month: computed.period_key.clone(),
                        kind: "group",
                        group: Some(group.group.name.clone()),
                        category: String::new(),
                        category_id: String::new(),
                        budgeted: group.planned_total,
                        spent: group.actual,
                        rollover_in: group.rollover_in,
                        rollover_out: group.rollover_out,
                        remaining: group.remaining,
                        overspent: group.overspent,
                        currency: computed.currency.clone(),
                        missing_fx_transactions: computed
                            .calculation_quality
                            .missing_fx_transactions,
                        missing_fx_currencies: join_currencies(&computed.calculation_quality),
                        group_buffer: Some(group.buffer),
                    });
                }
            }
            for (group, category) in grouped.chain(ungrouped) {
                if category.target != 0.0 || category.actual != 0.0 || category.rollover_in != 0.0 {
                    rows.push(row("spending", group, category));
                }
            }
            for category in &computed.income_rows {
                if category.target != 0.0 || category.actual != 0.0 {
                    rows.push(row("income", None, category));
                }
            }
        }
        ExportRecord::from_records(&rows)
    }

    async fn event_rows(
        &self,
        currency: &str,
        timezone: &str,
    ) -> wealthfolio_core::Result<Vec<ExportRecord>> {
        let totals = self
            .analytics
            .event_spending_summaries(
                EventSummariesRequest {
                    start_date: None,
                    end_date: None,
                    currency: Some(currency.to_string()),
                },
                timezone,
            )
            .await
            .map_err(core_error)?
            .into_iter()
            .map(|summary| {
                (
                    summary.event_id,
                    (summary.total_spending, summary.calculation_quality),
                )
            })
            .collect::<HashMap<_, _>>();
        let types = self
            .events
            .list_types()
            .await
            .map_err(core_error)?
            .into_iter()
            .map(|event_type| (event_type.id, event_type.name))
            .collect::<HashMap<_, _>>();
        let mut counts: HashMap<String, usize> = HashMap::new();
        for tag in self.activity_events.list_all().await.map_err(core_error)? {
            *counts.entry(tag.event_id).or_default() += 1;
        }
        let mut events = self.events.list_events().await.map_err(core_error)?;
        events.sort_by(|a, b| (&a.start_date, &a.name).cmp(&(&b.start_date, &b.name)));
        let rows = events
            .into_iter()
            .map(|event| EventRow {
                event_type: types.get(&event.event_type_id).cloned(),
                activity_count: counts.get(&event.id).copied().unwrap_or(0),
                total_spent: totals.get(&event.id).map(|(total, _)| *total),
                currency: currency.to_string(),
                missing_fx_transactions: totals
                    .get(&event.id)
                    .map_or(0, |(_, quality)| quality.missing_fx_transactions),
                missing_fx_currencies: totals
                    .get(&event.id)
                    .map(|(_, quality)| join_currencies(quality))
                    .unwrap_or_default(),
                id: event.id,
                name: event.name,
                start_date: event.start_date,
                end_date: event.end_date,
                description: event.description,
            })
            .collect::<Vec<_>>();
        ExportRecord::from_records(&rows)
    }
}

fn join_currencies(quality: &CalculationQuality) -> String {
    quality
        .missing_fx_currencies
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join("; ")
}

fn rollover_matches(
    target_type: &BudgetTargetType,
    category_id: &Option<String>,
    group_id: &Option<String>,
    setting: &BudgetRolloverSetting,
) -> bool {
    let same_type = matches!(
        (target_type, &setting.target_type),
        (
            BudgetTargetType::Category,
            BudgetRolloverTargetType::Category
        ) | (
            BudgetTargetType::GroupBuffer,
            BudgetRolloverTargetType::Group
        )
    );
    same_type && &setting.category_id == category_id && &setting.group_id == group_id
}

/// One row per budget amount with its rollover setting, then a row for each
/// rollover setting that has no amount, so no setting is dropped.
fn budget_rows_from(
    mut targets: Vec<BudgetTarget>,
    rollovers: &[BudgetRolloverSetting],
    paths: &CategoryPaths,
    groups: &HashMap<String, String>,
) -> Vec<BudgetRow> {
    targets.sort_by(|a, b| {
        (&a.period_key, &a.group_id, &a.category_id).cmp(&(
            &b.period_key,
            &b.group_id,
            &b.category_id,
        ))
    });
    let mut rows = targets
        .iter()
        .map(|target| {
            let rollover = rollovers.iter().find(|setting| {
                rollover_matches(
                    &target.target_type,
                    &target.category_id,
                    &target.group_id,
                    setting,
                )
            });
            BudgetRow {
                category: target.category_id.as_deref().and_then(|id| paths.path(id)),
                group: target
                    .group_id
                    .as_ref()
                    .and_then(|id| groups.get(id).cloned()),
                rollover_enabled: rollover.map(|setting| setting.enabled),
                rollover_start_month: rollover.map(|setting| setting.start_month.clone()),
                rollover_starting_balance: rollover.map(|setting| setting.starting_balance.clone()),
                period_key: Some(target.period_key.clone()),
                target_type: target.target_type.clone(),
                category_id: target.category_id.clone(),
                group_id: target.group_id.clone(),
                amount: Some(target.amount.clone()),
            }
        })
        .collect::<Vec<_>>();
    for setting in rollovers {
        let target_type = match setting.target_type {
            BudgetRolloverTargetType::Category => BudgetTargetType::Category,
            BudgetRolloverTargetType::Group => BudgetTargetType::GroupBuffer,
        };
        let has_target = targets.iter().any(|target| {
            rollover_matches(
                &target.target_type,
                &target.category_id,
                &target.group_id,
                setting,
            )
        });
        if has_target {
            continue;
        }
        rows.push(BudgetRow {
            category: setting.category_id.as_deref().and_then(|id| paths.path(id)),
            group: setting
                .group_id
                .as_ref()
                .and_then(|id| groups.get(id).cloned()),
            rollover_enabled: Some(setting.enabled),
            rollover_start_month: Some(setting.start_month.clone()),
            rollover_starting_balance: Some(setting.starting_balance.clone()),
            period_key: None,
            target_type,
            category_id: setting.category_id.clone(),
            group_id: setting.group_id.clone(),
            amount: None,
        });
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_paths_join_parents() {
        let paths = CategoryPaths(HashMap::from([
            ("food".to_string(), ("Food".to_string(), None)),
            (
                "groceries".to_string(),
                ("Groceries".to_string(), Some("food".to_string())),
            ),
        ]));
        assert_eq!(paths.path("groceries").as_deref(), Some("Food / Groceries"));
        assert_eq!(paths.path("food").as_deref(), Some("Food"));
        assert_eq!(paths.path("missing"), None);
    }

    #[test]
    fn budget_rows_keep_rollover_settings_without_a_budget_amount() {
        let at = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let target = BudgetTarget {
            id: "t1".into(),
            period_key: "2026-01".into(),
            target_type: BudgetTargetType::Category,
            taxonomy_id: Some("spending_categories".into()),
            category_id: Some("food".into()),
            group_id: None,
            amount: "300".into(),
            created_at: at,
            updated_at: at,
        };
        let setting =
            |id: &str, kind, category: Option<&str>, group: Option<&str>| BudgetRolloverSetting {
                id: id.into(),
                target_type: kind,
                taxonomy_id: category.map(|_| "spending_categories".into()),
                category_id: category.map(String::from),
                group_id: group.map(String::from),
                enabled: true,
                start_month: "2026-01".into(),
                starting_balance: "0".into(),
                created_at: at,
                updated_at: at,
            };
        let rollovers = vec![
            setting("r1", BudgetRolloverTargetType::Category, Some("food"), None),
            setting(
                "r2",
                BudgetRolloverTargetType::Group,
                None,
                Some("essentials"),
            ),
        ];
        let paths = CategoryPaths(HashMap::from([(
            "food".to_string(),
            ("Food".to_string(), None),
        )]));
        let groups = HashMap::from([("essentials".to_string(), "Essentials".to_string())]);

        let rows = budget_rows_from(vec![target], &rollovers, &paths, &groups);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].amount.as_deref(), Some("300"));
        assert_eq!(rows[0].rollover_enabled, Some(true));
        assert_eq!(rows[1].group.as_deref(), Some("Essentials"));
        assert_eq!(rows[1].period_key, None);
        assert_eq!(rows[1].amount, None);
        assert_eq!(rows[1].rollover_enabled, Some(true));
    }

    #[test]
    fn category_paths_stop_on_a_cycle() {
        let paths = CategoryPaths(HashMap::from([
            ("a".to_string(), ("A".to_string(), Some("b".to_string()))),
            ("b".to_string(), ("B".to_string(), Some("a".to_string()))),
        ]));
        assert!(paths.path("a").is_some());
    }
}
