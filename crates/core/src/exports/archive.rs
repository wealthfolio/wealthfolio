use std::io::{Cursor, Write};

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::ExportRecord;
use crate::errors::{Error, Result};

/// A file inside the "export all" archive.
#[derive(Debug, Clone)]
pub struct ArchiveEntry {
    pub file_name: String,
    pub content: Vec<u8>,
}

/// Zips the CSV files and the README into one archive.
pub fn build_csv_archive(entries: &[ArchiveEntry]) -> Result<Vec<u8>> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for entry in entries {
            zip.start_file(entry.file_name.as_str(), options)
                .map_err(|e| {
                    Error::Unexpected(format!("Failed to add {}: {}", entry.file_name, e))
                })?;
            zip.write_all(&entry.content).map_err(|e| {
                Error::Unexpected(format!("Failed to add {}: {}", entry.file_name, e))
            })?;
        }
        zip.finish()
            .map_err(|e| Error::Unexpected(format!("Failed to finish export archive: {}", e)))?;
    }
    Ok(cursor.into_inner())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonBundle<'a> {
    export_date: String,
    base_currency: &'a str,
    app_version: &'a str,
    include_archived: bool,
    datasets: ExportSections<'a>,
}

struct ExportSections<'a>(&'a [(&'static str, Vec<ExportRecord>)]);

impl Serialize for ExportSections<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, rows) in self.0 {
            map.serialize_entry(key, rows)?;
        }
        map.end()
    }
}

/// One JSON document holding every dataset as a section, in catalogue order.
pub fn build_json_bundle(
    export_date: chrono::NaiveDate,
    base_currency: &str,
    app_version: &str,
    include_archived: bool,
    sections: &[(&'static str, Vec<ExportRecord>)],
) -> Result<Vec<u8>> {
    let bundle = JsonBundle {
        export_date: export_date.format("%Y-%m-%d").to_string(),
        base_currency,
        app_version,
        include_archived,
        datasets: ExportSections(sections),
    };
    serde_json::to_vec_pretty(&bundle)
        .map_err(|e| Error::Unexpected(format!("Failed to serialize export JSON: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn archive_holds_each_file() {
        let bytes = build_csv_archive(&[
            ArchiveEntry {
                file_name: "README.txt".into(),
                content: b"hello".to_vec(),
            },
            ArchiveEntry {
                file_name: "accounts.csv".into(),
                content: b"\"id\"\n\"a\"".to_vec(),
            },
        ])
        .unwrap();

        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(archive.len(), 2);
        let mut content = String::new();
        archive
            .by_name("accounts.csv")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "\"id\"\n\"a\"");
    }

    #[test]
    fn json_bundle_keeps_section_order() {
        let sections = vec![
            ("zeta", vec![ExportRecord::new().with("id", "z")]),
            ("alpha", vec![]),
        ];
        let bytes = build_json_bundle(
            chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap(),
            "EUR",
            "1.0.0",
            true,
            &sections,
        )
        .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.find("\"zeta\"").unwrap() < text.find("\"alpha\"").unwrap());
        assert!(text.contains("\"exportDate\": \"2026-01-02\""));
    }
}
