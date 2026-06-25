import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { ProgressIndicator } from "@wealthfolio/ui/components/ui/progress-indicator";
import { FacetedFilter } from "@wealthfolio/ui";
import { useAccounts } from "@/hooks/use-accounts";
import { useCallback, useMemo, useState } from "react";
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
    const counts = {
      all: 0,
      errors: 0,
      warnings: 0,
      duplicates: 0,
      duplicatesCsv: 0,
      duplicatesDb: 0,
      skipped: 0,
      valid: 0,
    };
    counts.all = draftActivities.length;
    for (const d of draftActivities) {
      if (d.status === "error") counts.errors++;
      else if (d.status === "warning") counts.warnings++;
      else if (d.status === "duplicate") {
        counts.duplicates++;
        if (typeof d.duplicateOfLineNumber === "number") counts.duplicatesCsv++;
        else counts.duplicatesDb++;
      } else if (d.status === "skipped") counts.skipped++;
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
      { label: "Errors", value: "error", count: filterStats.errors },
      { label: "Warnings", value: "warning", count: filterStats.warnings },
      ...(filterStats.duplicatesCsv > 0
        ? [{ label: "CSV duplicates", value: "duplicate_csv", count: filterStats.duplicatesCsv }]
        : []),
      ...(filterStats.duplicatesDb > 0
        ? [
            {
              label: "Existing duplicates",
              value: "duplicate_db",
              count: filterStats.duplicatesDb,
            },
          ]
        : []),
      { label: "Skipped", value: "skipped", count: filterStats.skipped },
      { label: "Valid", value: "valid", count: filterStats.valid },
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
  }, [draftActivities, filterStats]);

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

    const hasDuplicateCsvFilter = statusFilter.has("duplicate_csv");
    const hasDuplicateDbFilter = statusFilter.has("duplicate_db");
    const nonDuplicateFilters = new Set(
      [...statusFilter].filter((v) => v !== "duplicate_csv" && v !== "duplicate_db"),
    );

    const matchesStatusFilter = (draft: DraftActivity): boolean => {
      if (nonDuplicateFilters.has(draft.status)) return true;
      if (draft.status !== "duplicate") return false;
      if (hasDuplicateCsvFilter && typeof draft.duplicateOfLineNumber === "number") return true;
      if (hasDuplicateDbFilter && typeof draft.duplicateOfLineNumber !== "number") return true;
      return false;
    };

    // Duplicate-only filter: apply special grouping to show CSV originals as context rows
    const isDuplicateOnlyFilter =
      nonDuplicateFilters.size === 0 && (hasDuplicateCsvFilter || hasDuplicateDbFilter);

    if (isDuplicateOnlyFilter) {
      const duplicateRows = draftsMatchingFacetFilters.filter(matchesStatusFilter);

      // buildDuplicateReviewRows looks up source rows (the original of a CSV duplicate)
      // from the dataset it receives. Re-attach any source rows from the full facet-filtered
      // set so they appear as non-selectable context when filtering by duplicate_csv.
      let rowsForGrouping = duplicateRows;
      if (hasDuplicateCsvFilter) {
        const byLineNumber = new Map(draftsMatchingFacetFilters.map((d) => [d.rowIndex + 1, d]));
        const duplicateRowIndexes = new Set(duplicateRows.map((d) => d.rowIndex));
        const sourceRows = duplicateRows
          .filter((d) => typeof d.duplicateOfLineNumber === "number")
          .map((d) => byLineNumber.get(d.duplicateOfLineNumber!))
          .filter(
            (d): d is DraftActivity => d !== undefined && !duplicateRowIndexes.has(d.rowIndex),
          );
        if (sourceRows.length > 0) {
          rowsForGrouping = [...duplicateRows, ...sourceRows];
        }
      }

      const groupedDrafts = buildDuplicateReviewRows(rowsForGrouping);
      return {
        facetFilteredDrafts: groupedDrafts,
        nonSelectableRowIndexes: findDuplicateContextRowIndexes(groupedDrafts),
      };
    }

    // Legacy: plain "duplicate" value (banner badges no longer emit it, kept for safety)
    if (statusFilter.size === 1 && statusFilter.has("duplicate")) {
      const groupedDrafts = buildDuplicateReviewRows(draftsMatchingFacetFilters);
      return {
        facetFilteredDrafts: groupedDrafts,
        nonSelectableRowIndexes: findDuplicateContextRowIndexes(groupedDrafts),
      };
    }

    return {
      facetFilteredDrafts: draftsMatchingFacetFilters.filter(matchesStatusFilter),
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
      dispatch(bulkSkipDrafts(rowIndexes, "Skipped"));
      setSelectedRows([]);
    },
    [dispatch],
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
          message={isValidating ? "Validating activities..." : "Processing activities..."}
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
        title="No Data"
        description="No CSV data available. Please go back and upload a file."
      />
    );
  }

  // Show error if no mapping
  if (!mapping || Object.keys(mapping.fieldMappings).length === 0) {
    return (
      <ImportAlert
        variant="warning"
        title="Missing Mapping"
        description="Column mappings are not configured. Please go back and configure the mapping."
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

  // Determine the dominant warning type for a more specific banner message
  const onlyDuplicatesDb =
    !hasErrors &&
    filterStats.warnings === 0 &&
    filterStats.duplicatesCsv === 0 &&
    filterStats.duplicatesDb > 0;
  const onlyDuplicatesCsv =
    !hasErrors &&
    filterStats.warnings === 0 &&
    filterStats.duplicatesDb === 0 &&
    filterStats.duplicatesCsv > 0;

  const bannerTitle = hasErrors
    ? `${filterStats.errors} ${filterStats.errors === 1 ? "row needs fixing" : "rows need fixing"}`
    : onlyDuplicatesDb
      ? `${filterStats.duplicatesDb} ${filterStats.duplicatesDb === 1 ? "activity" : "activities"} already in your portfolio`
      : onlyDuplicatesCsv
        ? `${filterStats.duplicatesCsv} ${filterStats.duplicatesCsv === 1 ? "duplicate" : "duplicates"} within this file`
        : `${warningCount} ${warningCount === 1 ? "warning" : "warnings"} to review`;

  const mixedBreakdownParts: string[] = [];
  if (filterStats.warnings > 0)
    mixedBreakdownParts.push(
      `${filterStats.warnings} ${filterStats.warnings === 1 ? "warning" : "warnings"}`,
    );
  if (filterStats.duplicatesCsv > 0)
    mixedBreakdownParts.push(
      `${filterStats.duplicatesCsv} CSV ${filterStats.duplicatesCsv === 1 ? "duplicate" : "duplicates"}`,
    );
  if (filterStats.duplicatesDb > 0)
    mixedBreakdownParts.push(
      `${filterStats.duplicatesDb} existing ${filterStats.duplicatesDb === 1 ? "duplicate" : "duplicates"}`,
    );

  const bannerDescription = hasErrors
    ? `${validCount} of ${filterStats.all} rows are valid and ready to import. Fix errors below, or skip them to continue.`
    : onlyDuplicatesDb
      ? `These activities match existing records in your portfolio and will be skipped. Use "Import anyway" on individual rows to override.`
      : onlyDuplicatesCsv
        ? `These activities appear more than once in this file and will be skipped. All ${filterStats.all} activities are otherwise importable.`
        : `All ${filterStats.all} activities are importable — ${mixedBreakdownParts.join(", ")} to review.`;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary alert */}
      {state.validationError ? (
        <ImportAlert
          variant="destructive"
          title="Backend validation failed"
          description={state.validationError}
        />
      ) : isStale ? (
        <ImportAlert
          variant="warning"
          title="Review validation is out of date"
          description="You changed one or more activities after the last backend validation. Revalidate before continuing to import."
        >
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void validateDrafts(draftActivities)}
          >
            Revalidate
          </Button>
        </ImportAlert>
      ) : hasIssues ? (
        <ImportAlert
          variant={hasErrors ? "destructive" : "warning"}
          title={bannerTitle}
          description={bannerDescription}
        >
          <div className="mt-2 flex flex-wrap gap-2">
            {filterStats.errors > 0 && (
              <Badge
                variant="outline"
                className="border-destructive/50 text-destructive hover:bg-destructive/10 cursor-pointer"
                onClick={() => setStatusFilter(new Set(["error"]))}
              >
                {filterStats.errors} errors
              </Badge>
            )}
            {filterStats.warnings > 0 && (
              <Badge
                variant="outline"
                className="cursor-pointer border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-400"
                onClick={() => setStatusFilter(new Set(["warning"]))}
              >
                {filterStats.warnings} warnings
              </Badge>
            )}
            {filterStats.duplicatesCsv > 0 && (
              <Badge
                variant="outline"
                className="cursor-pointer border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-400"
                onClick={() => setStatusFilter(new Set(["duplicate_csv"]))}
              >
                {filterStats.duplicatesCsv} CSV{" "}
                {filterStats.duplicatesCsv === 1 ? "duplicate" : "duplicates"}
              </Badge>
            )}
            {filterStats.duplicatesDb > 0 && (
              <Badge
                variant="outline"
                className="cursor-pointer border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-400"
                onClick={() => setStatusFilter(new Set(["duplicate_db"]))}
              >
                {filterStats.duplicatesDb} existing{" "}
                {filterStats.duplicatesDb === 1 ? "duplicate" : "duplicates"}
              </Badge>
            )}
          </div>
        </ImportAlert>
      ) : hasSkipped ? (
        <ImportAlert
          variant="success"
          title={`${importCount} of ${filterStats.all} activities will be imported`}
          description={`${filterStats.skipped} ${filterStats.skipped === 1 ? "activity is" : "activities are"} excluded. Your data is ready for import.`}
        />
      ) : (
        <ImportAlert
          variant="success"
          title={`All ${filterStats.all} activities are valid`}
          description="Your data is ready for import. You can still review and make adjustments if needed."
        />
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground mr-1 text-sm">{filterStats.all} activities</span>
          <FacetedFilter
            title="Type"
            options={facetedOptions.types}
            selectedValues={typeFilter}
            onFilterChange={setTypeFilter}
          />
          {importProfile.assetResolutionEnabled && (
            <FacetedFilter
              title="Symbol"
              options={facetedOptions.symbols}
              selectedValues={symbolFilter}
              onFilterChange={setSymbolFilter}
            />
          )}
          <FacetedFilter
            title="Account"
            options={facetedOptions.accounts}
            selectedValues={accountFilter}
            onFilterChange={setAccountScope}
          />
          <FacetedFilter
            title="Status"
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
              Clear filters
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
            statusFilter.size === 1 &&
            (statusFilter.has("duplicate") ||
              statusFilter.has("duplicate_csv") ||
              statusFilter.has("duplicate_db"))
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
