import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { motion } from "motion/react";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons, type Icon } from "@wealthfolio/ui/components/ui/icons";
import { ProgressIndicator } from "@wealthfolio/ui/components/ui/progress-indicator";
import {
  useImportContext,
  nextStep,
  prevStep,
  setImportResult,
  setStep,
  type DraftActivity,
  type DraftActivityStatus,
} from "../context";
import { useActivityImportMutations } from "../hooks/use-activity-import-mutations";
import { ImportAlert } from "../components/import-alert";
import { createAsset } from "@/adapters";
import { draftToActivityImport } from "../utils/draft-utils";
import { buildNewAssetFromDraft } from "../utils/asset-review-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ImportSummary {
  total: number;
  toImport: number;
  skipped: number;
  duplicates: number;
  forcedDuplicates: number;
  errors: number;
  warnings: number;
  byType: Record<string, number>;
  bySkipReason: Record<string, number>;
}

function hasDuplicateWarning(draft: DraftActivity): boolean {
  const hasDuplicateLineNumber = typeof draft.duplicateOfLineNumber === "number";
  return Boolean(
    draft.duplicateOfId || hasDuplicateLineNumber || draft.warnings?._duplicate?.length,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function computeSummary(draftActivities: DraftActivity[]): ImportSummary {
  const summary: ImportSummary = {
    total: draftActivities.length,
    toImport: 0,
    skipped: 0,
    duplicates: 0,
    forcedDuplicates: 0,
    errors: 0,
    warnings: 0,
    byType: {},
    bySkipReason: {},
  };

  for (const draft of draftActivities) {
    switch (draft.status) {
      case "valid": {
        summary.toImport++;
        // Count by activity type
        const actType = draft.activityType ?? "UNKNOWN";
        summary.byType[actType] = (summary.byType[actType] ?? 0) + 1;
        break;
      }
      case "warning": {
        summary.toImport++;
        summary.warnings++;
        if (hasDuplicateWarning(draft)) {
          summary.duplicates++;
        }
        // Also count by type for warnings (they will be imported)
        const warnType = draft.activityType ?? "UNKNOWN";
        summary.byType[warnType] = (summary.byType[warnType] ?? 0) + 1;
        break;
      }
      case "skipped": {
        summary.skipped++;
        const skipReason = draft.skipReason ?? "Manual";
        summary.bySkipReason[skipReason] = (summary.bySkipReason[skipReason] ?? 0) + 1;
        break;
      }
      case "duplicate": {
        summary.toImport++;
        summary.duplicates++;
        if (draft.forceImport) {
          summary.forcedDuplicates++;
        } else {
          summary.warnings++;
        }
        const duplicateType = draft.activityType ?? "UNKNOWN";
        summary.byType[duplicateType] = (summary.byType[duplicateType] ?? 0) + 1;
        break;
      }
      case "error": {
        summary.errors++;
        const errorKey = "Validation Error";
        summary.bySkipReason[errorKey] = (summary.bySkipReason[errorKey] ?? 0) + 1;
        break;
      }
    }
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVITY_TYPE_CONFIG: Record<string, { labelKey: string; icon: Icon; color: string }> = {
  BUY: {
    labelKey: "activity:import.confirm.typeBuy",
    icon: Icons.TrendingUp,
    color: "text-green-600 dark:text-green-400",
  },
  SELL: {
    labelKey: "activity:import.confirm.typeSell",
    icon: Icons.TrendingDown,
    color: "text-red-500 dark:text-red-400",
  },
  DIVIDEND: {
    labelKey: "activity:import.confirm.typeDividend",
    icon: Icons.DollarSign,
    color: "text-emerald-600 dark:text-emerald-400",
  },
  INTEREST: {
    labelKey: "activity:import.confirm.typeInterest",
    icon: Icons.Coins,
    color: "text-amber-600 dark:text-amber-400",
  },
  DEPOSIT: {
    labelKey: "activity:import.confirm.typeDeposit",
    icon: Icons.ArrowDownLeft,
    color: "text-blue-600 dark:text-blue-400",
  },
  WITHDRAWAL: {
    labelKey: "activity:import.confirm.typeWithdrawal",
    icon: Icons.ArrowUpRight,
    color: "text-orange-600 dark:text-orange-400",
  },
  TRANSFER_IN: {
    labelKey: "activity:import.confirm.typeTransferIn",
    icon: Icons.ArrowDownLeft,
    color: "text-blue-600 dark:text-blue-400",
  },
  TRANSFER_OUT: {
    labelKey: "activity:import.confirm.typeTransferOut",
    icon: Icons.ArrowUpRight,
    color: "text-orange-600 dark:text-orange-400",
  },
  FEE: {
    labelKey: "activity:import.confirm.typeFee",
    icon: Icons.Receipt,
    color: "text-slate-600 dark:text-slate-400",
  },
  TAX: {
    labelKey: "activity:import.confirm.typeTax",
    icon: Icons.FileText,
    color: "text-slate-600 dark:text-slate-400",
  },
  SPLIT: {
    labelKey: "activity:import.confirm.typeSplit",
    icon: Icons.Split,
    color: "text-purple-600 dark:text-purple-400",
  },
  UNKNOWN: {
    labelKey: "activity:import.confirm.typeUnknown",
    icon: Icons.HelpCircle,
    color: "text-muted-foreground",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

// Translate known internal skip-reason keys; fall back to the raw reason.
function translateSkipReason(t: TFunction, reason: string): string {
  switch (reason) {
    case "Manual":
      return t("activity:import.confirm.skipReasonManual");
    case "Validation Error":
      return t("activity:import.confirm.validationError");
    case "Skipped":
      return t("activity:import.review.skipReason");
    default:
      return reason;
  }
}

export function ConfirmStep() {
  const { state, dispatch } = useImportContext();
  const { t } = useTranslation();
  const [importError, setImportError] = useState<string | null>(null);
  const [isPreparingAssets, setIsPreparingAssets] = useState(false);

  const { confirmImportMutation } = useActivityImportMutations({
    onSuccess: (_activities, result) => {
      setImportError(null);

      // If the backend found validation errors, surface them in the review grid
      // rather than showing "Import Failed". This should be rare since the
      // frontend validates first, but guards against edge cases.
      if (!result.summary.success) {
        const errored = result.activities.filter(
          (a) => !a.isValid || (a.errors && Object.keys(a.errors).length > 0),
        );
        if (errored.length > 0) {
          const errorMap = new Map(errored.map((a) => [a.lineNumber, a]));
          const updatedDrafts = state.draftActivities.map((draft) => {
            const backendActivity = errorMap.get(draft.rowIndex + 1);
            if (!backendActivity?.errors) return draft;
            return {
              ...draft,
              errors: { ...(draft.errors ?? {}), ...backendActivity.errors },
              status: "error" as DraftActivityStatus,
            };
          });
          dispatch({ type: "SET_VALIDATED_DRAFT_ACTIVITIES", payload: updatedDrafts });
          dispatch(setStep("review"));
          return;
        }
      }

      const frontendSkipped = summary.skipped + summary.errors;
      dispatch(
        setImportResult({
          success: result.summary.success,
          stats: {
            total: summary.total,
            imported: result.summary.imported,
            skipped: result.summary.skipped + frontendSkipped,
            duplicates: result.summary.duplicates ?? 0,
            errors: 0,
          },
          importRunId: result.importRunId,
          errorMessage: result.summary.errorMessage,
        }),
      );
      dispatch(nextStep());
    },
    onError: (error) => {
      setImportError(error);
    },
  });

  const isProcessing = confirmImportMutation.isPending || isPreparingAssets;

  const summary = useMemo(() => computeSummary(state.draftActivities), [state.draftActivities]);

  const skippedTotal = summary.skipped + summary.errors;

  const persistCreatedAssets = (assetIdByKey: Record<string, string>) => {
    const createdKeys = Object.keys(assetIdByKey);
    if (createdKeys.length === 0) {
      return;
    }

    const nextDrafts = state.draftActivities.map((draft) => {
      const resolvedAssetId =
        (draft.importAssetKey ? assetIdByKey[draft.importAssetKey] : undefined) ||
        (draft.assetCandidateKey ? assetIdByKey[draft.assetCandidateKey] : undefined);

      if (!resolvedAssetId) {
        return draft;
      }

      return {
        ...draft,
        assetId: resolvedAssetId,
        importAssetKey: undefined,
      };
    });

    dispatch({ type: "SET_VALIDATED_DRAFT_ACTIVITIES", payload: nextDrafts });
    dispatch({
      type: "SET_ASSET_PREVIEW_ITEMS",
      payload: state.assetPreviewItems.map((item) => {
        const assetId = assetIdByKey[item.key];
        if (!assetId) {
          return item;
        }

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
  };

  const handleImport = async () => {
    // Send valid, warning, and duplicate activities to the backend.
    // Duplicate-status rows with forceImport=true will have their idempotency key
    // cleared server-side so they bypass the DB unique constraint and are inserted.
    // Non-forced duplicates are dropped by the backend dedup logic.
    const draftsToImport = state.draftActivities.filter(
      (d) => d.status === "valid" || d.status === "warning" || d.status === "duplicate",
    );
    if (draftsToImport.length === 0) {
      setImportError(t("activity:import.confirm.noValidActivities"));
      return;
    }

    setImportError(null);
    setIsPreparingAssets(true);
    const createdAssetIdsByKey: Record<string, string> = {};

    try {
      const pendingAssets = new Map<string, ReturnType<typeof buildNewAssetFromDraft>>();

      for (const pending of Object.values(state.pendingImportAssets)) {
        pendingAssets.set(pending.key, pending.draft);
      }

      for (const draft of draftsToImport) {
        if (draft.assetId) {
          continue;
        }
        const key = draft.importAssetKey || draft.assetCandidateKey;
        if (!key || pendingAssets.has(key)) {
          continue;
        }
        const nextAsset = buildNewAssetFromDraft(draft);
        if (nextAsset) {
          pendingAssets.set(key, nextAsset);
        }
      }

      for (const [key, assetDraft] of pendingAssets.entries()) {
        if (!assetDraft) {
          continue;
        }
        const created = await createAsset(assetDraft);
        createdAssetIdsByKey[key] = created.id;
      }

      persistCreatedAssets(createdAssetIdsByKey);

      const activitiesToImport = draftsToImport.map((draft) =>
        draftToActivityImport({
          ...draft,
          assetId:
            draft.assetId ||
            (draft.importAssetKey ? createdAssetIdsByKey[draft.importAssetKey] : undefined) ||
            (draft.assetCandidateKey ? createdAssetIdsByKey[draft.assetCandidateKey] : undefined),
        }),
      );

      confirmImportMutation.mutate({ activities: activitiesToImport });
    } catch (error) {
      persistCreatedAssets(createdAssetIdsByKey);
      setImportError(
        error instanceof Error ? error.message : t("activity:import.confirm.failedToPrepareAssets"),
      );
    } finally {
      setIsPreparingAssets(false);
    }
  };

  const handleBack = () => {
    dispatch(prevStep());
  };

  if (importError) {
    return (
      <div className="space-y-4">
        <ImportAlert
          variant="destructive"
          title={t("activity:import.confirm.errorTitle")}
          description={importError}
        >
          <div className="mt-4">
            <Button variant="destructive" onClick={() => setImportError(null)} size="sm">
              {t("activity:import.confirm.tryAgain")}
            </Button>
          </div>
        </ImportAlert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      {summary.toImport === 0 ? (
        <ImportAlert
          variant="warning"
          title={t("activity:import.confirm.noActivitiesTitle")}
          description={t("activity:import.confirm.noActivitiesDescription")}
        />
      ) : summary.warnings > 0 ? (
        <ImportAlert
          variant="warning"
          title={t("activity:import.confirm.readyTitle", { count: summary.toImport })}
          description={t("activity:import.confirm.warningsDescription", {
            count: summary.warnings,
          })}
        />
      ) : summary.forcedDuplicates > 0 ? (
        <ImportAlert
          variant="warning"
          title={t("activity:import.confirm.readyTitle", { count: summary.toImport })}
          description={t("activity:import.confirm.forcedDuplicatesDescription", {
            count: summary.forcedDuplicates,
          })}
        />
      ) : (
        <div>
          <p className="text-muted-foreground">{t("activity:import.confirm.reviewSummary")}</p>
        </div>
      )}

      {/* Summary section */}
      <div className="space-y-6">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          {/* Total Rows */}
          <div className="bg-muted/50 flex items-center gap-3 rounded-xl p-4">
            <div className="bg-background flex h-11 w-11 shrink-0 items-center justify-center rounded-lg">
              <Icons.FileText className="text-muted-foreground h-5 w-5" />
            </div>
            <div>
              <div className="text-muted-foreground text-sm">
                {t("activity:import.confirm.totalRows")}
              </div>
              <div className="text-2xl font-semibold">{summary.total}</div>
            </div>
          </div>

          {/* To Import - highlighted */}
          <div className="bg-muted/50 border-primary/30 flex items-center gap-3 rounded-xl border-2 p-4">
            <div className="bg-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-lg">
              <Icons.Import className="text-primary-foreground h-5 w-5" />
            </div>
            <div>
              <div className="text-primary text-sm">{t("activity:import.confirm.toImport")}</div>
              <div className="text-primary text-2xl font-semibold">{summary.toImport}</div>
            </div>
          </div>

          {/* Skipped */}
          <div className="bg-muted/50 flex items-center gap-3 rounded-xl p-4">
            <div className="bg-background flex h-11 w-11 shrink-0 items-center justify-center rounded-lg">
              <Icons.Minus className="text-muted-foreground h-5 w-5" />
            </div>
            <div>
              <div className="text-muted-foreground text-sm">
                {t("activity:import.confirm.skipped")}
              </div>
              <div className="text-muted-foreground text-2xl font-semibold">{skippedTotal}</div>
            </div>
          </div>
        </div>

        {/* Activity type breakdown */}
        {Object.keys(summary.byType).length > 0 && (
          <div className="space-y-3">
            <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              {t("activity:import.confirm.byActivityType")}
            </h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(summary.byType)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => {
                  const config = ACTIVITY_TYPE_CONFIG[type] ?? ACTIVITY_TYPE_CONFIG.UNKNOWN;
                  const IconComponent = config.icon;
                  return (
                    <div
                      key={type}
                      className="bg-muted/50 flex items-center gap-2 rounded-full px-3 py-1.5"
                    >
                      <IconComponent className={`h-4 w-4 ${config.color}`} />
                      <span className="text-sm">{t(config.labelKey)}</span>
                      <span className="text-muted-foreground bg-background rounded-full px-2 py-0.5 text-xs font-medium">
                        {count}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* Skipped breakdown */}
        {Object.keys(summary.bySkipReason).length > 0 && (
          <div className="space-y-3">
            <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
              {t("activity:import.confirm.skippedBreakdown")}
            </h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(summary.bySkipReason)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <div
                    key={reason}
                    className="bg-muted/50 flex items-center gap-2 rounded-full px-3 py-1.5"
                  >
                    <Icons.XCircle className="text-muted-foreground h-4 w-4" />
                    <span className="text-muted-foreground text-sm">
                      {translateSkipReason(t, reason)}
                    </span>
                    <span className="text-muted-foreground bg-background rounded-full px-2 py-0.5 text-xs font-medium">
                      {count}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* Progress indicator dialog */}
      <ProgressIndicator
        title={t("activity:import.confirm.progressTitle")}
        description={t("activity:import.confirm.progressDescription")}
        message={t("activity:import.confirm.progressMessage")}
        isLoading={isProcessing}
        open={isProcessing}
      />

      {/* Action buttons */}
      <div className="flex justify-between gap-3 border-t pt-6">
        <Button variant="outline" onClick={handleBack} disabled={isProcessing}>
          <Icons.ArrowLeft className="mr-2 h-4 w-4" />
          {t("activity:import.toolbar.back")}
        </Button>

        <motion.div whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}>
          <Button
            size="lg"
            onClick={() => void handleImport()}
            disabled={summary.toImport === 0 || isProcessing}
          >
            {isProcessing ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {isPreparingAssets
                  ? t("activity:import.confirm.preparingAssets")
                  : t("activity:import.confirm.importing")}
              </>
            ) : (
              <>
                <Icons.Import className="mr-2 h-4 w-4" />
                {t("activity:import.confirm.importActivities", { count: summary.toImport })}
              </>
            )}
          </Button>
        </motion.div>
      </div>
    </div>
  );
}

export default ConfirmStep;
