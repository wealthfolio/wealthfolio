import {
  createActivity,
  deleteActivity,
  linkTransferActivities,
  logger,
  saveActivities,
  saveInternalTransferPair,
  unlinkTransferActivities,
  updateActivity,
} from "@/adapters";
import { buildAssetResolutionInput, normalizeOptionalString } from "@/lib/asset-resolution-input";
import { generateId } from "@/lib/id";
import {
  ActivityBulkMutationRequest,
  ActivityBulkMutationResult,
  ActivityCreate,
  ActivityDetails,
  ActivityUpdate,
  InternalTransferPairRequest,
  InternalTransferPairResponse,
} from "@/lib/types";
import { isSecuritiesTransfer } from "@/lib/activity-utils";
import { ActivityType, InstrumentType } from "@/lib/constants";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { NewActivityFormValues } from "../components/forms/schemas";

export function useActivityMutations(
  onSuccess?: (activity: { accountId?: string | null }) => void,
) {
  const queryClient = useQueryClient();

  const buildActivityAssetInput = ({
    assetId,
    existingAssetId,
    currentAssetId,
    exchangeMic,
    quoteMode,
    assetKind,
    assetMetadata,
    symbolQuoteCcy,
    symbolInstrumentType,
    includeId,
  }: {
    assetId?: string;
    existingAssetId?: string;
    currentAssetId?: string;
    exchangeMic?: string;
    quoteMode?: string;
    assetKind?: string;
    assetMetadata?: {
      name?: string;
      kind?: string;
      exchangeMic?: string;
      providerId?: string | null;
      providerSymbol?: string | null;
    };
    symbolQuoteCcy?: string;
    symbolInstrumentType?: string;
    includeId: boolean;
  }): ActivityCreate["asset"] => {
    const normalizedAssetId = normalizeOptionalString(assetId);
    const normalizedInstrumentType = normalizeOptionalString(symbolInstrumentType);
    const normalizedExistingAssetId =
      normalizedAssetId && normalizedInstrumentType?.toUpperCase() !== "OPTION"
        ? normalizeOptionalString(existingAssetId)
        : undefined;
    const normalizedCurrentAssetId = includeId
      ? normalizeOptionalString(currentAssetId)
      : undefined;
    if (!normalizedAssetId && !normalizedCurrentAssetId) return undefined;

    return buildAssetResolutionInput({
      id: normalizedExistingAssetId ?? normalizedCurrentAssetId,
      symbol: normalizedAssetId,
      exchangeMic: normalizedAssetId ? exchangeMic : undefined,
      kind: normalizedAssetId
        ? (normalizeOptionalString(assetKind) ?? normalizeOptionalString(assetMetadata?.kind))
        : undefined,
      name: normalizedAssetId ? assetMetadata?.name : undefined,
      quoteMode: normalizedAssetId ? quoteMode : undefined,
      quoteCcy: normalizedAssetId ? symbolQuoteCcy : undefined,
      instrumentType: normalizedAssetId ? normalizedInstrumentType : undefined,
      providerId: normalizedAssetId ? assetMetadata?.providerId : undefined,
      providerSymbol: normalizedAssetId ? assetMetadata?.providerSymbol : undefined,
    });
  };

  const toDecimalPayload = (value: unknown): string | null | undefined => {
    if (value === null) return null;
    if (value === undefined) return undefined;
    const str = (typeof value === "string" ? value : `${value as number}`).trim();
    return str === "" ? undefined : str;
  };

  const createMutationOptions = (action: string) => ({
    onSuccess: (activity: { accountId?: string | null }) => {
      queryClient.invalidateQueries();
      if (onSuccess) onSuccess(activity);
    },
    onError: (error: string) => {
      logger.error(`Error ${action} activity: ${String(error)}`);
      toast.error(`Failed ${action} activity`, {
        description: String(error),
      });
    },
  });

  const addActivityMutation = useMutation({
    mutationFn: async (data: NewActivityFormValues) => {
      // Extract asset-related fields from form data
      const {
        assetId,
        exchangeMic,
        metadata,
        assetMetadata,
        existingAssetId,
        quoteMode,
        assetKind,
        symbolQuoteCcy,
        symbolInstrumentType,
        transferMode: _transferMode,
        isExternal: _isExternal,
        direction: _direction,
        toAccountId: _toAccountId,
        sourceAmount: _sourceAmount,
        destinationAmount: _destinationAmount,
        sourceCurrency: _sourceCurrency,
        destinationCurrency: _destinationCurrency,
        ...rest
      } = data as NewActivityFormValues & {
        assetId?: string;
        exchangeMic?: string;
        metadata?: Record<string, unknown>;
        assetMetadata?: {
          name?: string;
          kind?: string;
          exchangeMic?: string;
          providerId?: string | null;
          providerSymbol?: string | null;
        };
        existingAssetId?: string;
        quoteMode?: string;
        assetKind?: string;
        symbolQuoteCcy?: string;
        symbolInstrumentType?: string;
        transferMode?: string;
        isExternal?: boolean;
        direction?: string;
        toAccountId?: string;
        sourceAmount?: number;
        destinationAmount?: number;
        sourceCurrency?: string;
        destinationCurrency?: string;
      };
      const quantity = "quantity" in rest ? rest.quantity : undefined;
      const unitPrice = "unitPrice" in rest ? rest.unitPrice : undefined;
      const amount = "amount" in rest ? rest.amount : undefined;
      const fee = "fee" in rest ? rest.fee : undefined;
      const tax = "tax" in rest ? rest.tax : undefined;
      const fxRate = "fxRate" in rest ? rest.fxRate : undefined;

      // Build nested asset object
      const createPayload: ActivityCreate = {
        ...rest,
        quantity: toDecimalPayload(quantity),
        unitPrice: toDecimalPayload(unitPrice),
        amount: toDecimalPayload(amount),
        fee: toDecimalPayload(fee),
        tax: toDecimalPayload(tax),
        fxRate: toDecimalPayload(fxRate),
        asset: buildActivityAssetInput({
          assetId,
          existingAssetId,
          exchangeMic,
          quoteMode,
          assetKind,
          assetMetadata,
          symbolQuoteCcy,
          symbolInstrumentType,
          includeId: false,
        }),
        // Serialize metadata object to JSON string for backend
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      };
      // Backend handles quote creation for MANUAL pricing mode
      return await createActivity(createPayload);
    },
    ...createMutationOptions("adding"),
  });

  const updateActivityMutation = useMutation({
    mutationFn: async (data: NewActivityFormValues & { id: string }) => {
      // Extract asset-related fields from form data
      const {
        assetId,
        currentAssetId,
        exchangeMic,
        metadata,
        assetMetadata,
        existingAssetId,
        quoteMode,
        assetKind,
        symbolQuoteCcy,
        symbolInstrumentType,
        transferMode: _transferMode2,
        isExternal: _isExternal2,
        direction: _direction2,
        toAccountId: _toAccountId2,
        sourceAmount: _sourceAmount2,
        destinationAmount: _destinationAmount2,
        sourceCurrency: _sourceCurrency2,
        destinationCurrency: _destinationCurrency2,
        ...rest
      } = data as NewActivityFormValues & {
        id: string;
        assetId?: string;
        currentAssetId?: string;
        exchangeMic?: string;
        metadata?: Record<string, unknown>;
        assetMetadata?: {
          name?: string;
          kind?: string;
          exchangeMic?: string;
          providerId?: string | null;
          providerSymbol?: string | null;
        };
        existingAssetId?: string;
        quoteMode?: string;
        assetKind?: string;
        symbolQuoteCcy?: string;
        symbolInstrumentType?: string;
        transferMode?: string;
        isExternal?: boolean;
        direction?: string;
        toAccountId?: string;
        sourceAmount?: number;
        destinationAmount?: number;
        sourceCurrency?: string;
        destinationCurrency?: string;
      };
      const quantity = "quantity" in rest ? rest.quantity : undefined;
      const unitPrice = "unitPrice" in rest ? rest.unitPrice : undefined;
      const amount = "amount" in rest ? rest.amount : undefined;
      const fee = "fee" in rest ? rest.fee : undefined;
      const tax = "tax" in rest ? rest.tax : undefined;
      const fxRate = "fxRate" in rest ? rest.fxRate : undefined;

      // Build nested asset object
      const updatePayload: ActivityUpdate = {
        ...rest,
        subtype: rest.subtype === null ? "" : rest.subtype,
        quantity: toDecimalPayload(quantity),
        unitPrice: toDecimalPayload(unitPrice),
        amount: toDecimalPayload(amount),
        fee: toDecimalPayload(fee),
        tax: toDecimalPayload(tax),
        fxRate: toDecimalPayload(fxRate),
        asset: buildActivityAssetInput({
          assetId,
          existingAssetId,
          currentAssetId,
          exchangeMic,
          quoteMode,
          assetKind,
          assetMetadata,
          symbolQuoteCcy,
          symbolInstrumentType,
          includeId: true,
        }),
        // Serialize metadata object to JSON string for backend
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      };
      // Backend handles quote creation for MANUAL pricing mode
      const result = await updateActivity(updatePayload);

      if (!result || typeof result !== "object" || !("id" in result)) {
        throw new Error("Failed updating activity");
      }

      const serverError = (result as unknown as Record<string, unknown>).error;
      if (typeof serverError === "string" && serverError.trim()) {
        throw new Error(serverError);
      }

      return result;
    },
    ...createMutationOptions("updating"),
  });

  const deleteActivityMutation = useMutation({
    mutationFn: deleteActivity,
    ...createMutationOptions("deleting"),
  });

  const linkTransferActivitiesMutation = useMutation({
    mutationFn: ({ activityAId, activityBId }: { activityAId: string; activityBId: string }) =>
      linkTransferActivities(activityAId, activityBId),
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast.success("Transfers linked", {
        description: "The two activities are now paired as an internal transfer.",
      });
    },
    onError: (error: string) => {
      logger.error(`Error linking transfers: ${String(error)}`);
      toast.error("Failed to link transfers", {
        description: String(error),
      });
    },
  });

  const unlinkTransferActivitiesMutation = useMutation({
    mutationFn: ({ activityAId, activityBId }: { activityAId: string; activityBId: string }) =>
      unlinkTransferActivities(activityAId, activityBId),
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast.success("Transfers unlinked", {
        description: "The two activities are external transfers again.",
      });
    },
    onError: (error: string) => {
      logger.error(`Error unlinking transfers: ${String(error)}`);
      toast.error("Failed to unlink transfers", {
        description: String(error),
      });
    },
  });

  const duplicateActivity = async (activityToDuplicate: ActivityDetails) => {
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      comment: _comment,
      date,
      assetId: _assetId,
      assetSymbol,
      exchangeMic,
      assetQuoteMode,
      ...restOfActivityData
    } = activityToDuplicate;
    const isBuyOrSell =
      restOfActivityData.activityType === ActivityType.BUY ||
      restOfActivityData.activityType === ActivityType.SELL;
    const isBondTrade =
      isBuyOrSell && activityToDuplicate.instrumentType?.toUpperCase() === InstrumentType.BOND;
    const shouldCopyAmount =
      isBondTrade ||
      (!isBuyOrSell &&
        !isSecuritiesTransfer(restOfActivityData.activityType, assetSymbol, _assetId));

    // For duplicating, use nested asset object
    const createPayload: ActivityCreate = {
      idempotencyKey: generateId("manual-duplicate"),
      accountId: restOfActivityData.accountId,
      activityType: restOfActivityData.activityType,
      subtype: restOfActivityData.subtype,
      currency: restOfActivityData.currency,
      quantity: restOfActivityData.quantity,
      unitPrice: restOfActivityData.unitPrice,
      amount: shouldCopyAmount ? restOfActivityData.amount : undefined,
      fee: restOfActivityData.fee,
      tax: restOfActivityData.tax,
      fxRate: restOfActivityData.fxRate ?? undefined,
      activityDate: date,
      comment: "Duplicated",
      asset: buildAssetResolutionInput({
        id: _assetId,
        symbol: assetSymbol,
        exchangeMic,
        quoteMode: assetQuoteMode,
        instrumentType: activityToDuplicate.instrumentType,
      }),
    };

    return await createActivity(createPayload);
  };

  const duplicateActivityMutation = useMutation({
    mutationFn: duplicateActivity,
    ...createMutationOptions("duplicating"),
  });

  const saveActivitiesMutation = useMutation({
    mutationFn: async (request: ActivityBulkMutationRequest) => {
      // NOTE: No longer normalizing cash activities to CASH:{currency} here.
      // Backend is now responsible for generating canonical asset IDs:
      // - For cash activities: backend generates CASH:{currency}
      // - For market activities: backend generates SEC:{symbol}:{mic} from symbol + exchangeMic

      // Serialize metadata objects to JSON strings for backend
      const serializeMetadata = (
        item: ActivityCreate | ActivityUpdate,
      ): ActivityCreate | ActivityUpdate => {
        if (item.metadata && typeof item.metadata !== "string") {
          return { ...item, metadata: JSON.stringify(item.metadata) };
        }
        return item;
      };

      const normalizedRequest: ActivityBulkMutationRequest = {
        creates: request.creates?.map(serializeMetadata) as ActivityCreate[],
        updates: request.updates?.map(serializeMetadata) as ActivityUpdate[],
        deleteIds: request.deleteIds,
      };

      // Backend handles quote creation for MANUAL pricing mode
      return await saveActivities(normalizedRequest);
    },
    onSuccess: (result: ActivityBulkMutationResult) => {
      queryClient.invalidateQueries();

      // Show errors from partial failures
      if (result.errors?.length > 0) {
        const messages = result.errors.map((e) => e.message).join("; ");
        toast.error("Some activities failed to save", { description: messages });
        logger.error(`Bulk save partial failure: ${JSON.stringify(result.errors)}`);
      }

      // Call onSuccess with first created activity for sheet close callback
      if (onSuccess && result.created.length > 0) {
        onSuccess({ accountId: result.created[0].accountId });
      }
    },
    onError: (error: string) => {
      logger.error(`Error saving activities: ${String(error)}`);
      toast.error("Failed to save activities", {
        description: String(error),
      });
    },
  });

  const saveInternalTransferPairMutation = useMutation({
    mutationFn: async (request: InternalTransferPairRequest) => {
      return await saveInternalTransferPair(request);
    },
    onSuccess: (result: InternalTransferPairResponse) => {
      queryClient.invalidateQueries();
      if (onSuccess) onSuccess({ accountId: result.transferOut.accountId });
    },
    onError: (error: string) => {
      logger.error(`Error saving internal transfer pair: ${String(error)}`);
      toast.error("Failed to save transfer", {
        description: String(error),
      });
    },
  });

  return {
    addActivityMutation,
    updateActivityMutation,
    deleteActivityMutation,
    duplicateActivityMutation,
    saveActivitiesMutation,
    saveInternalTransferPairMutation,
    linkTransferActivitiesMutation,
    unlinkTransferActivitiesMutation,
  };
}
