use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;

use super::OrderedRow;
use crate::errors::{Error, Result};

/// One export row whose columns keep the order they were added in.
///
/// Rows built from a model keep the model's field order, so extra columns can
/// be appended or dropped without depending on how `serde_json` orders maps.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExportRecord(Vec<(String, Value)>);

impl ExportRecord {
    pub fn new() -> Self {
        Self::default()
    }

    /// The record's serialized fields, in declaration order.
    pub fn from_record<T: Serialize>(record: &T) -> Result<Self> {
        let json = serde_json::to_string(record)
            .map_err(|e| Error::Unexpected(format!("Failed to serialize export row: {}", e)))?;
        let row = serde_json::from_str::<OrderedRow>(&json)
            .map_err(|e| Error::Unexpected(format!("Export rows must be JSON objects: {}", e)))?;
        Ok(Self(row.0))
    }

    pub fn from_records<T: Serialize>(records: &[T]) -> Result<Vec<Self>> {
        records.iter().map(Self::from_record).collect()
    }

    /// Sets a column, replacing its value in place when it already exists.
    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        let value = value.into();
        match self.0.iter_mut().find(|(existing, _)| existing == key) {
            Some((_, existing)) => *existing = value,
            None => self.0.push((key.to_string(), value)),
        }
    }

    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.set(key, value);
        self
    }

    /// Appends another record's columns after this one's.
    pub fn extend(&mut self, other: ExportRecord) {
        for (key, value) in other.0 {
            self.set(&key, value);
        }
    }

    /// Renames a column in place, keeping its position.
    pub fn rename(&mut self, from: &str, to: &str) {
        if let Some((key, _)) = self.0.iter_mut().find(|(existing, _)| existing == from) {
            *key = to.to_string();
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let index = self.0.iter().position(|(existing, _)| existing == key)?;
        Some(self.0.remove(index).1)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }
}

impl Serialize for ExportRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        zeta: u32,
        alpha_name: String,
    }

    #[test]
    fn keeps_model_order_and_appends_columns() {
        let record = ExportRecord::from_record(&Row {
            zeta: 1,
            alpha_name: "a".into(),
        })
        .unwrap()
        .with("extra", "x")
        .with("zeta", 2);

        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"zeta":2,"alphaName":"a","extra":"x"}"#
        );
    }

    #[test]
    fn renames_columns_in_place() {
        let mut record = ExportRecord::new()
            .with("assetId", "AAPL")
            .with("name", "Apple");
        record.rename("assetId", "symbol");
        record.rename("missing", "other");
        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"symbol":"AAPL","name":"Apple"}"#
        );
    }

    #[test]
    fn removes_columns() {
        let mut record = ExportRecord::new().with("a", 1).with("b", 2);
        assert_eq!(record.remove("a"), Some(Value::from(1)));
        assert_eq!(record.remove("missing"), None);
        assert_eq!(serde_json::to_string(&record).unwrap(), r#"{"b":2}"#);
    }
}
