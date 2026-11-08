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
use crate::fx::currency::normalize_amount;
use crate::fx::FxServiceTrait;
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
    /// The day holdings are read on. None or today exports current holdings.
    pub as_of_date: Option<NaiveDate>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_archived: true,
            start_date: None,
            end_date: None,
            as_of_date: None,
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
    pub fx: Arc<dyn FxServiceTrait>,
    pub net_worth: Arc<dyn NetWorthServiceTrait>,
    pub portfolios: Arc<dyn PortfolioServiceTrait>,
    pub goals: Arc<dyn GoalServiceTrait>,
    pub limits: Arc<dyn ContributionLimitServiceTrait>,
    pub taxonomies: Arc<dyn TaxonomyServiceTrait>,
    pub income: Arc<dyn IncomeServiceTrait>,
    pub spending: Option<Arc<dyn SpendingExportSource>>,
    pub base_currency: Arc<RwLock<String>>,
    pub timezone: Arc<RwLock<String>>,
    pub app_version: String,
}

pub struct DataExportService {
    sources: DataExportSources,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoricalHoldingRow {
    as_of_date: NaiveDate,
    account_id: String,
    account_name: Option<String>,
    asset_id: String,
    symbol: Option<String>,
    name: Option<String>,
    quantity: Decimal,
    contract_multiplier: Decimal,
    average_cost: Decimal,
    cost_basis: Decimal,
    cost_basis_currency: String,
    price_date: Option<NaiveDate>,
    price: Option<Decimal>,
    price_currency: Option<String>,
    market_value: Option<Decimal>,
    base_currency: String,
    market_value_base: Option<Decimal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceRow {
    date: NaiveDate,
    asset_id: String,
    symbol: Option<String>,
    name: Option<String>,
    price: Decimal,
    open: Decimal,
    high: Decimal,
    low: Decimal,
    currency: String,
    source: String,
    notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlternativeAssetRow {
    id: String,
    kind: Value,
    name: String,
    currency: String,
    value: Decimal,
    valuation_date: NaiveDate,
    purchase_price: Option<Decimal>,
    purchase_date: Option<NaiveDate>,
    unrealized_gain: Option<Decimal>,
    unrealized_gain_pct: Option<Decimal>,
    linked_asset_id: Option<String>,
    linked_asset_name: Option<String>,
    notes: Option<String>,
    loan_original_amount: Option<f64>,
    loan_annual_rate: Option<f64>,
    loan_payment_amount: Option<f64>,
    loan_frequency: Option<Value>,
    loan_renewal_maturity: Option<NaiveDate>,
    loan_interest_to_date: Option<f64>,
    details: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetValuationRow {
    date: NaiveDate,
    asset_id: String,
    name: String,
    kind: Value,
    value: Decimal,
    currency: String,
    source: String,
    notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoanPaymentRow {
    date: NaiveDate,
    loan_id: String,
    loan_name: String,
    amount: f64,
    escrow: f64,
    applies_to: Option<Value>,
    activity_id: String,
    account_id: String,
    account_name: Option<String>,
}

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

fn asset_symbol(asset: &Asset) -> Option<String> {
    asset
        .display_code
        .clone()
        .or_else(|| asset.instrument_symbol.clone())
}

fn kind_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
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

    fn timezone(&self) -> chrono_tz::Tz {
        let raw = self
            .sources
            .timezone
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        parse_user_timezone_or_default(&raw)
    }

    /// Today in the user's timezone, used for file names and "current" reads.
    pub fn today(&self) -> NaiveDate {
        user_today(self.timezone())
    }

    /// Each dataset's size, for the export screen.
    pub async fn summary(&self, options: &ExportOptions) -> Result<Vec<ExportDatasetSummary>> {
        options.validate()?;
        let today = self.today();
        let accounts = self.sources.accounts.get_all_accounts()?;
        let mut summaries = Vec::with_capacity(ExportDataType::ALL.len());
        for dataset in ExportDataType::ALL {
            let count = match dataset {
                ExportDataType::Activities => Some(self.activity_count(&accounts, options)?),
                ExportDataType::Holdings => None,
                ExportDataType::NetWorthHistory | ExportDataType::PortfolioHistory => None,
                _ => Some(
                    self.records(dataset, ExportFileFormat::Csv, options, today)
                        .await?
                        .len(),
                ),
            };
            let available = match (dataset, count) {
                (_, Some(count)) => count > 0,
                (ExportDataType::Holdings, None) => {
                    !self.holdings_account_ids(&accounts, false).is_empty()
                }
                (ExportDataType::PortfolioHistory, None) => {
                    accounts.iter().any(|account| !account.is_archived)
                }
                (_, None) => self.earliest_date()?.is_some(),
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
                let records = self.records(dataset, format, options, today).await?;
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
        let mut sections = Vec::with_capacity(ExportDataType::ALL.len());
        for dataset in ExportDataType::ALL {
            sections.push((
                dataset,
                self.records(dataset, format, options, today).await?,
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
        dataset: ExportDataType,
        format: ExportFileFormat,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Vec<ExportRecord>> {
        match dataset {
            ExportDataType::Accounts => self.account_records(options),
            ExportDataType::Activities => self.activity_records(format, options).await,
            ExportDataType::Holdings => self.holding_records(format, options, today).await,
            ExportDataType::Lots => self.lot_records(options).await,
            ExportDataType::RealizedGains => self.realized_gain_records(options, today).await,
            ExportDataType::ManualPrices => self.manual_price_records(options),
            ExportDataType::Income => self.income_records(options),
            ExportDataType::IncomeBySource => self.income_by_source_records(),
            ExportDataType::AssetsAndLiabilities => self.alternative_asset_records(today),
            ExportDataType::AssetValuations => self.asset_valuation_records(options),
            ExportDataType::LoanPayments => self.loan_payment_records(options),
            ExportDataType::NetWorthHistory => self.net_worth_records(format, options, today).await,
            ExportDataType::PortfolioHistory => self.portfolio_history_records(options).await,
            ExportDataType::Budgets => match &self.sources.spending {
                Some(spending) => spending.budget_rows().await,
                None => Ok(Vec::new()),
            },
            ExportDataType::BudgetActuals => match &self.sources.spending {
                Some(spending) => {
                    let months = budget_months(options, today);
                    let timezone = self
                        .sources
                        .timezone
                        .read()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    spending
                        .budget_actual_rows(&months, &self.base_currency(), &timezone)
                        .await
                }
                None => Ok(Vec::new()),
            },
            ExportDataType::BudgetGroups => match &self.sources.spending {
                Some(spending) => spending.budget_group_rows().await,
                None => Ok(Vec::new()),
            },
            ExportDataType::SpendingRules => match &self.sources.spending {
                Some(spending) => spending.rule_rows().await,
                None => Ok(Vec::new()),
            },
            ExportDataType::SpendingEvents => match &self.sources.spending {
                Some(spending) => {
                    let timezone = self
                        .sources
                        .timezone
                        .read()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    spending.event_rows(&self.base_currency(), &timezone).await
                }
                None => Ok(Vec::new()),
            },
            ExportDataType::Goals => self.goal_records(),
            ExportDataType::ContributionLimits => self.contribution_limit_records(),
            ExportDataType::Portfolios => self.portfolio_records(),
            ExportDataType::Categories => self.category_records(),
            ExportDataType::Classifications => self.classification_records(),
        }
    }

    /// Accounts with the balance of their latest valuation.
    fn account_records(&self, options: &ExportOptions) -> Result<Vec<ExportRecord>> {
        let accounts = self.exported_accounts(options)?;
        let ids = accounts
            .iter()
            .map(|account| account.id.clone())
            .collect::<Vec<_>>();
        let valuations = self
            .sources
            .valuations
            .get_latest_valuations(&ids)?
            .into_iter()
            .map(|valuation| (valuation.account_id.clone(), valuation))
            .collect::<HashMap<_, _>>();
        accounts
            .iter()
            .map(|account| {
                let mut record = ExportRecord::from_record(account)?;
                let valuation = valuations.get(&account.id);
                let value = |pick: fn(&DailyAccountValuation) -> Decimal| {
                    valuation.map_or(Value::Null, |valuation| decimal_value(pick(valuation)))
                };
                record.set(
                    "balanceDate",
                    valuation
                        .map(|valuation| valuation.valuation_date.format("%Y-%m-%d").to_string()),
                );
                record.set("balance", value(|valuation| valuation.total_value));
                record.set("cashBalance", value(|valuation| valuation.cash_balance));
                record.set(
                    "investmentValue",
                    value(|valuation| valuation.investment_market_value),
                );
                record.set(
                    "balanceInBaseCurrency",
                    value(|valuation| valuation.total_value_base),
                );
                record.set(
                    "baseCurrency",
                    valuation.map(|valuation| valuation.base_currency.clone()),
                );
                Ok(record)
            })
            .collect()
    }

    /// Income per month and account, from the income screen's all-time view.
    fn income_records(&self, options: &ExportOptions) -> Result<Vec<ExportRecord>> {
        let summaries = self.sources.income.get_income_summary(None)?;
        let Some(all) = summaries.iter().find(|summary| summary.period == "ALL") else {
            return Ok(Vec::new());
        };
        // Income in a currency with no rate is left out of the totals.
        let unconverted = all
            .unconverted_currencies
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        let mut rows = all
            .by_account
            .values()
            .flat_map(|account| {
                account.by_month.iter().map(move |(month, amount)| {
                    (
                        month.clone(),
                        account.account_name.clone(),
                        account.account_id.clone(),
                        *amount,
                    )
                })
            })
            .filter(|(month, _, _, amount)| !amount.is_zero() && month_in_range(month, options))
            .collect::<Vec<_>>();
        rows.sort();
        Ok(rows
            .into_iter()
            .map(|(month, account_name, account_id, amount)| {
                ExportRecord::new()
                    .with("month", month)
                    .with("accountName", account_name)
                    .with("accountId", account_id)
                    .with("income", decimal_value(amount))
                    .with("currency", all.currency.clone())
                    .with("unconvertedCurrencies", unconverted.clone())
            })
            .collect())
    }

    /// Income from each holding: all time, this year and the two years before.
    fn income_by_source_records(&self) -> Result<Vec<ExportRecord>> {
        let summaries = self.sources.income.get_income_summary(None)?;
        let period = |name: &str| summaries.iter().find(|summary| summary.period == name);
        let Some(all) = period("ALL") else {
            return Ok(Vec::new());
        };
        let in_period = |name: &str, asset_id: &str| {
            period(name)
                .and_then(|summary| summary.by_asset.get(asset_id))
                .map_or(Decimal::ZERO, |asset| asset.income)
        };
        let mut assets = all.by_asset.values().collect::<Vec<_>>();
        assets.sort_by(|a, b| {
            b.income
                .cmp(&a.income)
                .then_with(|| a.symbol.cmp(&b.symbol))
        });
        Ok(assets
            .into_iter()
            .map(|asset| {
                ExportRecord::new()
                    .with("symbol", asset.symbol.clone())
                    .with("name", asset.name.clone())
                    .with("kind", asset.kind.clone())
                    .with("assetId", asset.asset_id.clone())
                    .with("incomeAllTime", decimal_value(asset.income))
                    .with("dividendsAllTime", decimal_value(asset.dividend_income))
                    .with(
                        "incomeThisYear",
                        decimal_value(in_period("YTD", &asset.asset_id)),
                    )
                    .with(
                        "incomeLastYear",
                        decimal_value(in_period("LAST_YEAR", &asset.asset_id)),
                    )
                    .with(
                        "incomeTwoYearsAgo",
                        decimal_value(in_period("TWO_YEARS_AGO", &asset.asset_id)),
                    )
                    .with("currency", all.currency.clone())
                    .with(
                        "unconvertedCurrencies",
                        all.unconverted_currencies
                            .iter()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join("; "),
                    )
            })
            .collect())
    }

    fn exported_accounts(&self, options: &ExportOptions) -> Result<Vec<Account>> {
        Ok(self
            .sources
            .accounts
            .get_all_accounts()?
            .into_iter()
            .filter(|account| options.include_archived || !account.is_archived)
            .collect())
    }

    fn account_names(&self) -> Result<HashMap<String, String>> {
        Ok(self
            .sources
            .accounts
            .get_all_accounts()?
            .into_iter()
            .map(|account| (account.id, account.name))
            .collect())
    }

    fn exported_account_ids(&self, options: &ExportOptions) -> Result<HashSet<String>> {
        Ok(self
            .exported_accounts(options)?
            .into_iter()
            .map(|account| account.id)
            .collect())
    }

    fn assets_by_id(&self) -> Result<HashMap<String, Asset>> {
        Ok(self
            .sources
            .assets
            .get_assets()?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect())
    }

    fn holdings_account_ids(&self, accounts: &[Account], include_archived: bool) -> Vec<String> {
        accounts
            .iter()
            .filter(|account| include_archived || !account.is_archived)
            .filter(|account| account_supports_portfolio_scope(account, AccountPurpose::Holdings))
            .map(|account| account.id.clone())
            .collect()
    }

    /// The export's dates as an exact UTC window in the user's timezone, so
    /// activities are picked by the day they show in the app.
    fn activity_bounds(&self, options: &ExportOptions) -> Result<UtcDateRangeBounds> {
        local_date_range_utc_bounds(options.start_date, options.end_date, self.timezone())
    }

    fn activity_count(&self, accounts: &[Account], options: &ExportOptions) -> Result<usize> {
        let bounds = self.activity_bounds(options)?;
        let active = self.sources.activities.search_activities_in_utc_range(
            0, 1, None, None, None, None, None, bounds.0, bounds.1, None, None,
        )?;
        let mut count = usize::try_from(active.meta.total_row_count).unwrap_or(0);
        if options.include_archived {
            let archived = accounts
                .iter()
                .filter(|account| account.is_archived)
                .map(|account| account.id.as_str())
                .collect::<HashSet<_>>();
            if !archived.is_empty() {
                // Account-scoped reads skip archived accounts, so filter the full list.
                count += self
                    .sources
                    .activities
                    .get_activities_including_archived_accounts()?
                    .into_iter()
                    .filter(|activity| archived.contains(activity.account_id.as_str()))
                    .filter(|activity| within_bounds(&bounds, activity.activity_date))
                    .count();
            }
        }
        Ok(count)
    }

    async fn activity_records(
        &self,
        format: ExportFileFormat,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let bounds = self.activity_bounds(options)?;
        let mut response = self.sources.activities.export_activities(
            options.include_archived,
            bounds.0,
            bounds.1,
        )?;
        // Rows of cash and credit-card accounts carry their running balance.
        self.sources
            .activities
            .attach_cash_balances(&mut response)
            .await?;
        let spending = match &self.sources.spending {
            Some(spending) => {
                let ids = response
                    .data
                    .iter()
                    .map(|row| row.id.clone())
                    .collect::<Vec<_>>();
                Some(spending.activity_spending(&ids).await?)
            }
            None => None,
        };
        response
            .data
            .iter()
            .map(|row| {
                let mut record = ExportRecord::from_record(row)?;
                // The activity CSV has always named this column "symbol".
                if format == ExportFileFormat::Csv {
                    record.rename("assetId", "symbol");
                }
                if let Some(spending) = &spending {
                    let columns = spending.get(&row.id).cloned().unwrap_or_default();
                    record.set("category", columns.category);
                    record.set("categoryId", columns.category_id);
                    record.set("event", columns.event);
                    record.set("splits", columns.splits.unwrap_or(Value::Null));
                }
                Ok(record)
            })
            .collect()
    }

    async fn holding_records(
        &self,
        format: ExportFileFormat,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Vec<ExportRecord>> {
        if let Some(as_of) = options.as_of_date.filter(|date| *date < today) {
            return self.historical_holding_records(as_of).await;
        }
        let base_currency = self.base_currency();
        let resolved = self
            .sources
            .portfolios
            .resolve_account_scope(&AccountScope::All, &base_currency)?;
        let accounts = self
            .sources
            .accounts
            .get_accounts_by_ids(&resolved.account_ids)?;
        let account_ids = self.holdings_account_ids(&accounts, true);
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let holdings = if account_ids.len() == 1 {
            self.sources
                .holdings
                .get_holdings(&account_ids[0], &base_currency)
                .await?
        } else {
            self.sources
                .holdings
                .get_holdings_for_accounts(&account_ids, &base_currency, &resolved.scope_id)
                .await?
        };
        let records = holdings
            .into_iter()
            .map(HoldingListItem::from)
            .collect::<Vec<_>>();
        match format {
            ExportFileFormat::Csv => ExportRecord::from_records(
                &records
                    .into_iter()
                    .map(HoldingExportRow::from)
                    .collect::<Vec<_>>(),
            ),
            ExportFileFormat::Json => ExportRecord::from_records(&records),
        }
    }

    /// Positions on a past day, valued at that day's prices. Each account's
    /// latest snapshot on or before the day gives the quantities and cost.
    async fn historical_holding_records(&self, as_of: NaiveDate) -> Result<Vec<ExportRecord>> {
        let base_currency = self.base_currency();
        let accounts = self.sources.accounts.get_all_accounts()?;
        let account_ids = self.holdings_account_ids(&accounts, false);
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let names = accounts
            .iter()
            .map(|account| (account.id.clone(), account.name.clone()))
            .collect::<HashMap<_, _>>();
        let snapshots = self
            .sources
            .snapshots
            .get_latest_snapshots_as_of(&account_ids, as_of)?;
        let mut positions = snapshots
            .values()
            .flat_map(|snapshot| snapshot.positions.values())
            .filter(|position| !position.quantity.is_zero() && !position.is_alternative)
            .collect::<Vec<_>>();
        positions.sort_by(|a, b| {
            (a.account_id.as_str(), a.asset_id.as_str())
                .cmp(&(b.account_id.as_str(), b.asset_id.as_str()))
        });
        let asset_ids = positions
            .iter()
            .map(|position| position.asset_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let assets = self
            .sources
            .assets
            .get_assets_by_asset_ids(&asset_ids)
            .await?
            .into_iter()
            .map(|asset| (asset.id.clone(), asset))
            .collect::<HashMap<_, _>>();
        let quotes = self
            .sources
            .quotes
            .get_latest_quotes_as_of(&asset_ids, as_of)?;

        let rows = positions
            .into_iter()
            .map(|position| {
                let asset = assets.get(&position.asset_id);
                let quote = quotes.get(&position.asset_id);
                let priced = quote.map(|quote| {
                    let (price, currency) = normalize_amount(quote.close, &quote.currency);
                    let value = price * position.quantity * position.contract_multiplier;
                    (price, currency.to_string(), value)
                });
                let market_value_base = priced.as_ref().and_then(|(_, currency, value)| {
                    self.sources
                        .fx
                        .convert_currency_for_date(*value, currency, &base_currency, as_of)
                        .ok()
                });
                HistoricalHoldingRow {
                    as_of_date: as_of,
                    account_id: position.account_id.clone(),
                    account_name: names.get(&position.account_id).cloned(),
                    asset_id: position.asset_id.clone(),
                    symbol: asset.and_then(asset_symbol),
                    name: asset.and_then(|asset| asset.name.clone()),
                    quantity: position.quantity,
                    contract_multiplier: position.contract_multiplier,
                    average_cost: position.average_cost,
                    cost_basis: position.total_cost_basis,
                    cost_basis_currency: position.currency.clone(),
                    price_date: quote.map(|quote| quote.timestamp.date_naive()),
                    price: priced.as_ref().map(|(price, _, _)| *price),
                    price_currency: priced.as_ref().map(|(_, currency, _)| currency.clone()),
                    market_value: priced.as_ref().map(|(_, _, value)| *value),
                    base_currency: base_currency.clone(),
                    market_value_base,
                }
            })
            .collect::<Vec<_>>();
        let mut rows = rows;
        let mut accounts_with_cash = snapshots.values().collect::<Vec<_>>();
        accounts_with_cash.sort_by(|a, b| a.account_id.cmp(&b.account_id));
        for snapshot in accounts_with_cash {
            rows.extend(historical_cash_rows(
                &snapshot.account_id,
                names.get(&snapshot.account_id).cloned(),
                &snapshot.cash_balances,
                as_of,
                &base_currency,
                |amount, currency| {
                    self.sources
                        .fx
                        .convert_currency_for_date(amount, currency, &base_currency, as_of)
                        .ok()
                },
            ));
        }
        ExportRecord::from_records(&rows)
    }

    /// Leading label columns for rows that only carry ids.
    fn labels(
        account_id: &str,
        asset_id: &str,
        accounts: &HashMap<String, String>,
        assets: &HashMap<String, Asset>,
    ) -> ExportRecord {
        let asset = assets.get(asset_id);
        ExportRecord::new()
            .with("accountName", accounts.get(account_id).cloned())
            .with("symbol", asset.and_then(asset_symbol))
            .with("assetName", asset.and_then(|asset| asset.name.clone()))
    }

    async fn lot_records(&self, options: &ExportOptions) -> Result<Vec<ExportRecord>> {
        let account_ids = self.exported_account_ids(options)?;
        let accounts = self.account_names()?;
        let assets = self.assets_by_id()?;
        let mut lots = self
            .sources
            .lots
            .get_all_lots()
            .await?
            .into_iter()
            .filter(|lot| account_ids.contains(&lot.account_id))
            .collect::<Vec<_>>();
        lots.sort_by(|a, b| (&a.open_date, &a.id).cmp(&(&b.open_date, &b.id)));
        lots.iter()
            .map(|lot| {
                let mut record = Self::labels(&lot.account_id, &lot.asset_id, &accounts, &assets);
                record.extend(ExportRecord::from_record(lot)?);
                Ok(record)
            })
            .collect()
    }

    async fn realized_gain_records(
        &self,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Vec<ExportRecord>> {
        let account_ids = self
            .exported_account_ids(options)?
            .into_iter()
            .collect::<Vec<_>>();
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }
        let floor = NaiveDate::from_ymd_opt(1900, 1, 1).expect("1900-01-01 is a valid date");
        let start_exclusive = options
            .start_date
            .and_then(|date| date.pred_opt())
            .unwrap_or(floor);
        let end = options.end_date.unwrap_or(today);
        let accounts = self.account_names()?;
        let assets = self.assets_by_id()?;
        let mut disposals = self
            .sources
            .lots
            .get_lot_disposals_for_accounts_in_date_range(&account_ids, start_exclusive, end)
            .await?;
        disposals.sort_by(|a, b| (&a.disposal_date, &a.id).cmp(&(&b.disposal_date, &b.id)));
        disposals
            .iter()
            .map(|disposal| {
                let mut record =
                    Self::labels(&disposal.account_id, &disposal.asset_id, &accounts, &assets);
                record.extend(ExportRecord::from_record(disposal)?);
                Ok(record)
            })
            .collect()
    }

    fn manual_price_records(&self, options: &ExportOptions) -> Result<Vec<ExportRecord>> {
        let mut assets = self
            .sources
            .assets
            .get_assets()?
            .into_iter()
            .filter(|asset| !asset.is_alternative())
            .collect::<Vec<_>>();
        assets.sort_by_key(asset_symbol);
        let mut rows = Vec::new();
        for asset in &assets {
            // Prices the user entered or imported, on any asset: an override on
            // a market-priced asset counts, provider history on a manual one doesn't.
            let mut quotes = self.sources.quotes.get_manual_quotes(&asset.id)?;
            quotes.sort_by_key(|quote| quote.timestamp);
            for quote in quotes {
                let date = quote.timestamp.date_naive();
                if !options.in_range(date) {
                    continue;
                }
                rows.push(PriceRow {
                    date,
                    asset_id: asset.id.clone(),
                    symbol: asset_symbol(asset),
                    name: asset.name.clone(),
                    price: quote.close,
                    open: quote.open,
                    high: quote.high,
                    low: quote.low,
                    currency: quote.currency,
                    source: quote.data_source,
                    notes: quote.notes,
                });
            }
        }
        ExportRecord::from_records(&rows)
    }

    fn alternative_asset_records(&self, today: NaiveDate) -> Result<Vec<ExportRecord>> {
        let holdings = self.sources.alternative_assets.get_alternative_holdings()?;
        let names = holdings
            .iter()
            .map(|holding| (holding.id.clone(), holding.name.clone()))
            .collect::<HashMap<_, _>>();
        let mut rows = Vec::with_capacity(holdings.len());
        for holding in &holdings {
            // Interest paid so far is a fact about the past; the payoff date
            // and future instalments are forecasts and stay on the loan screen.
            let interest_to_date = match (&holding.loan, &holding.metadata) {
                (Some(_), Some(metadata)) => {
                    let quotes = self.sources.quotes.get_historical_quotes(&holding.id)?;
                    let payments = self
                        .sources
                        .alternative_assets
                        .get_loan_payments(&holding.id)?;
                    loan_calculation(metadata, &quotes, &payments, today)
                        .map(|calculation| calculation.interest_to_date)
                }
                _ => None,
            };
            rows.push(AlternativeAssetRow {
                id: holding.id.clone(),
                kind: kind_value(&holding.kind),
                name: holding.name.clone(),
                currency: holding.currency.clone(),
                value: holding.market_value,
                valuation_date: holding.valuation_date.date_naive(),
                purchase_price: holding.purchase_price,
                purchase_date: holding.purchase_date,
                unrealized_gain: holding.unrealized_gain,
                unrealized_gain_pct: holding.unrealized_gain_pct,
                linked_asset_id: holding.linked_asset_id.clone(),
                linked_asset_name: holding
                    .linked_asset_id
                    .as_ref()
                    .and_then(|id| names.get(id).cloned()),
                notes: holding.notes.clone(),
                loan_original_amount: holding.loan.as_ref().and_then(|loan| loan.original_amount),
                loan_annual_rate: holding.loan.as_ref().and_then(|loan| loan.annual_rate),
                loan_payment_amount: holding.loan.as_ref().and_then(|loan| loan.payment_amount),
                loan_frequency: holding
                    .loan
                    .as_ref()
                    .and_then(|loan| loan.frequency.as_ref())
                    .map(kind_value),
                loan_renewal_maturity: holding.loan.as_ref().and_then(|loan| loan.renewal_maturity),
                loan_interest_to_date: interest_to_date,
                details: holding.metadata.clone(),
            });
        }
        ExportRecord::from_records(&rows)
    }

    fn asset_valuation_records(&self, options: &ExportOptions) -> Result<Vec<ExportRecord>> {
        let holdings = self.sources.alternative_assets.get_alternative_holdings()?;
        let mut rows = Vec::new();
        for holding in &holdings {
            let mut quotes: Vec<Quote> = self.sources.quotes.get_historical_quotes(&holding.id)?;
            quotes.sort_by_key(|quote| quote.timestamp);
            for quote in quotes {
                let date = quote.timestamp.date_naive();
                if !options.in_range(date) {
                    continue;
                }
                rows.push(AssetValuationRow {
                    date,
                    asset_id: holding.id.clone(),
                    name: holding.name.clone(),
                    kind: kind_value(&holding.kind),
                    value: quote.close,
                    currency: quote.currency,
                    source: quote.data_source,
                    notes: quote.notes,
                });
            }
        }
        ExportRecord::from_records(&rows)
    }

    fn loan_payment_records(&self, options: &ExportOptions) -> Result<Vec<ExportRecord>> {
        let account_ids = self.exported_account_ids(options)?;
        let accounts = self.account_names()?;
        let holdings = self.sources.alternative_assets.get_alternative_holdings()?;
        let mut rows = Vec::new();
        for holding in holdings.iter().filter(|holding| holding.loan.is_some()) {
            for payment in self
                .sources
                .alternative_assets
                .get_loan_payments(&holding.id)?
            {
                if !account_ids.contains(&payment.account_id) || !options.in_range(payment.date) {
                    continue;
                }
                rows.push(LoanPaymentRow {
                    date: payment.date,
                    loan_id: holding.id.clone(),
                    loan_name: holding.name.clone(),
                    amount: payment.amount,
                    escrow: payment.escrow,
                    applies_to: payment.applies_to.as_ref().map(kind_value),
                    activity_id: payment.activity_id.clone(),
                    account_name: accounts.get(&payment.account_id).cloned(),
                    account_id: payment.account_id,
                });
            }
        }
        rows.sort_by(|a, b| (a.date, &a.loan_id).cmp(&(b.date, &b.loan_id)));
        ExportRecord::from_records(&rows)
    }

    /// The first day anything was recorded: an activity or a valuation of an
    /// asset or liability.
    fn earliest_date(&self) -> Result<Option<NaiveDate>> {
        let tz = self.timezone();
        let first_activity = self
            .sources
            .activities
            .get_first_activity_date(None)?
            .map(|instant| user_date_from_utc(instant, tz));
        // Accounts tracked by holdings start at their first snapshot, which
        // can come before any activity or with none at all.
        let mut first_snapshot: Option<NaiveDate> = None;
        for account in self.sources.accounts.get_all_accounts()? {
            let first = self
                .sources
                .snapshots
                .get_snapshot_metadata(&account.id, None, None)?
                .into_iter()
                .filter_map(|meta| NaiveDate::parse_from_str(&meta.snapshot_date, "%Y-%m-%d").ok())
                .min();
            first_snapshot = earlier(first_snapshot, first);
        }
        let mut first_valuation: Option<NaiveDate> = None;
        for holding in self.sources.alternative_assets.get_alternative_holdings()? {
            let first = self
                .sources
                .quotes
                .get_historical_quotes(&holding.id)?
                .into_iter()
                .map(|quote| quote.timestamp.date_naive())
                .min();
            first_valuation = earlier(first_valuation, first);
        }
        Ok(earlier(
            earlier(first_activity, first_snapshot),
            first_valuation,
        ))
    }

    async fn net_worth_records(
        &self,
        format: ExportFileFormat,
        options: &ExportOptions,
        today: NaiveDate,
    ) -> Result<Vec<ExportRecord>> {
        let start = match options.start_date {
            Some(start) => start,
            None => match self.earliest_date()? {
                Some(start) => start,
                None => return Ok(Vec::new()),
            },
        };
        let end = options.end_date.unwrap_or(today).min(today);
        if start > end {
            return Ok(Vec::new());
        }
        let history = self
            .sources
            .net_worth
            .get_net_worth_history(start, end)
            .await?;
        match format {
            ExportFileFormat::Json => ExportRecord::from_records(&history),
            ExportFileFormat::Csv => {
                let labels = self.breakdown_labels(&history)?;
                Ok(net_worth_csv_records(&history, &labels))
            }
        }
    }

    /// Spreadsheet column names for the history breakdown's keys: category
    /// keys stay as they are, liabilities and credit cards get their names.
    fn breakdown_labels(&self, history: &[NetWorthHistoryPoint]) -> Result<Vec<(String, String)>> {
        let keys = history
            .iter()
            .flat_map(|point| point.breakdown.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let categories = NET_WORTH_CATEGORIES
            .iter()
            .map(|category| NetWorthService::category_key(*category))
            .collect::<Vec<_>>();
        let accounts = self.account_names()?;
        let liabilities = self
            .sources
            .alternative_assets
            .get_alternative_holdings()?
            .into_iter()
            .map(|holding| (holding.id, holding.name))
            .collect::<HashMap<_, _>>();

        let mut labels = categories
            .iter()
            .filter(|key| keys.contains(**key))
            .map(|key| (key.to_string(), key.to_string()))
            .collect::<Vec<_>>();
        let mut others = keys
            .iter()
            .filter(|key| !categories.contains(&key.as_str()))
            .map(|key| {
                let label = match key.strip_prefix(CREDIT_CARD_KEY_PREFIX) {
                    Some(account_id) => format!(
                        "Credit card: {}",
                        accounts.get(account_id).map_or(account_id, String::as_str)
                    ),
                    None => format!(
                        "Liability: {}",
                        liabilities.get(key).map_or(key.as_str(), String::as_str)
                    ),
                };
                (key.clone(), label)
            })
            .collect::<Vec<_>>();
        others.sort_by(|a, b| a.1.cmp(&b.1));
        // Two liabilities can share a name; keep both columns apart.
        let mut seen = HashSet::new();
        for (key, label) in &mut others {
            if !seen.insert(label.clone()) {
                *label = format!("{label} ({key})");
            }
        }
        labels.extend(others);
        Ok(labels)
    }

    async fn portfolio_history_records(
        &self,
        options: &ExportOptions,
    ) -> Result<Vec<ExportRecord>> {
        let base_currency = self.base_currency();
        let resolved = self
            .sources
            .portfolios
            .resolve_account_scope(&AccountScope::All, &base_currency)?;
        let totals = self
            .sources
            .valuations
            .get_historical_valuations_for_accounts(
                &resolved.scope_id,
                &resolved.account_ids,
                &resolved.base_currency,
                options.start_date,
                options.end_date,
            )
            .await?;
        // All accounts together first, as before, then each account's own rows.
        let mut records = totals
            .iter()
            .map(|row| Ok(ExportRecord::from_record(row)?.with("accountName", "All accounts")))
            .collect::<Result<Vec<_>>>()?;
        let mut accounts = self
            .sources
            .accounts
            .get_accounts_by_ids(&resolved.account_ids)?;
        accounts.sort_by(|a, b| a.name.cmp(&b.name));
        for account in accounts {
            // The async read loads the history off the async workers.
            let scope = self.sources.portfolios.resolve_account_scope(
                &AccountScope::Account {
                    account_id: account.id.clone(),
                },
                &base_currency,
            )?;
            for row in self
                .sources
                .valuations
                .get_historical_valuations_for_accounts(
                    &scope.scope_id,
                    &scope.account_ids,
                    &scope.base_currency,
                    options.start_date,
                    options.end_date,
                )
                .await?
            {
                records.push(
                    ExportRecord::from_record(&row)?.with("accountName", account.name.clone()),
                );
            }
        }
        Ok(records)
    }

    fn goal_records(&self) -> Result<Vec<ExportRecord>> {
        let accounts = self.account_names()?;
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

    fn contribution_limit_records(&self) -> Result<Vec<ExportRecord>> {
        let accounts = self.account_names()?;
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
                    limit_progress_columns(limit.limit_amount, &details.calculation, &accounts)
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

    fn portfolio_records(&self) -> Result<Vec<ExportRecord>> {
        let accounts = self.account_names()?;
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

    fn category_records(&self) -> Result<Vec<ExportRecord>> {
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

    fn classification_records(&self) -> Result<Vec<ExportRecord>> {
        let assets = self.assets_by_id()?;
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
            (asset_symbol_or_id(&assets, &a.asset_id), &a.taxonomy_id)
                .cmp(&(asset_symbol_or_id(&assets, &b.asset_id), &b.taxonomy_id))
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

/// Asset categories of the net worth breakdown, in the order the net worth
/// screen lists them. Liabilities are separate columns, one per liability.
const NET_WORTH_CATEGORIES: [AssetCategory; 7] = [
    AssetCategory::Cash,
    AssetCategory::Investment,
    AssetCategory::Property,
    AssetCategory::Vehicle,
    AssetCategory::Collectible,
    AssetCategory::PreciousMetal,
    AssetCategory::Other,
];

/// Net worth history as flat spreadsheet rows: totals first, then one
/// column per breakdown entry, the same columns on every row.
fn net_worth_csv_records(
    history: &[NetWorthHistoryPoint],
    labels: &[(String, String)],
) -> Vec<ExportRecord> {
    history
        .iter()
        .map(|point| {
            let mut record = ExportRecord::new()
                .with("date", point.date.format("%Y-%m-%d").to_string())
                .with("currency", point.currency.clone())
                .with("netWorth", decimal_value(point.net_worth))
                .with("totalAssets", decimal_value(point.total_assets))
                .with("totalLiabilities", decimal_value(point.total_liabilities))
                .with("portfolioValue", decimal_value(point.portfolio_value))
                .with(
                    "alternativeAssetsValue",
                    decimal_value(point.alternative_assets_value),
                )
                .with("netContribution", decimal_value(point.net_contribution));
            for (key, label) in labels {
                let value = point.breakdown.get(key).copied().unwrap_or(Decimal::ZERO);
                record.set(label, decimal_value(value));
            }
            record
        })
        .collect()
}

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

/// The earlier of two optional dates; a missing one doesn't count.
fn earlier(a: Option<NaiveDate>, b: Option<NaiveDate>) -> Option<NaiveDate> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Whether an instant falls in a `[start, end)` UTC window; open ends match all.
fn within_bounds(bounds: &UtcDateRangeBounds, instant: chrono::DateTime<chrono::Utc>) -> bool {
    bounds.0.is_none_or(|start| instant >= start) && bounds.1.is_none_or(|end| instant < end)
}

/// One holdings row per non-zero cash balance of an account on a past day.
/// Cash is its own price: quantity and market value are the balance.
fn historical_cash_rows(
    account_id: &str,
    account_name: Option<String>,
    cash_balances: &HashMap<String, Decimal>,
    as_of: NaiveDate,
    base_currency: &str,
    convert: impl Fn(Decimal, &str) -> Option<Decimal>,
) -> Vec<HistoricalHoldingRow> {
    let mut currencies = cash_balances
        .iter()
        .filter(|(_, amount)| !amount.is_zero())
        .collect::<Vec<_>>();
    currencies.sort();
    currencies
        .into_iter()
        .map(|(currency, amount)| HistoricalHoldingRow {
            as_of_date: as_of,
            account_id: account_id.to_string(),
            account_name: account_name.clone(),
            asset_id: format!("CASH-{currency}"),
            symbol: Some(currency.clone()),
            name: Some(format!("Cash ({currency})")),
            quantity: *amount,
            contract_multiplier: Decimal::ONE,
            average_cost: Decimal::ONE,
            cost_basis: *amount,
            cost_basis_currency: currency.clone(),
            price_date: Some(as_of),
            price: Some(Decimal::ONE),
            price_currency: Some(currency.clone()),
            market_value: Some(*amount),
            base_currency: base_currency.to_string(),
            market_value_base: if currency == base_currency {
                Some(*amount)
            } else {
                convert(*amount, currency)
            },
        })
        .collect()
}

/// Month keys (`YYYY-MM`) for budget actuals: the export's dates, or the
/// twelve months up to the current one.
fn budget_months(options: &ExportOptions, today: NaiveDate) -> Vec<String> {
    let end = options.end_date.unwrap_or(today).min(today);
    let start = options.start_date.unwrap_or_else(|| {
        let months_back = end.year() * 12 + end.month0() as i32 - 11;
        NaiveDate::from_ymd_opt(
            months_back.div_euclid(12),
            months_back.rem_euclid(12) as u32 + 1,
            1,
        )
        .unwrap_or(end)
    });
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
    let holdings_date = options
        .as_of_date
        .filter(|date| *date < today)
        .map(format_date)
        .unwrap_or_else(|| "today".to_string());
    let mut text = format!(
        "Wealthfolio data export\n\
         \n\
         Exported on {} from Wealthfolio {}. Base currency: {}.\n\
         Archived accounts: {}. Date range: {}. Holdings date: {}.\n\
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
        holdings_date,
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

fn asset_symbol_or_id(assets: &HashMap<String, Asset>, asset_id: &str) -> String {
    assets
        .get(asset_id)
        .and_then(asset_symbol)
        .unwrap_or_else(|| asset_id.to_string())
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

        let options: ExportOptions = serde_json::from_str(
            r#"{"includeArchived":false,"startDate":"2025-01-01","asOfDate":"2025-12-31"}"#,
        )
        .unwrap();
        assert!(!options.include_archived);
        assert_eq!(options.start_date, Some(date(2025, 1, 1)));
        assert_eq!(options.end_date, None);
        assert_eq!(options.as_of_date, Some(date(2025, 12, 31)));
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
        assert!(text.contains("Holdings date: today."));
        assert!(text.contains("- assets-and-liabilities.csv (2 rows):"));
        assert!(!text.contains("- accounts.csv"));
        assert!(text.contains("No data, so no file: accounts."));
        assert!(text.contains("can't be restored"));
    }

    #[test]
    fn net_worth_csv_gives_every_row_the_same_named_columns() {
        use std::collections::BTreeMap;
        use std::str::FromStr;
        let point = |day: u32, breakdown: &[(&str, &str)]| NetWorthHistoryPoint {
            date: date(2026, 1, day),
            portfolio_value: Decimal::from(100),
            alternative_assets_value: Decimal::from(500),
            total_liabilities: Decimal::from(50),
            total_assets: Decimal::from(600),
            net_worth: Decimal::from(550),
            net_contribution: Decimal::ZERO,
            breakdown: breakdown
                .iter()
                .map(|(key, value)| (key.to_string(), Decimal::from_str(value).unwrap()))
                .collect::<BTreeMap<_, _>>(),
            currency: "EUR".into(),
        };
        let history = vec![
            point(1, &[("cash", "100"), ("loan-1", "50")]),
            point(2, &[("properties", "500.5")]),
        ];
        let labels = vec![
            ("cash".to_string(), "cash".to_string()),
            ("properties".to_string(), "properties".to_string()),
            ("loan-1".to_string(), "Liability: Car loan".to_string()),
        ];

        let rows = net_worth_csv_records(&history, &labels);
        let csv = String::from_utf8(
            crate::exports::format_records(&rows, ExportFileFormat::Csv)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let lines = csv.lines().collect::<Vec<_>>();

        assert_eq!(
            lines[0],
            r#""date","currency","netWorth","totalAssets","totalLiabilities","portfolioValue","alternativeAssetsValue","netContribution","cash","properties","Liability: Car loan""#
        );
        assert_eq!(
            lines[1],
            r#""2026-01-01","EUR","550.0","600.0","50.0","100.0","500.0","0.0","100.0","0.0","50.0""#
        );
        assert!(lines[2].ends_with(r#""0.0","500.5","0.0""#), "{}", lines[2]);
        assert!(!csv.contains('{'), "no JSON left in the CSV");
    }

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

    #[test]
    fn budget_months_cover_the_last_year_or_the_export_dates() {
        let months = budget_months(&ExportOptions::default(), date(2026, 11, 8));
        assert_eq!(months.len(), 12);
        assert_eq!(months.first().unwrap(), "2025-12");
        assert_eq!(months.last().unwrap(), "2026-11");

        let ranged = ExportOptions {
            start_date: Some(date(2025, 11, 20)),
            end_date: Some(date(2026, 2, 3)),
            ..ExportOptions::default()
        };
        assert_eq!(
            budget_months(&ranged, date(2026, 11, 8)),
            vec!["2025-11", "2025-12", "2026-01", "2026-02"]
        );
        assert!(month_in_range("2025-11", &ranged));
        assert!(month_in_range("2026-02", &ranged));
        assert!(!month_in_range("2026-03", &ranged));
        assert!(month_in_range("1999-01", &ExportOptions::default()));
    }

    #[test]
    fn past_holdings_include_each_cash_balance() {
        let balances = HashMap::from([
            ("USD".to_string(), Decimal::from(250)),
            ("EUR".to_string(), Decimal::from(100)),
            ("CAD".to_string(), Decimal::ZERO),
        ]);
        let rows = historical_cash_rows(
            "acct",
            Some("Brokerage".into()),
            &balances,
            date(2025, 12, 31),
            "USD",
            |amount, currency| (currency == "EUR").then(|| amount * Decimal::from(2)),
        );

        assert_eq!(rows.len(), 2, "zero balances are left out");
        assert_eq!(rows[0].asset_id, "CASH-EUR");
        assert_eq!(rows[0].market_value, Some(Decimal::from(100)));
        assert_eq!(rows[0].market_value_base, Some(Decimal::from(200)));
        assert_eq!(rows[1].asset_id, "CASH-USD");
        assert_eq!(rows[1].market_value_base, Some(Decimal::from(250)));
        assert_eq!(rows[1].account_name.as_deref(), Some("Brokerage"));
    }

    #[test]
    fn activity_dates_follow_the_users_timezone() {
        // 02:00 UTC on Jan 3 is still Jan 2 in Toronto.
        let options = ExportOptions {
            start_date: Some(date(2026, 1, 2)),
            end_date: Some(date(2026, 1, 2)),
            ..ExportOptions::default()
        };
        let bounds = local_date_range_utc_bounds(
            options.start_date,
            options.end_date,
            chrono_tz::America::Toronto,
        )
        .unwrap();
        let late_evening: chrono::DateTime<chrono::Utc> = "2026-01-03T02:00:00Z".parse().unwrap();
        let next_morning: chrono::DateTime<chrono::Utc> = "2026-01-03T06:00:00Z".parse().unwrap();
        assert!(within_bounds(&bounds, late_evening));
        assert!(!within_bounds(&bounds, next_morning));
    }

    #[test]
    fn earliest_date_ignores_missing_sources() {
        assert_eq!(earlier(None, None), None);
        assert_eq!(
            earlier(Some(date(2025, 3, 1)), None),
            Some(date(2025, 3, 1))
        );
        assert_eq!(
            earlier(None, Some(date(2024, 1, 1))),
            Some(date(2024, 1, 1))
        );
        assert_eq!(
            earlier(Some(date(2025, 3, 1)), Some(date(2024, 1, 1))),
            Some(date(2024, 1, 1)),
            "a snapshot before the first activity starts the history"
        );
    }

    #[test]
    fn readme_names_a_past_holdings_date() {
        let options = ExportOptions {
            as_of_date: Some(date(2025, 12, 31)),
            ..ExportOptions::default()
        };
        let text = readme(&[], &options, date(2026, 11, 8), "1", "USD");
        assert!(text.contains("Holdings date: 2025-12-31."));
    }
}
