import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";

import { getAccountImportMapping } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useImportContext } from "../context";
import { setMapping } from "../context/import-actions";
import { ImportAlert } from "../components/import-alert";
import type { ImportMappingData } from "@/lib/types";
import { ImportType } from "@/lib/types";
import { shouldUseSavedHoldingsMapping } from "../utils/import-flow-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Holdings Format Fields
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_FIELD_VALUE = "__skip__";

export enum HoldingsFormat {
  DATE = "date",
  SYMBOL = "symbol",
  QUANTITY = "quantity",
  AVG_COST = "avgCost",
  CURRENCY = "currency",
}

const HOLDINGS_REQUIRED_FIELDS: HoldingsFormat[] = [
  HoldingsFormat.DATE,
  HoldingsFormat.SYMBOL,
  HoldingsFormat.QUANTITY,
];

const HOLDINGS_TARGET_FIELDS: {
  value: HoldingsFormat;
  labelKey: string;
  required: boolean;
}[] = [
  { value: HoldingsFormat.DATE, labelKey: "activity:import.holdings.fieldDate", required: true },
  {
    value: HoldingsFormat.SYMBOL,
    labelKey: "activity:import.holdings.fieldSymbol",
    required: true,
  },
  {
    value: HoldingsFormat.QUANTITY,
    labelKey: "activity:import.holdings.fieldQuantity",
    required: true,
  },
  {
    value: HoldingsFormat.AVG_COST,
    labelKey: "activity:import.holdings.fieldAvgCost",
    required: false,
  },
  {
    value: HoldingsFormat.CURRENCY,
    labelKey: "activity:import.holdings.fieldCurrency",
    required: false,
  },
];

const HOLDINGS_FIELD_LABEL_KEYS: Record<HoldingsFormat, string> = {
  [HoldingsFormat.DATE]: "activity:import.holdings.fieldDate",
  [HoldingsFormat.SYMBOL]: "activity:import.holdings.fieldSymbol",
  [HoldingsFormat.QUANTITY]: "activity:import.holdings.fieldQuantity",
  [HoldingsFormat.AVG_COST]: "activity:import.holdings.fieldAvgCost",
  [HoldingsFormat.CURRENCY]: "activity:import.holdings.fieldCurrency",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ColumnMappingItem {
  csvColumn: string;
  sampleValues: string[];
  mappedField: HoldingsFormat | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect helpers
// ─────────────────────────────────────────────────────────────────────────────

function autoDetectHoldingsMapping(headers: string[]): Record<string, string> {
  const mappings: Record<string, string> = {};

  for (const header of headers) {
    const lower = header.toLowerCase().trim();

    if (!mappings[HoldingsFormat.DATE] && (lower === "date" || lower.includes("date"))) {
      mappings[HoldingsFormat.DATE] = header;
    } else if (
      !mappings[HoldingsFormat.SYMBOL] &&
      (lower === "symbol" || lower === "ticker" || lower === "name")
    ) {
      mappings[HoldingsFormat.SYMBOL] = header;
    } else if (
      !mappings[HoldingsFormat.QUANTITY] &&
      (lower === "quantity" || lower === "qty" || lower === "shares" || lower === "amount")
    ) {
      mappings[HoldingsFormat.QUANTITY] = header;
    } else if (
      !mappings[HoldingsFormat.AVG_COST] &&
      (lower === "avgcost" ||
        lower === "avg_cost" ||
        lower === "average_cost" ||
        lower === "cost" ||
        lower === "price" ||
        lower.includes("avg") ||
        lower.includes("cost") ||
        lower.includes("price"))
    ) {
      mappings[HoldingsFormat.AVG_COST] = header;
    } else if (!mappings[HoldingsFormat.CURRENCY] && (lower === "currency" || lower === "ccy")) {
      mappings[HoldingsFormat.CURRENCY] = header;
    }
  }

  return mappings;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV Preview Component
// ─────────────────────────────────────────────────────────────────────────────

interface CsvPreviewProps {
  headers: string[];
  rows: string[][];
  mapping: Record<string, string>;
}

function CsvPreviewTable({ headers, rows, mapping }: CsvPreviewProps) {
  const { t } = useTranslation();
  const displayRows = rows.slice(0, 10);

  // Get reverse mapping (headerName -> field), only valid HoldingsFormat keys
  const holdingsFieldSet = useMemo(() => new Set(Object.values(HoldingsFormat) as string[]), []);
  const headerToField = useMemo(() => {
    const map: Record<string, HoldingsFormat> = {};
    for (const [field, headerName] of Object.entries(mapping)) {
      if (headerName && holdingsFieldSet.has(field)) {
        map[headerName] = field as HoldingsFormat;
      }
    }
    return map;
  }, [mapping, holdingsFieldSet]);

  return (
    <div className="max-h-[300px] overflow-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 sticky top-0">
          <tr>
            {headers.map((header, idx) => {
              const mappedField = headerToField[header];
              const fieldLabel = mappedField ? t(HOLDINGS_FIELD_LABEL_KEYS[mappedField]) : null;
              const isDifferent = fieldLabel && fieldLabel.toLowerCase() !== header.toLowerCase();
              return (
                <th key={idx} className="border-r px-3 py-2 text-left font-medium last:border-r-0">
                  <span className="text-xs">
                    {header}
                    {isDifferent && (
                      <span className="text-muted-foreground">
                        {" → "}
                        {fieldLabel}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {displayRows.map((row, rowIdx) => (
            <tr key={rowIdx} className="hover:bg-muted/30 border-t">
              {row.map((cell, cellIdx) => (
                <td key={cellIdx} className="border-r px-3 py-2 last:border-r-0">
                  {cell || <span className="text-muted-foreground">-</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Holdings Mapping Step Component
// ─────────────────────────────────────────────────────────────────────────────

export function HoldingsMappingStep() {
  const { state, dispatch } = useImportContext();
  const { t } = useTranslation();
  const { headers, parsedRows, mapping, accountId } = state;
  const hasAutoInitialized = useRef(false);
  const shouldUseSavedMapping = shouldUseSavedHoldingsMapping(state.suppressLinkedTemplate);

  // Fetch saved mapping from backend
  const { data: savedMapping } = useQuery({
    queryKey: [QueryKeys.IMPORT_MAPPING, accountId],
    queryFn: () => (accountId ? getAccountImportMapping(accountId, ImportType.HOLDINGS) : null),
    enabled: !!accountId && shouldUseSavedMapping,
  });

  // Local state for the field mappings being edited
  const [localFieldMappings, setLocalFieldMappings] = useState<Record<string, string>>(() => {
    return (mapping?.fieldMappings || {}) as Record<string, string>;
  });

  // Auto-initialize: merge saved mapping from backend, then auto-detect from headers
  const validHoldingsFields = useMemo(() => new Set(Object.values(HoldingsFormat) as string[]), []);

  useEffect(() => {
    if (hasAutoInitialized.current) return;
    if (!headers || headers.length === 0) return;

    const merged: Record<string, string> = {};

    // 1. Apply saved field mappings (only valid HoldingsFormat keys with headers in this CSV)
    if (shouldUseSavedMapping && savedMapping?.fieldMappings) {
      for (const [field, value] of Object.entries(savedMapping.fieldMappings)) {
        const header = Array.isArray(value) ? value[0] : value;
        if (validHoldingsFields.has(field) && header && headers.includes(header)) {
          merged[field] = header;
        }
      }
    }

    // 2. Auto-detect from column headers to fill any gaps
    const autoMappings = autoDetectHoldingsMapping(headers);
    for (const [field, header] of Object.entries(autoMappings)) {
      if (!merged[field]) {
        merged[field] = header;
      }
    }

    if (Object.keys(merged).length > 0) {
      setLocalFieldMappings(merged);
    }

    // 3. Merge saved symbol mappings into context
    if (
      shouldUseSavedMapping &&
      (savedMapping?.symbolMappings || savedMapping?.symbolMappingMeta)
    ) {
      const currentMapping = mapping || {
        accountId,
        importType: ImportType.HOLDINGS,
        name: "holdings-import",
        fieldMappings: {},
        activityMappings: {},
        symbolMappings: {},
        accountMappings: {},
      };
      dispatch(
        setMapping({
          ...currentMapping,
          symbolMappings: {
            ...currentMapping.symbolMappings,
            ...(savedMapping.symbolMappings || {}),
          },
          symbolMappingMeta: {
            ...(currentMapping.symbolMappingMeta || {}),
            ...(savedMapping.symbolMappingMeta || {}),
          },
        }),
      );
    }

    hasAutoInitialized.current = true;
  }, [
    headers,
    savedMapping,
    mapping,
    accountId,
    dispatch,
    shouldUseSavedMapping,
    validHoldingsFields,
  ]);

  // ───────────────────────────────────────────────────────────────────────────
  // Derived data
  // ───────────────────────────────────────────────────────────────────────────

  const columnMappingItems = useMemo<ColumnMappingItem[]>(() => {
    return headers.map((header) => {
      const headerIndex = headers.indexOf(header);

      // Get unique sample values from first 20 rows
      const allValues = parsedRows
        .slice(0, 20)
        .map((row) => row[headerIndex]?.trim() || "")
        .filter(Boolean);

      const uniqueValues: string[] = [];
      const seen = new Set<string>();
      for (const value of allValues) {
        if (!seen.has(value)) {
          seen.add(value);
          uniqueValues.push(value);
        }
        if (uniqueValues.length >= 5) break;
      }

      // Find if this column is mapped to a valid HoldingsFormat field
      const mappedField = Object.entries(localFieldMappings).find(
        ([key, csvHeader]) => csvHeader === header && validHoldingsFields.has(key),
      )?.[0] as HoldingsFormat | undefined;

      return {
        csvColumn: header,
        sampleValues: uniqueValues,
        mappedField: mappedField || null,
      };
    });
  }, [headers, parsedRows, localFieldMappings, validHoldingsFields]);

  // Track which fields are already used (only valid HoldingsFormat keys)
  const usedFields = useMemo(() => {
    return new Set(
      Object.keys(localFieldMappings).filter(
        (key) => validHoldingsFields.has(key) && localFieldMappings[key],
      ) as HoldingsFormat[],
    );
  }, [localFieldMappings, validHoldingsFields]);

  // Check which required fields are mapped
  const requiredFieldsMapped = HOLDINGS_REQUIRED_FIELDS.every(
    (field) => localFieldMappings[field] && headers.includes(localFieldMappings[field]),
  );

  // Count mapped fields (only valid HoldingsFormat keys)
  const mappedFieldsCount = Object.keys(localFieldMappings).filter(
    (k) => validHoldingsFields.has(k) && localFieldMappings[k],
  ).length;

  // Count unique dates to show number of snapshots
  const dateColumn = localFieldMappings[HoldingsFormat.DATE];
  const dateIndex = dateColumn ? headers.indexOf(dateColumn) : -1;
  const uniqueDates = useMemo(() => {
    if (dateIndex === -1) return new Set<string>();
    return new Set(parsedRows.map((row) => row[dateIndex]).filter(Boolean));
  }, [parsedRows, dateIndex]);

  // Count $CASH rows
  const symbolColumn = localFieldMappings[HoldingsFormat.SYMBOL];
  const symbolIndex = symbolColumn ? headers.indexOf(symbolColumn) : -1;
  const cashRowCount = useMemo(() => {
    if (symbolIndex === -1) return 0;
    return parsedRows.filter((row) => row[symbolIndex]?.toUpperCase() === "$CASH").length;
  }, [parsedRows, symbolIndex]);

  // ───────────────────────────────────────────────────────────────────────────
  // Handlers
  // ───────────────────────────────────────────────────────────────────────────

  const handleMapColumn = useCallback((csvColumn: string, field: HoldingsFormat | null) => {
    setLocalFieldMappings((prev) => {
      const newMappings = { ...prev };

      // Remove any existing mapping for this CSV column
      Object.keys(newMappings).forEach((key) => {
        if (newMappings[key] === csvColumn) {
          delete newMappings[key];
        }
      });

      // Set new mapping
      if (field) {
        newMappings[field] = csvColumn;
      }

      return newMappings;
    });
  }, []);

  // Auto-save mapping to context when local mapping changes
  // Use refs for values that shouldn't trigger the effect (avoids infinite loop)
  const isFirstRender = useRef(true);
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;
  const accountIdRef = useRef(state.accountId);
  accountIdRef.current = state.accountId;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const updatedMapping: ImportMappingData = {
      ...(mappingRef.current || {
        accountId: accountIdRef.current,
        importType: ImportType.HOLDINGS,
        name: "holdings-import",
        fieldMappings: {},
        activityMappings: {},
        symbolMappings: {},
        accountMappings: {},
      }),
      fieldMappings: localFieldMappings,
    };
    dispatch(setMapping(updatedMapping));
  }, [localFieldMappings, dispatch]);

  // ───────────────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ImportAlert
          variant={requiredFieldsMapped ? "success" : "destructive"}
          size="sm"
          title={t("activity:import.holdings.columns")}
          description={t("activity:import.holdings.columnsMapped", {
            mapped: mappedFieldsCount,
            total: HOLDINGS_TARGET_FIELDS.length,
          })}
          icon={Icons.ListChecks}
          className="mb-0"
          rightIcon={requiredFieldsMapped ? Icons.CheckCircle : Icons.AlertCircle}
        />

        {requiredFieldsMapped && (
          <>
            <ImportAlert
              variant="info"
              size="sm"
              title={t("activity:import.holdings.rows")}
              description={t("activity:import.holdings.rowsSummary", {
                total: parsedRows.length,
                holdings: parsedRows.length - cashRowCount,
                cash: cashRowCount,
              })}
              icon={Icons.FileText}
              className="mb-0"
            />
            <ImportAlert
              variant="info"
              size="sm"
              title={t("activity:import.holdings.snapshots")}
              description={t("activity:import.holdings.snapshotsDates", {
                count: uniqueDates.size,
              })}
              icon={Icons.Calendar}
              className="mb-0"
            />
          </>
        )}
      </div>

      {/* Column Mapping */}
      <div className="grid gap-4">
        <Card>
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm font-medium">
              {t("activity:import.holdings.columnMapping")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 px-4 pb-4">
            {columnMappingItems.map((column) => {
              const isMapped = !!column.mappedField;
              return (
                <div
                  key={column.csvColumn}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2.5 py-1",
                    isMapped
                      ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20"
                      : "bg-muted/30 border-dashed",
                  )}
                >
                  {/* Status icon */}
                  {isMapped ? (
                    <Icons.CheckCircle className="h-4 w-4 shrink-0 text-green-600" />
                  ) : (
                    <div className="border-muted-foreground/30 h-4 w-4 shrink-0 rounded-full border-2" />
                  )}

                  {/* Column info */}
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn("text-sm font-medium", !isMapped && "text-muted-foreground")}
                    >
                      {column.csvColumn}
                    </span>
                    {column.sampleValues.length > 0 && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        ({column.sampleValues.slice(0, 3).join(", ")}
                        {column.sampleValues.length > 3 ? ", ..." : ""})
                      </span>
                    )}
                  </div>

                  {/* Arrow */}
                  <Icons.ArrowRight className="text-muted-foreground h-4 w-4 shrink-0" />

                  {/* Field Selector */}
                  <Select
                    value={column.mappedField || SKIP_FIELD_VALUE}
                    onValueChange={(value) => {
                      handleMapColumn(
                        column.csvColumn,
                        value === SKIP_FIELD_VALUE ? null : (value as HoldingsFormat),
                      );
                    }}
                  >
                    <SelectTrigger
                      className={cn(
                        "!h-7 w-[130px] shrink-0 !py-0 text-xs",
                        !isMapped && "text-muted-foreground border-dashed",
                      )}
                    >
                      <SelectValue placeholder={t("activity:import.holdings.selectField")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP_FIELD_VALUE}>
                        <span className="text-muted-foreground">
                          {t("activity:import.holdings.skip")}
                        </span>
                      </SelectItem>
                      <SelectSeparator />
                      {HOLDINGS_TARGET_FIELDS.map((field) => {
                        const isUsed =
                          usedFields.has(field.value) && column.mappedField !== field.value;
                        return (
                          <SelectItem key={field.value} value={field.value} disabled={isUsed}>
                            {t(field.labelKey)}
                            {field.required && <span className="ml-1 text-amber-600">*</span>}
                            {isUsed && (
                              <span className="text-muted-foreground ml-1 text-xs">
                                {t("activity:import.holdings.used")}
                              </span>
                            )}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      {/* CSV Preview */}
      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-sm font-medium">
            {t("activity:import.holdings.dataPreview")}
          </CardTitle>
        </CardHeader>
        <CardContent className="border-t p-0">
          <CsvPreviewTable headers={headers} rows={parsedRows} mapping={localFieldMappings} />
        </CardContent>
      </Card>
    </div>
  );
}

export default HoldingsMappingStep;
