import type { ComponentType } from "react";
import {
  ACTIVITY_SUBTYPES,
  ActivityType,
  InstrumentType,
  METADATA_CONTRACT_MULTIPLIER,
  QuoteMode,
} from "@/lib/constants";
import { isSecuritiesTransfer } from "@/lib/activity-utils";
import { parseOccSymbol } from "@/lib/occ-symbol";
import type { ActivityDetails } from "@/lib/types";
import { BuyForm, type BuyFormValues } from "../components/forms/buy-form";
import { SellForm, type SellFormValues } from "../components/forms/sell-form";
import { DepositForm, type DepositFormValues } from "../components/forms/deposit-form";
import { WithdrawalForm, type WithdrawalFormValues } from "../components/forms/withdrawal-form";
import { DividendForm, type DividendFormValues } from "../components/forms/dividend-form";
import { TransferForm, type TransferFormValues } from "../components/forms/transfer-form";
import { SplitForm, type SplitFormValues } from "../components/forms/split-form";
import { FeeForm, type FeeFormValues } from "../components/forms/fee-form";
import { InterestForm, type InterestFormValues } from "../components/forms/interest-form";
import { TaxForm, type TaxFormValues } from "../components/forms/tax-form";
import type { AccountSelectOption } from "../components/forms/fields";
import type { NewActivityFormValues } from "../components/forms/schemas";

// Picker activity types (TRANSFER_IN/OUT merged into TRANSFER)
export type PickerActivityType =
  | typeof ActivityType.BUY
  | typeof ActivityType.SELL
  | typeof ActivityType.DEPOSIT
  | typeof ActivityType.WITHDRAWAL
  | typeof ActivityType.DIVIDEND
  | "TRANSFER"
  | typeof ActivityType.SPLIT
  | typeof ActivityType.FEE
  | typeof ActivityType.INTEREST
  | typeof ActivityType.TAX;

// Form values union type
export type ActivityFormValues =
  | BuyFormValues
  | SellFormValues
  | DepositFormValues
  | WithdrawalFormValues
  | DividendFormValues
  | TransferFormValues
  | SplitFormValues
  | FeeFormValues
  | InterestFormValues
  | TaxFormValues;

// Common form props interface
export interface ActivityFormComponentProps<T> {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<T>;
  onSubmit: (data: T) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}

// Config for each activity type
export interface ActivityTypeConfig<TFormValues = unknown> {
  component: ComponentType<ActivityFormComponentProps<TFormValues>>;
  activityType: string; // The actual ActivityType to submit
  getDefaults: (
    activity: Partial<ActivityDetails> | undefined,
    accounts: AccountSelectOption[],
  ) => Partial<TFormValues>;
  toPayload: (data: TFormValues) => Partial<NewActivityFormValues>;
}

// Normalize a numeric value to its absolute value (direction is determined by activity type)
function absNum(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? Math.abs(n) : undefined;
}

// Base defaults shared by most forms
function getBaseDefaults(
  activity: Partial<ActivityDetails> | undefined,
  accounts: AccountSelectOption[],
) {
  return {
    accountId: activity?.accountId ?? (accounts.length === 1 ? accounts[0].value : ""),
    activityDate: activity?.date ? new Date(activity.date) : new Date(),
    comment: activity?.comment ?? null,
  };
}

function selectedExistingAsset(
  assetSymbol: string | null | undefined,
  existingAssetId: string | null | undefined,
  instrumentType?: string | null,
) {
  if (!assetSymbol?.trim()) return {};
  if (instrumentType?.trim().toUpperCase() === InstrumentType.OPTION) return {};

  const id = existingAssetId?.trim();
  return id ? { existingAssetId: id } : {};
}

// Configuration for each activity type
export const ACTIVITY_FORM_CONFIG: Record<
  PickerActivityType,
  ActivityTypeConfig<ActivityFormValues>
> = {
  BUY: {
    component: BuyForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.BUY,
    getDefaults: (activity, accounts) => {
      const base = {
        ...getBaseDefaults(activity, accounts),
        assetId: activity?.assetSymbol ?? activity?.assetId ?? "",
        quantity: absNum(activity?.quantity),
        unitPrice: absNum(activity?.unitPrice),
        amount: absNum(activity?.amount),
        fee: absNum(activity?.fee) ?? 0,
        quoteMode:
          activity?.assetQuoteMode === QuoteMode.MANUAL ? QuoteMode.MANUAL : QuoteMode.MARKET,
        // Advanced options
        currency: activity?.currency,
        fxRate: activity?.fxRate ?? undefined,
        exchangeMic: activity?.exchangeMic,
      };

      // Populate option-specific fields from OCC symbol when editing
      if (activity?.instrumentType === InstrumentType.OPTION) {
        const parsed = parseOccSymbol(activity.assetSymbol ?? "");
        return {
          ...base,
          assetType: "option" as const,
          assetKind: InstrumentType.OPTION,
          symbolInstrumentType: InstrumentType.OPTION,
          symbolQuoteCcy: activity?.currency ?? undefined,
          underlyingSymbol: parsed?.underlying ?? "",
          strikePrice: parsed?.strikePrice,
          expirationDate: parsed?.expiration,
          optionType: parsed?.optionType,
          contractMultiplier: 100,
        };
      }

      // Populate bond-specific fields when editing
      if (activity?.instrumentType === InstrumentType.BOND) {
        return {
          ...base,
          assetType: "bond" as const,
          assetKind: InstrumentType.BOND,
          symbolInstrumentType: InstrumentType.BOND,
          symbolQuoteCcy: activity?.currency ?? undefined,
        };
      }

      return base;
    },
    toPayload: (data) => {
      const d = data as BuyFormValues;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        assetId: d.assetId,
        ...selectedExistingAsset(d.assetId, d.existingAssetId, d.symbolInstrumentType),
        quantity: d.quantity,
        unitPrice: d.unitPrice,
        fee: d.fee,
        comment: d.comment,
        quoteMode: d.quoteMode,
        exchangeMic: d.exchangeMic ?? undefined,
        symbolQuoteCcy: d.symbolQuoteCcy ?? undefined,
        symbolInstrumentType: d.symbolInstrumentType ?? undefined,
        assetKind: d.assetKind ?? undefined,
        currency: d.currency,
        fxRate: d.fxRate,
        assetMetadata: d.assetMetadata
          ? {
              name: d.assetMetadata.name ?? undefined,
              kind: d.assetMetadata.kind ?? undefined,
              exchangeMic: d.assetMetadata.exchangeMic ?? undefined,
              providerId: d.assetMetadata.providerId ?? undefined,
              providerSymbol: d.assetMetadata.providerSymbol ?? undefined,
            }
          : undefined,
        ...(d.symbolInstrumentType === InstrumentType.OPTION &&
          d.contractMultiplier != null &&
          d.contractMultiplier !== 100 && {
            metadata: { [METADATA_CONTRACT_MULTIPLIER]: d.contractMultiplier },
          }),
      };
    },
  },

  SELL: {
    component: SellForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.SELL,
    getDefaults: (activity, accounts) => {
      const base = {
        ...getBaseDefaults(activity, accounts),
        assetId: activity?.assetSymbol ?? activity?.assetId ?? "",
        quantity: absNum(activity?.quantity),
        unitPrice: absNum(activity?.unitPrice),
        amount: absNum(activity?.amount),
        fee: absNum(activity?.fee) ?? 0,
        quoteMode:
          activity?.assetQuoteMode === QuoteMode.MANUAL ? QuoteMode.MANUAL : QuoteMode.MARKET,
        // Advanced options
        currency: activity?.currency,
        fxRate: activity?.fxRate ?? undefined,
        exchangeMic: activity?.exchangeMic,
      };

      // Populate option-specific fields from OCC symbol when editing
      if (activity?.instrumentType === InstrumentType.OPTION) {
        const parsed = parseOccSymbol(activity.assetSymbol ?? "");
        return {
          ...base,
          assetType: "option" as const,
          assetKind: InstrumentType.OPTION,
          symbolInstrumentType: InstrumentType.OPTION,
          symbolQuoteCcy: activity?.currency ?? undefined,
          underlyingSymbol: parsed?.underlying ?? "",
          strikePrice: parsed?.strikePrice,
          expirationDate: parsed?.expiration,
          optionType: parsed?.optionType,
          contractMultiplier: 100,
        };
      }

      // Populate bond-specific fields when editing
      if (activity?.instrumentType === InstrumentType.BOND) {
        return {
          ...base,
          assetType: "bond" as const,
          assetKind: InstrumentType.BOND,
          symbolInstrumentType: InstrumentType.BOND,
          symbolQuoteCcy: activity?.currency ?? undefined,
        };
      }

      return base;
    },
    toPayload: (data) => {
      const d = data as SellFormValues;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        assetId: d.assetId,
        ...selectedExistingAsset(d.assetId, d.existingAssetId, d.symbolInstrumentType),
        quantity: d.quantity,
        unitPrice: d.unitPrice,
        fee: d.fee,
        comment: d.comment,
        quoteMode: d.quoteMode,
        exchangeMic: d.exchangeMic ?? undefined,
        symbolQuoteCcy: d.symbolQuoteCcy ?? undefined,
        symbolInstrumentType: d.symbolInstrumentType ?? undefined,
        assetKind: d.assetKind ?? undefined,
        currency: d.currency,
        fxRate: d.fxRate,
        assetMetadata: d.assetMetadata
          ? {
              name: d.assetMetadata.name ?? undefined,
              kind: d.assetMetadata.kind ?? undefined,
              exchangeMic: d.assetMetadata.exchangeMic ?? undefined,
              providerId: d.assetMetadata.providerId ?? undefined,
              providerSymbol: d.assetMetadata.providerSymbol ?? undefined,
            }
          : undefined,
        ...(d.symbolInstrumentType === InstrumentType.OPTION &&
          d.contractMultiplier != null &&
          d.contractMultiplier !== 100 && {
            metadata: { [METADATA_CONTRACT_MULTIPLIER]: d.contractMultiplier },
          }),
      };
    },
  },

  DEPOSIT: {
    component: DepositForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.DEPOSIT,
    getDefaults: (activity, accounts) => ({
      ...getBaseDefaults(activity, accounts),
      amount: absNum(activity?.amount),
      // Advanced options
      currency: activity?.currency,
      fxRate: activity?.fxRate ?? undefined,
    }),
    toPayload: (data) => {
      const d = data as DepositFormValues;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        amount: d.amount,
        comment: d.comment,
        currency: d.currency,
        fxRate: d.fxRate,
      };
    },
  },

  WITHDRAWAL: {
    component: WithdrawalForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.WITHDRAWAL,
    getDefaults: (activity, accounts) => ({
      ...getBaseDefaults(activity, accounts),
      amount: absNum(activity?.amount),
      // Advanced options
      currency: activity?.currency,
      fxRate: activity?.fxRate ?? undefined,
    }),
    toPayload: (data) => {
      const d = data as WithdrawalFormValues;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        amount: d.amount,
        comment: d.comment,
        currency: d.currency,
        fxRate: d.fxRate,
      };
    },
  },

  DIVIDEND: {
    component: DividendForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.DIVIDEND,
    getDefaults: (activity, accounts) => ({
      ...getBaseDefaults(activity, accounts),
      symbol: activity?.assetSymbol ?? activity?.assetId ?? "",
      amount: absNum(activity?.amount),
      unitPrice: absNum(activity?.unitPrice),
      quantity: absNum(activity?.quantity),
      // Advanced options
      currency: activity?.currency,
      fxRate: activity?.fxRate ?? undefined,
      subtype: activity?.subtype ?? null,
      exchangeMic: activity?.exchangeMic,
    }),
    toPayload: (data) => {
      const d = data as DividendFormValues;
      const isAssetBackedDividend =
        d.subtype === ACTIVITY_SUBTYPES.DRIP || d.subtype === ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        assetId: d.symbol,
        ...selectedExistingAsset(d.symbol, d.existingAssetId, d.symbolInstrumentType),
        amount: d.amount,
        unitPrice: isAssetBackedDividend ? d.unitPrice : null,
        quantity: isAssetBackedDividend ? d.quantity : null,
        comment: d.comment,
        subtype: d.subtype ?? null,
        currency: d.currency,
        fxRate: d.fxRate,
        exchangeMic: d.exchangeMic ?? undefined,
        symbolQuoteCcy: d.symbolQuoteCcy ?? undefined,
        symbolInstrumentType: d.symbolInstrumentType ?? undefined,
      };
    },
  },

  TRANSFER: {
    component: TransferForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.TRANSFER_OUT,
    getDefaults: (activity, _accounts) => {
      // Derive transferMode from existing activity data
      const transferIsSecurity = isSecuritiesTransfer(
        activity?.activityType ?? "",
        activity?.assetSymbol,
        activity?.assetId,
      );
      const transferMode = transferIsSecurity ? "securities" : "cash";
      // Derive isExternal from metadata (if flow.is_external is true)
      const flowMetadata = activity?.metadata?.flow as { is_external?: boolean } | undefined;
      const isExternal = flowMetadata?.is_external === true;
      // Derive direction from activity type
      const direction = activity?.activityType === ActivityType.TRANSFER_IN ? "in" : "out";
      return {
        isExternal,
        direction,
        accountId: isExternal ? (activity?.accountId ?? "") : "",
        fromAccountId: !isExternal ? (activity?.accountId ?? "") : "",
        toAccountId: "",
        activityDate: activity?.date ? new Date(activity.date) : new Date(),
        transferMode,
        amount: absNum(activity?.amount),
        assetId: transferIsSecurity ? (activity?.assetSymbol ?? activity?.assetId ?? null) : null,
        quantity: transferIsSecurity ? (absNum(activity?.quantity) ?? null) : null,
        unitPrice: transferIsSecurity ? (absNum(activity?.unitPrice) ?? null) : null,
        comment: activity?.comment ?? null,
        // Advanced options
        currency: activity?.currency,
        fxRate: activity?.fxRate ?? undefined,
        subtype: activity?.subtype ?? null,
        quoteMode:
          activity?.assetQuoteMode === QuoteMode.MANUAL ? QuoteMode.MANUAL : QuoteMode.MARKET,
        exchangeMic: activity?.exchangeMic,
      };
    },
    toPayload: (data) => {
      const d = data as TransferFormValues;
      const accountId = d.isExternal ? d.accountId : d.fromAccountId;
      return {
        accountId,
        activityDate: d.activityDate,
        amount: d.amount ?? undefined,
        assetId: d.assetId ?? undefined,
        ...selectedExistingAsset(d.assetId, d.existingAssetId, d.symbolInstrumentType),
        quantity: d.quantity ?? undefined,
        unitPrice: d.unitPrice ?? undefined,
        comment: d.comment ?? undefined,
        subtype: d.subtype ?? null,
        currency: d.currency,
        fxRate: d.fxRate,
        quoteMode: d.quoteMode,
        exchangeMic: d.exchangeMic ?? undefined,
        symbolQuoteCcy: d.symbolQuoteCcy ?? undefined,
        symbolInstrumentType: d.symbolInstrumentType ?? undefined,
        assetMetadata: d.assetMetadata
          ? {
              name: d.assetMetadata.name ?? undefined,
              kind: d.assetMetadata.kind ?? undefined,
              exchangeMic: d.assetMetadata.exchangeMic ?? undefined,
              providerId: d.assetMetadata.providerId ?? undefined,
              providerSymbol: d.assetMetadata.providerSymbol ?? undefined,
            }
          : undefined,
        ...(d.isExternal && { metadata: { flow: { is_external: true } } }),
      };
    },
  },

  SPLIT: {
    component: SplitForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.SPLIT,
    getDefaults: (activity, accounts) => ({
      ...getBaseDefaults(activity, accounts),
      symbol: activity?.assetSymbol ?? activity?.assetId ?? "",
      splitRatio: absNum(activity?.amount),
      // Advanced options
      currency: activity?.currency,
      subtype: activity?.subtype ?? null,
      exchangeMic: activity?.exchangeMic,
    }),
    toPayload: (data) => {
      const d = data as SplitFormValues;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        assetId: d.symbol,
        ...selectedExistingAsset(d.symbol, d.existingAssetId, d.symbolInstrumentType),
        amount: d.splitRatio,
        comment: d.comment,
        subtype: d.subtype ?? null,
        currency: d.currency,
        exchangeMic: d.exchangeMic ?? undefined,
        symbolQuoteCcy: d.symbolQuoteCcy ?? undefined,
        symbolInstrumentType: d.symbolInstrumentType ?? undefined,
      };
    },
  },

  FEE: {
    component: FeeForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.FEE,
    getDefaults: (activity, accounts) => ({
      ...getBaseDefaults(activity, accounts),
      amount: absNum(activity?.amount),
      // Advanced options
      currency: activity?.currency,
      subtype: activity?.subtype ?? null,
    }),
    toPayload: (data) => {
      const d = data as FeeFormValues;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        amount: d.amount,
        comment: d.comment,
        subtype: d.subtype,
        currency: d.currency,
      };
    },
  },

  INTEREST: {
    component: InterestForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.INTEREST,
    getDefaults: (activity, accounts) => ({
      ...getBaseDefaults(activity, accounts),
      symbol: activity?.assetSymbol ?? activity?.assetId ?? null,
      amount: absNum(activity?.amount),
      unitPrice: absNum(activity?.unitPrice),
      quantity: absNum(activity?.quantity),
      // Advanced options
      currency: activity?.currency,
      fxRate: (activity?.fxRate ?? undefined) as unknown as number | undefined,
      subtype: activity?.subtype ?? null,
      exchangeMic: activity?.exchangeMic,
    }),
    toPayload: (data) => {
      const d = data as InterestFormValues;
      const isStakingReward = d.subtype === ACTIVITY_SUBTYPES.STAKING_REWARD;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        assetId: d.symbol?.trim() || undefined,
        ...selectedExistingAsset(d.symbol, d.existingAssetId, d.symbolInstrumentType),
        amount: d.amount,
        unitPrice: isStakingReward ? d.unitPrice : null,
        quantity: isStakingReward ? d.quantity : null,
        comment: d.comment,
        subtype: d.subtype,
        currency: d.currency,
        fxRate: d.fxRate,
        exchangeMic: d.exchangeMic ?? undefined,
        symbolQuoteCcy: d.symbolQuoteCcy ?? undefined,
        symbolInstrumentType: d.symbolInstrumentType ?? undefined,
      };
    },
  },

  TAX: {
    component: TaxForm as ComponentType<ActivityFormComponentProps<ActivityFormValues>>,
    activityType: ActivityType.TAX,
    getDefaults: (activity, accounts) => ({
      ...getBaseDefaults(activity, accounts),
      amount: absNum(activity?.amount),
      // Advanced options
      currency: activity?.currency,
      subtype: activity?.subtype ?? null,
    }),
    toPayload: (data) => {
      const d = data as TaxFormValues;
      return {
        accountId: d.accountId,
        activityDate: d.activityDate,
        amount: d.amount,
        comment: d.comment,
        subtype: d.subtype,
        currency: d.currency,
      };
    },
  },
};
