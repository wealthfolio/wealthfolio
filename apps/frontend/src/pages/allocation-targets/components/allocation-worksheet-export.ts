import type {
  AllocationWorksheetLineResult,
  AllocationWorksheetResult,
  CalculatedAdjustments,
} from "@/lib/types";

/** A number written with a fixed count of decimals, the way sums are read. */
export interface DecimalCell {
  decimal: number;
  digits: number;
}

export type ExportCell = string | number | DecimalCell;

function decimal(value: number, digits = 2): DecimalCell {
  return { decimal: value, digits };
}

/** Every text the table carries, already translated by the caller. */
export interface WorksheetExportLabels {
  title: string;
  target: string;
  calculatedAt: string;
  accounts: string;
  mode: string;
  modeValue: string;
  rule: string;
  ruleValue: string;
  trackedCash: string;
  externalCash: string;
  eligible: string;
  eligibleValue: string;
  /** Sentences saying which amounts the calculation scaled, if any. */
  scaling: readonly string[];
  /** Said with the context when inputs changed after the calculation. */
  outOfDate?: string;
  /** Heads the last column and labels each sentence of the context. */
  note: string;
  category: string;
  symbol: string;
  security: string;
  account: string;
  amount: string;
  quantity: string;
  price: string;
  priceDate: string;
  warnings: string;
  statusUnresolved: string;
  unknownAccount: string;
  total: string;
  cashLeft: string;
  limitationsTitle: string;
  limitations: string;
}

export interface WorksheetExportInput {
  result: AllocationWorksheetResult;
  /** The last calculation, for the amounts it could not place. */
  calculated: CalculatedAdjustments | null;
  accountNames: ReadonlyMap<string, string>;
  accountIds: readonly string[];
  trackedCashToUse: number;
  externalCash: number;
}

function lineCategory(line: AllocationWorksheetLineResult): string {
  const exposures = line.categoryExposures.filter((exposure) => exposure.weightBps > 0);
  if (exposures.length === 1 && exposures[0].weightBps >= 10_000) {
    return exposures[0].categoryName;
  }
  return exposures
    .map((exposure) => `${exposure.categoryName} ${Math.round(exposure.weightBps / 100)}%`)
    .join(" · ");
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * Prices are stored as 32-bit floats and widened, so 59.71 arrives as
 * 59.709999. Seven significant digits is what the stored value holds.
 */
function storedPrice(value: number): number {
  return Number(value.toPrecision(7));
}

/** Local date and time to the minute, as the user would write it. */
function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function signedAmount(line: AllocationWorksheetLineResult): number {
  return line.direction === "increase" ? line.estimatedAmount : -line.estimatedAmount;
}

/** Wide enough for a security's name, which shares the column. */
const TEXT_WIDTH = 70;

/**
 * Breaks a sentence into lines inside its cell. A spreadsheet sizes a column
 * to its longest line, so one long sentence would otherwise widen the whole
 * table. Scripts written without spaces break anywhere.
 */
export function wrapText(text: string, width = TEXT_WIDTH): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (word.length > width) {
      if (line) lines.push(line);
      const pieces = word.match(new RegExp(`.{1,${Math.floor(width / 2)}}`, "gu")) ?? [word];
      lines.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1];
    } else if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/**
 * The export table (§8), laid out to be read first and kept narrow: the lines
 * grouped by account, the amounts the calculation could not place, each
 * account's total and the cash it has left, then what the worksheet was
 * calculated from, the warnings and the limitations. Amounts are signed, so a
 * reduction reads as a negative amount; quantities are estimates. Nothing
 * reads like an order ticket.
 */
export function worksheetExportRows(
  input: WorksheetExportInput,
  labels: WorksheetExportLabels,
): ExportCell[][] {
  const { result, calculated } = input;
  const currency = result.baseCurrency;
  const accountName = (accountId: string) =>
    input.accountNames.get(accountId) ?? labels.unknownAccount;
  const warningsByLine = new Map<string, string[]>();
  for (const warning of result.warnings) {
    if (!warning.lineId) continue;
    warningsByLine.set(warning.lineId, [
      ...(warningsByLine.get(warning.lineId) ?? []),
      warning.message,
    ]);
  }
  const lines = [...result.lines].sort(
    (left, right) =>
      accountName(left.accountId).localeCompare(accountName(right.accountId)) ||
      left.symbol.localeCompare(right.symbol),
  );

  const rows: ExportCell[][] = [
    [
      labels.account,
      labels.symbol,
      labels.security,
      `${labels.amount} (${currency})`,
      labels.quantity,
      `${labels.price} (${currency})`,
      labels.category,
      labels.priceDate,
      labels.note,
    ],
  ];

  for (const line of lines) {
    rows.push([
      accountName(line.accountId),
      line.symbol,
      line.name,
      decimal(signedAmount(line)),
      round(line.direction === "increase" ? line.quantity : -line.quantity, 6),
      storedPrice(line.unitPrice),
      lineCategory(line),
      line.quoteSource.timestamp.slice(0, 10),
      (warningsByLine.get(line.lineId) ?? []).join("; "),
    ]);
  }
  // Part of the picture, so part of the table rather than only on screen.
  for (const item of calculated?.unresolved ?? []) {
    rows.push([
      "",
      "",
      "",
      decimal(item.amount),
      "",
      "",
      item.categoryName,
      "",
      labels.statusUnresolved,
    ]);
  }

  // A table of its own rather than total rows among the lines, so a sum or a
  // filter over the amounts column counts each line once.
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const fundingByAccount = new Map(
    result.accountFunding.map((funding) => [funding.accountId, funding]),
  );
  if (accountIds.length > 0) {
    rows.push(
      [],
      [labels.account, `${labels.total} (${currency})`, `${labels.cashLeft} (${currency})`],
    );
    for (const accountId of accountIds) {
      const net = lines
        .filter((line) => line.accountId === accountId)
        .reduce((sum, line) => sum + signedAmount(line), 0);
      const funding = fundingByAccount.get(accountId);
      rows.push([accountName(accountId), decimal(net), funding ? decimal(funding.remaining) : ""]);
    }
  }

  // The context reads label, value: the label first, the value under the
  // security names, where a sentence is no wider than they are.
  const context = (label: string, value: ExportCell): ExportCell[] => [
    label,
    "",
    typeof value === "string" ? wrapText(value) : value,
  ];
  rows.push(
    [],
    [labels.title],
    context(labels.target, result.targetName),
    context(labels.calculatedAt, localDateTime(result.calculatedAt)),
    context(labels.accounts, input.accountIds.map(accountName).join(", ")),
    context(labels.mode, labels.modeValue),
    context(labels.rule, labels.ruleValue),
    context(labels.eligible, labels.eligibleValue),
    context(`${labels.trackedCash} (${currency})`, decimal(input.trackedCashToUse)),
    context(`${labels.externalCash} (${currency})`, decimal(input.externalCash)),
    ...labels.scaling.map((sentence) => context(labels.note, sentence)),
    ...(labels.outOfDate ? [context(labels.note, labels.outOfDate)] : []),
  );
  result.warnings.forEach((warning, index) => {
    rows.push(context(index === 0 ? labels.warnings : "", warning.message));
  });
  rows.push(context(labels.limitationsTitle, labels.limitations));
  return rows;
}

/** A text a spreadsheet would run as a formula is kept as text. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function textCell(value: ExportCell, decimalSeparator: string): string {
  if (typeof value === "object") {
    // A sign is part of the number, not a formula.
    const fixed = value.decimal.toFixed(value.digits);
    const text = Number(fixed) === 0 ? (0).toFixed(value.digits) : fixed;
    return text.replace(".", decimalSeparator);
  }
  if (typeof value === "number") return String(value).replace(".", decimalSeparator);
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/**
 * A spreadsheet reads a number only in its own format, so numbers carry the
 * user's decimal mark, without group separators. Where that mark is a comma,
 * columns are separated by semicolons, as spreadsheets there expect.
 */
export function toCsv(rows: readonly ExportCell[][], decimalSeparator = "."): string {
  const separator = decimalSeparator === "," ? ";" : ",";
  return rows
    .map((row) =>
      row
        .map((cell) => `"${textCell(cell, decimalSeparator).replaceAll('"', '""')}"`)
        .join(separator),
    )
    .join("\n");
}

/** The same table for the clipboard, so it pastes into a spreadsheet as cells. */
export function toTsv(rows: readonly ExportCell[][], decimalSeparator = "."): string {
  return rows
    .map((row) =>
      row.map((cell) => textCell(cell, decimalSeparator).replace(/[\t\r\n]+/g, " ")).join("\t"),
    )
    .join("\n");
}

/**
 * The CSV as a file. The byte order mark lets spreadsheet apps read accented
 * names as UTF-8.
 */
export function csvFile(csv: string): Blob {
  return new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
}
