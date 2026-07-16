import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { ProgressIndicator } from "@wealthfolio/ui/components/ui/progress-indicator";
import { FacetedFilter } from "@wealthfolio/ui";
import { useAccounts } from "@/hooks/use-accounts";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImportAlert } from "../components/import-alert";
import { ImportReviewGrid } from "../components/import-review-grid";
import {
  bulkForceImportDrafts,
  bulkSetCurrency,
  bulkSkipDrafts,
  bulkUnskipDrafts,
  updateDraft,
  useImportContext,
  type DraftActivity,
} from "../context";
import { buildImportAssetCandidateFromDraft } from "../utils/asset-review-utils";
import { validateDraft } from "../utils/draft-utils";
import { getActivityImportProfileForResolvedAccountIds } from "../utils/activity-import-profile";

// ─────────────────────────────────────────────────────────────────────────────
// Filter Helpers
// ─────────────────────────────────────────────────────────────────────────────

function matchesFacetFilters(
  draft: DraftActivity,
  typeFilter: Set<string>,
  accountFilter: Set<string>,
  symbolFilter: Set<string>,
): boolean {
  if (typeFilter.size > 0 && (!draft.activityType || !typeFilter.has(draft.activityType))) {
    return false;
  }
  if (accountFilter.size > 0 && (!draft.accountId || !accountFilter.has(draft.accountId))) {
    return false;
  }
  if (symbolFilter.size > 0 && (!draft.symbol || !symbolFilter.has(draft.symbol))) {
    return false;
  }
  return true;
}

function buildDuplicateReviewRows(drafts: DraftActivity[]): DraftActivity[] {
  const byLineNumber = new Map(drafts.map((draft) => [draft.rowIndex + 1, draft]));
  const duplicateRows = drafts
    .filter((draft) => draft.status === "duplicate")
    .sort((left, right) => {
      const leftSource = left.duplicateOfLineNumber ?? left.rowIndex + 1;
      const rightSource = right.duplicateOfLineNumber ?? right.rowIndex + 1;
      return leftSource - rightSource || left.rowIndex - right.rowIndex;
    });

  const ordered: DraftActivity[] = [];
  const seen = new Set<number>();
  const pushOnce = (draft?: DraftActivity) => {
    if (!draft || seen.has(draft.rowIndex)) return;
    ordered.push(draft);
    seen.add(draft.rowIndex);
  };

  for (const duplicate of duplicateRows) {
    if (typeof duplicate.duplicateOfLineNumber === "number") {
      pushOnce(byLineNumber.get(duplicate.duplicateOfLineNumber));
    }
    pushOnce(duplicate);
  }

  return ordered;
}

function findDuplicateContextRowIndexes(drafts: DraftActivity[]): number[] {
  const byLineNumber = new Map(drafts.map((draft) => [draft.rowIndex + 1, draft]));
  const contextRowIndexes = new Set<number>();

  for (const draft of drafts) {
    if (typeof draft.duplicateOfLineNumber !== "number") continue;
    const sourceDraft = byLineNumber.get(draft.duplicateOfLineNumber);
    if (sourceDraft) {
      contextRowIndexes.add(sourceDraft.rowIndex);
    }
  }

  return [...contextRowIndexes];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function ReviewStep() {
  const { state, dispatch, validateDrafts } = useImportContext();
  const { t } = useTranslation();
  const { parsedRows, mapping, draftActivities } = state;
  const isValidating = state.isValidating;
  const { accounts = [] } = useAccounts({ filterActive: true, includeArchived: false });

  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [accountFilter, setAccountScope] = useState<Set<string>>(new Set());
  const [symbolFilter, setSymbolFilter] = useState<Set<string>>(new Set());
  const accountTypeById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.accountType])),
    [accounts],
  );
  const importProfile = useMemo(
    () =>
      getActivityImportProfileForResolvedAccountIds(
        accounts,
        state.accountId
          ? [state.accountId]
          : draftActivities.map((draft) => draft.accountId).filter(Boolean),
      ),
    [accounts, draftActivities, state.accountId],
  );

  // Calculate filter stats (counts by status)
  const filterStats = useMemo(() => {
    const counts = { all: 0, errors: 0, warnings: 0, duplicates: 0, skipped: 0, valid: 0 };
    counts.all = draftActivities.length;
    for (const d of draftActivities) {
      if (d.status === "error") counts.errors++;
      else if (d.status === "warning") counts.warnings++;
      else if (d.status === "duplicate") counts.duplicates++;
      else if (d.status === "skipped") counts.skipped++;
      else counts.valid++;
    }
    return counts;
  }, [draftActivities]);

  // Faceted filter options — derived from draft data
  const facetedOptions = useMemo(() => {
    const types = new Map<string, number>();
    const accounts = new Map<string, number>();
    const symbols = new Map<string, number>();

    for (const d of draftActivities) {
      if (d.activityType) types.set(d.activityType, (types.get(d.activityType) ?? 0) + 1);
      if (d.accountId) accounts.set(d.accountId, (accounts.get(d.accountId) ?? 0) + 1);
      if (d.symbol) symbols.set(d.symbol, (symbols.get(d.symbol) ?? 0) + 1);
    }

    const statuses = [
      {
        label: t("activity:import.review.statusErrors"),
        value: "error",
        count: filterStats.errors,
      },
      {
        label: t("activity:import.review.statusWarnings"),
        value: "warning",
        count: filterStats.warnings,
      },
      {
        label: t("activity:import.review.statusDuplicates"),
        value: "duplicate",
        count: filterStats.duplicates,
      },
      {
        label: t("activity:import.review.statusSkipped"),
        value: "skipped",
        count: filterStats.skipped,
      },
      { label: t("activity:import.review.statusValid"), value: "valid", count: filterStats.valid },
    ].filter((o) => o.count > 0);

    return {
      types: Array.from(types, ([value, count]) => ({ label: value, value, count })).sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
      accounts: Array.from(accounts, ([value, count]) => ({ label: value, value, count })).sort(
        (a, b) => a.label.localeCompare(b.label),
      ),
      symbols: Array.from(symbols, ([value, count]) => ({ label: value, value, count })).sort(
        (a, b) => a.label.localeCompare(b.label),
      ),
      statuses,
    };
  }, [draftActivities, filterStats, t]);

  // Apply all filters on top of drafts passed to the grid
  const { facetFilteredDrafts, nonSelectableRowIndexes } = useMemo(() => {
    const effectiveSymbolFilter = importProfile.assetResolutionEnabled
      ? symbolFilter
      : new Set<string>();
    const draftsMatchingFacetFilters = draftActivities.filter((draft) =>
      matchesFacetFilters(draft, typeFilter, accountFilter, effectiveSymbolFilter),
    );

    if (statusFilter.size === 0) {
      return { facetFilteredDrafts: draftsMatchingFacetFilters, nonSelectableRowIndexes: [] };
    }

    if (statusFilter.size === 1 && statusFilter.has("duplicate")) {
      const groupedDrafts = buildDuplicateReviewRows(draftsMatchingFacetFilters);
      return {
        facetFilteredDrafts: groupedDrafts,
        nonSelectableRowIndexes: findDuplicateContextRowIndexes(groupedDrafts),
      };
    }

    return {
      facetFilteredDrafts: draftsMatchingFacetFilters.filter((draft) =>
        statusFilter.has(draft.status),
      ),
      nonSelectableRowIndexes: [],
    };
  }, [
    draftActivities,
    typeFilter,
    accountFilter,
    symbolFilter,
    statusFilter,
    importProfile.assetResolutionEnabled,
  ]);

  const hasActiveFacetFilters =
    typeFilter.size > 0 ||
    accountFilter.size > 0 ||
    (importProfile.assetResolutionEnabled && symbolFilter.size > 0) ||
    statusFilter.size > 0;

  const clearAllFilters = useCallback(() => {
    setTypeFilter(new Set());
    setAccountScope(new Set());
    setSymbolFilter(new Set());
    setStatusFilter(new Set());
  }, []);

  // Handlers
  const handleDraftUpdate = useCallback(
    (rowIndex: number, updates: Partial<DraftActivity>) => {
      // Find the current draft and merge with updates
      const currentDraft = draftActivities.find((d) => d.rowIndex === rowIndex);
      if (currentDraft) {
        const changesAssetIdentity = [
          "symbol",
          "exchangeMic",
          "quoteCcy",
          "instrumentType",
          "quoteMode",
          "isin",
          "accountId",
          "activityType",
        ].some((field) => field in updates);
        const mergedDraft = {
          ...currentDraft,
          ...updates,
        } as DraftActivity;
        const nextCandidate = buildImportAssetCandidateFromDraft(mergedDraft);
        // Re-validate the merged draft
        const validation = validateDraft(mergedDraft, accountTypeById);
        // Don't override status if it was explicitly skipped.
        const shouldRevalidateStatus = currentDraft.status !== "skipped";
        dispatch(
          updateDraft(rowIndex, {
            ...updates,
            ...(changesAssetIdentity
              ? {
                  assetId: undefined,
                  importAssetKey: undefined,
                  assetCandidateKey: nextCandidate?.key,
                }
              : {}),
            ...(shouldRevalidateStatus
              ? {
                  status: validation.status,
                  errors: validation.errors,
                  warnings: validation.warnings,
                  duplicateOfId: undefined,
                  duplicateOfLineNumber: undefined,
                }
              : {}),
          }),
        );
      } else {
        dispatch(updateDraft(rowIndex, updates));
      }
    },
    [accountTypeById, dispatch, draftActivities],
  );

  const handleBulkSkip = useCallback(
    (rowIndexes: number[]) => {
      dispatch(bulkSkipDrafts(rowIndexes, t("activity:import.review.skipReason")));
      setSelectedRows([]);
    },
    [dispatch, t],
  );

  const handleBulkUnskip = useCallback(
    (rowIndexes: number[]) => {
      dispatch(bulkUnskipDrafts(rowIndexes));
      setSelectedRows([]);
    },
    [dispatch],
  );

  const handleBulkSetCurrency = useCallback(
    (rowIndexes: number[], currency: string) => {
      dispatch(bulkSetCurrency(rowIndexes, currency));
    },
    [dispatch],
  );

  const handleBulkSetAccount = useCallback(
    (rowIndexes: number[], newAccountId: string) => {
      for (const rowIndex of rowIndexes) {
        const currentDraft = draftActivities.find((draft) => draft.rowIndex === rowIndex);
        if (!currentDraft) continue;

        const mergedDraft = {
          ...currentDraft,
          accountId: newAccountId,
        } as DraftActivity;
        const nextCandidate = buildImportAssetCandidateFromDraft(mergedDraft);
        const validation = validateDraft(mergedDraft, accountTypeById);
        const shouldRevalidateStatus = currentDraft.status !== "skipped";

        dispatch(
          updateDraft(rowIndex, {
            accountId: newAccountId,
            assetId: undefined,
            importAssetKey: undefined,
            assetCandidateKey: nextCandidate?.key,
            ...(shouldRevalidateStatus
              ? {
                  status: validation.status,
                  errors: validation.errors,
                  warnings: validation.warnings,
                  duplicateOfId: undefined,
                  duplicateOfLineNumber: undefined,
                }
              : {}),
          }),
        );
      }
    },
    [accountTypeById, dispatch, draftActivities],
  );

  const handleBulkForceImport = useCallback(
    (rowIndexes: number[]) => {
      // Only apply to duplicate rows — force_import is a no-op for others
      const duplicateIndexes = rowIndexes.filter(
        (idx) => draftActivities.find((d) => d.rowIndex === idx)?.status === "duplicate",
      );
      if (duplicateIndexes.length > 0) {
        dispatch(bulkForceImportDrafts(duplicateIndexes));
      }
      setSelectedRows([]);
    },
    [dispatch, draftActivities],
  );

  // --- All hooks above this line ---

  // Show loading state while drafts are being created or validated
  if ((draftActivities.length === 0 && parsedRows.length > 0) || isValidating) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <ProgressIndicator
          message={
            isValidating
              ? t("activity:import.review.validating")
              : t("activity:import.review.processing")
          }
          className="border-none shadow-none"
        />
      </div>
    );
  }

  // Show error if no data
  if (parsedRows.length === 0) {
    return (
      <ImportAlert
        variant="destructive"
        title={t("activity:import.review.noDataTitle")}
        description={t("activity:import.review.noDataDescription")}
      />
    );
  }

  // Show error if no mapping
  if (!mapping || Object.keys(mapping.fieldMappings).length === 0) {
    return (
      <ImportAlert
        variant="warning"
        title={t("activity:import.review.missingMappingTitle")}
        description={t("activity:import.review.missingMappingDescription")}
      />
    );
  }

  const validCount = filterStats.valid + filterStats.warnings + filterStats.duplicates;
  const hasErrors = filterStats.errors > 0;
  const hasWarnings = filterStats.warnings > 0 || filterStats.duplicates > 0;
  const hasIssues = hasErrors || hasWarnings;
  const hasSkipped = filterStats.skipped > 0;
  const importCount = validCount; // skipped are excluded
  const isStale = state.lastValidatedRevision !== state.draftRevision;
  const warningCount = filterStats.warnings + filterStats.duplicates;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary alert */}
      {state.validationError ? (
        <ImportAlert
          variant="destructive"
          title={t("activity:import.review.backendFailedTitle")}
          description={state.validationError}
        />
      ) : isStale ? (
        <ImportAlert
          variant="warning"
          title={t("activity:import.review.outOfDateTitle")}
          description={t("activity:import.review.outOfDateDescription")}
        >
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void validateDrafts(draftActivities)}
          >
            {t("activity:import.review.revalidate")}
          </Button>
        </ImportAlert>
      ) : hasIssues ? (
        <ImportAlert
          variant={hasErrors ? "destructive" : "warning"}
          title={
            hasErrors
              ? t("activity:import.review.rowNeedsFixing", { count: filterStats.errors })
              : t("activity:import.review.warningsToReview", { count: warningCount })
          }
          description={
            hasErrors
              ? t("activity:import.review.errorsDescription", {
                  valid: validCount,
                  all: filterStats.all,
                })
              : t("activity:import.review.warningsDescription", { all: filterStats.all })
          }
        >
          <div className="mt-2 flex flex-wrap gap-2">
            {filterStats.errors > 0 && (
              <Badge
                variant="outline"
                className="border-destructive/50 text-destructive hover:bg-destructive/10 cursor-pointer"
                onClick={() => setStatusFilter(new Set(["error"]))}
              >
                {t("activity:import.review.errorsBadge", { count: filterStats.errors })}
              </Badge>
            )}
            {filterStats.warnings > 0 && (
              <Badge
                variant="outline"
                className="cursor-pointer border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-400"
                onClick={() => setStatusFilter(new Set(["warning"]))}
              >
                {t("activity:import.review.warningsBadge", { count: filterStats.warnings })}
              </Badge>
            )}
            {filterStats.duplicates > 0 && (
              <Badge
                variant="outline"
                className="cursor-pointer border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-400"
                onClick={() => setStatusFilter(new Set(["duplicate"]))}
              >
                {t("activity:import.review.duplicatesBadge", { count: filterStats.duplicates })}
              </Badge>
            )}
          </div>
        </ImportAlert>
      ) : hasSkipped ? (
        <ImportAlert
          variant="success"
          title={t("activity:import.review.willBeImportedTitle", {
            count: importCount,
            all: filterStats.all,
          })}
          description={t("activity:import.review.excludedDescription", {
            count: filterStats.skipped,
          })}
        />
      ) : (
        <ImportAlert
          variant="success"
          title={t("activity:import.review.allValidTitle", { all: filterStats.all })}
          description={t("activity:import.review.allValidDescription")}
        />
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground mr-1 text-sm">
            {t("activity:import.review.activitiesCount", { count: filterStats.all })}
          </span>
          <FacetedFilter
            title={t("activity:import.review.filterType")}
            options={facetedOptions.types}
            selectedValues={typeFilter}
            onFilterChange={setTypeFilter}
          />
          {importProfile.assetResolutionEnabled && (
            <FacetedFilter
              title={t("activity:import.review.filterSymbol")}
              options={facetedOptions.symbols}
              selectedValues={symbolFilter}
              onFilterChange={setSymbolFilter}
            />
          )}
          <FacetedFilter
            title={t("activity:import.review.filterAccount")}
            options={facetedOptions.accounts}
            selectedValues={accountFilter}
            onFilterChange={setAccountScope}
          />
          <FacetedFilter
            title={t("activity:import.review.filterStatus")}
            options={facetedOptions.statuses}
            selectedValues={statusFilter}
            onFilterChange={setStatusFilter}
          />
          {hasActiveFacetFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 text-xs"
              onClick={clearAllFilters}
            >
              {t("activity:import.review.clearFilters")}
            </Button>
          )}
        </div>

        <ImportReviewGrid
          drafts={facetFilteredDrafts}
          nonSelectableRowIndexes={nonSelectableRowIndexes}
          onDraftUpdate={handleDraftUpdate}
          selectedRows={selectedRows}
          onSelectionChange={setSelectedRows}
          onBulkSkip={handleBulkSkip}
          onBulkUnskip={handleBulkUnskip}
          onBulkForceImport={
            statusFilter.size === 1 && statusFilter.has("duplicate")
              ? handleBulkForceImport
              : undefined
          }
          onBulkSetCurrency={handleBulkSetCurrency}
          onBulkSetAccount={handleBulkSetAccount}
          importProfile={importProfile}
        />
      </div>
    </div>
  );
}

export default ReviewStep;
