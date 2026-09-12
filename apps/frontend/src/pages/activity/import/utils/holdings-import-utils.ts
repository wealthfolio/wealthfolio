import { parse, parseISO, isValid, format as formatDate } from "date-fns";

import type { HoldingsSnapshotInput, HoldingsPositionInput } from "@/lib/types";
import {
  DAY_FIRST_NUMERIC_FORMATS,
  type DateOrder,
  MONTH_FIRST_NUMERIC_FORMATS,
  detectDateOrder,
  isAmbiguousNumericDate,
  isDateInRange,
} from "@/lib/utils";
import type { DraftActivity } from "../context";
import { HoldingsFormat } from "../steps/holdings-mapping-step";
import { getDateFnsPattern } from "./date-format-options";

export const CASH_SYMBOL = "$CASH";

/**
 * Numeric dates like 03/08/2026 or 3-8-26 — the field order is not self-evident.
 * Deliberately broader than the detection regex in lib/utils: this only guards
 * the `new Date` fallback, and two-digit-year dates are exactly the input that
 * fallback would guess at, so they must not reach it either.
 */
const NUMERIC_DATE_SHAPE = /^\d{1,2}([/.-])\d{1,2}\1\d{2,4}$/;

/**
 * Numeric date patterns, ordered by which field leads. The resolved orders
 * reuse the shared lists so detection and parsing support the same formats.
 * `auto` keeps its historical sequence — dash dates read month-first here, so
 * files that parse correctly today keep doing so when a column yields no
 * evidence — with the single-digit forms appended: those used to be reachable
 * only through `new Date`, which guessed their field order.
 */
const NUMERIC_PATTERNS = {
  auto: [
    "MM/dd/yyyy",
    "dd/MM/yyyy",
    "MM-dd-yyyy",
    "dd-MM-yyyy",
    "dd.MM.yyyy",
    "MM.dd.yyyy",
    "M/d/yyyy",
    "d/M/yyyy",
    "M-d-yyyy",
    "d-M-yyyy",
    "d.M.yyyy",
    "M.d.yyyy",
    "yyyy/MM/dd",
  ],
  DMY: [...DAY_FIRST_NUMERIC_FORMATS, ...MONTH_FIRST_NUMERIC_FORMATS, "yyyy/MM/dd"],
  MDY: [...MONTH_FIRST_NUMERIC_FORMATS, ...DAY_FIRST_NUMERIC_FORMATS, "yyyy/MM/dd"],
} as const;

export interface ParseOptions {
  dateFormat: string;
  decimalSeparator: string;
  thousandsSeparator: string;
  defaultCurrency: string;
}

export interface HoldingsRowResolution {
  symbol?: string;
  exchangeMic?: string;
  quoteCcy?: string;
  instrumentType?: string;
  quoteMode?: string;
  providerId?: string;
  providerSymbol?: string;
  assetId?: string;
}

export function buildHoldingsRowResolutionMap(
  drafts: DraftActivity[],
  assetIdByKey: Record<string, string> = {},
): Record<number, HoldingsRowResolution> {
  const resolutions: Record<number, HoldingsRowResolution> = {};

  for (const draft of drafts) {
    if (draft.rowIndex < 0) continue;

    const resolvedAssetId =
      draft.assetId ||
      (draft.importAssetKey ? assetIdByKey[draft.importAssetKey] : undefined) ||
      (draft.assetCandidateKey ? assetIdByKey[draft.assetCandidateKey] : undefined);

    if (
      !draft.symbol &&
      !draft.exchangeMic &&
      !draft.quoteCcy &&
      !draft.instrumentType &&
      !draft.quoteMode &&
      !draft.providerId &&
      !draft.providerSymbol &&
      !resolvedAssetId
    ) {
      continue;
    }

    resolutions[draft.rowIndex] = {
      ...(draft.symbol ? { symbol: draft.symbol } : {}),
      ...(draft.exchangeMic ? { exchangeMic: draft.exchangeMic } : {}),
      ...(draft.quoteCcy ? { quoteCcy: draft.quoteCcy } : {}),
      ...(draft.instrumentType ? { instrumentType: draft.instrumentType } : {}),
      ...(draft.quoteMode ? { quoteMode: draft.quoteMode } : {}),
      ...(draft.providerId ? { providerId: draft.providerId } : {}),
      ...(draft.providerSymbol ? { providerSymbol: draft.providerSymbol } : {}),
      ...(resolvedAssetId ? { assetId: resolvedAssetId } : {}),
    };
  }

  return resolutions;
}

export function parseNumericValue(
  value: string | undefined,
  decimalSeparator: string,
  thousandsSeparator: string,
): string | undefined {
  if (!value || value.trim() === "") return undefined;

  let normalized = value.trim();
  let isNegative = false;

  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    isNegative = true;
    normalized = normalized.slice(1, -1);
  }

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  let resolvedDecimal = decimalSeparator;
  if (decimalSeparator === "auto") {
    if (lastComma !== -1 && lastDot !== -1) {
      resolvedDecimal = lastComma > lastDot ? "," : ".";
    } else if (lastComma !== -1) {
      resolvedDecimal = ",";
    } else {
      resolvedDecimal = ".";
    }
  }

  let cleaned = normalized.replace(/[^\d.,+-]/g, "");

  if (thousandsSeparator !== "none" && thousandsSeparator !== "auto") {
    cleaned = cleaned.replace(new RegExp(`\\${thousandsSeparator}`, "g"), "");
  } else {
    const defaultThousands = resolvedDecimal === "," ? "." : ",";
    cleaned = cleaned.replace(new RegExp(`\\${defaultThousands}`, "g"), "");
  }

  if (resolvedDecimal === ",") {
    const parts = cleaned.split(",");
    if (parts.length > 1) {
      const decimalPart = parts.pop() ?? "";
      cleaned = `${parts.join("")}.${decimalPart}`;
    }
  } else {
    const parts = cleaned.split(".");
    if (parts.length > 1) {
      const decimalPart = parts.pop() ?? "";
      cleaned = `${parts.join("")}.${decimalPart}`;
    }
  }

  let candidate = cleaned;
  if (isNegative && candidate && !candidate.startsWith("-")) {
    candidate = `-${candidate}`;
  }

  if (candidate === "" || candidate === "-" || candidate === "+") {
    return undefined;
  }

  const numericCheck = Number(candidate);
  return Number.isFinite(numericCheck) ? candidate : undefined;
}

export interface DateColumnAnalysis {
  /** Day/month order resolved from the column, if it carries the evidence. */
  order?: DateOrder;
  /** The column is numeric-ambiguous and nothing settles it — ask the user. */
  needsExplicitFormat: boolean;
  /** First unresolvable value, to show the user what is being guessed at. */
  ambiguousSample?: string;
}

/**
 * Inspect a holdings CSV's date column as a whole rather than row by row.
 *
 * A lone "03/08/2026" cannot be read, but a "26/06/2026" elsewhere in the same
 * column resolves every row in it. When the column is all-ambiguous and the
 * user left the format on auto-detect, say so instead of silently guessing.
 */
export function analyzeDateColumn(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  dateFormat: string,
): DateColumnAnalysis {
  if (dateFormat !== "auto") return { needsExplicitFormat: false };

  const dateHeader = mapping[HoldingsFormat.DATE];
  const dateIndex = dateHeader ? headers.indexOf(dateHeader) : -1;
  if (dateIndex < 0) return { needsExplicitFormat: false };

  const values = rows.map((row) => row[dateIndex] ?? "");
  const order = detectDateOrder(values) ?? undefined;
  if (order) return { order, needsExplicitFormat: false };

  const ambiguousSample = values.find(isAmbiguousNumericDate);
  return {
    needsExplicitFormat: ambiguousSample !== undefined,
    ...(ambiguousSample ? { ambiguousSample: ambiguousSample.trim() } : {}),
  };
}

export function parseDateToYMD(
  dateStr: string,
  dateFormat: string,
  order?: DateOrder,
): string | null {
  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  const pattern = getDateFnsPattern(dateFormat);
  if (pattern) {
    try {
      const parsed = parse(trimmed, pattern, new Date());
      if (isValid(parsed) && isDateInRange(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      // fall through to auto-detection
    }
  }

  if (dateFormat === "ISO8601") {
    try {
      const parsed = parseISO(trimmed);
      if (isValid(parsed) && isDateInRange(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      // fall through
    }
  }

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (isoMatch) {
    try {
      const parsed = parseISO(trimmed);
      if (isValid(parsed) && isDateInRange(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      // fall through
    }
  }

  // "03/08/2026" is 3 August or 8 March depending only on which pattern runs
  // first, so a day/month order resolved from the whole column decides it.
  // Without that evidence the existing per-separator order is left untouched.
  const commonPatterns = order ? NUMERIC_PATTERNS[order] : NUMERIC_PATTERNS.auto;
  for (const p of commonPatterns) {
    try {
      const parsed = parse(trimmed, p, new Date());
      if (isValid(parsed) && isDateInRange(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      continue;
    }
  }

  // Never hand a numeric date to the Date constructor: its day/month order is
  // engine-defined, so it reintroduces exactly the guess the patterns above
  // just resolved. Anything still unparsed here is not a numeric date.
  if (!NUMERIC_DATE_SHAPE.test(trimmed)) {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime()) && isDateInRange(date)) {
      return formatDate(date, "yyyy-MM-dd");
    }
  }

  return null;
}

export function parseHoldingsSnapshots(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  parseOptions: ParseOptions,
  symbolMappings?: Record<string, string>,
  symbolMeta?: Record<
    string,
    {
      exchangeMic?: string;
      quoteCcy?: string;
      instrumentType?: string;
      quoteMode?: string;
      providerId?: string;
      providerSymbol?: string;
    }
  >,
  rowResolutions?: Record<number, HoldingsRowResolution>,
): HoldingsSnapshotInput[] {
  return parseHoldingsSnapshotsInternal(
    headers,
    rows,
    mapping,
    parseOptions,
    symbolMappings,
    symbolMeta,
    rowResolutions,
    false,
  );
}

/**
 * Builds the validation/import payload without dropping malformed rows.
 * Keeping those rows in their date group lets the backend reject the whole
 * snapshot before any assets or holdings are persisted.
 */
export function parseHoldingsSnapshotsForValidation(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  parseOptions: ParseOptions,
  symbolMappings?: Record<string, string>,
  symbolMeta?: Record<
    string,
    {
      exchangeMic?: string;
      quoteCcy?: string;
      instrumentType?: string;
      quoteMode?: string;
      providerId?: string;
      providerSymbol?: string;
    }
  >,
  rowResolutions?: Record<number, HoldingsRowResolution>,
): HoldingsSnapshotInput[] {
  return parseHoldingsSnapshotsInternal(
    headers,
    rows,
    mapping,
    parseOptions,
    symbolMappings,
    symbolMeta,
    rowResolutions,
    true,
  );
}

function parseHoldingsSnapshotsInternal(
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  parseOptions: ParseOptions,
  symbolMappings: Record<string, string> | undefined,
  symbolMeta:
    | Record<
        string,
        {
          exchangeMic?: string;
          quoteCcy?: string;
          instrumentType?: string;
          quoteMode?: string;
          providerId?: string;
          providerSymbol?: string;
        }
      >
    | undefined,
  rowResolutions: Record<number, HoldingsRowResolution> | undefined,
  preserveInvalidRows: boolean,
): HoldingsSnapshotInput[] {
  const { dateFormat, decimalSeparator, thousandsSeparator, defaultCurrency } = parseOptions;

  const dateHeader = mapping[HoldingsFormat.DATE];
  const symbolHeader = mapping[HoldingsFormat.SYMBOL];
  const quantityHeader = mapping[HoldingsFormat.QUANTITY];
  const avgCostHeader = mapping[HoldingsFormat.AVG_COST];
  const currencyHeader = mapping[HoldingsFormat.CURRENCY];

  const dateIndex = dateHeader ? headers.indexOf(dateHeader) : -1;
  const { order: dateOrder } = analyzeDateColumn(headers, rows, mapping, dateFormat);
  const symbolIndex = symbolHeader ? headers.indexOf(symbolHeader) : -1;
  const quantityIndex = quantityHeader ? headers.indexOf(quantityHeader) : -1;
  const avgCostIndex = avgCostHeader ? headers.indexOf(avgCostHeader) : -1;
  const currencyIndex = currencyHeader ? headers.indexOf(currencyHeader) : -1;

  const snapshotsByDate = new Map<
    string,
    { positions: HoldingsPositionInput[]; cashBalances: Record<string, string> }
  >();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const rowResolution = rowResolutions?.[rowIndex];
    const rawDate = dateIndex >= 0 ? row[dateIndex]?.trim() : "";
    const rawSymbol = symbolIndex >= 0 ? row[symbolIndex]?.trim().toUpperCase() : "";
    const rawQuantity = quantityIndex >= 0 ? row[quantityIndex]?.trim() : "";
    const rawAvgCost = avgCostIndex >= 0 ? row[avgCostIndex]?.trim() : undefined;
    const currency = currencyIndex >= 0 ? row[currencyIndex]?.trim() : defaultCurrency;

    const normalizedDate = parseDateToYMD(rawDate, dateFormat, dateOrder);
    const parsedQuantity = parseNumericValue(rawQuantity, decimalSeparator, thousandsSeparator);
    const parsedAvgCost = parseNumericValue(rawAvgCost, decimalSeparator, thousandsSeparator);

    if (!preserveInvalidRows && (!normalizedDate || !rawSymbol || !parsedQuantity)) continue;

    const snapshotDate = normalizedDate ?? rawDate;
    const quantity = parsedQuantity ?? rawQuantity;
    const avgCost = parsedAvgCost ?? rawAvgCost;

    if (!snapshotsByDate.has(snapshotDate)) {
      snapshotsByDate.set(snapshotDate, { positions: [], cashBalances: {} });
    }

    const snapshot = snapshotsByDate.get(snapshotDate)!;
    const symbol = rowResolution?.symbol || symbolMappings?.[rawSymbol] || rawSymbol;

    if (symbol === CASH_SYMBOL && parsedQuantity) {
      const cashCurrency = currency || defaultCurrency;
      const existingAmount = parseFloat(snapshot.cashBalances[cashCurrency] || "0");
      const newAmount = parseFloat(quantity) || 0;
      snapshot.cashBalances[cashCurrency] = String(existingAmount + newAmount);
    } else {
      const exchangeMic =
        rowResolution?.exchangeMic ??
        symbolMeta?.[rawSymbol]?.exchangeMic ??
        symbolMeta?.[symbol]?.exchangeMic;
      const quoteCcy =
        rowResolution?.quoteCcy ??
        symbolMeta?.[rawSymbol]?.quoteCcy ??
        symbolMeta?.[symbol]?.quoteCcy;
      const instrumentType =
        rowResolution?.instrumentType ??
        symbolMeta?.[rawSymbol]?.instrumentType ??
        symbolMeta?.[symbol]?.instrumentType;
      const providerId =
        rowResolution?.providerId ??
        symbolMeta?.[rawSymbol]?.providerId ??
        symbolMeta?.[symbol]?.providerId;
      const quoteMode =
        rowResolution?.quoteMode ??
        symbolMeta?.[rawSymbol]?.quoteMode ??
        symbolMeta?.[symbol]?.quoteMode;
      const providerSymbol =
        rowResolution?.providerSymbol ??
        symbolMeta?.[rawSymbol]?.providerSymbol ??
        symbolMeta?.[symbol]?.providerSymbol;
      const assetId = rowResolution?.assetId;
      snapshot.positions.push({
        symbol,
        quantity,
        avgCost: avgCost || undefined,
        currency: currency || defaultCurrency,
        ...(exchangeMic ? { exchangeMic } : {}),
        ...(quoteCcy ? { quoteCcy } : {}),
        ...(instrumentType ? { instrumentType } : {}),
        ...(quoteMode ? { quoteMode } : {}),
        ...(providerId ? { providerId } : {}),
        ...(providerSymbol ? { providerSymbol } : {}),
        ...(assetId ? { assetId } : {}),
      });
    }
  }

  const snapshots: HoldingsSnapshotInput[] = [];
  for (const [date, data] of snapshotsByDate.entries()) {
    snapshots.push({
      date,
      positions: data.positions,
      cashBalances: data.cashBalances,
    });
  }

  snapshots.sort((left, right) => right.date.localeCompare(left.date));

  return snapshots;
}
