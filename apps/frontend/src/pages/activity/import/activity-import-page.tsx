import { getAccounts, logger } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { isCashSymbol, needsImportAssetResolution } from "@/lib/activity-utils";
import { canImportCSV } from "@/lib/activity-restrictions";
import { QueryKeys } from "@/lib/query-keys";
import type { Account } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { AlertFeedback, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { AnimatePresence, motion } from "motion/react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

// Context
import {
  ImportProvider,
  nextStep,
  prevStep,
  setDraftActivities,
  setMapping,
  setStepOrder,
  useImportContext,
  type ImportStep,
} from "./context";
import { createDraftActivities } from "./utils/draft-utils";
import { createDefaultActivityMapping } from "./utils/default-activity-template";

// Components
import { CancelConfirmationDialog } from "./components/cancel-confirmation-dialog";
import { StepNavigation } from "./components/step-navigation";
import { WizardStepIndicator, type WizardStep } from "./components/wizard-step-indicator";
import { ImportHelpPopover } from "./import-help";

// Steps
import { AssetReviewStep } from "./steps/asset-review-step";
import { ConfirmStep } from "./steps/confirm-step";
import { ContextResultStep } from "./steps/context-result-step";
import { MappingStepUnified } from "./steps/mapping-step-unified";
import { ReviewStep } from "./steps/review-step";
import { UploadStep } from "./steps/upload-step";

// Holdings Import Steps
import { HoldingsConfirmStep } from "./steps/holdings-confirm-step";
import { HoldingsFormat, HoldingsMappingStep } from "./steps/holdings-mapping-step";
import { HoldingsReviewStep } from "./steps/holdings-review-step";

// Constants
import { ImportFormat } from "@/lib/constants";
import { computeFieldMappings } from "./hooks/use-import-mapping";
import {
  buildSyntheticDraftsFromHoldings,
  canProceedFromAssetReviewStep,
  holdingsImportHasAssets,
} from "./utils/asset-review-utils";
import { ACTIVITY_SKIP, isFieldMapped, primaryHeader } from "./utils/draft-utils";
import { findMappedActivityType, validateTickerSymbol } from "./utils/validation-utils";
import {
  activityTypeAllowedForImportProfile,
  getActivityImportProfileForImportContext,
  isTransactionImportProfile,
  mergeActivityMappingsForImportProfile,
  sanitizeImportMappingForProfile,
  type ActivityImportProfile,
} from "./utils/activity-import-profile";

// ─────────────────────────────────────────────────────────────────────────────
// Step Configuration
// ─────────────────────────────────────────────────────────────────────────────

const STEP_COMPONENTS: Record<ImportStep, React.ComponentType> = {
  upload: UploadStep,
  mapping: MappingStepUnified,
  assets: AssetReviewStep,
  review: ReviewStep,
  confirm: ConfirmStep,
  result: ContextResultStep,
};

// Holdings import steps (for HOLDINGS-mode accounts)
const HOLDINGS_STEP_COMPONENTS: Record<ImportStep, React.ComponentType> = {
  upload: UploadStep,
  mapping: HoldingsMappingStep,
  assets: AssetReviewStep,
  review: HoldingsReviewStep,
  confirm: HoldingsConfirmStep,
  result: ContextResultStep,
};

// Holdings import required fields
const HOLDINGS_REQUIRED_FIELDS: HoldingsFormat[] = [
  HoldingsFormat.DATE,
  HoldingsFormat.SYMBOL,
  HoldingsFormat.QUANTITY,
];

/**
 * Check if a step can proceed to the next step (for activity import)
 */
function useStepValidation(
  isHoldingsMode: boolean,
  importProfile: ActivityImportProfile,
  accounts?: Account[],
) {
  const { state } = useImportContext();

  return useMemo(() => {
    const { step, file, headers, parsedRows, mapping, draftActivities } = state;

    switch (step) {
      case "upload":
        // Can proceed if file is uploaded and parsed successfully
        return file !== null && headers.length > 0 && parsedRows.length > 0;

      case "mapping": {
        if (isHoldingsMode) {
          // Holdings mode: only check required fields are mapped.
          // Symbol resolution happens in the asset review step.
          if (!mapping) return false;
          return HOLDINGS_REQUIRED_FIELDS.every((field) =>
            isFieldMapped(mapping.fieldMappings[field], headers),
          );
        }

        // Activity mode: existing validation logic
        if (!mapping) return false;
        if (!state.accountId && !mapping.fieldMappings[ImportFormat.ACCOUNT]) {
          return false;
        }

        if (mapping.fieldMappings[ImportFormat.ACCOUNT]) {
          const accountCol = primaryHeader(mapping.fieldMappings[ImportFormat.ACCOUNT]);
          const accountHeaderIndex = accountCol ? headers.indexOf(accountCol) : -1;
          if (accountHeaderIndex === -1) {
            return false;
          }

          const validAccountIds = new Set((accounts ?? []).map((account) => account.id));
          for (const row of parsedRows) {
            const rawAccount = row[accountHeaderIndex]?.trim();
            if (!rawAccount) {
              if (!state.accountId && !mapping.accountMappings?.[""]) {
                return false;
              }
              continue;
            }
            if (!validAccountIds.has(rawAccount) && !mapping.accountMappings?.[rawAccount]) {
              return false;
            }
          }
        }

        const requiredFieldsMapped = importProfile.requiredMappingFields.every((field) =>
          isFieldMapped(mapping.fieldMappings[field], headers),
        );
        if (!requiredFieldsMapped) return false;

        // Check if all activity types have mappings
        const activityTypeMapping = mapping.fieldMappings[ImportFormat.ACTIVITY_TYPE];
        if (activityTypeMapping) {
          const activityMappings = isTransactionImportProfile(importProfile)
            ? mergeActivityMappingsForImportProfile(mapping.activityMappings, importProfile)
            : mapping.activityMappings || {};
          // Build column indices for fallback resolution
          const atHeaders = Array.isArray(activityTypeMapping)
            ? activityTypeMapping
            : [activityTypeMapping];
          const atIndices = atHeaders.map((h) => headers.indexOf(h)).filter((i) => i !== -1);

          if (atIndices.length > 0) {
            const uniqueValues = new Set<string>();
            parsedRows.forEach((row) => {
              for (const idx of atIndices) {
                const value = row[idx]?.trim();
                if (value) {
                  uniqueValues.add(value);
                  break;
                }
              }
            });

            for (const value of uniqueValues) {
              const mappedType = findMappedActivityType(value, activityMappings) as string | null;
              if (
                !mappedType ||
                (mappedType !== ACTIVITY_SKIP &&
                  !activityTypeAllowedForImportProfile(mappedType, importProfile))
              ) {
                return false;
              }
            }
          }
        }

        // Check if all symbols are resolved (only for non-cash activities)
        if (!importProfile.assetResolutionEnabled) {
          return true;
        }

        const symbolColumn = primaryHeader(mapping.fieldMappings[ImportFormat.SYMBOL]);
        if (symbolColumn) {
          const symbolHeaderIndex = headers.indexOf(symbolColumn);

          // Activity type indices for per-row type resolution
          const atMapping = mapping.fieldMappings[ImportFormat.ACTIVITY_TYPE];
          const atCols = atMapping
            ? (Array.isArray(atMapping) ? atMapping : [atMapping])
                .map((h) => headers.indexOf(h))
                .filter((i) => i !== -1)
            : [];
          const subtypeMapping = mapping.fieldMappings[ImportFormat.SUBTYPE];
          const subtypeCols = subtypeMapping
            ? (Array.isArray(subtypeMapping) ? subtypeMapping : [subtypeMapping])
                .map((h) => headers.indexOf(h))
                .filter((i) => i !== -1)
            : [];

          if (symbolHeaderIndex !== -1) {
            const symbolsNeedingResolution = new Set<string>();

            parsedRows.forEach((row) => {
              const symbol = row[symbolHeaderIndex]?.trim();
              if (!symbol) return;

              // Resolve activity type using explicit mappings only
              let csvActivityType: string | undefined;
              for (const idx of atCols) {
                const val = row[idx]?.trim();
                if (val) {
                  csvActivityType = val;
                  break;
                }
              }
              let csvSubtype: string | undefined;
              for (const idx of subtypeCols) {
                const val = row[idx]?.trim();
                if (val) {
                  csvSubtype = val;
                  break;
                }
              }

              if (csvActivityType) {
                const mappedType = findMappedActivityType(
                  csvActivityType,
                  mapping.activityMappings || {},
                );
                if (
                  mappedType &&
                  (!needsImportAssetResolution(mappedType, csvSubtype) || isCashSymbol(symbol))
                ) {
                  return;
                }
              }

              symbolsNeedingResolution.add(symbol);
            });

            for (const symbol of symbolsNeedingResolution) {
              if (!mapping.symbolMappings?.[symbol] && !validateTickerSymbol(symbol)) {
                return false;
              }
            }
          }
        }

        return true;
      }

      case "assets":
        return canProceedFromAssetReviewStep({
          isHoldingsMode,
          parsedRowCount: parsedRows.length,
          draftActivities,
          isPreviewingAssets: state.isPreviewingAssets,
          assetPreviewError: state.assetPreviewError,
          assetPreviewItems: state.assetPreviewItems,
        });

      case "review":
        if (isHoldingsMode) {
          // Holdings mode: can proceed if we have parsed rows and backend check passed
          return parsedRows.length > 0 && state.holdingsCheckPassed;
        }
        return draftActivities.length > 0 && !state.isValidating && !state.validationError;

      case "confirm":
        // This step handles its own navigation via the import button
        return false;

      case "result":
        // Final step, no next
        return false;

      default:
        return false;
    }
  }, [accounts, state, isHoldingsMode, importProfile]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard Content Component
// ─────────────────────────────────────────────────────────────────────────────

function ImportWizardContent() {
  const { state, dispatch, validateDrafts, previewAssets } = useImportContext();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isMobile } = usePlatform();

  const STEPS: WizardStep[] = useMemo(
    () => [
      { id: "upload", label: t("activity:import.steps.upload") },
      { id: "mapping", label: t("activity:import.steps.mapping") },
      { id: "assets", label: t("activity:import.steps.reviewAssets") },
      { id: "review", label: t("activity:import.steps.reviewActivities") },
      { id: "confirm", label: t("activity:import.steps.import") },
    ],
    [t],
  );

  const TRANSACTION_STEPS: WizardStep[] = useMemo(
    () => [
      { id: "upload", label: t("activity:import.steps.upload") },
      { id: "mapping", label: t("activity:import.steps.mapping") },
      { id: "review", label: t("activity:import.steps.reviewTransactions") },
      { id: "confirm", label: t("activity:import.steps.import") },
    ],
    [t],
  );

  const HOLDINGS_STEPS: WizardStep[] = useMemo(
    () => [
      { id: "upload", label: t("activity:import.steps.upload") },
      { id: "mapping", label: t("activity:import.steps.mapping") },
      { id: "assets", label: t("activity:import.steps.reviewAssets") },
      { id: "review", label: t("activity:import.steps.reviewHoldings") },
      { id: "confirm", label: t("activity:import.steps.import") },
    ],
    [t],
  );

  // Cash-only holdings imports have no securities to resolve, so the asset review
  // step is omitted entirely (see holdingsImportHasAssets).
  const HOLDINGS_STEPS_CASH_ONLY: WizardStep[] = useMemo(
    () => [
      { id: "upload", label: t("activity:import.steps.upload") },
      { id: "mapping", label: t("activity:import.steps.mapping") },
      { id: "review", label: t("activity:import.steps.reviewHoldings") },
      { id: "confirm", label: t("activity:import.steps.import") },
    ],
    [t],
  );

  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [isNextLoading, setIsNextLoading] = useState(false);

  // Fetch accounts to determine tracking mode based on selected account
  const { data: accounts } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
  });

  // Determine if the selected account is in HOLDINGS mode
  const selectedAccount = useMemo(() => {
    if (!state.accountId || !accounts) return undefined;
    return accounts.find((a: Account) => a.id === state.accountId);
  }, [state.accountId, accounts]);

  const isHoldingsMode = useMemo(() => {
    return selectedAccount?.trackingMode === "HOLDINGS";
  }, [selectedAccount]);
  const importProfile = useMemo(
    () =>
      getActivityImportProfileForImportContext({
        defaultAccountId: state.accountId,
        accounts,
        headers: state.headers,
        parsedRows: state.parsedRows,
        fieldMappings: state.mapping?.fieldMappings,
        accountMappings: state.mapping?.accountMappings,
      }),
    [
      accounts,
      state.accountId,
      state.headers,
      state.mapping?.accountMappings,
      state.mapping?.fieldMappings,
      state.parsedRows,
    ],
  );
  const isTransactionImport = isTransactionImportProfile(importProfile);

  const isCsvImportAllowed = canImportCSV(selectedAccount);

  const canProceed = useStepValidation(isHoldingsMode, importProfile, accounts);

  // Cash-only holdings imports have no securities to resolve, so the asset review
  // step is dropped from the wizard for them (mapping → review directly).
  const holdingsHasAssets = useMemo(() => {
    if (!isHoldingsMode || !state.mapping) return false;
    return holdingsImportHasAssets(
      state.headers,
      state.parsedRows,
      state.mapping,
      state.accountId,
      state.parseConfig.defaultCurrency,
    );
  }, [
    isHoldingsMode,
    state.mapping,
    state.headers,
    state.parsedRows,
    state.accountId,
    state.parseConfig.defaultCurrency,
  ]);

  // Select the appropriate steps and components based on mode
  const steps = isHoldingsMode
    ? holdingsHasAssets
      ? HOLDINGS_STEPS
      : HOLDINGS_STEPS_CASH_ONLY
    : isTransactionImport
      ? TRANSACTION_STEPS
      : STEPS;
  const stepComponents = isHoldingsMode ? HOLDINGS_STEP_COMPONENTS : STEP_COMPONENTS;

  useEffect(() => {
    dispatch(setStepOrder([...steps.map((step) => step.id), "result"]));
  }, [dispatch, steps]);

  // Step navigation
  const currentStepIndex = useMemo(
    () => steps.findIndex((s) => s.id === state.step),
    [state.step, steps],
  );

  const canGoBack = currentStepIndex > 0 && state.step !== "result";
  const canGoNext = canProceed;

  // Show navigation buttons only on certain steps
  // ConfirmStep and ResultStep handle their own navigation
  const showNavigation = !["confirm", "result"].includes(state.step);

  // Get current step component
  const CurrentStepComponent = stepComponents[state.step];

  // Handlers
  const handleNext = useCallback(() => {
    void (async () => {
      if (!canGoNext) return;

      if (state.step === "upload" && state.headers.length > 0 && !isHoldingsMode) {
        const mergedFieldMappings = computeFieldMappings(
          state.headers,
          state.mapping?.fieldMappings,
          importProfile,
        );
        const existingAccountMappings = state.mapping?.accountMappings ?? {};
        // When no account column is mapped, pre-fill accountMappings[""] with the selected
        // account so every row resolves without requiring manual per-row assignment.
        const accountMappings =
          !mergedFieldMappings[ImportFormat.ACCOUNT] &&
          state.accountId &&
          !existingAccountMappings[""]
            ? { ...existingAccountMappings, "": state.accountId }
            : existingAccountMappings;
        dispatch(
          setMapping(
            sanitizeImportMappingForProfile(
              {
                ...(state.mapping ??
                  createDefaultActivityMapping(state.accountId || "", importProfile)),
                fieldMappings: mergedFieldMappings,
                accountMappings,
              },
              importProfile,
            ),
          ),
        );
      }

      if (state.step === "mapping" && state.mapping && state.parsedRows.length > 0) {
        if (isHoldingsMode) {
          // Holdings mode: build synthetic drafts for asset review
          const drafts = buildSyntheticDraftsFromHoldings(
            state.headers,
            state.parsedRows,
            state.mapping,
            state.accountId,
            state.parseConfig.defaultCurrency,
          );
          dispatch(setDraftActivities(drafts));
          dispatch({ type: "SET_ASSET_PREVIEW_ITEMS", payload: [] });
          dispatch({ type: "CLEAR_PENDING_IMPORT_ASSETS" });
          dispatch(nextStep());
          void previewAssets(drafts, { revision: state.draftRevision + 1 });
          return;
        }

        // Activity mode: build draft activities
        const validAccountIds = new Set((accounts ?? []).map((account) => account.id));
        const accountTypeById = new Map<string, string>(
          (accounts ?? []).map((account) => [account.id, account.accountType]),
        );
        const drafts = createDraftActivities(
          state.parsedRows,
          state.headers,
          {
            fieldMappings: state.mapping.fieldMappings,
            activityMappings: isTransactionImportProfile(importProfile)
              ? mergeActivityMappingsForImportProfile(state.mapping.activityMappings, importProfile)
              : state.mapping.activityMappings,
            symbolMappings: state.mapping.symbolMappings,
            accountMappings: state.mapping.accountMappings || {},
            symbolMappingMeta: state.mapping.symbolMappingMeta || {},
          },
          {
            dateFormat: state.parseConfig.dateFormat,
            decimalSeparator: state.parseConfig.decimalSeparator,
            thousandsSeparator: state.parseConfig.thousandsSeparator,
            defaultCurrency: state.parseConfig.defaultCurrency,
          },
          state.accountId,
          validAccountIds,
          accountTypeById,
          { importProfile },
        );
        dispatch(setDraftActivities(drafts));
        dispatch({ type: "SET_ASSET_PREVIEW_ITEMS", payload: [] });
        dispatch({ type: "CLEAR_PENDING_IMPORT_ASSETS" });
        dispatch(nextStep());
        if (importProfile.assetResolutionEnabled) {
          void previewAssets(drafts, { revision: state.draftRevision + 1 }); // fire-and-forget: assets step shows spinner
        } else {
          void validateDrafts(drafts, { revision: state.draftRevision + 1 });
        }
        return;
      }

      if (state.step === "assets") {
        if (isHoldingsMode) {
          // Holdings mode: just advance to review step (no validateDrafts needed)
          dispatch(nextStep());
          return;
        }
        setIsNextLoading(true);
        try {
          const result = await validateDrafts(state.draftActivities);
          if (!result.ok) return; // network/race error only — activity errors are shown in review step
          dispatch(nextStep());
        } finally {
          setIsNextLoading(false);
        }
        return;
      }

      if (state.step === "review" && !isHoldingsMode) {
        setIsNextLoading(true);
        try {
          const result = await validateDrafts(state.draftActivities);
          if (!result.ok || result.hasErrors) return;
        } finally {
          setIsNextLoading(false);
        }
      }

      dispatch(nextStep());
    })();
  }, [
    dispatch,
    canGoNext,
    state.step,
    state.headers,
    state.mapping,
    state.accountId,
    state.parsedRows,
    state.parseConfig,
    state.draftActivities,
    state.draftRevision,
    accounts,
    isHoldingsMode,
    importProfile,
    validateDrafts,
    previewAssets,
  ]);

  const handleBack = useCallback(() => {
    if (canGoBack) {
      dispatch(prevStep());
    }
  }, [dispatch, canGoBack]);

  const handleCancelClick = useCallback(() => {
    // On first step or result step, just navigate back without confirmation
    if (state.step === "upload" || state.step === "result") {
      navigate(-1);
    } else {
      // Show confirmation dialog for other steps
      setShowCancelDialog(true);
    }
  }, [state.step, navigate]);

  const handleConfirmCancel = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  // Get step-specific next button label
  const getNextLabel = useCallback(() => {
    switch (state.step) {
      case "upload":
        return t("activity:import.toolbar.configureMapping");
      case "mapping":
        if (isTransactionImport) return t("activity:import.steps.reviewTransactions");
        if (isHoldingsMode && !holdingsHasAssets) return t("activity:import.steps.reviewHoldings");
        return t("activity:import.steps.reviewAssets");
      case "assets":
        return isHoldingsMode
          ? t("activity:import.steps.reviewHoldings")
          : t("activity:import.steps.reviewActivities");
      case "review":
        return state.lastValidatedRevision === state.draftRevision
          ? t("activity:import.toolbar.continueToImport")
          : t("activity:import.toolbar.revalidateAndContinue");
      default:
        return t("activity:import.toolbar.continue");
    }
  }, [
    state.step,
    isHoldingsMode,
    holdingsHasAssets,
    isTransactionImport,
    state.lastValidatedRevision,
    state.draftRevision,
    t,
  ]);

  // Page title
  const pageTitle = isHoldingsMode
    ? t("activity:import.page.titleHoldings")
    : isTransactionImport
      ? t("activity:import.page.titleTransactions")
      : t("activity:import.page.titleActivities");

  if (selectedAccount && !isCsvImportAllowed) {
    return (
      <Page>
        <PageHeader heading={pageTitle} onBack={() => navigate(-1)} />
        <PageContent>
          <div className="mx-auto max-w-3xl space-y-4 py-6">
            <AlertFeedback variant="warning" title={t("activity:import.page.csvDisabledTitle")}>
              {t("activity:import.page.csvDisabledDescription")}
            </AlertFeedback>
            <Button variant="outline" onClick={() => navigate(`/account/${selectedAccount.id}`)}>
              {t("activity:import.page.goToAccount")}
            </Button>
          </div>
        </PageContent>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        heading={pageTitle}
        onBack={isMobile ? handleCancelClick : undefined}
        actions={
          <div className="flex items-center gap-2">
            <ImportHelpPopover defaultTab={isHoldingsMode ? "holdings" : "activities"} />
            {!isMobile && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelClick}
                className="hidden sm:flex"
              >
                <Icons.X className="mr-2 h-4 w-4" />
                {t("activity:import.toolbar.cancel")}
              </Button>
            )}
          </div>
        }
      />

      <PageContent withPadding={false}>
        <ErrorBoundary fallbackTitle={t("activity:import.page.somethingWentWrong")}>
          <div className="px-2 pb-6 pt-2 sm:px-4 sm:pt-4 md:px-6 md:pt-6">
            <Card className="flex max-h-[calc(100dvh-9rem)] w-full flex-col overflow-hidden">
              {/* Step indicator — hidden on result step */}
              {state.step !== "result" && (
                <CardHeader className="shrink-0 border-b px-3 py-3 sm:px-6 sm:py-4">
                  <WizardStepIndicator steps={steps} currentStep={state.step} />
                </CardHeader>
              )}

              {/* Step content — scrollable */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={state.step}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.3 }}
                    className="p-3 sm:p-6"
                  >
                    <CurrentStepComponent />
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Navigation buttons — always visible */}
              {showNavigation && (
                <div className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-6">
                  <StepNavigation
                    onNext={handleNext}
                    onBack={handleBack}
                    canGoBack={canGoBack}
                    canGoNext={canGoNext}
                    nextLabel={getNextLabel()}
                    isNextLoading={isNextLoading}
                  />
                </div>
              )}
            </Card>
          </div>
        </ErrorBoundary>
      </PageContent>

      {/* Cancel confirmation dialog */}
      <CancelConfirmationDialog
        open={showCancelDialog}
        onOpenChange={setShowCancelDialog}
        onConfirm={handleConfirmCancel}
      />
    </Page>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Boundary
// ─────────────────────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallbackTitle: string },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error(`Caught error: ${error}, info: ${errorInfo.componentStack}`);
  }

  override render() {
    if (this.state.hasError) {
      return <AlertFeedback variant="error" title={this.props.fallbackTitle} />;
    }

    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

export function ActivityImportPageV2() {
  const [searchParams] = useSearchParams();
  const accountId = searchParams.get("account") || "";

  return (
    <ImportProvider initialAccountId={accountId}>
      <ImportWizardContent />
    </ImportProvider>
  );
}

export default ActivityImportPageV2;
