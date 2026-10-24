import i18n from "i18next";
import { logger } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import type { ActivityBulkMutationRequest } from "@/lib/types";
import { useCallback } from "react";
import { useActivityMutations } from "../../hooks/use-activity-mutations";
import {
  buildSavePayload,
  validateTransactionsForSave,
  type ValidationResult,
} from "./activity-utils";
import type { CurrencyResolutionOptions, LocalTransaction } from "./types";

interface UseSaveActivitiesParams {
  localTransactions: LocalTransaction[];
  dirtyTransactionIds: Set<string>;
  pendingDeleteIds: Set<string>;
  resolveTransactionCurrency: (
    transaction: LocalTransaction,
    options?: CurrencyResolutionOptions,
  ) => string | undefined;
  dirtyCurrencyLookup: Map<string, string>;
  assetCurrencyLookup: Map<string, string>;
  fallbackCurrency: string;
  setLocalTransactions: React.Dispatch<React.SetStateAction<LocalTransaction[]>>;
  resetChangeState: () => void;
  resetRowSelection: () => void;
  onRefetch: () => Promise<unknown>;
}

interface SaveResult {
  success: boolean;
  validation?: ValidationResult;
}

/**
 * Hook for handling activity save operations with validation and error handling
 */
export function useSaveActivities({
  localTransactions,
  dirtyTransactionIds,
  pendingDeleteIds,
  resolveTransactionCurrency,
  dirtyCurrencyLookup,
  assetCurrencyLookup,
  fallbackCurrency,
  setLocalTransactions,
  resetChangeState,
  resetRowSelection,
  onRefetch,
}: UseSaveActivitiesParams) {
  const { saveActivitiesMutation } = useActivityMutations();

  const saveActivities = useCallback(async (): Promise<SaveResult> => {
    // Validate before save
    const validation = validateTransactionsForSave(localTransactions, dirtyTransactionIds);

    if (!validation.isValid) {
      logger.warn(`Validation failed for activities: ${JSON.stringify(validation.errors)}`);

      const errorMessages = validation.errors
        .slice(0, 3)
        .map((validationError) => `${validationError.field}: ${validationError.message}`)
        .join(", ");

      toast({
        title: i18n.t("common:notifications.validation_failed"),
        description: errorMessages + (validation.errors.length > 3 ? "..." : ""),
        variant: "destructive",
      });

      return { success: false, validation };
    }

    const payload = buildSavePayload(
      localTransactions,
      dirtyTransactionIds,
      pendingDeleteIds,
      resolveTransactionCurrency,
      dirtyCurrencyLookup,
      assetCurrencyLookup,
      fallbackCurrency,
    );

    // Note: payload uses string types for decimal fields to preserve precision
    // (e.g., 0.000000099). Rust's Decimal type can deserialize from strings.
    const request: ActivityBulkMutationRequest = {
      creates: payload.creates as unknown as ActivityBulkMutationRequest["creates"],
      updates: payload.updates as unknown as ActivityBulkMutationRequest["updates"],
      deleteIds: payload.deleteIds,
    };

    try {
      logger.info(
        `Saving activities: creates=${request.creates?.length ?? 0}, updates=${request.updates?.length ?? 0}, deletes=${request.deleteIds?.length ?? 0}`,
      );

      const result = await saveActivitiesMutation.mutateAsync(request);

      // Check for backend validation errors (partial failure)
      const hasErrors = result.errors && result.errors.length > 0;
      const hasSuccesses =
        result.created.length > 0 || result.updated.length > 0 || result.deleted.length > 0;

      if (hasErrors) {
        const errorMessages = result.errors
          .slice(0, 3)
          .map((err) => err.message)
          .join("\n");
        const suffix = result.errors.length > 3 ? `\n...and ${result.errors.length - 3} more` : "";

        logger.warn(`Backend validation errors: ${JSON.stringify(result.errors)}`);

        if (!hasSuccesses) {
          // Complete failure - no items were saved
          toast({
            title: i18n.t("ai:recordActivities.failedSave"),
            description: errorMessages + suffix,
            variant: "destructive",
          });
          return { success: false };
        }

        // Partial success - some items saved, some failed
        toast({
          title: i18n.t("common:notifications.some_activities_failed_to_save"),
          description: errorMessages + suffix,
          variant: "destructive",
        });
      }

      // Map temporary IDs to persisted IDs
      const createdMappings = new Map(
        (result.createdMappings ?? [])
          .filter((mapping) => mapping.tempId && mapping.activityId)
          .map((mapping) => [mapping.tempId!, mapping.activityId]),
      );

      // Build set of failed temp IDs so we keep them in local state
      const failedTempIds = new Set(result.errors?.map((err) => err.id) ?? []);

      // All IDs deleted by backend (includes cascade-deleted counterparts)
      const allDeletedIds = new Set(result.deleted.map((a) => a.id));

      // Update local state with persisted IDs, keep failed items
      setLocalTransactions((prev) =>
        prev
          .filter((transaction) => {
            // Keep failed items so user can fix them
            if (failedTempIds.has(transaction.id)) return true;
            // Remove explicitly deleted and cascade-deleted items
            return !pendingDeleteIds.has(transaction.id) && !allDeletedIds.has(transaction.id);
          })
          .map((transaction) => {
            // Don't update failed items
            if (failedTempIds.has(transaction.id)) return transaction;
            if (transaction.isNew) {
              const mappedId = createdMappings.get(transaction.id);
              if (mappedId) {
                return { ...transaction, id: mappedId, isNew: false };
              }
            }
            return transaction;
          }),
      );

      resetChangeState();
      resetRowSelection();

      if (!hasErrors) {
        toast({
          title: i18n.t("activity:datagrid_activities_saved"),
          description: i18n.t("common:notifications.pending_changes_saved"),
          variant: "success",
        });
      }

      await onRefetch();

      logger.info(
        `Activities save completed: ${result.created.length} created, ${result.updated.length} updated, ${result.deleted.length} deleted, ${result.errors?.length ?? 0} errors`,
      );
      return { success: !hasErrors || hasSuccesses };
    } catch (error) {
      logger.error(
        `Failed to save activities: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Error toast is handled by the mutation hook
      return { success: false };
    }
  }, [
    assetCurrencyLookup,
    dirtyCurrencyLookup,
    dirtyTransactionIds,
    fallbackCurrency,
    localTransactions,
    onRefetch,
    pendingDeleteIds,
    resetChangeState,
    resetRowSelection,
    resolveTransactionCurrency,
    saveActivitiesMutation,
    setLocalTransactions,
  ]);

  return {
    saveActivities,
    isSaving: saveActivitiesMutation.isPending,
  };
}
