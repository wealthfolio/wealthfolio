import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";

import { useMemo, useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";

import { createAsset, importHoldingsCsv, saveAccountImportMapping, logger } from "@/adapters";
import { useImportContext } from "../context";
import { setImportResult, nextStep } from "../context/import-actions";
import { buildNewAssetFromDraft } from "../utils/asset-review-utils";
import {
  buildHoldingsRowResolutionMap,
  parseHoldingsSnapshots,
} from "../utils/holdings-import-utils";
import { HoldingsFormat } from "./holdings-mapping-step";
import type { HoldingsSnapshotInput, ImportHoldingsCsvResult } from "@/lib/types";
import { ImportType } from "@/lib/types";

interface PersistedSymbolResolution {
  symbol: string;
  exchangeMic?: string;
  quoteCcy?: string;
  instrumentType?: string;
  symbolName?: string;
  providerId?: string;
  providerSymbol?: string;
}

function isSamePersistedResolution(
  left: PersistedSymbolResolution,
  right: PersistedSymbolResolution,
): boolean {
  return (
    left.symbol === right.symbol &&
    (left.exchangeMic ?? "") === (right.exchangeMic ?? "") &&
    (left.quoteCcy ?? "") === (right.quoteCcy ?? "") &&
    (left.instrumentType ?? "") === (right.instrumentType ?? "") &&
    (left.symbolName ?? "") === (right.symbolName ?? "") &&
    (left.providerId ?? "") === (right.providerId ?? "") &&
    (left.providerSymbol ?? "") === (right.providerSymbol ?? "")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Holdings Confirm Step Component
// ─────────────────────────────────────────────────────────────────────────────

export function HoldingsConfirmStep() {
  const { state, dispatch } = useImportContext();
  const {
    headers,
    parsedRows,
    mapping,
    parseConfig,
    accountId,
    draftActivities,
    pendingImportAssets,
    assetPreviewItems,
  } = state;
  const navigate = useNavigate();
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [isPreparingAssets, setIsPreparingAssets] = useState(false);

  const parseOptions = useMemo(
    () => ({
      dateFormat: parseConfig.dateFormat,
      decimalSeparator: parseConfig.decimalSeparator,
      thousandsSeparator: parseConfig.thousandsSeparator,
      defaultCurrency: parseConfig.defaultCurrency,
    }),
    [parseConfig],
  );

  // Merge asset-review resolutions back into the saved template, but only when a raw symbol
  // resolves consistently across all rows in this import. Flat templates cannot safely encode
  // multiple reviewed outcomes for the same raw CSV symbol.
  const enrichedMapping = useMemo(() => {
    const fieldMappings = (mapping?.fieldMappings || {}) as Record<string, string>;
    const symHeader = fieldMappings[HoldingsFormat.SYMBOL];
    const symIndex = symHeader ? headers.indexOf(symHeader) : -1;

    const mergedSymbolMappings = { ...(mapping?.symbolMappings || {}) };
    const mergedSymbolMeta: Record<
      string,
      {
        exchangeMic?: string;
        quoteCcy?: string;
        instrumentType?: string;
        symbolName?: string;
        providerId?: string;
        providerSymbol?: string;
      }
    > = { ...(mapping?.symbolMappingMeta || {}) };
    const resolutionsByRawSymbol = new Map<string, PersistedSymbolResolution[]>();

    if (symIndex >= 0) {
      for (const draft of draftActivities) {
        const rawSym = draft.rawRow[symIndex]?.trim().toUpperCase();
        if (!rawSym || rawSym === "$CASH" || !draft.symbol) continue;

        const nextResolution: PersistedSymbolResolution = {
          symbol: draft.symbol,
          exchangeMic: draft.exchangeMic,
          quoteCcy: draft.quoteCcy,
          instrumentType: draft.instrumentType,
          symbolName: draft.symbolName,
          providerId: draft.providerId,
          providerSymbol: draft.providerSymbol,
        };
        const existing = resolutionsByRawSymbol.get(rawSym) || [];
        if (!existing.some((entry) => isSamePersistedResolution(entry, nextResolution))) {
          existing.push(nextResolution);
        }
        resolutionsByRawSymbol.set(rawSym, existing);
      }
    }

    for (const [rawSym, resolutions] of resolutionsByRawSymbol.entries()) {
      if (resolutions.length !== 1) {
        delete mergedSymbolMappings[rawSym];
        delete mergedSymbolMeta[rawSym];
        continue;
      }

      const resolution = resolutions[0];
      if (resolution.symbol !== rawSym) {
        mergedSymbolMappings[rawSym] = resolution.symbol;
      } else {
        delete mergedSymbolMappings[rawSym];
      }

      if (
        resolution.exchangeMic ||
        resolution.quoteCcy ||
        resolution.instrumentType ||
        resolution.symbolName ||
        resolution.providerId ||
        resolution.providerSymbol
      ) {
        mergedSymbolMeta[rawSym] = {
          exchangeMic: resolution.exchangeMic,
          quoteCcy: resolution.quoteCcy,
          instrumentType: resolution.instrumentType,
          symbolName: resolution.symbolName,
          providerId: resolution.providerId,
          providerSymbol: resolution.providerSymbol,
        };
      } else {
        delete mergedSymbolMeta[rawSym];
      }
    }

    return mapping
      ? {
          ...mapping,
          symbolMappings: mergedSymbolMappings,
          symbolMappingMeta: mergedSymbolMeta,
        }
      : mapping;
  }, [mapping, draftActivities, headers]);

  const buildSnapshots = useCallback(
    (createdAssetIdsByKey: Record<string, string> = {}) => {
      const fieldMappings = (enrichedMapping?.fieldMappings || {}) as Record<string, string>;
      const rowResolutions = buildHoldingsRowResolutionMap(draftActivities, createdAssetIdsByKey);

      return parseHoldingsSnapshots(
        headers,
        parsedRows,
        fieldMappings,
        parseOptions,
        enrichedMapping?.symbolMappings,
        enrichedMapping?.symbolMappingMeta,
        rowResolutions,
      );
    },
    [draftActivities, enrichedMapping, headers, parseOptions, parsedRows],
  );

  const snapshots = useMemo(() => buildSnapshots(), [buildSnapshots]);

  const persistCreatedAssets = useCallback(
    (assetIdByKey: Record<string, string>) => {
      const createdKeys = Object.keys(assetIdByKey);
      if (createdKeys.length === 0) return;

      const nextDrafts = draftActivities.map((draft) => {
        const resolvedAssetId =
          (draft.importAssetKey ? assetIdByKey[draft.importAssetKey] : undefined) ||
          (draft.assetCandidateKey ? assetIdByKey[draft.assetCandidateKey] : undefined);

        if (!resolvedAssetId) return draft;

        return {
          ...draft,
          assetId: resolvedAssetId,
          importAssetKey: undefined,
        };
      });

      dispatch({ type: "SET_VALIDATED_DRAFT_ACTIVITIES", payload: nextDrafts });
      dispatch({
        type: "SET_ASSET_PREVIEW_ITEMS",
        payload: assetPreviewItems.map((item) => {
          const assetId = assetIdByKey[item.key];
          if (!assetId) return item;

          return {
            ...item,
            status: "EXISTING_ASSET",
            resolutionSource: "created_on_import",
            assetId,
          };
        }),
      });

      for (const key of createdKeys) {
        dispatch({ type: "REMOVE_PENDING_IMPORT_ASSET", payload: key });
      }
    },
    [assetPreviewItems, dispatch, draftActivities],
  );

  const importMutation = useMutation<ImportHoldingsCsvResult, Error, HoldingsSnapshotInput[]>({
    mutationFn: async (snapshotsToImport) => {
      return await importHoldingsCsv(accountId, snapshotsToImport);
    },
    onSuccess: async (result, snapshotsToImport) => {
      if (enrichedMapping && accountId) {
        try {
          await saveAccountImportMapping({
            ...enrichedMapping,
            accountId,
            importType: ImportType.HOLDINGS,
            parseConfig,
          });
        } catch (error) {
          logger.error("Error saving holdings import mapping:", error);
        }
      }

      dispatch(
        setImportResult({
          success: result.snapshotsFailed === 0,
          stats: {
            total: snapshotsToImport.length,
            imported: result.snapshotsImported,
            skipped: 0,
            duplicates: 0,
            errors: result.snapshotsFailed,
          },
          errorMessage: result.errors.length > 0 ? result.errors.join("; ") : undefined,
        }),
      );
      dispatch(nextStep());
    },
    onError: (error, snapshotsToImport) => {
      dispatch(
        setImportResult({
          success: false,
          stats: {
            total: snapshotsToImport.length,
            imported: 0,
            skipped: 0,
            duplicates: 0,
            errors: snapshotsToImport.length,
          },
          errorMessage: error.message,
        }),
      );
      dispatch(nextStep());
    },
  });
  const { mutate: mutateImport, isPending: isImportPending } = importMutation;

  const handleImport = useCallback(() => {
    void (async () => {
      setPrepareError(null);
      setIsPreparingAssets(true);

      const createdAssetIdsByKey: Record<string, string> = {};
      try {
        const pendingAssets = new Map<string, ReturnType<typeof buildNewAssetFromDraft>>();

        for (const pending of Object.values(pendingImportAssets)) {
          pendingAssets.set(pending.key, pending.draft);
        }

        for (const draft of draftActivities) {
          if (draft.assetId) continue;

          const key = draft.importAssetKey || draft.assetCandidateKey;
          if (!key || pendingAssets.has(key)) continue;

          const nextAsset = buildNewAssetFromDraft(draft);
          if (nextAsset) {
            pendingAssets.set(key, nextAsset);
          }
        }

        for (const [key, assetDraft] of pendingAssets.entries()) {
          if (!assetDraft) continue;

          const created = await createAsset(assetDraft);
          createdAssetIdsByKey[key] = created.id;
        }

        const snapshotsToImport = buildSnapshots(createdAssetIdsByKey);
        persistCreatedAssets(createdAssetIdsByKey);
        mutateImport(snapshotsToImport);
      } catch (error) {
        persistCreatedAssets(createdAssetIdsByKey);
        setPrepareError(
          error instanceof Error ? error.message : "Failed to prepare assets for import.",
        );
      } finally {
        setIsPreparingAssets(false);
      }
    })();
  }, [buildSnapshots, draftActivities, mutateImport, pendingImportAssets, persistCreatedAssets]);

  const handleCancel = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const isImporting = isImportPending || isPreparingAssets;
  const totalPositions = snapshots.reduce((sum, s) => sum + s.positions.length, 0);
  const totalCashEntries = snapshots.reduce(
    (sum, s) => sum + Object.keys(s.cashBalances).length,
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-sm font-medium">Confirm Holdings Import</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Alert>
              <Icons.AlertTriangle className="h-4 w-4" />
              <AlertTitle>Important</AlertTitle>
              <AlertDescription>
                Importing will create or update snapshots for each date in your CSV. Existing
                snapshots for the same dates will be replaced.
              </AlertDescription>
            </Alert>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <div className="text-primary text-2xl font-bold">{snapshots.length}</div>
                <div className="text-muted-foreground text-xs">Snapshots</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold">{totalPositions}</div>
                <div className="text-muted-foreground text-xs">Positions</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold">{totalCashEntries}</div>
                <div className="text-muted-foreground text-xs">Cash Balances</div>
              </div>
              <div className="bg-muted/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold">{parsedRows.length}</div>
                <div className="text-muted-foreground text-xs">CSV Rows</div>
              </div>
            </div>

            {snapshots.length > 0 && (
              <div className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
                <Icons.Calendar className="h-4 w-4" />
                <span>
                  {snapshots[snapshots.length - 1].date} to {snapshots[0].date}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {prepareError && (
        <Alert variant="destructive">
          <Icons.AlertCircle className="h-4 w-4" />
          <AlertTitle>Import preparation failed</AlertTitle>
          <AlertDescription>{prepareError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={handleCancel} disabled={isImporting}>
          Cancel
        </Button>
        <Button onClick={handleImport} disabled={isImporting || snapshots.length === 0}>
          {isImporting ? (
            <>
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              {isPreparingAssets ? "Preparing assets..." : "Importing..."}
            </>
          ) : (
            <>
              <Icons.Upload className="mr-2 h-4 w-4" />
              Import {snapshots.length} Snapshot{snapshots.length !== 1 ? "s" : ""}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export default HoldingsConfirmStep;
