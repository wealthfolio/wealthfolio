//! CSV parsing module with configurable options.
//!
//! Provides flexible CSV parsing with auto-detection for delimiter,
//! encoding, and various formatting options.

use csv::{ReaderBuilder, Terminator};
use serde::{Deserialize, Serialize};

use crate::errors::{Error, ValidationError};
use crate::Result;

/// Configuration for CSV parsing.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ParseConfig {
    /// Whether the CSV has a header row (default: true)
    pub has_header_row: Option<bool>,
    /// Index of the header row (default: 0)
    pub header_row_index: Option<usize>,
    /// Delimiter character: ",", ";", "\t", or "auto" (default: "auto")
    pub delimiter: Option<String>,
    /// Quote character (default: "\"")
    pub quote_char: Option<String>,
    /// Number of rows to skip at the top (default: 0)
    pub skip_top_rows: Option<usize>,
    /// Number of rows to skip at the bottom (default: 0)
    pub skip_bottom_rows: Option<usize>,
    /// Whether to skip empty rows (default: true)
    pub skip_empty_rows: Option<bool>,
    /// Date format: "auto" or format string (default: "auto")
    pub date_format: Option<String>,
    /// Decimal separator: "auto", ".", or "," (default: "auto")
    pub decimal_separator: Option<String>,
    /// Thousands separator: "auto", ",", ".", " ", or "none" (default: "auto")
    pub thousands_separator: Option<String>,
    /// Default currency to use if not specified in the CSV
    pub default_currency: Option<String>,
}

impl ParseConfig {
    /// Returns the effective delimiter, defaulting to "auto"
    pub fn effective_delimiter(&self) -> &str {
        self.delimiter.as_deref().unwrap_or("auto")
    }

    /// Returns whether the CSV has a header row
    pub fn has_header(&self) -> bool {
        self.has_header_row.unwrap_or(true)
    }

    /// Returns the header row index
    pub fn header_index(&self) -> usize {
        self.header_row_index.unwrap_or(0)
    }

    /// Returns the number of rows to skip at the top
    pub fn top_skip(&self) -> usize {
        self.skip_top_rows.unwrap_or(0)
    }

    /// Returns the number of rows to skip at the bottom
    pub fn bottom_skip(&self) -> usize {
        self.skip_bottom_rows.unwrap_or(0)
    }

    /// Returns whether to skip empty rows
    pub fn skip_empty(&self) -> bool {
        self.skip_empty_rows.unwrap_or(true)
    }

    /// Returns the quote character as a byte
    pub fn quote_byte(&self) -> u8 {
        self.quote_char
            .as_ref()
            .and_then(|s| s.chars().next())
            .map(|c| c as u8)
            .unwrap_or(b'"')
    }
}

/// Result of parsing a CSV file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCsvResult {
    /// Headers extracted from the CSV
    pub headers: Vec<String>,
    /// Data rows (each row is a vector of string values)
    pub rows: Vec<Vec<String>>,
    /// The configuration values actually used (with auto-detected values filled in)
    pub detected_config: ParseConfig,
    /// Any errors encountered during parsing
    pub errors: Vec<ParseError>,
    /// Total number of data rows (excluding headers and skipped rows)
    pub row_count: usize,
}

/// Error encountered during CSV parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseError {
    /// Row index where the error occurred (if applicable)
    pub row_index: Option<usize>,
    /// Column index where the error occurred (if applicable)
    pub column_index: Option<usize>,
    /// Human-readable error message
    pub message: String,
    /// Error type: "parse", "encoding", "structure"
    pub error_type: String,
}

impl ParseError {
    fn new_parse(row: Option<usize>, col: Option<usize>, message: impl Into<String>) -> Self {
        Self {
            row_index: row,
            column_index: col,
            message: message.into(),
            error_type: "parse".to_string(),
        }
    }

    fn encoding_error(message: impl Into<String>) -> Self {
        Self {
            row_index: None,
            column_index: None,
            message: message.into(),
            error_type: "encoding".to_string(),
        }
    }

    fn structure_error(message: impl Into<String>) -> Self {
        Self {
            row_index: None,
            column_index: None,
            message: message.into(),
            error_type: "structure".to_string(),
        }
    }
}

/// Parses CSV content with the given configuration.
///
/// # Arguments
/// * `content` - Raw bytes of the CSV file
/// * `config` - Parsing configuration options
///
/// # Returns
/// A `ParsedCsvResult` containing headers, rows, detected config, and any errors.
pub fn parse_csv(content: &[u8], config: &ParseConfig) -> Result<ParsedCsvResult> {
    let mut errors = Vec::new();

    // Handle UTF-8 BOM and convert to string
    let content_str = decode_content(content, &mut errors)?;

    // Auto-detect delimiter if needed
    let delimiter = detect_delimiter(&content_str, config);

    // Build the detected config with actual values used
    let mut detected_config = config.clone();
    detected_config.delimiter = Some(delimiter.to_string());
    detected_config.has_header_row = Some(config.has_header());
    detected_config.header_row_index = Some(config.header_index());
    detected_config.skip_top_rows = Some(config.top_skip());
    detected_config.skip_bottom_rows = Some(config.bottom_skip());
    detected_config.skip_empty_rows = Some(config.skip_empty());
    detected_config.quote_char = Some((config.quote_byte() as char).to_string());

    // Parse the CSV
    let delimiter_byte = delimiter.chars().next().unwrap_or(',') as u8;
    let (headers, rows) = parse_csv_content(&content_str, delimiter_byte, config, &mut errors)?;

    let row_count = rows.len();

    Ok(ParsedCsvResult {
        headers,
        rows,
        detected_config,
        errors,
        row_count,
    })
}

/// Detects the encoding of raw bytes.
///
/// Priority: BOM → valid UTF-8 → statistical detection (chardetng).
fn detect_encoding(content: &[u8]) -> &'static encoding_rs::Encoding {
    // BOM is authoritative (handles UTF-8, UTF-16LE, UTF-16BE)
    if let Some((encoding, _)) = encoding_rs::Encoding::for_bom(content) {
        return encoding;
    }
    // Fast path: valid UTF-8 (no need for statistical detection)
    if std::str::from_utf8(content).is_ok() {
        return encoding_rs::UTF_8;
    }
    // Legacy encoding detection (Shift_JIS, Windows-1252, EUC-KR, etc.)
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(content, true);
    detector.guess(None, chardetng::Utf8Detection::Allow)
}

/// Decodes content bytes to UTF-8 string, handling BOM and non-UTF-8 encodings.
fn decode_content(content: &[u8], errors: &mut Vec<ParseError>) -> Result<String> {
    let encoding = detect_encoding(content);
    let (decoded, _, had_errors) = encoding.decode(content);

    if had_errors {
        errors.push(ParseError::encoding_error(format!(
            "Some characters could not be decoded (encoding: {}).",
            encoding.name()
        )));
    }
    if encoding != encoding_rs::UTF_8 {
        log::debug!("Detected CSV encoding: {}", encoding.name());
    }

    Ok(decoded.into_owned())
}

/// Auto-detects the delimiter by analyzing the content.
fn detect_delimiter<'a>(content: &str, config: &'a ParseConfig) -> &'a str {
    let delimiter_setting = config.effective_delimiter();

    if delimiter_setting != "auto" {
        return match delimiter_setting {
            "\\t" | "\t" => "\t",
            other => {
                // Return the first character or default to comma
                if other.is_empty() {
                    ","
                } else {
                    delimiter_setting
                }
            }
        };
    }

    // Auto-detect: try common delimiters and pick the one with most consistent columns
    let delimiters = [",", ";", "\t"];
    let mut best_delimiter = ",";
    let mut best_score = 0usize;

    for delim in delimiters {
        let score = score_delimiter(content, delim);
        if score > best_score {
            best_score = score;
            best_delimiter = delim;
        }
    }

    best_delimiter
}

/// Scores a delimiter by counting consistent column counts across lines.
fn score_delimiter(content: &str, delimiter: &str) -> usize {
    let lines: Vec<&str> = content.lines().take(10).collect();
    if lines.is_empty() {
        return 0;
    }

    let delimiter_char = delimiter.chars().next().unwrap_or(',');
    let counts: Vec<usize> = lines
        .iter()
        .map(|line| line.matches(delimiter_char).count())
        .collect();

    if counts.is_empty() {
        return 0;
    }

    // Score based on: number of delimiters * consistency
    let first_count = counts[0];
    let consistent_count = counts.iter().filter(|&&c| c == first_count).count();

    // Prefer delimiters that have at least one occurrence and are consistent
    if first_count == 0 {
        0
    } else {
        first_count * consistent_count
    }
}

/// Parses CSV content and returns headers and data rows.
fn parse_csv_content(
    content: &str,
    delimiter: u8,
    config: &ParseConfig,
    errors: &mut Vec<ParseError>,
) -> Result<(Vec<String>, Vec<Vec<String>>)> {
    let quote_byte = config.quote_byte();
    let skip_top = config.top_skip();
    let skip_bottom = config.bottom_skip();
    let skip_empty = config.skip_empty();
    let has_header = config.has_header();
    let header_index = config.header_index();

    // Build CSV reader
    let mut reader = ReaderBuilder::new()
        .delimiter(delimiter)
        .quote(quote_byte)
        .has_headers(false) // We handle headers manually for more control
        .flexible(true) // Allow varying number of fields
        .terminator(Terminator::Any(b'\n'))
        .from_reader(content.as_bytes());

    // Collect all records
    let mut all_records: Vec<Vec<String>> = Vec::new();
    for (idx, result) in reader.records().enumerate() {
        match result {
            Ok(record) => {
                let row: Vec<String> = record.iter().map(|s| s.to_string()).collect();
                all_records.push(row);
            }
            Err(e) => {
                errors.push(ParseError::new_parse(
                    Some(idx),
                    None,
                    format!("Failed to parse row {}: {}", idx + 1, e),
                ));
            }
        }
    }

    if all_records.is_empty() {
        return Err(Error::Validation(ValidationError::InvalidInput(
            "CSV file is empty or contains no valid records".to_string(),
        )));
    }

    // Skip top rows
    let start_index = skip_top;
    if start_index >= all_records.len() {
        return Err(Error::Validation(ValidationError::InvalidInput(format!(
            "Cannot skip {} rows from a file with {} rows",
            skip_top,
            all_records.len()
        ))));
    }

    // Skip bottom rows
    let end_index = if skip_bottom > 0 {
        all_records.len().saturating_sub(skip_bottom)
    } else {
        all_records.len()
    };

    if start_index >= end_index {
        return Err(Error::Validation(ValidationError::InvalidInput(
            "No rows remaining after applying skip settings".to_string(),
        )));
    }

    let working_records: Vec<Vec<String>> = all_records[start_index..end_index].to_vec();

    // Filter empty rows if configured
    let filtered_records: Vec<Vec<String>> = if skip_empty {
        working_records
            .into_iter()
            .filter(|row| !row.iter().all(|cell| cell.trim().is_empty()))
            .collect()
    } else {
        working_records
    };

    if filtered_records.is_empty() {
        return Err(Error::Validation(ValidationError::InvalidInput(
            "No non-empty rows found in CSV".to_string(),
        )));
    }

    // Extract headers
    let (headers, data_rows) = if has_header {
        let effective_header_index = header_index.min(filtered_records.len().saturating_sub(1));
        let headers = filtered_records
            .get(effective_header_index)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|h| h.trim().to_string())
            .collect();

        // Data rows are everything after the header row
        let data: Vec<Vec<String>> = filtered_records
            .into_iter()
            .enumerate()
            .filter(|(i, _)| *i != effective_header_index)
            .map(|(_, row)| row)
            .collect();

        (headers, data)
    } else {
        // No headers - generate column names
        let max_cols = filtered_records.iter().map(|r| r.len()).max().unwrap_or(0);
        let headers: Vec<String> = (0..max_cols).map(|i| format!("Column{}", i + 1)).collect();
        (headers, filtered_records)
    };

    // Normalize row lengths to match header count
    let header_count = headers.len();
    let normalized_rows: Vec<Vec<String>> = data_rows
        .into_iter()
        .enumerate()
        .map(|(idx, mut row)| {
            if row.len() < header_count {
                // Add empty strings for missing columns
                row.resize(header_count, String::new());
            } else if row.len() > header_count {
                // Log warning and truncate
                errors.push(ParseError::structure_error(format!(
                    "Row {} has {} columns, expected {}. Extra columns ignored.",
                    idx + 1,
                    row.len(),
                    header_count
                )));
                row.truncate(header_count);
            }
            row
        })
        .collect();

    Ok((headers, normalized_rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_csv() {
        let content = b"name,age,city\nAlice,30,NYC\nBob,25,LA";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.headers, vec!["name", "age", "city"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0], vec!["Alice", "30", "NYC"]);
        assert_eq!(result.rows[1], vec!["Bob", "25", "LA"]);
        assert_eq!(result.detected_config.delimiter, Some(",".to_string()));
    }

    #[test]
    fn test_parse_semicolon_delimiter() {
        let content = b"name;age;city\nAlice;30;NYC\nBob;25;LA";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.headers, vec!["name", "age", "city"]);
        assert_eq!(result.detected_config.delimiter, Some(";".to_string()));
    }

    #[test]
    fn test_parse_explicit_delimiter() {
        let content = b"name;age;city\nAlice;30;NYC";
        let config = ParseConfig {
            delimiter: Some(";".to_string()),
            ..Default::default()
        };

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.headers, vec!["name", "age", "city"]);
    }

    #[test]
    fn test_parse_tab_delimiter() {
        let content = b"name\tage\tcity\nAlice\t30\tNYC";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.headers, vec!["name", "age", "city"]);
        assert_eq!(result.detected_config.delimiter, Some("\t".to_string()));
    }

    #[test]
    fn test_skip_top_rows() {
        let content = b"Some title\nAnother line\nname,age\nAlice,30";
        let config = ParseConfig {
            skip_top_rows: Some(2),
            ..Default::default()
        };

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.headers, vec!["name", "age"]);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0], vec!["Alice", "30"]);
    }

    #[test]
    fn test_skip_bottom_rows() {
        let content = b"name,age\nAlice,30\nBob,25\nTotal,55";
        let config = ParseConfig {
            skip_bottom_rows: Some(1),
            ..Default::default()
        };

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[1], vec!["Bob", "25"]);
    }

    #[test]
    fn test_no_header_row() {
        let content = b"Alice,30,NYC\nBob,25,LA";
        let config = ParseConfig {
            has_header_row: Some(false),
            ..Default::default()
        };

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.headers, vec!["Column1", "Column2", "Column3"]);
        assert_eq!(result.rows.len(), 2);
    }

    #[test]
    fn test_skip_empty_rows() {
        let content = b"name,age\nAlice,30\n\nBob,25";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.rows.len(), 2);
    }

    #[test]
    fn test_keep_empty_rows() {
        let content = b"name,age\nAlice,30\n,\nBob,25";
        let config = ParseConfig {
            skip_empty_rows: Some(false),
            ..Default::default()
        };

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.rows.len(), 3);
    }

    #[test]
    fn test_utf8_bom() {
        // UTF-8 BOM: EF BB BF
        let content = b"\xEF\xBB\xBFname,age\nAlice,30";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.headers, vec!["name", "age"]);
    }

    #[test]
    fn test_windows_1252_is_detected_and_decoded() {
        // A European bank export saved as Windows-1252 (é = E9, ü = FC).
        let content = b"date,description,amount\n2026-01-02,Caf\xE9 M\xFCller,12.50\n2026-01-03,R\xE9sum\xE9 fee,3.00";

        assert_eq!(detect_encoding(content), encoding_rs::WINDOWS_1252);
        let result = parse_csv(content, &ParseConfig::default()).unwrap();
        assert_eq!(result.rows[0], vec!["2026-01-02", "Café Müller", "12.50"]);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_shift_jis_is_detected_and_decoded() {
        let text = "日付,摘要,金額\n2026/01/02,東京電力,1200\n2026/01/03,コンビニ,450";
        let (content, _, _) = encoding_rs::SHIFT_JIS.encode(text);

        assert_eq!(detect_encoding(&content), encoding_rs::SHIFT_JIS);
        let result = parse_csv(&content, &ParseConfig::default()).unwrap();
        assert_eq!(result.headers, vec!["日付", "摘要", "金額"]);
        assert_eq!(result.rows[0], vec!["2026/01/02", "東京電力", "1200"]);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_quoted_fields() {
        let content = b"name,description\nAlice,\"Hello, World\"\nBob,\"Line1\nLine2\"";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.rows[0], vec!["Alice", "Hello, World"]);
    }

    #[test]
    fn test_uneven_columns() {
        let content = b"a,b,c\n1,2\n3,4,5,6";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config).unwrap();

        // First row should be padded
        assert_eq!(result.rows[0], vec!["1", "2", ""]);
        // Second row should be truncated (with error logged)
        assert_eq!(result.rows[1], vec!["3", "4", "5"]);
        // Should have a structure error for the extra columns
        assert!(result.errors.iter().any(|e| e.error_type == "structure"));
    }

    #[test]
    fn test_empty_csv_error() {
        let content = b"";
        let config = ParseConfig::default();

        let result = parse_csv(content, &config);
        assert!(result.is_err());
    }

    #[test]
    fn test_custom_quote_char() {
        let content = b"name,city\nAlice,'New York'";
        let config = ParseConfig {
            quote_char: Some("'".to_string()),
            ..Default::default()
        };

        let result = parse_csv(content, &config).unwrap();

        assert_eq!(result.rows[0][1], "New York");
    }
}
