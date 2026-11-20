//! Reads an Excel (.xlsx) statement into the text rows the CSV parser produces.
//!
//! The first visible worksheet is read from cell A1, so row and column positions
//! match a CSV saved from the same sheet. Cells become text:
//! - numbers use up to 15 significant digits, as Excel shows them, with the
//!   decimal separator the import's number settings read;
//! - date cells become `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS`, or `HH:MM:SS` for a
//!   time alone;
//! - formula cells use the value last saved with the file;
//! - a merged range keeps its value in its first cell.

use std::io::Cursor;

use calamine::{DataRef, Reader, SheetType, SheetVisible, Xlsx, XlsxError};

use crate::errors::{Error, ValidationError};
use crate::Result;

/// ZIP local file header: an .xlsx workbook, or another ZIP-based file.
const ZIP_MAGIC: &[u8] = b"PK\x03\x04";
/// OLE compound file: a password-protected .xlsx, or an older .xls workbook.
const CFB_MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// Rows × columns read from A1 to the last value. Statements are far smaller;
/// the cap stops one far-off cell from allocating a whole sheet.
const MAX_CELLS: u64 = 5_000_000;

/// Whether the bytes are a spreadsheet container rather than CSV text.
pub(crate) fn is_spreadsheet(content: &[u8]) -> bool {
    content.starts_with(ZIP_MAGIC) || content.starts_with(CFB_MAGIC)
}

/// Reads the first visible worksheet into rows of text cells, writing a number
/// cell's fraction after `decimal_separator`.
pub(crate) fn read_xlsx_rows(content: &[u8], decimal_separator: char) -> Result<Vec<Vec<String>>> {
    let mut workbook = Xlsx::new(Cursor::new(content)).map_err(open_error)?;
    let sheet = workbook
        .sheets_metadata()
        .iter()
        .find(|sheet| sheet.typ == SheetType::WorkSheet && sheet.visible == SheetVisible::Visible)
        .map(|sheet| sheet.name.clone())
        .ok_or_else(|| invalid("The spreadsheet has no visible worksheet."))?;

    let mut cells = workbook
        .worksheet_cells_reader(&sheet)
        .map_err(|_| unreadable())?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut width = 0usize;
    let mut height = 0usize;
    while let Some(cell) = cells.next_cell().map_err(|_| unreadable())? {
        let text = cell_text(cell.get_value(), decimal_separator);
        if text.is_empty() {
            continue;
        }
        let (row, col) = cell.get_position();
        let (row, col) = (row as usize, col as usize);
        width = width.max(col + 1);
        height = height.max(row + 1);
        if (height as u64).saturating_mul(width as u64) > MAX_CELLS {
            return Err(invalid("The spreadsheet is too large to import."));
        }
        if rows.len() <= row {
            rows.resize_with(row + 1, Vec::new);
        }
        let cells_in_row = &mut rows[row];
        if cells_in_row.len() <= col {
            cells_in_row.resize(col + 1, String::new());
        }
        cells_in_row[col] = text;
    }

    if rows.is_empty() {
        return Err(invalid("The spreadsheet's first sheet is empty."));
    }
    // Every row spans the sheet's used columns, as in a CSV saved from it.
    for row in &mut rows {
        row.resize(width, String::new());
    }
    Ok(rows)
}

fn cell_text(value: &DataRef<'_>, decimal_separator: char) -> String {
    match value {
        DataRef::Empty => String::new(),
        DataRef::String(text) => text.clone(),
        DataRef::SharedString(text) => (*text).to_string(),
        DataRef::Int(number) => number.to_string(),
        DataRef::Float(number) => float_text(*number, decimal_separator),
        DataRef::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        DataRef::DateTime(date) if date.is_duration() => date
            .as_duration()
            .map(|duration| {
                let seconds = duration.num_seconds();
                let sign = if seconds < 0 { "-" } else { "" };
                let seconds = seconds.unsigned_abs();
                format!(
                    "{sign}{}:{:02}:{:02}",
                    seconds / 3600,
                    seconds % 3600 / 60,
                    seconds % 60
                )
            })
            .unwrap_or_else(|| float_text(date.as_f64(), decimal_separator)),
        DataRef::DateTime(date) => match date.as_datetime() {
            Some(datetime) if date.as_f64() < 1.0 => datetime.format("%H:%M:%S").to_string(),
            Some(datetime) if datetime.time() == chrono::NaiveTime::MIN => {
                datetime.format("%Y-%m-%d").to_string()
            }
            Some(datetime) => datetime.format("%Y-%m-%d %H:%M:%S").to_string(),
            None => float_text(date.as_f64(), decimal_separator),
        },
        DataRef::DateTimeIso(text) | DataRef::DurationIso(text) => text.clone(),
        DataRef::Error(error) => error.to_string(),
    }
}

/// Excel keeps 15 significant digits, so a saved 0.30000000000000004 shows as 0.3.
fn float_text(number: f64, decimal_separator: char) -> String {
    let rounded = format!("{number:.14e}").parse::<f64>().unwrap_or(number);
    if rounded == 0.0 {
        // Also drops the sign of -0.
        "0".to_string()
    } else {
        rounded
            .to_string()
            .replace('.', &decimal_separator.to_string())
    }
}

fn open_error(error: XlsxError) -> Error {
    match error {
        XlsxError::Password => Error::Validation(ValidationError::SpreadsheetPasswordProtected),
        _ => unreadable(),
    }
}

fn unreadable() -> Error {
    Error::Validation(ValidationError::SpreadsheetUnreadable)
}

fn invalid(message: &str) -> Error {
    Error::Validation(ValidationError::InvalidInput(message.to_string()))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::activities::{parse_csv, ParseConfig};

    /// Style indexes in `STYLES`: 0 general, 1 date, 2 date and time, 3 time, 4 duration.
    const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="[h]:mm:ss"/></numFmts>
<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="20"/><xf numFmtId="164"/></cellXfs>
</styleSheet>"#;

    /// Builds an .xlsx whose sheets hold the given `<sheetData>` rows, in order.
    /// A sheet named with a leading `~` is hidden.
    fn workbook(sheets: &[(&str, &str)], shared_strings: &[&str]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        let mut add = |name: &str, body: &str| {
            zip.start_file(name, options).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        };
        add(
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        );
        let mut entries = String::new();
        let mut rels = String::new();
        for (index, (name, _)) in sheets.iter().enumerate() {
            let id = index + 1;
            let (name, state) = match name.strip_prefix('~') {
                Some(name) => (name, r#" state="hidden""#),
                None => (*name, ""),
            };
            entries.push_str(&format!(
                r#"<sheet name="{name}" sheetId="{id}"{state} r:id="rId{id}"/>"#
            ));
            rels.push_str(&format!(
                r#"<Relationship Id="rId{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{id}.xml"/>"#
            ));
        }
        add(
            "xl/workbook.xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{entries}</sheets></workbook>"#
            ),
        );
        add(
            "xl/_rels/workbook.xml.rels",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>"#
            ),
        );
        add("xl/styles.xml", STYLES);
        let strings: String = shared_strings
            .iter()
            .map(|text| format!("<si><t>{text}</t></si>"))
            .collect();
        add(
            "xl/sharedStrings.xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{strings}</sst>"#
            ),
        );
        for (index, (_, rows)) in sheets.iter().enumerate() {
            add(
                &format!("xl/worksheets/sheet{}.xml", index + 1),
                &format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{rows}</sheetData></worksheet>"#
                ),
            );
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_a_statement_into_the_rows_a_csv_would_give() {
        // Row 1 is a title in B1, row 2 is blank, headers start in row 3 at
        // column B, and C4 is empty.
        let content = workbook(
            &[(
                "Statement",
                r#"<row r="1"><c r="B1" t="s"><v>0</v></c></row>
<row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3" t="s"><v>2</v></c><c r="D3" t="s"><v>3</v></c></row>
<row r="4"><c r="B4" s="1"><v>45672</v></c><c r="D4"><v>1234.5</v></c></row>
<row r="5"><c r="B5" s="2"><v>45672.5625</v></c><c r="C5" t="inlineStr"><is><t>Interest</t></is></c><c r="D5"><f>D4*2</f><v>2469</v></c></row>"#,
            )],
            &["PPF statement", "Date", "Description", "Amount"],
        );

        let result = parse_csv(
            &content,
            &ParseConfig {
                skip_top_rows: Some(1),
                delimiter: Some(";".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(result.headers, vec!["", "Date", "Description", "Amount"]);
        assert_eq!(
            result.rows,
            vec![
                vec!["", "2025-01-15", "", "1234.5"],
                vec!["", "2025-01-15 13:30:00", "Interest", "2469"],
            ]
        );
        assert_eq!(result.row_count, 2);
        assert!(result.errors.is_empty());
        // The CSV delimiter setting is left for the next CSV file.
        assert_eq!(result.detected_config.delimiter.as_deref(), Some(";"));
    }

    #[test]
    fn writes_cells_as_excel_shows_them() {
        let content = workbook(
            &[(
                "Sheet1",
                r#"<row r="1"><c r="A1"><v>0.30000000000000004</v></c><c r="B1"><v>-0</v></c><c r="C1"><v>1E+20</v></c><c r="D1"><v>-42</v></c></row>
<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#N/A</v></c><c r="C2" s="3"><v>0.6045138888888889</v></c><c r="D2" s="4"><v>1.5</v></c><c r="E2" s="4"><v>-0.020833333333333332</v></c></row>"#,
            )],
            &[],
        );

        let rows = read_xlsx_rows(&content, '.').unwrap();

        assert_eq!(
            rows,
            vec![
                vec!["0.3", "0", "100000000000000000000", "-42", ""],
                vec!["TRUE", "#N/A", "14:30:30", "36:00:00", "-0:30:00"],
            ]
        );
    }

    #[test]
    fn writes_numbers_with_the_decimal_separator_the_import_reads() {
        // A typed number and a text cell, under settings saved for comma decimals.
        let content = workbook(
            &[(
                "Sheet1",
                r#"<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2"><v>1234.5</v></c><c r="B2" t="s"><v>2</v></c></row>"#,
            )],
            &["Typed", "Text", "1234,5"],
        );

        for (decimal, thousands) in [
            (Some(","), None),
            (None, Some(".")),
            (Some("auto"), Some(".")),
        ] {
            let config = ParseConfig {
                decimal_separator: decimal.map(str::to_string),
                thousands_separator: thousands.map(str::to_string),
                ..Default::default()
            };
            let result = parse_csv(&content, &config).unwrap();
            assert_eq!(
                result.rows,
                vec![vec!["1234,5", "1234,5"]],
                "{decimal:?} {thousands:?}"
            );
        }
        for (decimal, thousands) in [
            (None, None),
            (Some("auto"), Some("auto")),
            (Some("."), Some(".")),
        ] {
            let config = ParseConfig {
                decimal_separator: decimal.map(str::to_string),
                thousands_separator: thousands.map(str::to_string),
                ..Default::default()
            };
            let result = parse_csv(&content, &config).unwrap();
            assert_eq!(
                result.rows,
                vec![vec!["1234.5", "1234,5"]],
                "{decimal:?} {thousands:?}"
            );
        }
    }

    #[test]
    fn reads_the_first_visible_worksheet() {
        let content = workbook(
            &[
                (
                    "~Hidden",
                    r#"<row r="1"><c r="A1" t="s"><v>0</v></c></row>"#,
                ),
                (
                    "Visible",
                    r#"<row r="1"><c r="A1" t="s"><v>1</v></c></row>"#,
                ),
            ],
            &["hidden", "visible"],
        );

        assert_eq!(
            read_xlsx_rows(&content, '.').unwrap(),
            vec![vec!["visible"]]
        );
    }

    #[test]
    fn refuses_a_sheet_whose_used_range_is_too_large() {
        let content = workbook(
            &[(
                "Sheet1",
                r#"<row r="1"><c r="A1"><v>1</v></c></row>
<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>"#,
            )],
            &[],
        );

        let error = read_xlsx_rows(&content, '.').unwrap_err();
        assert!(
            matches!(error, Error::Validation(ValidationError::InvalidInput(_))),
            "{error}"
        );
    }

    #[test]
    fn refuses_an_empty_sheet() {
        let content = workbook(&[("Sheet1", "")], &[]);

        assert!(matches!(
            parse_csv(&content, &ParseConfig::default()),
            Err(Error::Validation(ValidationError::InvalidInput(_)))
        ));
    }

    #[test]
    fn names_a_spreadsheet_it_cannot_read() {
        let mut other_zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        other_zip
            .start_file("notes.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        let other_zip = other_zip.finish().unwrap().into_inner();
        let mut old_xls = CFB_MAGIC.to_vec();
        old_xls.extend([0; 504]);

        for content in [other_zip, old_xls] {
            assert!(matches!(
                parse_csv(&content, &ParseConfig::default()),
                Err(Error::Validation(ValidationError::SpreadsheetUnreadable))
            ));
        }
    }

    #[test]
    fn names_a_password_protected_workbook() {
        assert!(matches!(
            open_error(XlsxError::Password),
            Error::Validation(ValidationError::SpreadsheetPasswordProtected)
        ));
        let public = open_error(XlsxError::Password).public_error();
        assert_eq!(
            public.error_code,
            crate::errors::SPREADSHEET_PASSWORD_PROTECTED
        );
        assert_eq!(
            Error::Validation(ValidationError::SpreadsheetUnreadable)
                .public_error()
                .error_code,
            crate::errors::SPREADSHEET_UNREADABLE
        );
    }

    #[test]
    fn leaves_csv_text_to_the_csv_reader() {
        assert!(!is_spreadsheet(b"Date,Amount\n2025-01-15,10"));
        assert!(!is_spreadsheet(b""));
    }
}
