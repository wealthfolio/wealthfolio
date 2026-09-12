import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

import { checkHoldingsImport } from "@/adapters";
import { useImportContext } from "../context";
import { setParsedData, setHoldingsCheckPassed, setIsValidating } from "../context/import-actions";
import { ImportAlert } from "../components/import-alert";
import { HoldingsFormat } from "./holdings-mapping-step";
import {
  CASH_SYMBOL,
  analyzeDateColumn,
  buildHoldingsRowResolutionMap,
  type HoldingsRowResolution,
  parseDateToYMD,
  parseHoldingsSnapshots,
  parseHoldingsSnapshotsForValidation,
  parseNumericValue,
  type ParseOptions,
} from "../utils/holdings-import-utils";
import { HoldingsDataGrid, type HoldingsRow } from "../components/holdings-data-grid";
import type { CheckHoldingsImportResult } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Build flat rows for the data grid
// ─────────────────────────────────────────────────────────────────────────────

function buildHoldingsRows(
  headers: string[],
  parsedRows: string[][],
  fieldMappings: Record<string, string>,
  parseOptions: ParseOptions,
  symbolMappings?: Record<string, string>,
  rowResolutions?: Record<number, HoldingsRowResolution>,
): HoldingsRow[] {
  const { dateFormat, decimalSeparator, thousandsSeparator, defaultCurrency } = parseOptions;

  const { order: dateOrder } = analyzeDateColumn(headers, parsedRows, fieldMappings, dateFormat);

  const dateIndex = fieldMappings[HoldingsFormat.DATE]
    ? headers.indexOf(fieldMappings[HoldingsFormat.DATE])
    : -1;
  const symbolIndex = fieldMappings[HoldingsFormat.SYMBOL]
    ? headers.indexOf(fieldMappings[HoldingsFormat.SYMBOL])
    : -1;
  const quantityIndex = fieldMappings[HoldingsFormat.QUANTITY]
    ? headers.indexOf(fieldMappings[HoldingsFormat.QUANTITY])
    : -1;
  const avgCostIndex = fieldMappings[HoldingsFormat.AVG_COST]
    ? headers.indexOf(fieldMappings[HoldingsFormat.AVG_COST])
    : -1;
  const currencyIndex = fieldMappings[HoldingsFormat.CURRENCY]
    ? headers.indexOf(fieldMappings[HoldingsFormat.CURRENCY])
    : -1;

  const rows: HoldingsRow[] = [];

  for (let i = 0; i < parsedRows.length; i++) {
    const row = parsedRows[i];
    const rowResolution = rowResolutions?.[i];
    const rawDate = dateIndex >= 0 ? row[dateIndex]?.trim() : "";
    const rawSymbol = symbolIndex >= 0 ? row[symbolIndex]?.trim().toUpperCase() : "";
    const rawQuantity = quantityIndex >= 0 ? row[quantityIndex]?.trim() : "";
    const rawAvgCost = avgCostIndex >= 0 ? row[avgCostIndex]?.trim() : "";
    const rawCurrency = currencyIndex >= 0 ? row[currencyIndex]?.trim() : "";

    // Skip rows with missing required fields
    if (!rawDate || !rawSymbol || !rawQuantity) continue;

    const normalizedDate = parseDateToYMD(rawDate, dateFormat, dateOrder) ?? rawDate;
    const quantity =
      parseNumericValue(rawQuantity, decimalSeparator, thousandsSeparator) ?? rawQuantity;
    const avgCost =
      parseNumericValue(rawAvgCost, decimalSeparator, thousandsSeparator) ?? rawAvgCost;
    const currency = rawCurrency || defaultCurrency;
    const isCash = rawSymbol === CASH_SYMBOL;
    const resolvedSymbol = isCash
      ? CASH_SYMBOL
      : rowResolution?.symbol || symbolMappings?.[rawSymbol] || rawSymbol;

    rows.push({
      rowIndex: i,
      date: normalizedDate,
      rawSymbol,
      symbol: resolvedSymbol,
      isCash,
      quantity,
      avgCost,
      currency,
    });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Holdings Review Step Component
// ─────────────────────────────────────────────────────────────────────────────

export function HoldingsReviewStep() {
  const { state, dispatch } = useImportContext();
  const { t } = useTranslation();
  const { headers, parsedRows, mapping, parseConfig, accountId, draftActivities } = state;

  // Holdings imports never use fallback-column arrays — narrow to Record<string, string>
  const fieldMappings = useMemo(
    () => (mapping?.fieldMappings || {}) as Record<string, string>,
    [mapping?.fieldMappings],
  );
  const symbolMappings = useMemo(() => mapping?.symbolMappings || {}, [mapping?.symbolMappings]);
  const parseOptions: ParseOptions = useMemo(
    () => ({
      dateFormat: parseConfig.dateFormat,
      decimalSeparator: parseConfig.decimalSeparator,
      thousandsSeparator: parseConfig.thousandsSeparator,
      defaultCurrency: parseConfig.defaultCurrency,
    }),
    [parseConfig],
  );
  const dateColumn = useMemo(
    () => analyzeDateColumn(headers, parsedRows, fieldMappings, parseConfig.dateFormat),
    [headers, parsedRows, fieldMappings, parseConfig.dateFormat],
  );
  const rowResolutions = useMemo(
    () => buildHoldingsRowResolutionMap(draftActivities),
    [draftActivities],
  );

  // Build flat row data for the grid
  const holdingsRows = useMemo(
    () =>
      buildHoldingsRows(
        headers,
        parsedRows,
        fieldMappings,
        parseOptions,
        symbolMappings,
        rowResolutions,
      ),
    [headers, parsedRows, fieldMappings, parseOptions, symbolMappings, rowResolutions],
  );

  // Parse snapshots for the summary stats
  const snapshots = useMemo(
    () =>
      parseHoldingsSnapshots(
        headers,
        parsedRows,
        fieldMappings,
        parseOptions,
        symbolMappings,
        undefined,
        rowResolutions,
      ),
    [headers, parsedRows, fieldMappings, parseOptions, symbolMappings, rowResolutions],
  );

  const validationSnapshots = useMemo(
    () =>
      parseHoldingsSnapshotsForValidation(
        headers,
        parsedRows,
        fieldMappings,
        parseOptions,
        symbolMappings,
        undefined,
        rowResolutions,
      ),
    [headers, parsedRows, fieldMappings, parseOptions, symbolMappings, rowResolutions],
  );

  const totalPositions = snapshots.reduce((sum, s) => sum + s.positions.length, 0);
  const totalCashEntries = snapshots.reduce(
    (sum, s) => sum + Object.keys(s.cashBalances).length,
    0,
  );

  // Backend check state
  const [checkResult, setCheckResult] = useState<CheckHoldingsImportResult | null>(null);
  const [checkLoading, setCheckLoading] = useState(
    () => Boolean(accountId) && validationSnapshots.length > 0 && !dateColumn.needsExplicitFormat,
  );
  const [checkFailed, setCheckFailed] = useState(false);
  const [checkRetryRevision, setCheckRetryRevision] = useState(0);

  useEffect(() => {
    if (!accountId || validationSnapshots.length === 0 || dateColumn.needsExplicitFormat) {
      setCheckLoading(false);
      setCheckFailed(false);
      setCheckResult(null);
      dispatch(setHoldingsCheckPassed(false));
      dispatch(setIsValidating(false));
      return;
    }

    let cancelled = false;
    setCheckResult(null);
    setCheckFailed(false);
    setCheckLoading(true);
    dispatch(setIsValidating(true));
    dispatch(setHoldingsCheckPassed(false));
    checkHoldingsImport(accountId, validationSnapshots)
      .then((result) => {
        if (cancelled) return;
        setCheckResult(result);
        setCheckFailed(false);

        // Assets are already resolved in the asset review step. A mixed-date
        // import can continue when at least one complete snapshot group is valid.
        dispatch(setHoldingsCheckPassed(result.validSnapshotDates.length > 0));
      })
      .catch(() => {
        if (!cancelled) {
          setCheckResult(null);
          setCheckFailed(true);
          dispatch(setHoldingsCheckPassed(false));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCheckLoading(false);
          dispatch(setIsValidating(false));
        }
      });

    return () => {
      cancelled = true;
      dispatch(setIsValidating(false));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, validationSnapshots, checkRetryRevision, dateColumn.needsExplicitFormat]);

  // Handle data changes from the grid (quantity, avgCost, currency edits)
  const handleDataChange = useCallback(
    (nextRows: HoldingsRow[]) => {
      // Map grid edits back to parsedRows
      const updatedParsedRows = [...parsedRows];

      const quantityIndex = fieldMappings[HoldingsFormat.QUANTITY]
        ? headers.indexOf(fieldMappings[HoldingsFormat.QUANTITY])
        : -1;
      const avgCostIndex = fieldMappings[HoldingsFormat.AVG_COST]
        ? headers.indexOf(fieldMappings[HoldingsFormat.AVG_COST])
        : -1;
      const currencyIndex = fieldMappings[HoldingsFormat.CURRENCY]
        ? headers.indexOf(fieldMappings[HoldingsFormat.CURRENCY])
        : -1;

      for (const row of nextRows) {
        const origRow = [...(updatedParsedRows[row.rowIndex] || [])];
        if (quantityIndex >= 0) origRow[quantityIndex] = row.quantity;
        if (avgCostIndex >= 0) origRow[avgCostIndex] = row.avgCost;
        if (currencyIndex >= 0) origRow[currencyIndex] = row.currency;
        updatedParsedRows[row.rowIndex] = origRow;
      }

      dispatch(setParsedData(headers, updatedParsedRows));
    },
    [parsedRows, headers, fieldMappings, dispatch],
  );

  return (
    <div className="flex flex-col gap-6">
      {dateColumn.needsExplicitFormat && (
        <ImportAlert
          variant="warning"
          size="sm"
          title={t("activity:import.holdings.ambiguousDateTitle")}
          description={t("activity:import.holdings.ambiguousDateHint", {
            example: dateColumn.ambiguousSample,
          })}
          className="mb-0"
        />
      )}
      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ImportAlert
          variant="info"
          size="sm"
          title={t("activity:import.holdings.snapshots")}
          description={t("activity:import.holdings.snapshotsDates", { count: snapshots.length })}
          icon={Icons.Calendar}
          className="mb-0"
        />
        <ImportAlert
          variant="info"
          size="sm"
          title={t("activity:import.holdings.positions")}
          description={t("activity:import.holdings.positionsCount", { count: totalPositions })}
          icon={Icons.BarChart}
          className="mb-0"
        />
        <ImportAlert
          variant="info"
          size="sm"
          title={t("activity:import.holdings.cashBalances")}
          description={t("activity:import.holdings.cashEntries", { count: totalCashEntries })}
          icon={Icons.Wallet}
          className="mb-0"
        />
        {!dateColumn.needsExplicitFormat &&
          (checkLoading ? (
            <div role="status" aria-live="polite">
              <ImportAlert
                variant="info"
                size="sm"
                title={t("activity:import.holdings.validating")}
                description={t("activity:import.holdings.validatingRows", {
                  count: holdingsRows.length,
                })}
                icon={Icons.Spinner}
                iconClassName="animate-spin"
                className="mb-0"
              />
            </div>
          ) : checkFailed ? (
            <ImportAlert
              variant="destructive"
              size="sm"
              title={t("activity:import.holdings.validationFailed")}
              description={t("activity:import.holdings.validationFailedDescription")}
              icon={Icons.AlertTriangle}
              className="mb-0"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 h-7"
                onClick={() => setCheckRetryRevision((revision) => revision + 1)}
              >
                <Icons.RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t("activity:import.validationAlert.retry")}
              </Button>
            </ImportAlert>
          ) : checkResult?.validationErrors.length ? (
            <ImportAlert
              variant={checkResult.validSnapshotDates.length > 0 ? "warning" : "destructive"}
              size="sm"
              title={t("activity:import.holdings.validationErrors")}
              description={t("activity:import.holdings.validationErrorsCount", {
                count: checkResult.validationErrors.length,
              })}
              icon={Icons.AlertTriangle}
              className="mb-0"
            />
          ) : (
            <ImportAlert
              variant="success"
              size="sm"
              title={t("activity:import.holdings.readyToImport")}
              description={t("activity:import.holdings.readyRows", { count: holdingsRows.length })}
              icon={Icons.CheckCircle}
              className="mb-0"
              rightIcon={Icons.CheckCircle}
            />
          ))}
      </div>

      {/* Backend check alerts */}
      {checkResult && (
        <div className="flex flex-col gap-3">
          {checkResult.existingDates.length > 0 && (
            <ImportAlert
              variant="warning"
              size="sm"
              title={t("activity:import.holdings.existingOverwrittenTitle")}
            >
              <p className="text-xs">
                {t("activity:import.holdings.existingOverwritten", {
                  count: checkResult.existingDates.length,
                  dates: checkResult.existingDates.sort().join(", "),
                })}
              </p>
            </ImportAlert>
          )}
          {checkResult.validationErrors.length > 0 && (
            <ImportAlert
              variant="destructive"
              size="sm"
              title={t("activity:import.holdings.validationErrors")}
            >
              <ul className="list-inside list-disc text-xs">
                {checkResult.validationErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </ImportAlert>
          )}
        </div>
      )}

      {/* Editable Data Grid */}
      <HoldingsDataGrid
        rows={holdingsRows}
        onDataChange={handleDataChange}
        enableSymbolEditing={false}
      />
    </div>
  );
}

export default HoldingsReviewStep;
