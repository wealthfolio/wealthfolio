/**
 * Pasted tables become CSV attachments, so `import_csv` reads the exact text
 * the user pasted instead of a copy the model writes into the tool call.
 */

const PASTED_CSV_BASENAME = "pasted";

/** Non-empty records; a line break inside quotes stays in its cell. */
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let record = "";
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "\n" && !inQuotes) {
      records.push(record.replace(/\r$/, ""));
      record = "";
      continue;
    }
    record += char;
  }
  records.push(record);
  return records.filter((line) => line.trim() !== "");
}

function countFields(line: string, delimiter: string): number {
  let fields = 1;
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      fields++;
    }
  }
  return fields;
}

/**
 * Whether pasted text is a table: at least two non-empty records that all split
 * into the same number of fields on one delimiter. With comma or semicolon, a
 * two-field table also needs a digit in every row after the header, so a few
 * lines of prose with one comma each stay text.
 */
export function isPastedCsvTable(text: string): boolean {
  const lines = splitRecords(text);
  if (lines.length < 2) return false;
  const rowsHaveDigits = lines.slice(1).every((line) => /\d/.test(line));

  return ["\t", ",", ";"].some((delimiter) => {
    const minFields = delimiter === "\t" || rowsHaveDigits ? 2 : 3;
    const fields = countFields(lines[0], delimiter);
    return fields >= minFields && lines.every((line) => countFields(line, delimiter) === fields);
  });
}

/** `pasted.csv`, or `pasted-2.csv` and so on when the name is taken. */
export function pastedCsvFileName(existingNames: readonly string[]): string {
  const taken = new Set(existingNames);
  let name = `${PASTED_CSV_BASENAME}.csv`;
  for (let n = 2; taken.has(name); n++) {
    name = `${PASTED_CSV_BASENAME}-${n}.csv`;
  }
  return name;
}
