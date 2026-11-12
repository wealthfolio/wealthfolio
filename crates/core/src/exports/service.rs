//! Builds every dataset of the data export, for both runtimes.
//!
//! The export carries what the user entered and calculated results about the
//! past or present. Forecasts (goal projections, future loan instalments) are
//! exported from the screen that shows them, never here.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    build_csv_archive, build_json_bundle, export_file_name, format_records, ArchiveEntry,
    ExportDataType, ExportDatasetGroup, ExportFileFormat, ExportRecord, HoldingExportRow,
};
use crate::accounts::{
    account_supports_portfolio_scope, Account, AccountPurpose, AccountServiceTrait,
};
use crate::activities::ActivityServiceTrait;
use crate::assets::loan::loan_calculation;
use crate::assets::{AlternativeAssetServiceTrait, Asset, AssetServiceTrait};
use crate::errors::{Error, Result, ValidationError};
use crate::goals::GoalServiceTrait;
use crate::limits::{ContributionLimitServiceTrait, ContributionTreatment, DepositsCalculation};
use crate::lots::LotRepositoryTrait;
use crate::portfolio::holdings::{HoldingListItem, HoldingsServiceTrait};
use crate::portfolio::income::IncomeServiceTrait;
use crate::portfolio::net_worth::{
    AssetCategory, NetWorthHistoryPoint, NetWorthService, NetWorthServiceTrait,
    CREDIT_CARD_KEY_PREFIX,
};
use crate::portfolio::snapshot::SnapshotServiceTrait;
use crate::portfolio::valuation::{DailyAccountValuation, ValuationServiceTrait};
use crate::portfolios::{AccountScope, PortfolioServiceTrait};
use crate::quotes::{Quote, QuoteServiceTrait};
use crate::taxonomies::TaxonomyServiceTrait;
use crate::utils::time_utils::{
    local_date_range_utc_bounds, parse_user_timezone_or_default, user_date_from_utc, user_today,
    UtcDateRangeBounds,
};

mod accounts;
mod investments;
mod net_worth;
mod planning;

const ARCHIVE_README: &str = "README.txt";

/// What the user chose on the export screen. Each dataset uses only the
/// options that apply to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// Include archived accounts and their activities, lots and payments.
    pub include_archived: bool,
    /// First day of dated rows (activities, sales, histories, valuations).
    pub start_date: Option<NaiveDate>,
    /// Last day of dated rows.
    pub end_date: Option<NaiveDate>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_archived: true,
            start_date: None,
            end_date: None,
        }
    }
}

impl ExportOptions {
    pub fn validate(&self) -> Result<()> {
        if let (Some(start), Some(end)) = (self.start_date, self.end_date) {
            if start > end {
                return Err(Error::Validation(ValidationError::InvalidInput(
                    "The export's start date is after its end date".to_string(),
                )));
            }
        }
        Ok(())
    }

    fn in_range(&self, date: NaiveDate) -> bool {
        self.start_date.is_none_or(|start| date >= start)
            && self.end_date.is_none_or(|end| date <= end)
    }
}

/// One dataset or every dataset at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportTarget {
    All,
    Dataset(ExportDataType),
}

impl ExportTarget {
    pub fn parse(value: &str) -> Result<Self> {
        if value == "all" {
            Ok(Self::All)
        } else {
            ExportDataType::parse(value).map(Self::Dataset)
        }
    }
}

/// A finished export file.
#[derive(Debug, Clone)]
pub struct ExportFile {
    pub file_name: String,
    pub content_type: &'static str,
    pub content: Vec<u8>,
}

/// How much a dataset holds, shown before anyone clicks.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDatasetSummary {
    pub dataset: &'static str,
    pub group: ExportDatasetGroup,
    /// Rows the file would hold. None for daily histories and holdings, which
    /// are calculated on export and would be costly to count.
    pub count: Option<usize>,
    pub available: bool,
}

/// Spending columns added to an activity row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActivitySpendingColumns {
    pub category: Option<String>,
    pub category_id: Option<String>,
    pub event: Option<String>,
    /// The splits as `[{category, amount, note}]`, when the activity is split.
    pub splits: Option<Value>,
}

/// Spending data lives in its own crate, which implements this for the export.
#[async_trait]
pub trait SpendingExportSource: Send + Sync {
    async fn activity_spending(
        &self,
        activity_ids: &[String],
    ) -> Result<HashMap<String, ActivitySpendingColumns>>;
    async fn budget_rows(&self) -> Result<Vec<ExportRecord>>;
    /// Budgeted, spent and remaining per category for each month key
    /// (`YYYY-MM`), as the budget screen calculates them.
    async fn budget_actual_rows(
        &self,
        months: &[String],
        currency: &str,
        timezone: &str,
    ) -> Result<Vec<ExportRecord>>;
    async fn budget_group_rows(&self) -> Result<Vec<ExportRecord>>;
    async fn rule_rows(&self) -> Result<Vec<ExportRecord>>;
    /// Events with what was spent on each, in `currency`.
    async fn event_rows(&self, currency: &str, timezone: &str) -> Result<Vec<ExportRecord>>;
}

/// The services the export reads from.
pub struct DataExportSources {
    pub accounts: Arc<dyn AccountServiceTrait>,
    pub activities: Arc<dyn ActivityServiceTrait>,
    pub holdings: Arc<dyn HoldingsServiceTrait>,
    pub valuations: Arc<dyn ValuationServiceTrait>,
    pub snapshots: Arc<dyn SnapshotServiceTrait>,
    pub lots: Arc<dyn LotRepositoryTrait>,
    pub assets: Arc<dyn AssetServiceTrait>,
    pub alternative_assets: Arc<dyn AlternativeAssetServiceTrait>,
    pub quotes: Arc<dyn QuoteServiceTrait>,
    pub net_worth: Arc<dyn NetWorthServiceTrait>,
    pub portfolios: Arc<dyn PortfolioServiceTrait>,
    pub goals: Arc<dyn GoalServiceTrait>,
    pub limits: Arc<dyn ContributionLimitServiceTrait>,
    pub taxonomies: Arc<dyn TaxonomyServiceTrait>,
    pub income: Arc<dyn IncomeServiceTrait>,
    pub spending: Arc<dyn SpendingExportSource>,
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub app_version: String,
}

pub struct DataExportService {
    sources: DataExportSources,
}

fn asset_symbol(asset: &Asset) -> Option<String> {
    asset
        .display_code
        .clone()
        .or_else(|| asset.instrument_symbol.clone())
}

fn kind_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Accounts and assets read once per export and shared by every dataset.
struct Lookups {
    accounts: Vec<Account>,
    account_names: HashMap<String, String>,
    assets: HashMap<String, Asset>,
}

impl Lookups {
    fn load(sources: &DataExportSources) -> Result<Self> {
        let accounts = sources.accounts.get_all_accounts()?;
        let account_names = accounts
            .iter()
            .map(|account| (account.id.clone(), account.name.clone()))
            .collect();
        let assets = sources
            .assets
            .get_assets()?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect();
        Ok(Self {
            accounts,
            account_names,
            assets,
        })
    }

    /// The accounts the export covers, archived ones only when asked.
    fn exported_accounts(&self, options: &ExportOptions) -> Vec<&Account> {
        self.accounts
            .iter()
            .filter(|account| options.include_archived || !account.is_archived)
            .collect()
    }

    fn exported_account_ids(&self, options: &ExportOptions) -> HashSet<String> {
        self.exported_accounts(options)
            .into_iter()
            .map(|account| account.id.clone())
            .collect()
    }
}

impl DataExportService {
    pub fn new(sources: DataExportSources) -> Self {
        Self { sources }
    }

    fn base_currency(&self) -> String {
        self.sources
            .base_currency
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The user's timezone setting, as stored.
    fn timezone_name(&self) -> String {
        self.sources
            .timezone
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn timezone(&self) -> chrono_tz::Tz {
        parse_user_timezone_or_default(&self.timezone_name())
    }

    /// Today in the user's timezone, used for file names and "current" reads.
    pub fn today(&self) -> NaiveDate {
        user_today(self.timezone())
    }

    /// Each dataset's size, for the export screen.
    pub async fn summary(&self, options: &ExportOptions) -> Result<Vec<ExportDatasetSummary>> {
        options.validate()?;
        let today = self.today();
        let lookups = Lookups::load(&self.sources)?;
        let accounts = &lookups.accounts;
        let mut summaries = Vec::with_capacity(ExportDataType::ALL.len());
        for dataset in ExportDataType::ALL {
            let count = match dataset {
                ExportDataType::Activities => Some(self.activity_count(accounts, options)?),
                ExportDataType::Holdings => None,
                ExportDataType::NetWorthHistory | ExportDataType::PortfolioHistory => None,
                _ => Some(
                    self.records(&lookups, dataset, ExportFileFormat::Csv, options, today)
                        .await?
                        .len(),
                ),
            };
            let available = match (dataset, count) {
                (_, Some(count)) => count > 0,
                (ExportDataType::Holdings, None) => {
                    !self.holdings_account_ids(accounts, false).is_empty()
                }
                (ExportDataType::PortfolioHistory, None) => {
                    accounts.iter().any(|account| !account.is_archived)
                }
                (_, None) => self.earliest_date(&lookups)?.is_some(),
            };
            summaries.push(ExportDatasetSummary {
                dataset: dataset.key(),
                group: dataset.group(),
                count,
                available,
            });
        }
        Ok(summaries)
    }

    /// Builds one dataset's file, or the "export all" file. None when there is
    /// nothing to export.
    pub async fn export(
        &self,
        target: ExportTarget,
        format: ExportFileFormat,
        options: &ExportOptions,
    ) -> Result<Option<ExportFile>> {
        options.validate()?;
        let today = self.today();
        match target {
            ExportTarget::Dataset(dataset) => {
                let lookups = Lookups::load(&self.sources)?;
                let records = self
                    .records(&lookups, dataset, format, options, today)
                    .await?;
                let Some(content) = format_records(&records, format)? else {
                    return Ok(None);
                };
                Ok(Some(ExportFile {
                    file_name: export_file_name(dataset, format, today),
                    content_type: format.content_type(),
                    content,
                }))
            }
            ExportTarget::All => self.export_all(format, options, today).await,
        }
    }

    async fn export_all(
        &self,
        format: ExportFileFormat,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Option<ExportFile>> {
        let lookups = Lookups::load(&self.sources)?;
        let mut sections = Vec::with_capacity(ExportDataType::ALL.len());
        for dataset in ExportDataType::ALL {
            sections.push((
                dataset,
                self.records(&lookups, dataset, format, options, today)
                    .await?,
            ));
        }
        if sections.iter().all(|(_, records)| records.is_empty()) {
            return Ok(None);
        }
        let stem = format!("wealthfolio-export_{}", today.format("%Y-%m-%d"));
        match format {
            ExportFileFormat::Csv => {
                let mut entries = vec![ArchiveEntry {
                    file_name: ARCHIVE_README.to_string(),
                    content: readme(
                        &sections,
                        options,
                        today,
                        &self.sources.app_version,
                        &self.base_currency(),
                    )
                    .into_bytes(),
                }];
                for (dataset, records) in &sections {
                    if let Some(content) = format_records(records, format)? {
                        entries.push(ArchiveEntry {
                            file_name: format!("{}.csv", dataset.key()),
                            content,
                        });
                    }
                }
                Ok(Some(ExportFile {
                    file_name: format!("{stem}.zip"),
                    content_type: "application/zip",
                    content: build_csv_archive(&entries)?,
                }))
            }
            ExportFileFormat::Json => {
                let sections = sections
                    .into_iter()
                    .map(|(dataset, records)| (dataset.key(), records))
                    .collect::<Vec<_>>();
                Ok(Some(ExportFile {
                    file_name: format!("{stem}.json"),
                    content_type: format.content_type(),
                    content: build_json_bundle(
                        today,
                        &self.base_currency(),
                        &self.sources.app_version,
                        options.include_archived,
                        &sections,
                    )?,
                }))
            }
        }
    }

    /// The rows of one dataset. Holdings keep their list shape in JSON.
    async fn records(
        &self,
        lookups: &Lookups,
        dataset: ExportDataType,
        format: ExportFileFormat,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Vec<ExportRecord>> {
        match dataset {
            ExportDataType::Accounts => self.account_records(lookups, options),
            ExportDataType::Activities => self.activity_records(format, options).await,
            ExportDataType::Holdings => self.holding_records(format).await,
            ExportDataType::Lots => self.lot_records(lookups, options).await,
            ExportDataType::RealizedGains => {
                self.realized_gain_records(lookups, options, today).await
            }
            ExportDataType::ManualPrices => self.manual_price_records(lookups, options),
            ExportDataType::Income => self.income_records(options),
            ExportDataType::IncomeBySource => self.income_by_source_records(),
            ExportDataType::AssetsAndLiabilities => self.alternative_asset_records(today),
            ExportDataType::AssetValuations => self.asset_valuation_records(options),
            ExportDataType::LoanPayments => self.loan_payment_records(lookups, options),
            ExportDataType::NetWorthHistory => {
                self.net_worth_records(lookups, format, options, today)
                    .await
            }
            ExportDataType::PortfolioHistory => self.portfolio_history_records(options).await,
            ExportDataType::Budgets => self.sources.spending.budget_rows().await,
            ExportDataType::BudgetActuals => {
                let first_activity = self
                    .sources
                    .activities
                    .get_first_activity_date(None)?
                    .map(|instant| user_date_from_utc(instant, self.timezone()));
                let months = budget_months(options, today, first_activity);
                self.sources
                    .spending
                    .budget_actual_rows(&months, &self.base_currency(), &self.timezone_name())
                    .await
            }
            ExportDataType::BudgetGroups => self.sources.spending.budget_group_rows().await,
            ExportDataType::SpendingRules => self.sources.spending.rule_rows().await,
            ExportDataType::SpendingEvents => {
                self.sources
                    .spending
                    .event_rows(&self.base_currency(), &self.timezone_name())
                    .await
            }
            ExportDataType::Goals => self.goal_records(lookups),
            ExportDataType::ContributionLimits => self.contribution_limit_records(lookups),
            ExportDataType::Portfolios => self.portfolio_records(lookups),
            ExportDataType::Categories => self.category_records(),
            ExportDataType::Classifications => self.classification_records(lookups),
        }
    }
}

/// Whether an instant falls in a `[start, end)` UTC window; open ends match all.
fn within_bounds(bounds: &UtcDateRangeBounds, instant: chrono::DateTime<chrono::Utc>) -> bool {
    bounds.0.is_none_or(|start| instant >= start) && bounds.1.is_none_or(|end| instant < end)
}

/// Month keys (`YYYY-MM`) for budget actuals: the export's dates, or every
/// month from the first activity to the current one.
fn budget_months(
    options: &ExportOptions,
    today: NaiveDate,
    first_activity: Option<NaiveDate>,
) -> Vec<String> {
    let end = options.end_date.unwrap_or(today).min(today);
    let Some(start) = options.start_date.or(first_activity) else {
        return Vec::new();
    };
    let mut months = Vec::new();
    let (mut year, mut month) = (start.year(), start.month());
    while (year, month) <= (end.year(), end.month()) {
        months.push(format!("{year:04}-{month:02}"));
        if month == 12 {
            year += 1;
            month = 1;
        } else {
            month += 1;
        }
    }
    months
}

/// Whether a `YYYY-MM` month overlaps the export's date range.
fn month_in_range(month: &str, options: &ExportOptions) -> bool {
    let key = |date: NaiveDate| date.format("%Y-%m").to_string();
    options
        .start_date
        .is_none_or(|start| month >= key(start).as_str())
        && options
            .end_date
            .is_none_or(|end| month <= key(end).as_str())
}

fn decimal_value(value: Decimal) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The archive's README: what was exported, with which options, and one line
/// per file.
fn readme(
    sections: &[(ExportDataType, Vec<ExportRecord>)],
    options: &ExportOptions,
    today: NaiveDate,
    app_version: &str,
    base_currency: &str,
) -> String {
    let format_date = |date: NaiveDate| date.format("%Y-%m-%d").to_string();
    let range = match (options.start_date, options.end_date) {
        (None, None) => "all dates".to_string(),
        (Some(start), None) => format!("from {}", format_date(start)),
        (None, Some(end)) => format!("up to {}", format_date(end)),
        (Some(start), Some(end)) => format!("{} to {}", format_date(start), format_date(end)),
    };
    let mut text = format!(
        "Wealthfolio data export\n\
         \n\
         Exported on {} from Wealthfolio {}. Base currency: {}.\n\
         Archived accounts: {}. Date range: {}.\n\
         \n\
         These files are for spreadsheets and other apps. They can't be restored\n\
         into Wealthfolio: use a backup for that. Projections for goals and loan\n\
         schedules aren't included: export them from the goal or the loan.\n\
         \n\
         Files:\n",
        format_date(today),
        app_version,
        if base_currency.is_empty() {
            "not set"
        } else {
            base_currency
        },
        if options.include_archived {
            "included"
        } else {
            "left out"
        },
        range,
    );
    for (dataset, records) in sections {
        if records.is_empty() {
            continue;
        }
        text.push_str(&format!(
            "- {}.csv ({} rows): {}\n",
            dataset.key(),
            records.len(),
            dataset.description()
        ));
    }
    let empty = sections
        .iter()
        .filter(|(_, records)| records.is_empty())
        .map(|(dataset, _)| dataset.key())
        .collect::<Vec<_>>();
    if !empty.is_empty() {
        text.push_str(&format!("\nNo data, so no file: {}.\n", empty.join(", ")));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn every_dataset_round_trips_its_key_once() {
        let keys = ExportDataType::ALL
            .iter()
            .map(|dataset| dataset.key())
            .collect::<HashSet<_>>();
        assert_eq!(keys.len(), ExportDataType::ALL.len());
        for dataset in ExportDataType::ALL {
            assert_eq!(ExportDataType::parse(dataset.key()).unwrap(), dataset);
            assert!(!dataset.description().is_empty());
        }
        assert!(ExportDataType::parse("all").is_err());
    }

    #[test]
    fn target_parses_all_and_each_dataset() {
        assert_eq!(ExportTarget::parse("all").unwrap(), ExportTarget::All);
        assert_eq!(
            ExportTarget::parse("assets-and-liabilities").unwrap(),
            ExportTarget::Dataset(ExportDataType::AssetsAndLiabilities)
        );
        assert!(ExportTarget::parse("everything").is_err());
    }

    #[test]
    fn options_default_to_including_archived_accounts() {
        let options: ExportOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(options, ExportOptions::default());
        assert!(options.include_archived);

        let options: ExportOptions =
            serde_json::from_str(r#"{"includeArchived":false,"startDate":"2025-01-01"}"#).unwrap();
        assert!(!options.include_archived);
        assert_eq!(options.start_date, Some(date(2025, 1, 1)));
        assert_eq!(options.end_date, None);
    }

    #[test]
    fn options_reject_a_start_after_the_end() {
        let options = ExportOptions {
            start_date: Some(date(2026, 2, 1)),
            end_date: Some(date(2026, 1, 1)),
            ..ExportOptions::default()
        };
        assert!(options.validate().is_err());
        assert!(ExportOptions::default().validate().is_ok());
    }

    #[test]
    fn date_range_is_inclusive_and_open_ended() {
        let options = ExportOptions {
            start_date: Some(date(2026, 1, 1)),
            end_date: Some(date(2026, 1, 31)),
            ..ExportOptions::default()
        };
        assert!(options.in_range(date(2026, 1, 1)));
        assert!(options.in_range(date(2026, 1, 31)));
        assert!(!options.in_range(date(2025, 12, 31)));
        assert!(!options.in_range(date(2026, 2, 1)));
        assert!(ExportOptions::default().in_range(date(1990, 1, 1)));
    }

    #[test]
    fn readme_lists_files_options_and_empty_datasets() {
        let sections = vec![
            (
                ExportDataType::AssetsAndLiabilities,
                vec![ExportRecord::new().with("id", "house"), ExportRecord::new()],
            ),
            (ExportDataType::Accounts, Vec::new()),
        ];
        let options = ExportOptions {
            include_archived: false,
            start_date: Some(date(2026, 1, 1)),
            ..ExportOptions::default()
        };
        let text = readme(&sections, &options, date(2026, 11, 8), "3.12.0", "EUR");
        assert!(
            text.contains("Exported on 2026-11-08 from Wealthfolio 3.12.0. Base currency: EUR.")
        );
        assert!(text.contains("Archived accounts: left out. Date range: from 2026-01-01."));
        assert!(text.contains("- assets-and-liabilities.csv (2 rows):"));
        assert!(!text.contains("- accounts.csv"));
        assert!(text.contains("No data, so no file: accounts."));
        assert!(text.contains("can't be restored"));
    }

    #[test]
    fn budget_months_cover_every_month_or_the_export_dates() {
        let months = budget_months(
            &ExportOptions::default(),
            date(2026, 11, 8),
            Some(date(2023, 5, 10)),
        );
        assert_eq!(months.len(), 43, "May 2023 through November 2026");
        assert_eq!(months.first().unwrap(), "2023-05");
        assert_eq!(months.last().unwrap(), "2026-11");
        assert!(budget_months(&ExportOptions::default(), date(2026, 11, 8), None).is_empty());

        let ranged = ExportOptions {
            start_date: Some(date(2025, 11, 20)),
            end_date: Some(date(2026, 2, 3)),
            ..ExportOptions::default()
        };
        assert_eq!(
            budget_months(&ranged, date(2026, 11, 8), Some(date(2023, 5, 10))),
            vec!["2025-11", "2025-12", "2026-01", "2026-02"]
        );
        assert!(month_in_range("2025-11", &ranged));
        assert!(month_in_range("2026-02", &ranged));
        assert!(!month_in_range("2026-03", &ranged));
        assert!(month_in_range("1999-01", &ExportOptions::default()));
    }
}
