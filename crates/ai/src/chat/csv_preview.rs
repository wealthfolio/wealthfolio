//! What the model sees of an attached CSV file.
//!
//! `import_csv` reads the attached file itself, so the model only needs
//! enough of it to write the mapping. A small file is shown whole. A large
//! file is shown as a preview: its first and last lines verbatim (preamble,
//! header, footer) and the distinct values of each column that has few of
//! them, which is where symbols, activity types, currencies and accounts
//! show up.

use std::collections::{HashMap, HashSet};

use csv::{ReaderBuilder, StringRecord};

/// Files up to this size (about 2,500 tokens) are shown whole.
const FULL_FILE_MAX_BYTES: usize = 8 * 1024;
const HEAD_LINES: usize = 40;
const TAIL_LINES: usize = 5;
const MAX_LINE_CHARS: usize = 1_000;
/// Columns with more distinct values than this are left out of the list.
const MAX_DISTINCT_VALUES: usize = 40;
const MAX_VALUE_CHARS: usize = 60;
const MAX_COLUMNS: usize = 40;

/// The delimited CSV block added to the user prompt for an attached file.
pub(super) fn csv_prompt_block(name: &str, data: &str) -> String {
    if data.len() <= FULL_FILE_MAX_BYTES {
        return format!("[BEGIN UNTRUSTED CSV DATA: {name}]\n{data}\n[END UNTRUSTED CSV DATA]");
    }

    let lines: Vec<&str> = data.lines().collect();
    let head_end = lines.len().min(HEAD_LINES);
    let tail_start = lines.len().saturating_sub(TAIL_LINES).max(head_end);
    let mut block = format!(
        "[BEGIN UNTRUSTED CSV DATA: {name} (preview of {} lines; import_csv reads the whole file)]\n",
        lines.len()
    );
    for line in &lines[..head_end] {
        block.push_str(&truncate_chars(line, MAX_LINE_CHARS));
        block.push('\n');
    }
    if tail_start > head_end {
        block.push_str(&format!(
            "[... {} lines not shown ...]\n",
            tail_start - head_end
        ));
    }
    for line in &lines[tail_start..] {
        block.push_str(&truncate_chars(line, MAX_LINE_CHARS));
        block.push('\n');
    }

    let distinct = distinct_values_by_column(data);
    if !distinct.is_empty() {
        block.push_str(&format!(
            "[DISTINCT VALUES PER COLUMN (columns with at most {MAX_DISTINCT_VALUES})]\n"
        ));
        for (label, values) in distinct {
            block.push_str(&format!("{label}: {}\n", values.join(" | ")));
        }
    }
    block.push_str("[END UNTRUSTED CSV DATA]");
    block
}

/// Rows of the file's main table, header first: the records with the most
/// common field count, read with the delimiter that yields the most of them.
/// Preamble and footer lines have other field counts and drop out.
fn table_records(data: &str) -> Vec<StringRecord> {
    // Reversed so that `max_by_key`, which keeps the last maximum, prefers
    // the comma on ties.
    b"\t;,"
        .iter()
        .copied()
        .map(|delimiter| {
            let records: Vec<StringRecord> = ReaderBuilder::new()
                .delimiter(delimiter)
                .has_headers(false)
                .flexible(true)
                .from_reader(data.as_bytes())
                .records()
                .filter_map(Result::ok)
                .collect();
            let mut width_counts: HashMap<usize, usize> = HashMap::new();
            for record in records.iter().filter(|record| record.len() >= 2) {
                *width_counts.entry(record.len()).or_default() += 1;
            }
            let Some(width) = width_counts
                .into_iter()
                .max_by_key(|(width, count)| (*count, *width))
                .map(|(width, _)| width)
            else {
                return Vec::new();
            };
            records
                .into_iter()
                .filter(|record| record.len() == width)
                .collect()
        })
        .max_by_key(Vec::len)
        .unwrap_or_default()
}

fn distinct_values_by_column(data: &str) -> Vec<(String, Vec<String>)> {
    let records = table_records(data);
    let Some((header, rows)) = records.split_first() else {
        return Vec::new();
    };

    (0..header.len().min(MAX_COLUMNS))
        .filter_map(|column| {
            let mut seen = HashSet::new();
            let mut values = Vec::new();
            for row in rows {
                let value = row.get(column).unwrap_or_default().trim();
                if value.is_empty() || !seen.insert(value) {
                    continue;
                }
                if values.len() == MAX_DISTINCT_VALUES {
                    return None;
                }
                values.push(truncate_chars(value, MAX_VALUE_CHARS));
            }
            if values.is_empty() {
                return None;
            }
            let label = match header.get(column).unwrap_or_default().trim() {
                "" => format!("Column {}", column + 1),
                label => truncate_chars(label, MAX_VALUE_CHARS),
            };
            Some((label, values))
        })
        .collect()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    match value.char_indices().nth(max_chars) {
        Some((index, _)) => format!("{}…", &value[..index]),
        None => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trades_csv(rows: usize) -> String {
        let mut csv = String::from(
            "Account Statement\nAccount: 12345678\n\nTrade Date,Security,Type,Quantity,Amount\n",
        );
        let securities = ["\"Apple Inc, Common\"", "Microsoft Corp", "Cloudflare"];
        let types = ["Buy", "Sell", "Dividend"];
        for row in 0..rows {
            csv.push_str(&format!(
                "2024-01-{:02},{},{},{},{}.50\n",
                row % 28 + 1,
                securities[row % securities.len()],
                types[row % types.len()],
                row + 1,
                row * 10
            ));
        }
        csv.push_str("Total,,,,12345.00\n");
        csv
    }

    #[test]
    fn small_file_is_shown_whole() {
        // More lines than a preview shows, but under the size limit.
        let csv = trades_csv(120);
        assert!(csv.len() <= FULL_FILE_MAX_BYTES);
        let block = csv_prompt_block("trades.csv", &csv);

        assert_eq!(
            block,
            format!("[BEGIN UNTRUSTED CSV DATA: trades.csv]\n{csv}\n[END UNTRUSTED CSV DATA]")
        );
    }

    #[test]
    fn large_file_shows_head_tail_and_distinct_values() {
        let csv = trades_csv(500);
        let block = csv_prompt_block("trades.csv", &csv);
        let lines: Vec<&str> = csv.lines().collect();

        assert!(block.starts_with(
            "[BEGIN UNTRUSTED CSV DATA: trades.csv (preview of 505 lines; import_csv reads the whole file)]\n"
        ));
        // Preamble, blank line and header are shown verbatim.
        assert!(block.contains(&format!("{}\n", lines[..HEAD_LINES].join("\n"))));
        assert!(block.contains("[... 460 lines not shown ...]\n"));
        assert!(block.contains(&format!(
            "{}\n",
            lines[lines.len() - TAIL_LINES..].join("\n")
        )));
        assert!(!block.contains(lines[HEAD_LINES]));

        assert!(block.contains("Security: Apple Inc, Common | Microsoft Corp | Cloudflare\n"));
        assert!(block.contains("Type: Buy | Sell | Dividend\n"));
        // Quantities and amounts are all distinct, so they are left out.
        assert!(!block.contains("Quantity:"));
        assert!(!block.contains("Amount:"));
        assert!(block.ends_with("[END UNTRUSTED CSV DATA]"));
        assert!(block.len() < 4_000, "preview is {} bytes", block.len());
    }

    #[test]
    fn large_file_with_few_lines_is_previewed_with_lines_cut() {
        let note = "x".repeat(3 * MAX_LINE_CHARS);
        let csv = format!("Date,Note\n2024-01-01,{note}\n2024-01-02,{note}\n2024-01-03,{note}\n");
        assert!(csv.len() > FULL_FILE_MAX_BYTES);

        let block = csv_prompt_block("notes.csv", &csv);

        assert!(block.starts_with("[BEGIN UNTRUSTED CSV DATA: notes.csv (preview of 4 lines"));
        assert!(!block.contains("lines not shown"));
        assert!(block.contains(&format!("2024-01-03,{}…\n", &note[..MAX_LINE_CHARS - 11])));
        assert!(block.len() < 5 * MAX_LINE_CHARS);
    }

    #[test]
    fn semicolon_file_with_decimal_commas_uses_semicolon_columns() {
        let mut csv = String::from("Datum;Fonds;Aktion;Betrag\n");
        for row in 0..400 {
            let fund = if row % 2 == 0 {
                "MSCI World"
            } else {
                "DAX ETF"
            };
            csv.push_str(&format!("0{}.01.2024;{fund};Kauf;{row},50\n", row % 9 + 1));
        }

        let block = csv_prompt_block("depot.csv", &csv);

        assert!(block.contains("Fonds: MSCI World | DAX ETF\n"));
        assert!(block.contains("Aktion: Kauf\n"));
    }

    #[test]
    fn long_lines_and_values_are_truncated() {
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        assert_eq!(truncate_chars("ébc", 3), "ébc");
        assert_eq!(truncate_chars("ébcd", 1), "é…");
    }
}
