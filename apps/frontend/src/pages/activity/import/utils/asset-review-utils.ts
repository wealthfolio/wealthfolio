import { isCashSymbol, needsImportAssetResolutionForRow } from "@/lib/activity-utils";
import { quoteModeFromSearchResult } from "@/lib/asset-utils";
import { ActivityType } from "@/lib/constants";
import type {
  ImportAssetCandidate,
  ImportMappingData,
  NewAsset,
  SymbolSearchResult,
} from "@/lib/types";
import type { DraftActivity } from "../context";
import { HoldingsFormat } from "../steps/holdings-mapping-step";

export function applyAssetResolution(
  drafts: DraftActivity[],
  key: string,
  draft: NewAsset,
  options: { assetId?: string; importAssetKey?: string },
): DraftActivity[] {
  return drafts.map((row) => {
    if (row.assetCandidateKey !== key && buildImportAssetCandidateKeyFromDraft(row) !== key) {
      return row;
    }
    return {
      ...row,
      symbol: draft.instrumentSymbol || draft.displayCode || row.symbol,
      symbolName: draft.name || row.symbolName,
      exchangeMic: draft.instrumentExchangeMic || undefined,
      quoteCcy: draft.quoteCcy || row.quoteCcy,
      instrumentType: draft.instrumentType || row.instrumentType,
      quoteMode: draft.quoteMode || row.quoteMode,
      providerId: draft.providerId,
      providerSymbol: draft.providerSymbol,
      assetId: options.assetId,
      assetCandidateKey: key,
      importAssetKey: options.importAssetKey,
    };
  });
}

export function mapQuoteTypeToInstrumentType(quoteType?: string): string | undefined {
  switch ((quoteType ?? "").toUpperCase()) {
    case "EQUITY":
    case "ETF":
    case "MUTUALFUND":
    case "INDEX":
    case "ECNQUOTE":
      return "EQUITY";
    case "CRYPTO":
    case "CRYPTOCURRENCY":
      return "CRYPTO";
    case "BOND":
    case "MONEYMARKET":
      return "BOND";
    case "OPTION":
      return "OPTION";
    case "METAL":
    case "COMMODITY":
      return "METAL";
    case "FX":
    case "FOREX":
      return "FX";
    default:
      return undefined;
  }
}

export function buildImportAssetCandidateKey(input: {
  accountId: string;
  symbol: string;
  instrumentType?: string;
  quoteMode?: string;
  quoteCcy?: string;
  exchangeMic?: string;
  isin?: string;
  providerId?: string;
  providerSymbol?: string;
}): string {
  // quoteCcy is included so that the same symbol with different currencies
  // (e.g. SHOP on NASDAQ/USD vs TSX/CAD) resolves independently.
  // ISIN is included so same-ticker rows from different instruments do not
  // collapse before preview/validation can disambiguate them.
  // Provider refs are appended only when present to preserve existing keys.
  const parts = [
    input.symbol.trim().toUpperCase(),
    input.instrumentType?.trim().toUpperCase() ?? "",
    input.quoteMode?.trim().toUpperCase() ?? "",
    input.exchangeMic?.trim().toUpperCase() ?? "",
    input.quoteCcy?.trim().toUpperCase() ?? "",
    input.isin?.trim().toUpperCase() ?? "",
  ];

  const providerId = input.providerId?.trim().toUpperCase() ?? "";
  const providerSymbol = input.providerSymbol?.trim().toUpperCase() ?? "";
  if (providerId || providerSymbol) {
    parts.push("PROVIDER", providerId, providerSymbol);
  }

  return parts.join("::");
}

function hasProviderIdentity(input: { providerId?: string; providerSymbol?: string }): boolean {
  return Boolean(input.providerId?.trim() || input.providerSymbol?.trim());
}

function buildImportAssetCandidateKeyFromDraft(draft: DraftActivity): string | undefined {
  if (!draft.symbol || !draft.accountId) {
    return undefined;
  }

  return buildImportAssetCandidateKey({
    accountId: draft.accountId,
    symbol: draft.symbol,
    instrumentType: draft.instrumentType,
    quoteMode: draft.quoteMode,
    quoteCcy: draft.quoteCcy || draft.currency,
    exchangeMic: draft.exchangeMic,
    isin: draft.isin,
    providerId: draft.providerId,
    providerSymbol: draft.providerSymbol,
  });
}

export function buildImportAssetCandidateFromDraft(
  draft: DraftActivity,
): ImportAssetCandidate | null {
  if (!draft.symbol || !draft.activityType) {
    return null;
  }
  if (
    !needsImportAssetResolutionForRow({
      activityType: draft.activityType,
      subtype: draft.subtype,
      symbol: draft.symbol,
      assetId: draft.assetId,
      quantity: draft.quantity,
      unitPrice: draft.unitPrice,
    }) ||
    isCashSymbol(draft.symbol)
  ) {
    return null;
  }
  if (!draft.accountId) {
    return null;
  }

  const computedKey = buildImportAssetCandidateKeyFromDraft(draft);
  if (!computedKey) {
    return null;
  }
  const storedKey = draft.assetCandidateKey;
  const shouldUseStoredKey = Boolean(
    storedKey && (!hasProviderIdentity(draft) || draft.assetId || draft.importAssetKey),
  );

  return {
    key: shouldUseStoredKey && storedKey ? storedKey : computedKey,
    accountId: draft.accountId,
    symbol: draft.symbol,
    currency: draft.currency,
    instrumentType: draft.instrumentType,
    quoteCcy: draft.quoteCcy,
    quoteMode: draft.quoteMode,
    exchangeMic: draft.exchangeMic,
    isin: draft.isin,
    providerId: draft.providerId,
    providerSymbol: draft.providerSymbol,
  };
}

export function buildNewAssetFromSearchResult(
  result: SymbolSearchResult,
  fallbackCurrency: string,
): NewAsset {
  const instrumentType = mapQuoteTypeToInstrumentType(result.quoteType);
  const kind = instrumentType === "FX" ? "FX" : "INVESTMENT";
  const quoteMode = quoteModeFromSearchResult(result);
  const canonicalSymbol = result.canonicalSymbol || result.symbol;
  const canonicalExchangeMic = result.canonicalExchangeMic || result.exchangeMic;

  return {
    kind,
    name: result.longName || result.shortName || result.symbol,
    displayCode: canonicalSymbol,
    isActive: true,
    quoteMode,
    quoteCcy: result.currency || fallbackCurrency,
    instrumentType,
    instrumentSymbol: canonicalSymbol,
    instrumentExchangeMic: canonicalExchangeMic,
    providerId: result.providerId,
    providerSymbol: result.providerSymbol,
  };
}

export function buildNewAssetFromDraft(draft: DraftActivity): NewAsset | null {
  if (!draft.symbol || !draft.instrumentType || !draft.quoteCcy) {
    return null;
  }

  const normalizedInstrumentType = draft.instrumentType.toUpperCase();
  const kind = normalizedInstrumentType === "FX" ? "FX" : "INVESTMENT";

  return {
    kind,
    name: draft.symbolName || draft.symbol,
    displayCode: draft.symbol,
    isActive: true,
    quoteMode: draft.quoteMode === "MANUAL" ? "MANUAL" : "MARKET",
    quoteCcy: draft.quoteCcy,
    instrumentType: draft.instrumentType,
    instrumentSymbol: draft.symbol,
    instrumentExchangeMic: draft.exchangeMic,
    providerId: draft.providerId,
    providerSymbol: draft.providerSymbol,
  };
}

/**
 * Build synthetic DraftActivity[] from parsed holdings CSV rows.
 * These are used to drive the existing AssetReviewStep for holdings import.
 */
export function buildSyntheticDraftsFromHoldings(
  headers: string[],
  parsedRows: string[][],
  mapping: ImportMappingData,
  accountId: string,
  defaultCurrency: string,
): DraftActivity[] {
  const fieldMappings = mapping.fieldMappings as Record<string, string>;
  const symbolMappings = mapping.symbolMappings || {};
  const symbolMeta = mapping.symbolMappingMeta || {};

  const symbolIndex = fieldMappings[HoldingsFormat.SYMBOL]
    ? headers.indexOf(fieldMappings[HoldingsFormat.SYMBOL])
    : -1;
  const currencyIndex = fieldMappings[HoldingsFormat.CURRENCY]
    ? headers.indexOf(fieldMappings[HoldingsFormat.CURRENCY])
    : -1;

  if (symbolIndex === -1) return [];

  const drafts: DraftActivity[] = [];

  for (let i = 0; i < parsedRows.length; i++) {
    const row = parsedRows[i];
    const rawSymbol = row[symbolIndex]?.trim().toUpperCase();
    if (!rawSymbol || rawSymbol === "$CASH") continue;

    const resolvedSymbol = symbolMappings[rawSymbol] || rawSymbol;
    const currency =
      (currencyIndex >= 0 ? row[currencyIndex]?.trim() : undefined) || defaultCurrency;
    const meta = symbolMeta[rawSymbol] || symbolMeta[resolvedSymbol] || {};

    const key = buildImportAssetCandidateKey({
      accountId,
      symbol: resolvedSymbol,
      instrumentType: meta.instrumentType,
      quoteCcy: meta.quoteCcy || currency,
      exchangeMic: meta.exchangeMic,
      providerId: meta.providerId,
      providerSymbol: meta.providerSymbol,
    });

    drafts.push({
      rowIndex: i,
      rawRow: row,
      activityDate: "2000-01-01",
      activityType: ActivityType.BUY,
      symbol: resolvedSymbol,
      currency,
      accountId,
      quantity: "1",
      unitPrice: "1",
      exchangeMic: meta.exchangeMic,
      quoteCcy: meta.quoteCcy,
      instrumentType: meta.instrumentType,
      symbolName: meta.symbolName,
      providerId: meta.providerId,
      providerSymbol: meta.providerSymbol,
      assetCandidateKey: key,
      status: "valid",
      errors: {},
      warnings: {},
      isEdited: false,
    });
  }

  return drafts;
}
