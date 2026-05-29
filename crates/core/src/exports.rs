use chrono::NaiveDate;
use serde::de::{MapAccess, Visitor};
use serde::Deserializer;
use serde::Serialize;
use serde_json::Value;
use std::fmt;

use crate::errors::{Error, Result, ValidationError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportDataType {
    Accounts,
    Activities,
    Goals,
    PortfolioHistory,
}

impl ExportDataType {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "accounts" => Ok(Self::Accounts),
            "activities" => Ok(Self::Activities),
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
            Self::Goals => "goals",
            Self::PortfolioHistory => "portfolio-history",
        }
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
