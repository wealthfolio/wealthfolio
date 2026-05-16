import { parse, parseISO, isValid, format as formatDate } from "date-fns";

import type { HoldingsSnapshotInput, HoldingsPositionInput } from "@/lib/types";
import type { DraftActivity } from "../context";
import { HoldingsFormat } from "../steps/holdings-mapping-step";
import { getDateFnsPattern } from "./date-format-options";

export const CASH_SYMBOL = "$CASH";

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

export function parseDateToYMD(dateStr: string, dateFormat: string): string | null {
  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  const pattern = getDateFnsPattern(dateFormat);
  if (pattern) {
    try {
      const parsed = parse(trimmed, pattern, new Date());
      if (isValid(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      // fall through to auto-detection
    }
  }

  if (dateFormat === "ISO8601") {
    try {
      const parsed = parseISO(trimmed);
      if (isValid(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      // fall through
    }
  }

  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (isoMatch) {
    try {
      const parsed = parseISO(trimmed);
      if (isValid(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      // fall through
    }
  }

  const commonPatterns = [
    "MM/dd/yyyy",
    "dd/MM/yyyy",
    "MM-dd-yyyy",
    "dd-MM-yyyy",
    "dd.MM.yyyy",
    "MM.dd.yyyy",
    "yyyy/MM/dd",
  ];
  for (const p of commonPatterns) {
    try {
      const parsed = parse(trimmed, p, new Date());
      if (isValid(parsed)) return formatDate(parsed, "yyyy-MM-dd");
    } catch {
      continue;
    }
  }

  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    return formatDate(date, "yyyy-MM-dd");
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
      providerId?: string;
      providerSymbol?: string;
    }
  >,
  rowResolutions?: Record<number, HoldingsRowResolution>,
): HoldingsSnapshotInput[] {
  const { dateFormat, decimalSeparator, thousandsSeparator, defaultCurrency } = parseOptions;

  const dateHeader = mapping[HoldingsFormat.DATE];
  const symbolHeader = mapping[HoldingsFormat.SYMBOL];
  const quantityHeader = mapping[HoldingsFormat.QUANTITY];
  const avgCostHeader = mapping[HoldingsFormat.AVG_COST];
  const currencyHeader = mapping[HoldingsFormat.CURRENCY];

  const dateIndex = dateHeader ? headers.indexOf(dateHeader) : -1;
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

    if (!rawDate || !rawSymbol || !rawQuantity) continue;

    const normalizedDate = parseDateToYMD(rawDate, dateFormat);
    if (!normalizedDate) continue;

    const quantity = parseNumericValue(rawQuantity, decimalSeparator, thousandsSeparator);
    if (!quantity) continue;
    const avgCost = parseNumericValue(rawAvgCost, decimalSeparator, thousandsSeparator);

    if (!snapshotsByDate.has(normalizedDate)) {
      snapshotsByDate.set(normalizedDate, { positions: [], cashBalances: {} });
    }

    const snapshot = snapshotsByDate.get(normalizedDate)!;
    const symbol = rowResolution?.symbol || symbolMappings?.[rawSymbol] || rawSymbol;

    if (symbol === CASH_SYMBOL) {
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
