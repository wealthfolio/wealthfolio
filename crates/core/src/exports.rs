use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::de::{MapAccess, Visitor};
use serde::Deserializer;
use serde::Serialize;
use serde_json::Value;
use std::fmt;

use crate::assets::AssetKind;
use crate::errors::{Error, Result, ValidationError};
use crate::portfolio::holdings::{HoldingListItem, HoldingType, MonetaryValue};
use crate::utils::occ_symbol::parse_occ_symbol;

mod archive;
mod record;
mod service;

pub use archive::{build_csv_archive, build_json_bundle, ArchiveEntry};
pub use record::ExportRecord;
pub use service::{
    ActivitySpendingColumns, DataExportService, DataExportSources, ExportDatasetSummary,
    ExportFile, ExportOptions, ExportTarget, SpendingExportSource,
};

/// A dataset of the data export. Each one is a file of its own.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum ExportDataType {
    Accounts,
    Activities,
    Holdings,
    Lots,
    RealizedGains,
    ManualPrices,
    Income,
    IncomeBySource,
    AssetsAndLiabilities,
    AssetValuations,
    LoanPayments,
    NetWorthHistory,
    PortfolioHistory,
    Budgets,
    BudgetActuals,
    BudgetGroups,
    SpendingRules,
    SpendingEvents,
    Goals,
    ContributionLimits,
    Portfolios,
    Categories,
    Classifications,
}

/// Where a dataset sits in the export screen, grouped like the app.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportDatasetGroup {
    Accounts,
    Investments,
    NetWorth,
    Spending,
    Planning,
    Organization,
}

impl ExportDataType {
    /// Every dataset, in the order the export screen and archive list them.
    pub const ALL: [ExportDataType; 23] = [
        Self::Accounts,
        Self::Activities,
        Self::Holdings,
        Self::Lots,
        Self::RealizedGains,
        Self::ManualPrices,
        Self::Income,
        Self::IncomeBySource,
        Self::AssetsAndLiabilities,
        Self::AssetValuations,
        Self::LoanPayments,
        Self::NetWorthHistory,
        Self::PortfolioHistory,
        Self::Budgets,
        Self::BudgetActuals,
        Self::BudgetGroups,
        Self::SpendingRules,
        Self::SpendingEvents,
        Self::Goals,
        Self::ContributionLimits,
        Self::Portfolios,
        Self::Categories,
        Self::Classifications,
    ];

    pub fn parse(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|data_type| data_type.key() == value)
            .ok_or_else(|| {
                Error::Validation(ValidationError::InvalidInput(format!(
                    "Unsupported export data type: {}",
                    value
                )))
            })
    }

    /// The identifier the frontend and the file names use.
    pub fn key(self) -> &'static str {
        match self {
            Self::Accounts => "accounts",
            Self::Activities => "activities",
            Self::Holdings => "holdings",
            Self::Lots => "lots",
            Self::RealizedGains => "realized-gains",
            Self::ManualPrices => "manual-prices",
            Self::Income => "income",
            Self::IncomeBySource => "income-by-source",
            Self::AssetsAndLiabilities => "assets-and-liabilities",
            Self::AssetValuations => "asset-valuations",
            Self::LoanPayments => "loan-payments",
            Self::NetWorthHistory => "net-worth-history",
            Self::PortfolioHistory => "portfolio-history",
            Self::Budgets => "budgets",
            Self::BudgetActuals => "budget-actuals",
            Self::BudgetGroups => "budget-groups",
            Self::SpendingRules => "spending-rules",
            Self::SpendingEvents => "spending-events",
            Self::Goals => "goals",
            Self::ContributionLimits => "contribution-limits",
            Self::Portfolios => "portfolios",
            Self::Categories => "categories",
            Self::Classifications => "classifications",
        }
    }

    pub fn group(self) -> ExportDatasetGroup {
        match self {
            Self::Accounts | Self::Activities => ExportDatasetGroup::Accounts,
            Self::Holdings
            | Self::Lots
            | Self::RealizedGains
            | Self::ManualPrices
            | Self::Income
            | Self::IncomeBySource => ExportDatasetGroup::Investments,
            Self::AssetsAndLiabilities
            | Self::AssetValuations
            | Self::LoanPayments
            | Self::NetWorthHistory
            | Self::PortfolioHistory => ExportDatasetGroup::NetWorth,
            Self::Budgets
            | Self::BudgetActuals
            | Self::BudgetGroups
            | Self::SpendingRules
            | Self::SpendingEvents => ExportDatasetGroup::Spending,
            Self::Goals | Self::ContributionLimits => ExportDatasetGroup::Planning,
            Self::Portfolios | Self::Categories | Self::Classifications => {
                ExportDatasetGroup::Organization
            }
        }
    }

    /// One line for the archive's README.
    pub fn description(self) -> &'static str {
        match self {
            Self::Accounts => {
                "Your accounts with their latest balance, archived ones marked in the isArchived column."
            }
            Self::Activities => {
                "Every activity, with the account's running cash balance and, for spending, the category, event and splits."
            }
            Self::Holdings => {
                "Current holdings, valued in their own and your base currency."
            }
            Self::Lots => "Tax lots, open and closed, with their cost basis.",
            Self::RealizedGains => "Each sale matched to the lots it closed, with the realised gain.",
            Self::ManualPrices => "Prices you entered for assets you price yourself.",
            Self::Income => {
                "Dividends and interest per month for each account, in your base currency."
            }
            Self::IncomeBySource => {
                "Income from each holding: all time, this year and the two years before."
            }
            Self::AssetsAndLiabilities => {
                "Property, vehicles, collectibles, precious metals and liabilities, with loan terms and interest paid to date."
            }
            Self::AssetValuations => "Every valuation you recorded for those assets and liabilities.",
            Self::LoanPayments => "Payments linked to each loan.",
            Self::NetWorthHistory => {
                "Daily net worth: investments, other assets and liabilities, in your base currency."
            }
            Self::PortfolioHistory => "Daily valuation of each account and of all accounts together.",
            Self::Budgets => "Budget amounts per period, with rollover settings.",
            Self::BudgetActuals => {
                "Budgeted, spent, rollover and remaining per category and group, every month from the first activity (or the export's dates)."
            }
            Self::BudgetGroups => "Budget groups and the categories in each.",
            Self::SpendingRules => "Rules that categorise transactions automatically.",
            Self::SpendingEvents => {
                "Spending events such as trips, with what was spent and how many activities each has."
            }
            Self::Goals => {
                "Goals with their plan settings, linked accounts and current progress. Projections are left out: export them from the goal."
            }
            Self::ContributionLimits => "Contribution limits and the accounts they cover.",
            Self::Portfolios => "Portfolios (groups of accounts) and their accounts.",
            Self::Categories => "Every category of every taxonomy, including spending categories.",
            Self::Classifications => "Which category each asset belongs to, per taxonomy.",
        }
    }

    fn file_stem(self) -> &'static str {
        self.key()
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HoldingExportRow {
    pub id: String,
    pub account_id: String,
    pub holding_type: HoldingType,
    pub instrument_id: Option<String>,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub instrument_currency: Option<String>,
    pub quote_mode: Option<String>,
    pub isin: Option<String>,
    pub exchange_mic: Option<String>,
    pub asset_type_id: Option<String>,
    pub asset_type_name: Option<String>,
    pub asset_type_key: Option<String>,
    pub asset_kind: Option<AssetKind>,
    pub quantity: Decimal,
    pub open_date: Option<chrono::DateTime<chrono::Utc>>,
    pub contract_multiplier: Decimal,
    pub local_currency: String,
    pub base_currency: String,
    pub fx_rate: Option<Decimal>,
    pub market_value_local: Option<Decimal>,
    pub market_value_base: Option<Decimal>,
    pub cost_basis_local: Option<Decimal>,
    pub cost_basis_base: Option<Decimal>,
    pub average_price: Option<Decimal>,
    pub price: Option<Decimal>,
    pub unrealized_gain_local: Option<Decimal>,
    pub unrealized_gain_base: Option<Decimal>,
    pub unrealized_gain_pct: Option<Decimal>,
    pub realized_gain_local: Option<Decimal>,
    pub realized_gain_base: Option<Decimal>,
    pub realized_gain_pct: Option<Decimal>,
    pub total_gain_local: Option<Decimal>,
    pub total_gain_base: Option<Decimal>,
    pub total_gain_pct: Option<Decimal>,
    pub income_local: Option<Decimal>,
    pub income_base: Option<Decimal>,
    pub total_return_local: Option<Decimal>,
    pub total_return_base: Option<Decimal>,
    pub total_return_pct: Option<Decimal>,
    pub return_basis_local: Option<Decimal>,
    pub return_basis_base: Option<Decimal>,
    pub day_change_local: Option<Decimal>,
    pub day_change_base: Option<Decimal>,
    pub day_change_pct: Option<Decimal>,
    pub prev_close_value_local: Option<Decimal>,
    pub prev_close_value_base: Option<Decimal>,
    pub weight: Option<Decimal>,
    pub as_of_date: NaiveDate,
    pub source_account_ids: Vec<String>,
}

impl From<HoldingListItem> for HoldingExportRow {
    fn from(holding: HoldingListItem) -> Self {
        let (
            instrument_id,
            symbol,
            name,
            instrument_currency,
            quote_mode,
            isin,
            exchange_mic,
            asset_type_id,
            asset_type_name,
            asset_type_key,
        ) = if let Some(instrument) = holding.instrument {
            let asset_type = instrument
                .classifications
                .and_then(|classifications| classifications.asset_type);

            (
                Some(instrument.id),
                Some(instrument.symbol),
                instrument.name,
                Some(instrument.currency),
                Some(instrument.quote_mode),
                instrument.isin,
                instrument.exchange_mic,
                asset_type.as_ref().map(|category| category.id.clone()),
                asset_type.as_ref().map(|category| category.name.clone()),
                asset_type.as_ref().map(|category| category.key.clone()),
            )
        } else {
            (None, None, None, None, None, None, None, None, None, None)
        };

        let average_price = average_price(
            holding.cost_basis.as_ref(),
            holding.quantity,
            holding.contract_multiplier,
            symbol.as_deref(),
        );

        Self {
            id: holding.id,
            account_id: holding.account_id,
            holding_type: holding.holding_type,
            instrument_id,
            symbol,
            name,
            instrument_currency,
            quote_mode,
            isin,
            exchange_mic,
            asset_type_id,
            asset_type_name,
            asset_type_key,
            asset_kind: holding.asset_kind,
            quantity: holding.quantity,
            open_date: holding.open_date,
            contract_multiplier: holding.contract_multiplier,
            local_currency: holding.local_currency,
            base_currency: holding.base_currency,
            fx_rate: holding.fx_rate,
            market_value_local: holding.market_value.local,
            market_value_base: holding.market_value.base,
            cost_basis_local: holding.cost_basis.as_ref().and_then(|value| value.local),
            cost_basis_base: holding.cost_basis.as_ref().and_then(|value| value.base),
            average_price,
            price: holding.price,
            unrealized_gain_local: holding
                .unrealized_gain
                .as_ref()
                .and_then(|value| value.local),
            unrealized_gain_base: holding
                .unrealized_gain
                .as_ref()
                .and_then(|value| value.base),
            unrealized_gain_pct: holding.unrealized_gain_pct,
            realized_gain_local: holding.realized_gain.as_ref().and_then(|value| value.local),
            realized_gain_base: holding.realized_gain.as_ref().and_then(|value| value.base),
            realized_gain_pct: holding.realized_gain_pct,
            total_gain_local: holding.total_gain.as_ref().and_then(|value| value.local),
            total_gain_base: holding.total_gain.as_ref().and_then(|value| value.base),
            total_gain_pct: holding.total_gain_pct,
            income_local: holding.income.as_ref().and_then(|value| value.local),
            income_base: holding.income.as_ref().and_then(|value| value.base),
            total_return_local: holding.total_return.as_ref().and_then(|value| value.local),
            total_return_base: holding.total_return.as_ref().and_then(|value| value.base),
            total_return_pct: holding.total_return_pct,
            return_basis_local: holding.return_basis.as_ref().and_then(|value| value.local),
            return_basis_base: holding.return_basis.as_ref().and_then(|value| value.base),
            day_change_local: holding.day_change.as_ref().and_then(|value| value.local),
            day_change_base: holding.day_change.as_ref().and_then(|value| value.base),
            day_change_pct: holding.day_change_pct,
            prev_close_value_local: holding
                .prev_close_value
                .as_ref()
                .and_then(|value| value.local),
            prev_close_value_base: holding
                .prev_close_value
                .as_ref()
                .and_then(|value| value.base),
            weight: holding.weight,
            as_of_date: holding.as_of_date,
            source_account_ids: holding.source_account_ids,
        }
    }
}

fn average_price(
    cost_basis: Option<&MonetaryValue>,
    quantity: Decimal,
    contract_multiplier: Decimal,
    symbol: Option<&str>,
) -> Option<Decimal> {
    let cost_basis = cost_basis?.local?;
    if quantity == Decimal::ZERO {
        return None;
    }

    let is_option = symbol
        .map(|symbol| parse_occ_symbol(symbol).is_ok())
        .unwrap_or(false);
    let units = if is_option && contract_multiplier > Decimal::ZERO {
        quantity * contract_multiplier
    } else {
        quantity
    };

    if units == Decimal::ZERO {
        None
    } else {
        Some(cost_basis / units)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportFileFormat {
    Csv,
    Json,
}

impl ExportFileFormat {
    pub fn parse(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            _ => Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Unsupported export file format: {}",
                value
            )))),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Csv => "text/csv; charset=utf-8",
            Self::Json => "application/json; charset=utf-8",
        }
    }
}

pub fn export_file_name(
    data_type: ExportDataType,
    format: ExportFileFormat,
    date: NaiveDate,
) -> String {
    format!(
        "{}_{}.{}",
        data_type.file_stem(),
        date.format("%Y-%m-%d"),
        format.extension()
    )
}

pub fn format_records<T: Serialize>(
    records: &[T],
    format: ExportFileFormat,
) -> Result<Option<Vec<u8>>> {
    if records.is_empty() {
        return Ok(None);
    }

    let content = match format {
        ExportFileFormat::Csv => records_to_csv(records)?,
        ExportFileFormat::Json => serde_json::to_string_pretty(records)
            .map_err(|e| Error::Unexpected(format!("Failed to serialize export JSON: {}", e)))?,
    };

    Ok(Some(content.into_bytes()))
}

pub fn format_holding_list_records(
    records: &[HoldingListItem],
    format: ExportFileFormat,
) -> Result<Option<Vec<u8>>> {
    match format {
        ExportFileFormat::Csv => {
            let export_rows = records
                .iter()
                .cloned()
                .map(HoldingExportRow::from)
                .collect::<Vec<_>>();
            format_records(&export_rows, format)
        }
        ExportFileFormat::Json => format_records(records, format),
    }
}

fn records_to_csv<T: Serialize>(records: &[T]) -> Result<String> {
    let rows = records_to_object_rows(records)?;
    if rows.is_empty() {
        return Ok(String::new());
    }

    let source_keys = source_keys(&rows);
    let headers = source_keys
        .iter()
        .map(|key| csv_field(key))
        .collect::<Vec<_>>();

    let data_rows = rows
        .iter()
        .map(|row| {
            source_keys
                .iter()
                .map(|key| cell_value(row.get(key)))
                .map(|cell| cell.map(|value| csv_field(&value)))
                .collect::<Result<Vec<_>>>()
                .map(|fields| fields.join(","))
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(std::iter::once(headers.join(","))
        .chain(data_rows)
        .collect::<Vec<_>>()
        .join("\n"))
}

struct OrderedRow(Vec<(String, Value)>);

impl OrderedRow {
    fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(row_key, _)| row_key == key)
            .map(|(_, value)| value)
    }
}

impl<'de> serde::Deserialize<'de> for OrderedRow {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(OrderedRowVisitor)
    }
}

struct OrderedRowVisitor;

impl<'de> Visitor<'de> for OrderedRowVisitor {
    type Value = OrderedRow;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut entries = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Value>()? {
            entries.push((key, value));
        }
        Ok(OrderedRow(entries))
    }
}

fn records_to_object_rows<T: Serialize>(records: &[T]) -> Result<Vec<OrderedRow>> {
    records
        .iter()
        .map(|record| {
            let json = serde_json::to_string(record)
                .map_err(|e| Error::Unexpected(format!("Failed to serialize export row: {}", e)))?;
            serde_json::from_str::<OrderedRow>(&json)
                .map_err(|e| Error::Unexpected(format!("Export rows must be JSON objects: {}", e)))
        })
        .collect()
}

fn source_keys(rows: &[OrderedRow]) -> Vec<String> {
    let mut keys = Vec::new();
    for row in rows {
        for (key, _) in &row.0 {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    keys
}

fn cell_value(value: Option<&Value>) -> Result<String> {
    match value {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(Value::Number(value)) => Ok(value.to_string()),
        Some(Value::Bool(value)) => Ok(value.to_string()),
        Some(value @ Value::Array(_)) | Some(value @ Value::Object(_)) => {
            serde_json::to_string(value)
                .map_err(|e| Error::Unexpected(format!("Failed to serialize export cell: {}", e)))
        }
    }
}

/// One quoted CSV field (RFC 4180): quotes are doubled and line breaks kept,
/// so spreadsheets read nested JSON and multi-line notes as a single cell.
fn csv_field(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AssetRow {
        asset_id: String,
        name: String,
        quantity: u32,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NoteRow {
        id: u32,
        description: String,
        notes: String,
    }

    fn sample_holding_list_item() -> HoldingListItem {
        HoldingListItem {
            id: "AGG-AAPL".to_string(),
            account_id: "all".to_string(),
            holding_type: HoldingType::Security,
            is_closed: false,
            instrument: Some(crate::portfolio::holdings::HoldingListInstrument {
                id: "asset-aapl".to_string(),
                symbol: "AAPL".to_string(),
                name: Some("Apple Inc.".to_string()),
                currency: "USD".to_string(),
                quote_mode: "MARKET".to_string(),
                isin: Some("US0378331005".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                instrument_type: None,
                classifications: None,
            }),
            asset_kind: Some(AssetKind::Investment),
            quantity: dec!(10),
            open_date: None,
            contract_multiplier: dec!(1),
            local_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate: Some(dec!(1)),
            market_value: MonetaryValue::new(dec!(2000), dec!(2000)),
            cost_basis: Some(MonetaryValue::new(dec!(1000), dec!(1000))),
            price: Some(dec!(200)),
            unrealized_gain: None,
            unrealized_gain_pct: None,
            realized_gain: None,
            realized_gain_pct: None,
            total_gain: None,
            total_gain_pct: None,
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            day_change: None,
            day_change_pct: None,
            prev_close_value: None,
            weight: Some(dec!(1)),
            as_of_date: NaiveDate::from_ymd_opt(2026, 6, 25).unwrap(),
            source_account_ids: vec!["account-1".to_string()],
        }
    }

    #[test]
    fn holdings_export_type_parses_and_names_file() {
        let data_type = ExportDataType::parse("holdings").unwrap();

        assert_eq!(data_type, ExportDataType::Holdings);
        assert_eq!(
            export_file_name(
                data_type,
                ExportFileFormat::Csv,
                NaiveDate::from_ymd_opt(2026, 6, 25).unwrap()
            ),
            "holdings_2026-06-25.csv"
        );
    }

    #[test]
    fn average_price_uses_option_contract_multiplier() {
        let cost_basis = MonetaryValue::new(dec!(1000), dec!(1000));

        assert_eq!(
            average_price(
                Some(&cost_basis),
                dec!(2),
                dec!(100),
                Some("AAPL250321C00150000")
            ),
            Some(dec!(5))
        );
        assert_eq!(
            average_price(Some(&cost_basis), dec!(10), dec!(100), Some("AAPL")),
            Some(dec!(100))
        );
    }

    #[test]
    fn holding_list_json_keeps_list_shape_while_csv_flattens_rows() {
        let records = vec![sample_holding_list_item()];

        let json = String::from_utf8(
            format_holding_list_records(&records, ExportFileFormat::Json)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let csv = String::from_utf8(
            format_holding_list_records(&records, ExportFileFormat::Csv)
                .unwrap()
                .unwrap(),
        )
        .unwrap();

        assert!(json.contains("\"marketValue\""));
        assert!(!json.contains("\"marketValueLocal\""));
        assert!(csv.contains("\"marketValueLocal\""));
        assert!(csv.contains("\"averagePrice\""));
    }

    #[test]
    fn csv_headers_keep_each_column_name() {
        let rows = vec![AssetRow {
            asset_id: "8a70fdb6".to_string(),
            name: "Flat".to_string(),
            quantity: 1,
        }];

        let csv = records_to_csv(&rows).unwrap();

        assert_eq!(
            csv,
            "\"assetId\",\"name\",\"quantity\"\n\"8a70fdb6\",\"Flat\",\"1\""
        );
    }

    #[test]
    fn csv_export_quotes_fields_for_spreadsheets() {
        let rows = vec![NoteRow {
            id: 1,
            description: "Item with \"quotes\"".to_string(),
            notes: "Comma, and new\nline".to_string(),
        }];

        let csv = records_to_csv(&rows).unwrap();

        assert_eq!(
            csv,
            "\"id\",\"description\",\"notes\"\n\"1\",\"Item with \"\"quotes\"\"\",\"Comma, and new\nline\""
        );
    }

    #[test]
    fn csv_export_keeps_nested_json_in_one_cell() {
        let rows = vec![ExportRecord::new().with("id", "a").with(
            "details",
            serde_json::json!({"rate": 4.5, "name": "Car \"loan\""}),
        )];

        let csv = records_to_csv(&rows).unwrap();
        let mut reader = csv_reader(&csv);

        assert_eq!(reader.len(), 2);
        let row = reader.remove(1);
        assert_eq!(row.len(), 2);
        let details: Value = serde_json::from_str(&row[1]).unwrap();
        assert_eq!(details["name"], "Car \"loan\"");
    }

    /// A minimal RFC 4180 reader, enough to check what a spreadsheet sees.
    fn csv_reader(text: &str) -> Vec<Vec<String>> {
        let mut rows = vec![Vec::new()];
        let mut field = String::new();
        let mut quoted = false;
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            match (c, quoted) {
                ('"', true) if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                ('"', _) => quoted = !quoted,
                (',', false) => rows.last_mut().unwrap().push(std::mem::take(&mut field)),
                ('\n', false) => {
                    rows.last_mut().unwrap().push(std::mem::take(&mut field));
                    rows.push(Vec::new());
                }
                _ => field.push(c),
            }
        }
        rows.last_mut().unwrap().push(field);
        rows
    }

    #[test]
    fn csv_export_adds_balance_columns_left_blank_for_rows_without_one() {
        let row = |id: &str| -> crate::activities::ActivityDetails {
            serde_json::from_value(serde_json::json!({
                "id": id,
                "accountId": "checking",
                "assetId": "",
                "activityType": "WITHDRAWAL",
                "status": "POSTED",
                "date": "2026-04-02T00:00:00Z",
                "currency": "USD",
                "amount": "30",
                "needsReview": false,
                "createdAt": "2026-04-02T00:00:00Z",
                "updatedAt": "2026-04-02T00:00:00Z",
                "accountName": "Checking",
                "accountCurrency": "USD",
                "assetSymbol": "",
                "assetPricingMode": "NONE",
                "isUserModified": false
            }))
            .unwrap()
        };
        let plain = row("brokerage-row");
        let mut balanced = row("checking-row");
        balanced.cash_balance = Some("954.90".to_string());
        balanced.cash_balance_currency = Some("USD".to_string());
        balanced.cash_balance_scope = Some(crate::activities::CashBalanceScope::Row);

        let csv = records_to_csv(&[plain.clone(), balanced]).unwrap();

        let lines: Vec<&str> = csv.lines().collect();
        let columns = ",\"cashBalance\",\"cashBalanceCurrency\",\"cashBalanceScope\"";
        assert!(lines[0].ends_with(columns));
        assert!(lines[1].ends_with(",\"\",\"\",\"\""));
        assert!(lines[2].ends_with(",\"954.90\",\"USD\",\"ROW\""));

        // An export where no row has a balance keeps the same columns.
        let csv = records_to_csv(&[plain]).unwrap();

        let lines: Vec<&str> = csv.lines().collect();
        assert!(lines[0].ends_with(columns));
        assert!(lines[1].ends_with(",\"\",\"\",\"\""));
    }

    #[test]
    fn empty_records_return_no_export_content() {
        let rows: Vec<AssetRow> = Vec::new();

        let content = format_records(&rows, ExportFileFormat::Json).unwrap();

        assert!(content.is_none());
    }
}
