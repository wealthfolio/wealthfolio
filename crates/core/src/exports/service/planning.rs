//! Goals, contribution limits, portfolios, categories and classifications.

use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CategoryRow {
    taxonomy_id: String,
    taxonomy: String,
    id: String,
    name: String,
    key: String,
    parent_id: Option<String>,
    parent: Option<String>,
    color: String,
    description: Option<String>,
    sort_order: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassificationRow {
    asset_id: String,
    symbol: Option<String>,
    asset_name: Option<String>,
    taxonomy: Option<String>,
    category: Option<String>,
    category_key: Option<String>,
    category_id: String,
    weight: i32,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedAccount {
    account_id: String,
    account_name: Option<String>,
    share_percent: f64,
    tax_bucket: Option<String>,
}

/// Goal columns that are forecasts; goals export their projection themselves.
const GOAL_FORECAST_COLUMNS: [&str; 2] = ["projectedCompletionDate", "projectedValueAtTargetDate"];

/// A limit's progress columns: what went in, what is left (negative when
/// over), the share used, and each account's part, by name.
fn limit_progress_columns(
    limit_amount: f64,
    progress: &DepositsCalculation,
    accounts: &HashMap<String, String>,
) -> Vec<(&'static str, Value)> {
    let limit = Decimal::from_f64_retain(limit_amount).unwrap_or(Decimal::ZERO);
    let contributed = progress.total.round_dp(2);
    let percent_used =
        (!limit.is_zero()).then(|| (progress.total / limit * Decimal::from(100)).round_dp(2));
    let mut by_account = progress
        .by_account
        .iter()
        .filter(|(_, deposit)| !deposit.converted_amount.is_zero())
        .map(|(account_id, deposit)| {
            let name = accounts
                .get(account_id)
                .map_or(account_id.as_str(), String::as_str);
            (name.to_string(), deposit.converted_amount.round_dp(2))
        })
        .collect::<Vec<_>>();
    by_account.sort();
    vec![
        ("currency", Value::String(progress.base_currency.clone())),
        ("contributed", decimal_value(contributed)),
        (
            "remaining",
            decimal_value((limit - progress.total).round_dp(2)),
        ),
        (
            "percentUsed",
            percent_used.map(decimal_value).unwrap_or(Value::Null),
        ),
        (
            "contributionsByAccount",
            Value::String(
                by_account
                    .iter()
                    .map(|(name, amount)| format!("{name}: {amount}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            ),
        ),
    ]
}

fn asset_symbol_or_id(assets: &HashMap<String, Asset>, asset_id: &str) -> String {
    assets
        .get(asset_id)
        .and_then(asset_symbol)
        .unwrap_or_else(|| asset_id.to_string())
}

impl DataExportService {
    pub(super) fn goal_records(&self, lookups: &Lookups) -> Result<Vec<ExportRecord>> {
        let accounts = &lookups.account_names;
        let goals = self.sources.goals.get_goals()?;
        let mut records = Vec::with_capacity(goals.len());
        for goal in &goals {
            let mut record = ExportRecord::from_record(goal)?;
            for column in GOAL_FORECAST_COLUMNS {
                record.remove(column);
            }
            let plan = self.sources.goals.get_goal_plan(&goal.id)?;
            record.set("planKind", plan.as_ref().map(|plan| plan.plan_kind.clone()));
            record.set(
                "plannerMode",
                plan.as_ref().and_then(|plan| plan.planner_mode.clone()),
            );
            record.set(
                "planSettings",
                plan.as_ref()
                    .map(|plan| {
                        serde_json::from_str::<Value>(&plan.settings_json)
                            .unwrap_or_else(|_| Value::String(plan.settings_json.clone()))
                    })
                    .unwrap_or(Value::Null),
            );
            let linked = self
                .sources
                .goals
                .get_goal_funding(&goal.id)?
                .into_iter()
                .map(|rule| LinkedAccount {
                    account_name: accounts.get(&rule.account_id).cloned(),
                    account_id: rule.account_id,
                    share_percent: rule.share_percent,
                    tax_bucket: rule.tax_bucket,
                })
                .collect::<Vec<_>>();
            record.set(
                "linkedAccounts",
                serde_json::to_value(&linked).unwrap_or(Value::Null),
            );
            records.push(record);
        }
        Ok(records)
    }

    pub(super) fn contribution_limit_records(
        &self,
        lookups: &Lookups,
    ) -> Result<Vec<ExportRecord>> {
        let accounts = &lookups.account_names;
        let base_currency = self.base_currency();
        self.sources
            .limits
            .get_contribution_limits()?
            .iter()
            .map(|limit| {
                let names = limit
                    .account_ids
                    .as_deref()
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(|id| accounts.get(id).cloned().unwrap_or_else(|| id.to_string()))
                    .collect::<Vec<_>>();
                let mut record =
                    ExportRecord::from_record(limit)?.with("accountNames", names.join("; "));
                // Progress so far, as the contribution limits screen shows it.
                let details = self
                    .sources
                    .limits
                    .get_contribution_limit_details(&limit.id, &base_currency)?;
                for (key, value) in
                    limit_progress_columns(limit.limit_amount, &details.calculation, accounts)
                {
                    record.set(key, value);
                }
                // Deposits the user chose not to count against this limit.
                let excluded = details
                    .activities
                    .iter()
                    .filter(|activity| activity.treatment == ContributionTreatment::ExcludedByUser)
                    .map(|activity| activity.id.clone())
                    .collect::<Vec<_>>();
                record.set("excludedActivityIds", excluded.join("; "));
                Ok(record)
            })
            .collect()
    }

    pub(super) fn portfolio_records(&self, lookups: &Lookups) -> Result<Vec<ExportRecord>> {
        let accounts = &lookups.account_names;
        self.sources
            .portfolios
            .list_portfolios()?
            .iter()
            .map(|portfolio| {
                let names = portfolio
                    .account_ids
                    .iter()
                    .map(|id| accounts.get(id).cloned().unwrap_or_else(|| id.clone()))
                    .collect::<Vec<_>>();
                Ok(ExportRecord::from_record(portfolio)?.with("accountNames", names.join("; ")))
            })
            .collect()
    }

    pub(super) fn category_records(&self) -> Result<Vec<ExportRecord>> {
        let mut rows = Vec::new();
        for taxonomy in self.sources.taxonomies.get_taxonomies_with_categories()? {
            let names = taxonomy
                .categories
                .iter()
                .map(|category| (category.id.clone(), category.name.clone()))
                .collect::<HashMap<_, _>>();
            let mut categories = taxonomy.categories.clone();
            categories
                .sort_by(|a, b| (&a.parent_id, a.sort_order).cmp(&(&b.parent_id, b.sort_order)));
            for category in categories {
                rows.push(CategoryRow {
                    taxonomy_id: taxonomy.taxonomy.id.clone(),
                    taxonomy: taxonomy.taxonomy.name.clone(),
                    parent: category
                        .parent_id
                        .as_ref()
                        .and_then(|id| names.get(id).cloned()),
                    id: category.id,
                    name: category.name,
                    key: category.key,
                    parent_id: category.parent_id,
                    color: category.color,
                    description: category.description,
                    sort_order: category.sort_order,
                });
            }
        }
        ExportRecord::from_records(&rows)
    }

    pub(super) fn classification_records(&self, lookups: &Lookups) -> Result<Vec<ExportRecord>> {
        let assets = &lookups.assets;
        if assets.is_empty() {
            return Ok(Vec::new());
        }
        let mut taxonomy_names = HashMap::new();
        let mut categories = HashMap::new();
        for taxonomy in self.sources.taxonomies.get_taxonomies_with_categories()? {
            taxonomy_names.insert(taxonomy.taxonomy.id.clone(), taxonomy.taxonomy.name.clone());
            for category in taxonomy.categories {
                categories.insert(category.id.clone(), category);
            }
        }
        let asset_ids = assets.keys().cloned().collect::<Vec<_>>();
        let mut assignments = self
            .sources
            .taxonomies
            .get_asset_assignments_for_assets(&asset_ids)?;
        assignments.sort_by(|a, b| {
            (asset_symbol_or_id(assets, &a.asset_id), &a.taxonomy_id)
                .cmp(&(asset_symbol_or_id(assets, &b.asset_id), &b.taxonomy_id))
        });
        let rows = assignments
            .into_iter()
            .map(|assignment| {
                let asset = assets.get(&assignment.asset_id);
                let category = categories.get(&assignment.category_id);
                ClassificationRow {
                    symbol: asset.and_then(asset_symbol),
                    asset_name: asset.and_then(|asset| asset.name.clone()),
                    taxonomy: taxonomy_names.get(&assignment.taxonomy_id).cloned(),
                    category: category.map(|category| category.name.clone()),
                    category_key: category.map(|category| category.key.clone()),
                    asset_id: assignment.asset_id,
                    category_id: assignment.category_id,
                    weight: assignment.weight,
                    source: assignment.source,
                }
            })
            .collect::<Vec<_>>();
        ExportRecord::from_records(&rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_progress_reports_contributed_remaining_and_accounts() {
        use crate::limits::AccountDeposit;
        let deposit = |amount: i64| AccountDeposit {
            amount: Decimal::from(amount),
            currency: "USD".into(),
            converted_amount: Decimal::from(amount),
        };
        let progress = DepositsCalculation {
            total: Decimal::from(7500),
            base_currency: "USD".into(),
            by_account: HashMap::from([
                ("roth".to_string(), deposit(5000)),
                ("ira".to_string(), deposit(2500)),
                ("empty".to_string(), deposit(0)),
            ]),
        };
        let accounts = HashMap::from([
            ("roth".to_string(), "Roth IRA".to_string()),
            ("ira".to_string(), "Traditional IRA".to_string()),
        ]);

        let columns = limit_progress_columns(7000.0, &progress, &accounts)
            .into_iter()
            .collect::<HashMap<_, _>>();

        assert_eq!(columns["currency"], "USD");
        assert_eq!(columns["contributed"], decimal_value(Decimal::from(7500)));
        assert_eq!(columns["remaining"], decimal_value(Decimal::from(-500)));
        assert_eq!(
            columns["percentUsed"],
            decimal_value(Decimal::from_str_exact("107.14").unwrap())
        );
        assert_eq!(
            columns["contributionsByAccount"],
            "Roth IRA: 5000; Traditional IRA: 2500"
        );
        assert_eq!(
            limit_progress_columns(0.0, &progress, &accounts)[3].1,
            Value::Null,
            "no share of a zero limit"
        );
    }
}
