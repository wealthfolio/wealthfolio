import { getTransferPairForActivity, logger } from "@/adapters";
import { buildAssetResolutionInput } from "@/lib/asset-resolution-input";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import { generateId } from "@/lib/id";
import type { ActivityCreate, ActivityDetails, ActivityUpdate } from "@/lib/types";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { AccountSelectOption } from "../components/forms/fields";
import type { NewActivityFormValues } from "../components/forms/schemas";
import type { TransferFormValues } from "../components/forms/transfer-form";
import type { AdjustmentFormValues } from "../components/forms/adjustment-form";
import {
  ACTIVITY_FORM_CONFIG,
  type ActivityFormValues,
  type PickerActivityType,
} from "../config/activity-form-config";
import { useActivityMutations } from "./use-activity-mutations";

function generateSourceGroupId(): string {
  return generateId("wf-transfer");
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object") {
    const raw = error as Record<string, unknown>;
    if (typeof raw.error === "string" && raw.error.trim()) return raw.error;
    if (typeof raw.message === "string" && raw.message.trim()) return raw.message;
  }
  return "Failed to save activity. Please check your inputs and try again.";
}

function transferPairIds(activity: Partial<ActivityDetails> | undefined): {
  transferOutId?: string;
  transferInId?: string;
} {
  return {
    transferOutId:
      activity?.transferOutId ??
      (activity?.activityType === ActivityType.TRANSFER_OUT
        ? activity.id
        : activity?.counterpartActivityId),
    transferInId:
      activity?.transferInId ??
      (activity?.activityType === ActivityType.TRANSFER_IN
        ? activity.id
        : activity?.counterpartActivityId),
  };
}

export interface UseActivityFormParams {
  accounts: AccountSelectOption[];
  activity?: Partial<ActivityDetails>;
  selectedType: PickerActivityType | undefined;
  onSuccess?: () => void;
}

export interface UseActivityFormReturn {
  /** Default values for the selected form type */
  defaultValues: Partial<ActivityFormValues> | undefined;
  /** Whether we're editing an existing activity */
  isEditing: boolean;
  /** Whether a mutation is in progress */
  isLoading: boolean;
  /** Error from the last mutation */
  error: Error | string | null;
  /** Whether the last mutation resulted in an error */
  isError: boolean;
  /** Submit handler for the selected form type */
  handleSubmit: (data: ActivityFormValues) => Promise<void>;
}

/**
 * Hook that provides all form logic for activity forms.
 * Uses configuration-driven approach for optimal performance.
 */
export function useActivityForm({
  accounts,
  activity,
  selectedType,
  onSuccess,
}: UseActivityFormParams): UseActivityFormReturn {
  const {
    addActivityMutation,
    updateActivityMutation,
    saveActivitiesMutation,
    saveInternalTransferPairMutation,
    unlinkTransferActivitiesMutation,
  } = useActivityMutations(onSuccess);

  const isEditing = !!activity?.id;
  const isLoading =
    addActivityMutation.isPending ||
    updateActivityMutation.isPending ||
    saveActivitiesMutation.isPending ||
    saveInternalTransferPairMutation.isPending ||
    unlinkTransferActivitiesMutation.isPending;
  const error =
    addActivityMutation.error ??
    updateActivityMutation.error ??
    saveActivitiesMutation.error ??
    saveInternalTransferPairMutation.error ??
    unlinkTransferActivitiesMutation.error;
  const isError =
    addActivityMutation.isError ||
    updateActivityMutation.isError ||
    saveActivitiesMutation.isError ||
    saveInternalTransferPairMutation.isError ||
    unlinkTransferActivitiesMutation.isError;

  // Get config for selected type (undefined if no type selected)
  const config = selectedType ? ACTIVITY_FORM_CONFIG[selectedType] : undefined;

  // Compute default values only for selected type (lazy evaluation)
  const defaultValues = useMemo(() => {
    if (!config) return undefined;
    return config.getDefaults(activity, accounts);
  }, [config, activity, accounts]);

  // Single submit handler that uses config transform
  const handleSubmit = useCallback(
    async (formData: ActivityFormValues) => {
      if (!config) return;

      try {
        // Handle internal transfers specially - need to create two activities
        if (selectedType === "TRANSFER") {
          const transferData = formData as TransferFormValues;

          // Internal transfer: update or create both legs
          if (!transferData.isExternal && transferData.fromAccountId && transferData.toAccountId) {
            const fromAccount = accounts.find((a) => a.value === transferData.fromAccountId);
            const toAccount = accounts.find((a) => a.value === transferData.toAccountId);

            if (transferData.transferMode === "cash") {
              const sourceAmount = transferData.sourceAmount ?? transferData.amount;
              const sourceCurrency = transferData.sourceCurrency ?? fromAccount?.currency;
              const destinationCurrency =
                transferData.destinationCurrency ?? toAccount?.currency ?? sourceCurrency;
              const destinationAmount =
                sourceCurrency === destinationCurrency
                  ? sourceAmount
                  : (transferData.destinationAmount ??
                    (sourceAmount && transferData.fxRate
                      ? sourceAmount * transferData.fxRate
                      : undefined));

              if (!sourceAmount || !destinationAmount || !sourceCurrency || !destinationCurrency) {
                throw new Error("Transfer amount and currencies are required.");
              }

              const { transferOutId, transferInId } = transferPairIds(activity);

              if (isEditing && (!transferOutId || !transferInId)) {
                throw new Error(
                  "Use Link transfer... to pair this existing transfer before saving it as internal.",
                );
              }

              await saveInternalTransferPairMutation.mutateAsync({
                transferOutId: isEditing ? transferOutId : undefined,
                transferInId: isEditing ? transferInId : undefined,
                fromAccountId: transferData.fromAccountId,
                toAccountId: transferData.toAccountId,
                activityDate: transferData.activityDate,
                sourceAmount,
                destinationAmount,
                sourceCurrency,
                destinationCurrency,
                fxRate:
                  sourceCurrency === destinationCurrency
                    ? undefined
                    : (transferData.fxRate ?? null),
                notes: transferData.comment ?? null,
                transferMode: "cash",
              });
              return;
            }

            const formPayload = config.toPayload(formData);

            // Extract symbol-related and fxRate fields from payload
            const {
              assetId,
              existingAssetId,
              fxRate,
              exchangeMic,
              quoteMode,
              symbolQuoteCcy,
              symbolInstrumentType,
              assetMetadata,
              ...sharedFields
            } = formPayload as {
              assetId?: string;
              fxRate?: number;
              exchangeMic?: string;
              existingAssetId?: string;
              quoteMode?: string;
              symbolQuoteCcy?: string;
              symbolInstrumentType?: string;
              assetMetadata?: {
                name?: string;
                kind?: string;
                exchangeMic?: string;
                providerId?: string | null;
                providerSymbol?: string | null;
              };
            } & Record<string, unknown>;

            // Build the nested asset object with all metadata
            const assetInput: ActivityCreate["asset"] = assetId
              ? buildAssetResolutionInput({
                  id: existingAssetId,
                  symbol: assetId,
                  exchangeMic,
                  quoteMode,
                  quoteCcy: symbolQuoteCcy,
                  instrumentType: symbolInstrumentType,
                  name: assetMetadata?.name,
                  kind: assetMetadata?.kind,
                  providerId: assetMetadata?.providerId,
                  providerSymbol: assetMetadata?.providerSymbol,
                })
              : undefined;

            if (isEditing) {
              const { transferOutId, transferInId } = transferPairIds(activity);

              if (!transferOutId || !transferInId) {
                throw new Error("Editing an internal securities transfer requires both legs.");
              }

              const transferOutActivity: ActivityUpdate = {
                ...sharedFields,
                id: transferOutId,
                accountId: transferData.fromAccountId,
                activityType: ActivityType.TRANSFER_OUT,
                currency: fromAccount?.currency,
                asset: assetInput,
              } as ActivityUpdate;

              const transferInActivity: ActivityUpdate = {
                ...sharedFields,
                id: transferInId,
                accountId: transferData.toAccountId,
                activityType: ActivityType.TRANSFER_IN,
                currency: toAccount?.currency,
                asset: assetInput,
                fxRate,
              } as ActivityUpdate;

              await saveActivitiesMutation.mutateAsync({
                updates: [transferOutActivity, transferInActivity],
              });
              return;
            }

            const sourceGroupId = generateSourceGroupId();

            // Create TRANSFER_OUT on source account (no fxRate - activity currency = account currency)
            const transferOutActivity: ActivityCreate = {
              ...sharedFields,
              accountId: transferData.fromAccountId,
              activityType: ActivityType.TRANSFER_OUT,
              currency: fromAccount?.currency,
              sourceGroupId,
              asset: assetInput,
            } as ActivityCreate;

            // Create TRANSFER_IN on destination account (fxRate applies if currencies differ)
            const transferInActivity: ActivityCreate = {
              ...sharedFields,
              accountId: transferData.toAccountId,
              activityType: ActivityType.TRANSFER_IN,
              currency: toAccount?.currency,
              sourceGroupId,
              asset: assetInput,
              fxRate,
            } as ActivityCreate;

            await saveActivitiesMutation.mutateAsync({
              creates: [transferOutActivity, transferInActivity],
            });
            return;
          }

          // External transfer: determine activity type from direction
          const activityType =
            transferData.direction === "in" ? ActivityType.TRANSFER_IN : ActivityType.TRANSFER_OUT;
          const basePayload = config.toPayload(formData);
          const accountId = transferData.accountId;
          const account = accounts.find((a) => a.value === accountId);

          const submitData: NewActivityFormValues = {
            ...basePayload,
            activityType,
          } as NewActivityFormValues;

          if (!submitData.currency?.trim() && account?.currency) {
            submitData.currency = account.currency;
          }

          if (isEditing && activity?.id) {
            let { transferOutId, transferInId } = transferPairIds(activity);
            if (activity.sourceGroupId && (!transferOutId || !transferInId)) {
              try {
                const pair = await getTransferPairForActivity(activity.id);
                if (pair) {
                  transferOutId = pair.transferOut.id;
                  transferInId = pair.transferIn.id;
                }
              } catch {
                // Invalid/orphan groups are cleared by the single-row external update below.
              }
            }
            if (activity.sourceGroupId && transferOutId && transferInId) {
              await unlinkTransferActivitiesMutation.mutateAsync({
                activityAId: transferOutId,
                activityBId: transferInId,
              });
            }
            await updateActivityMutation.mutateAsync({
              id: activity.id,
              currentAssetId: activity.assetId,
              ...submitData,
            } as NewActivityFormValues & { id: string; currentAssetId?: string });
          } else {
            await addActivityMutation.mutateAsync(submitData);
          }
          return;
        }

        // Standard activity handling
        const basePayload = config.toPayload(formData);

        // Get account currency for pure cash activities
        const accountId = (formData as { accountId?: string }).accountId;
        const account = accounts.find((a) => a.value === accountId);

        const submitData: NewActivityFormValues = {
          ...basePayload,
          activityType: config.activityType as NewActivityFormValues["activityType"],
        } as NewActivityFormValues;

        if (!submitData.currency?.trim() && account?.currency) {
          submitData.currency = account.currency;
        }

        // A form save is a review: every field - including the total, typed
        // or calculated - is on screen when the user submits, so every form
        // submission attests. Drafts are the exception: they stay in their
        // review queue until explicitly approved and posted.
        if (isEditing && activity?.status === ActivityStatus.DRAFT) {
          delete (submitData as { needsReview?: boolean }).needsReview;
        } else {
          (submitData as { needsReview?: boolean }).needsReview = false;
        }

        if (isEditing && activity?.id) {
          const currentAssetId =
            selectedType === ActivityType.ADJUSTMENT &&
            (formData as AdjustmentFormValues).adjustmentMode === "cash"
              ? undefined
              : activity.assetId;
          const clearAsset = Boolean(
            activity.assetId &&
            selectedType === ActivityType.ADJUSTMENT &&
            (formData as AdjustmentFormValues).adjustmentMode === "cash",
          );
          await updateActivityMutation.mutateAsync({
            id: activity.id,
            currentAssetId,
            clearAsset,
            ...submitData,
          } as NewActivityFormValues & {
            id: string;
            currentAssetId?: string;
            clearAsset?: boolean;
          });
        } else {
          await addActivityMutation.mutateAsync(submitData);
        }
      } catch (err) {
        const message = extractErrorMessage(err);
        toast.error("Failed to save activity", { description: message });
        logger.error(`Activity Form Submit Error: ${JSON.stringify({ error: err, formData })}`);
      }
    },
    [
      config,
      accounts,
      isEditing,
      activity,
      selectedType,
      addActivityMutation,
      updateActivityMutation,
      saveActivitiesMutation,
      saveInternalTransferPairMutation,
      unlinkTransferActivitiesMutation,
    ],
  );

  return {
    defaultValues,
    isEditing,
    isLoading,
    error,
    isError,
    handleSubmit,
  };
}
