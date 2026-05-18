import { logger } from "@/adapters";
import { buildAssetResolutionInput } from "@/lib/asset-resolution-input";
import { ActivityType } from "@/lib/constants";
import { generateId } from "@/lib/id";
import type { ActivityCreate, ActivityDetails } from "@/lib/types";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { AccountSelectOption } from "../components/forms/fields";
import type { NewActivityFormValues } from "../components/forms/schemas";
import type { TransferFormValues } from "../components/forms/transfer-form";
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
  const { addActivityMutation, updateActivityMutation, saveActivitiesMutation } =
    useActivityMutations(onSuccess);

  const isEditing = !!activity?.id;
  const isLoading =
    addActivityMutation.isPending ||
    updateActivityMutation.isPending ||
    saveActivitiesMutation.isPending;
  const error =
    addActivityMutation.error ?? updateActivityMutation.error ?? saveActivitiesMutation.error;
  const isError =
    addActivityMutation.isError || updateActivityMutation.isError || saveActivitiesMutation.isError;

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

          // Internal transfer: create both TRANSFER_OUT and TRANSFER_IN
          if (!transferData.isExternal && transferData.fromAccountId && transferData.toAccountId) {
            const formPayload = config.toPayload(formData);
            const sourceGroupId = generateSourceGroupId();

            // Get currencies for both accounts
            const fromAccount = accounts.find((a) => a.value === transferData.fromAccountId);
            const toAccount = accounts.find((a) => a.value === transferData.toAccountId);

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

        if (isEditing && activity?.id) {
          await updateActivityMutation.mutateAsync({
            id: activity.id,
            currentAssetId: activity.assetId,
            ...submitData,
          } as NewActivityFormValues & { id: string; currentAssetId?: string });
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
      activity?.id,
      selectedType,
      addActivityMutation,
      updateActivityMutation,
      saveActivitiesMutation,
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
