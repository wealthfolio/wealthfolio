import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ImportFormat, ImportMappingData, type SymbolSearchResult } from "@/lib/types";
import { quoteModeFromSearchResult } from "@/lib/asset-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { saveAccountImportMapping, logger } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { createDefaultActivityMapping } from "../utils/default-activity-template";
import { normalizeActivityLabel } from "../utils/activity-type-mapping";
import {
  DEFAULT_ACTIVITY_IMPORT_PROFILE,
  isTransactionImportProfile,
  sanitizeFieldMappingsForImportProfile,
  type ActivityImportProfile,
} from "../utils/activity-import-profile";

/**
 * Common column name aliases for each ImportFormat field.
 * Used for smart auto-mapping of CSV columns.
 * Includes variations: lowercase, camelCase, snake_case, with spaces
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  [ImportFormat.DATE]: [
    "date",
    "trade date",
    "tradedate",
    "transaction date",
    "transactiondate",
    "settlement date",
    "settlementdate",
    "settledate",
    "activity date",
    "activitydate",
    "time",
    "datetime",
    "timestamp",
    "executed at",
    "executedat",
    "trade_date",
    "transaction_date",
  ],
  [ImportFormat.ACTIVITY_TYPE]: [
    "activitytype",
    "activity type",
    "activity_type",
    "type",
    "action",
    "transaction",
    "transaction type",
    "transactiontype",
    "transaction_type",
    "trans type",
    "transtype",
    "trans_type",
    "activity",
    "operation",
    "trade type",
    "tradetype",
  ],
  [ImportFormat.SYMBOL]: [
    "symbol",
    "ticker",
    "tickersymbol",
    "ticker symbol",
    "ticker_symbol",
    "security",
    "securitysymbol",
    "security symbol",
    "stock",
    "stocksymbol",
    "stock symbol",
    "asset",
    "assetid",
    "asset id",
    "asset_id",
    "instrument",
    "cusip",
  ],
  [ImportFormat.ISIN]: ["isin", "security id", "securityid"],
  [ImportFormat.INSTRUMENT_TYPE]: [
    "instrumenttype",
    "instrument type",
    "instrument_type",
    "assettype",
    "asset type",
    "asset_type",
    "securitytype",
    "security type",
    "security_type",
    "type hint",
    "type_hint",
  ],
  [ImportFormat.QUANTITY]: [
    "quantity",
    "qty",
    "shares",
    "units",
    "no of shares",
    "numberofshares",
    "number of shares",
    "share quantity",
    "sharequantity",
    "num shares",
    "numshares",
    "volume",
  ],
  [ImportFormat.UNIT_PRICE]: [
    "unitprice",
    "unit price",
    "unit_price",
    "price",
    "shareprice",
    "share price",
    "share_price",
    "cost per share",
    "costpershare",
    "price per share",
    "pricepershare",
    "avg price",
    "avgprice",
    "average price",
    "averageprice",
    "execution price",
    "executionprice",
    "trade price",
    "tradeprice",
    "cost basis",
    "costbasis",
  ],
  [ImportFormat.AMOUNT]: [
    "amount",
    "transaction amount",
    "transactionamount",
    "total",
    "totalamount",
    "total amount",
    "total_amount",
    "value",
    "totalvalue",
    "total value",
    "total_value",
    "netamount",
    "net amount",
    "net_amount",
    "grossamount",
    "gross amount",
    "gross_amount",
    "netvalue",
    "net value",
    "proceeds",
    "cost",
    "split ratio",
    "splitratio",
  ],
  [ImportFormat.CURRENCY]: [
    "currency",
    "currencycode",
    "currency code",
    "currency_code",
    "ccy",
    "curr",
    "tradecurrency",
    "trade currency",
    "trade_currency",
  ],
  [ImportFormat.FEE]: [
    "fee",
    "fees",
    "commission",
    "commissions",
    "tradingfee",
    "trading fee",
    "trading_fee",
    "transactionfee",
    "transaction fee",
    "transaction_fee",
    "brokerage",
    "brokeragefee",
    "brokerage fee",
    "brokerage_fee",
    "charges",
    "fees & comm",
    "fees & commission",
    "fees and commissions",
    "fees and comm",
  ],
  [ImportFormat.TAX]: [
    "tax",
    "taxes",
    "transaction tax",
    "stamp duty",
    "sdrt",
    "levy",
    "withholding tax",
    "tax withheld",
    "withholding",
    "foreign tax",
    "foreign withholding tax",
    "non-resident tax",
  ],
  [ImportFormat.ACCOUNT]: [
    "account",
    "accountid",
    "account id",
    "account_id",
    "accountname",
    "account name",
    "account_name",
    "portfolio",
    "portfolioid",
    "portfolio id",
    "accountnumber",
    "account number",
    "account_number",
    "acct",
  ],
  [ImportFormat.COMMENT]: [
    "comment",
    "comments",
    "note",
    "notes",
    "description",
    "transaction description",
    "transactiondescription",
    "memo",
    "remarks",
    "details",
  ],
  [ImportFormat.FX_RATE]: [
    "fxrate",
    "fx rate",
    "fx_rate",
    "exchangerate",
    "exchange rate",
    "exchange_rate",
    "forex rate",
    "forexrate",
    "conversion rate",
    "conversionrate",
  ],
  [ImportFormat.SUBTYPE]: [
    "subtype",
    "sub type",
    "sub_type",
    "variation",
    "subcategory",
    "sub category",
  ],
};

const TRANSACTION_COLUMN_ALIASES: Partial<Record<ImportFormat, string[]>> = {
  [ImportFormat.AMOUNT]: [
    "debit",
    "credit",
    "charge",
    "charges",
    "payment",
    "payments",
    "withdrawal",
    "withdrawals",
    "deposit",
    "deposits",
    "money out",
    "money in",
    "paid out",
    "paid in",
  ],
  [ImportFormat.COMMENT]: [
    "merchant",
    "merchant name",
    "payee",
    "payer",
    "vendor",
    "name",
    "transaction name",
    "narrative",
  ],
};

/**
 * Normalize a header string for comparison.
 * Removes special characters, converts to lowercase, and trims whitespace.
 */
function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .trim()
    .replace(/[_\-.&]/g, " ") // Replace underscores, hyphens, dots, ampersands with spaces
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

function aliasesForField(field: ImportFormat, profile: ActivityImportProfile): string[] {
  const aliases = COLUMN_ALIASES[field] ?? [field];
  if (!isTransactionImportProfile(profile)) return aliases;
  return [...aliases, ...(TRANSACTION_COLUMN_ALIASES[field] ?? [])];
}

function headerMatchesAliases(header: string, aliases: readonly string[]): boolean {
  const normalized = normalizeHeader(header);
  const compact = normalized.replace(/\s/g, "");
  return aliases.some((alias) => {
    const aliasNormalized = normalizeHeader(alias);
    const aliasCompact = aliasNormalized.replace(/\s/g, "");
    return (
      normalized === aliasNormalized ||
      (aliasNormalized.length >= 4 && normalized.includes(aliasNormalized)) ||
      (aliasCompact.length >= 4 && compact.includes(aliasCompact))
    );
  });
}

function headerIsBlockedForField(header: string, field: ImportFormat): boolean {
  if (field !== ImportFormat.AMOUNT) {
    return false;
  }

  const normalized = normalizeHeader(header);
  const compact = normalized.replace(/\s/g, "");

  return normalized.includes("market value") || compact.includes("marketvalue");
}

/**
 * Initialize column mapping by matching CSV headers to ImportFormat fields.
 * Uses tiered matching: exact → word-boundary contains → substring contains.
 */
export function initializeColumnMapping(
  headerRow: string[],
  profile: ActivityImportProfile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): Partial<Record<ImportFormat, string>> {
  const initialMapping: Partial<Record<ImportFormat, string>> = {};
  const usedHeaders = new Set<string>();

  const fields = profile.visibleMappingFields;

  // Pass 1: Exact match (normalized alias === normalized header)
  for (const field of fields) {
    if (initialMapping[field]) continue;
    const aliases = aliasesForField(field, profile);

    const match = headerRow.find((header) => {
      if (usedHeaders.has(header)) return false;
      if (headerIsBlockedForField(header, field)) return false;
      const nh = normalizeHeader(header);
      return aliases.some((alias) => nh === normalizeHeader(alias));
    });

    if (match) {
      initialMapping[field] = match;
      usedHeaders.add(match);
    }
  }

  // Pass 2: Word-boundary contains (catches "Trade Date (UTC)" → alias "trade date")
  for (const field of fields) {
    if (initialMapping[field]) continue;
    const aliases = aliasesForField(field, profile);

    const match = headerRow.find((header) => {
      if (usedHeaders.has(header)) return false;
      if (headerIsBlockedForField(header, field)) return false;
      const nh = normalizeHeader(header);
      return aliases.some((alias) => {
        const na = normalizeHeader(alias);
        // Only use word-boundary for multi-word aliases to avoid false positives
        if (na.length < 4) return false;
        const escaped = na.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`\\b${escaped.replace(/\s+/g, "\\s+")}\\b`);
        return pattern.test(nh);
      });
    });

    if (match) {
      initialMapping[field] = match;
      usedHeaders.add(match);
    }
  }

  // Pass 3: Substring contains for aliases ≥ 4 chars (catches "transactiondate_utc")
  for (const field of fields) {
    if (initialMapping[field]) continue;
    const aliases = aliasesForField(field, profile);

    const match = headerRow.find((header) => {
      if (usedHeaders.has(header)) return false;
      if (headerIsBlockedForField(header, field)) return false;
      const nh = normalizeHeader(header).replace(/\s/g, "");
      return aliases.some((alias) => {
        const na = normalizeHeader(alias).replace(/\s/g, "");
        return na.length >= 4 && nh.includes(na);
      });
    });

    if (match) {
      initialMapping[field] = match;
      usedHeaders.add(match);
    }
  }

  return initialMapping;
}

/**
 * Pure computation: auto-detect field mappings from headers, then merge with saved mappings.
 * Saved mappings take precedence; stale entries (pointing to missing headers) are filtered out.
 */
export function computeFieldMappings(
  headers: string[],
  savedFieldMappings?: Record<string, string | string[]>,
  profile: ActivityImportProfile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): Record<string, string | string[]> {
  const autoDetected = initializeColumnMapping(headers, profile);
  const headerSet = new Set(headers);

  // Start with auto-detected (all values are defined)
  const result: Record<string, string | string[]> = {};
  for (const [field, header] of Object.entries(autoDetected)) {
    if (header) result[field] = header;
  }

  if (isTransactionImportProfile(profile)) {
    const amountAliases = aliasesForField(ImportFormat.AMOUNT, profile);
    const amountHeaders = headers.filter(
      (header) =>
        !headerIsBlockedForField(header, ImportFormat.AMOUNT) &&
        headerMatchesAliases(header, amountAliases),
    );
    if (amountHeaders.length > 1) {
      result[ImportFormat.AMOUNT] = amountHeaders;
    }
  }

  // Merge saved mappings on top (only entries pointing to headers that still exist)
  if (savedFieldMappings) {
    for (const [field, header] of Object.entries(
      sanitizeFieldMappingsForImportProfile(savedFieldMappings, profile),
    )) {
      if (!header) continue;
      if (Array.isArray(header)) {
        // Keep fallback array if at least one header exists in the CSV
        if (header.some((h) => headerSet.has(h))) {
          result[field] = header;
        }
      } else if (headerSet.has(header)) {
        result[field] = header;
      }
    }
  }

  return sanitizeFieldMappingsForImportProfile(result, profile);
}

const emptyMapping: ImportMappingData = createDefaultActivityMapping();

interface UseImportMappingProps {
  defaultMapping?: ImportMappingData;
  accountId?: string;
  onSaveSuccess?: (mapping: ImportMappingData) => void;
}

export function useImportMapping({
  defaultMapping,
  accountId,
  onSaveSuccess,
}: UseImportMappingProps = {}) {
  const [mapping, setMapping] = useState<ImportMappingData>(defaultMapping ?? emptyMapping);
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  // Save mapping mutation
  const saveMappingMutation = useMutation({
    mutationFn: saveAccountImportMapping,
    onSuccess: (savedMapping) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.IMPORT_MAPPING, accountId] });
      if (onSaveSuccess) {
        onSaveSuccess(savedMapping);
      }
    },
    onError: (error) => {
      logger.error(`Error saving import mapping: ${error}`);
      toast({
        title: t("activity:import.errors.saveMappingTitle"),
        description: t("activity:import.errors.saveMappingDescription"),
        variant: "destructive",
      });
    },
  });

  // Handle saving the mapping (with optional parseConfig from context)
  const saveMapping = useCallback(
    (parseConfig?: Record<string, unknown>) => {
      if (accountId) {
        saveMappingMutation.mutate({
          ...mapping,
          accountId,
          ...(parseConfig && { parseConfig }),
        });
      }
    },
    [mapping, accountId, saveMappingMutation],
  );

  const updateMapping = useCallback((updates: Partial<ImportMappingData>) => {
    setMapping((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleColumnMapping = useCallback((field: ImportFormat, value: string) => {
    setMapping((prev) => ({
      ...prev,
      fieldMappings: { ...prev.fieldMappings, [field]: value.trim() },
    }));
  }, []);

  const handleActivityTypeMapping = useCallback((csvActivity: string, activityType: string) => {
    const normalizedCsvType = normalizeActivityLabel(csvActivity);
    const legacyPrefix = normalizedCsvType.slice(0, 12);

    setMapping((prev) => {
      const updatedMappings = Object.fromEntries(
        Object.entries(prev.activityMappings).flatMap(([key, values]) => {
          const nextValues = (values ?? []).filter((value) => {
            const normalizedValue = normalizeActivityLabel(value);
            return normalizedValue !== normalizedCsvType && normalizedValue !== legacyPrefix;
          });
          return nextValues.length > 0 ? [[key, nextValues]] : [];
        }),
      );

      if (!activityType.trim()) {
        return { ...prev, activityMappings: updatedMappings };
      }

      const nextValues = updatedMappings[activityType] ?? [];
      if (!nextValues.includes(normalizedCsvType)) {
        updatedMappings[activityType] = [...nextValues, normalizedCsvType];
      }

      return { ...prev, activityMappings: updatedMappings };
    });
  }, []);

  const handleSymbolMapping = useCallback(
    (csvSymbol: string, newSymbol: string, searchResult?: SymbolSearchResult) => {
      const canonicalSymbol = searchResult?.canonicalSymbol || newSymbol;
      const canonicalExchangeMic = searchResult?.canonicalExchangeMic || searchResult?.exchangeMic;

      setMapping((prev) => ({
        ...prev,
        symbolMappings: {
          ...prev.symbolMappings,
          [csvSymbol.trim()]: canonicalSymbol.trim(),
        },
        symbolMappingMeta: {
          ...prev.symbolMappingMeta,
          ...(searchResult
            ? {
                [csvSymbol.trim()]: {
                  exchangeMic: canonicalExchangeMic,
                  symbolName: searchResult.longName,
                  quoteCcy: searchResult.currency,
                  instrumentType: searchResult.quoteType,
                  quoteMode: quoteModeFromSearchResult(searchResult),
                  providerId: searchResult.providerId,
                  providerSymbol: searchResult.providerSymbol,
                },
              }
            : {}),
        },
      }));
    },
    [],
  );

  const handleAccountIdMapping = useCallback((csvAccountId: string, accountId: string) => {
    setMapping((prev) => {
      const updatedMappings = { ...prev.accountMappings };

      if (accountId.trim() === "") {
        // Remove mapping if accountId is empty
        delete updatedMappings[csvAccountId.trim()];
      } else {
        // Add or update mapping
        updatedMappings[csvAccountId.trim()] = accountId.trim();
      }
      return {
        ...prev,
        accountMappings: updatedMappings,
      };
    });
  }, []);

  return {
    mapping,
    updateMapping,
    handleColumnMapping,
    handleActivityTypeMapping,
    handleSymbolMapping,
    handleAccountIdMapping,
    saveMapping,
    saveMappingMutation,
  };
}
