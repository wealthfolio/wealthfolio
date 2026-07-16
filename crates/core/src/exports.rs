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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportDataType {
    Accounts,
    Activities,
    Holdings,
    Goals,
    PortfolioHistory,
}

impl ExportDataType {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "accounts" => Ok(Self::Accounts),
            "activities" => Ok(Self::Activities),
            "holdings" => Ok(Self::Holdings),
            "goals" => Ok(Self::Goals),
            "portfolio-history" => Ok(Self::PortfolioHistory),
            _ => Err(Error::Validation(ValidationError::InvalidInput(format!(
                "Unsupported export data type: {}",
                value
            )))),
        }
    }

    fn file_stem(self) -> &'static str {
        match self {
            Self::Accounts => "accounts",
            Self::Activities => "activities",
            Self::Holdings => "holdings",
            Self::Goals => "goals",
            Self::PortfolioHistory => "portfolio-history",
        }
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
    pub market_value_local: Decimal,
    pub market_value_base: Decimal,
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
    pub weight: Decimal,
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
            cost_basis_local: holding.cost_basis.as_ref().map(|value| value.local),
            cost_basis_base: holding.cost_basis.as_ref().map(|value| value.base),
            average_price,
            price: holding.price,
            unrealized_gain_local: holding.unrealized_gain.as_ref().map(|value| value.local),
            unrealized_gain_base: holding.unrealized_gain.as_ref().map(|value| value.base),
            unrealized_gain_pct: holding.unrealized_gain_pct,
            realized_gain_local: holding.realized_gain.as_ref().map(|value| value.local),
            realized_gain_base: holding.realized_gain.as_ref().map(|value| value.base),
            realized_gain_pct: holding.realized_gain_pct,
            total_gain_local: holding.total_gain.as_ref().map(|value| value.local),
            total_gain_base: holding.total_gain.as_ref().map(|value| value.base),
            total_gain_pct: holding.total_gain_pct,
            income_local: holding.income.as_ref().map(|value| value.local),
            income_base: holding.income.as_ref().map(|value| value.base),
            total_return_local: holding.total_return.as_ref().map(|value| value.local),
            total_return_base: holding.total_return.as_ref().map(|value| value.base),
            total_return_pct: holding.total_return_pct,
            return_basis_local: holding.return_basis.as_ref().map(|value| value.local),
            return_basis_base: holding.return_basis.as_ref().map(|value| value.base),
            day_change_local: holding.day_change.as_ref().map(|value| value.local),
            day_change_base: holding.day_change.as_ref().map(|value| value.base),
            day_change_pct: holding.day_change_pct,
            prev_close_value_local: holding.prev_close_value.as_ref().map(|value| value.local),
            prev_close_value_base: holding.prev_close_value.as_ref().map(|value| value.base),
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
    let cost_basis = cost_basis?.local;
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
        .map(|key| {
            if key == "assetId" {
                "symbol"
            } else {
                key.as_str()
            }
        })
        .map(json_string)
        .collect::<Result<Vec<_>>>()?;

    let data_rows = rows
        .iter()
        .map(|row| {
            source_keys
                .iter()
                .map(|key| cell_value(row.get(key)))
                .map(|cell| cell.and_then(|value| json_string(&value)))
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

fn json_string(value: &str) -> Result<String> {
    serde_json::to_string(value)
        .map_err(|e| Error::Unexpected(format!("Failed to serialize export CSV field: {}", e)))
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
            instrument: Some(crate::portfolio::holdings::HoldingListInstrument {
                id: "asset-aapl".to_string(),
                symbol: "AAPL".to_string(),
                name: Some("Apple Inc.".to_string()),
                currency: "USD".to_string(),
                quote_mode: "MARKET".to_string(),
                isin: Some("US0378331005".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                classifications: None,
            }),
            asset_kind: Some(AssetKind::Investment),
            quantity: dec!(10),
            open_date: None,
            contract_multiplier: dec!(1),
            local_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate: Some(dec!(1)),
            market_value: MonetaryValue {
                local: dec!(2000),
                base: dec!(2000),
            },
            cost_basis: Some(MonetaryValue {
                local: dec!(1000),
                base: dec!(1000),
            }),
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
            weight: dec!(1),
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
        let cost_basis = MonetaryValue {
            local: dec!(1000),
            base: dec!(1000),
        };

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
    fn csv_export_renames_asset_id_to_symbol() {
        let rows = vec![AssetRow {
            asset_id: "AAPL".to_string(),
            name: "Apple Inc.".to_string(),
            quantity: 10,
        }];

        let csv = records_to_csv(&rows).unwrap();

        assert_eq!(
            csv,
            "\"symbol\",\"name\",\"quantity\"\n\"AAPL\",\"Apple Inc.\",\"10\""
        );
    }

    #[test]
    fn csv_export_uses_json_string_escaping() {
        let rows = vec![NoteRow {
            id: 1,
            description: "Item with \"quotes\"".to_string(),
            notes: "Comma, and new\nline".to_string(),
        }];

        let csv = records_to_csv(&rows).unwrap();

        assert_eq!(
            csv,
            "\"id\",\"description\",\"notes\"\n\"1\",\"Item with \\\"quotes\\\"\",\"Comma, and new\\nline\""
        );
    }

    #[test]
    fn empty_records_return_no_export_content() {
        let rows: Vec<AssetRow> = Vec::new();

        let content = format_records(&rows, ExportFileFormat::Json).unwrap();

        assert!(content.is_none());
    }
}
