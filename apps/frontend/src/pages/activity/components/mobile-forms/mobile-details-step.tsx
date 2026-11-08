import { restrictionAllowsType } from "@/lib/activity-restrictions";
import { cn } from "@/lib/utils";
import type { ActivityDetails } from "@/lib/types";
import {
  ACTIVITY_SUBTYPES,
  ActivityType,
  isLiabilityAccountType,
  QuoteMode,
} from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  Button,
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  DatePickerInput,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Icons,
  MoneyInput,
  QuantityInput,
  SheetScreen,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { AnimatedToggleGroup } from "@wealthfolio/ui/components/ui/animated-toggle-group";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { useAmountFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { useSellHoldings } from "../../hooks/use-sell-holdings";
import { SellAllButton } from "../forms/fields/sell-all-button";
import {
  getCalculationRate,
  getTransferRate,
  useInternalTransferCurrencies,
} from "../../hooks/use-internal-transfer-currencies";
import { InternalTransferCurrencyFields } from "../forms/fields/internal-transfer-currency-fields";
import { useActivityCurrency } from "../../hooks/use-activity-currency";
import {
  AdvancedOptionsSection,
  AssetTypeSelector,
  FormSection,
  OptionContractFields,
  PositionIntentSelector,
  StockTradeIntentSelector,
  SymbolSearch,
  type AccountSelectOption,
  type AssetType,
} from "../forms/fields";
import type { NewActivityFormValues } from "../forms/schemas";
import { useIncomeAmounts, type IncomeAmountTypedLast } from "../forms/use-income-amounts";
import { calculateIncomeFinalAmount, calculateTradeFinalCash } from "@/lib/activity-final-amount";
import { AccountTypeIconTile } from "@/components/account-type-icon";

interface MobileDetailsStepProps {
  accounts: AccountSelectOption[];
  activityType: string;
  isEditing?: boolean;
  originalActivity?: Partial<ActivityDetails>;
  /** Owned by the form root; true for a stored or session-entered custom amount. */
  amountWasEdited: RefObject<boolean>;
  /** Owned by the form root; which cash income amount the user typed last. */
  incomeAmountTypedLast: RefObject<IncomeAmountTypedLast>;
}

const INCOME_MODE_CASH = "CASH";
const TRADE_ACTIVITY_TYPES: readonly string[] = [ActivityType.BUY, ActivityType.SELL];
const TRANSFER_ACTIVITY_TYPES: readonly string[] = [
  ActivityType.TRANSFER_IN,
  ActivityType.TRANSFER_OUT,
];
const SYMBOL_FIELD_ACTIVITY_TYPES: readonly string[] = [
  ActivityType.BUY,
  ActivityType.SELL,
  ActivityType.DIVIDEND,
  ActivityType.SPLIT,
  ActivityType.ADJUSTMENT,
];
const AMOUNT_FIELD_ACTIVITY_TYPES: readonly string[] = [
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.DIVIDEND,
  ActivityType.INTEREST,
  ActivityType.TAX,
  ActivityType.CREDIT,
];
const FEE_FIELD_ACTIVITY_TYPES: readonly string[] = [
  ActivityType.BUY,
  ActivityType.SELL,
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.TRANSFER_IN,
  ActivityType.TRANSFER_OUT,
  ActivityType.INTEREST,
];

function FmvPerUnitLabel() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <FormLabel className="text-base leading-none font-medium">
        {t("activity:form.label_fmv_per_unit")}
      </FormLabel>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
              aria-label={t("activity:form.more_info_about", {
                label: t("activity:form.label_fmv_per_unit"),
              })}
            />
          }
        >
          <Icons.Info className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {t("activity:form.help_fmv_per_unit")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function MobileDetailsStep({
  accounts,
  activityType,
  isEditing,
  originalActivity,
  amountWasEdited,
  incomeAmountTypedLast,
}: MobileDetailsStepProps) {
  const { t } = useTranslation();
  const form = useFormContext<NewActivityFormValues>();
  const { control, getFieldState, getValues, watch, setValue, register } = form;
  const { settings } = useSettingsContext();
  const isManualAsset = watch("quoteMode") === QuoteMode.MANUAL;
  const accountId = watch("accountId");
  const toAccountId = watch("toAccountId" as any) as string | undefined;
  const currency = watch("currency");
  const quantity = watch("quantity");
  const unitPrice = watch("unitPrice");
  const sourceAmount = watch("sourceAmount" as any) as number | null | undefined;
  const transferRate = watch("transferRate" as any) as number | null | undefined;
  const sourceCurrency = watch("sourceCurrency" as any) as string | undefined;
  const destinationCurrency = watch("destinationCurrency" as any) as string | undefined;

  const isTransfer = TRANSFER_ACTIVITY_TYPES.includes(activityType);
  const transferMode = isTransfer ? ((watch("transferMode" as any) as string) ?? "cash") : null;

  // Cards support cash transfers in either direction, but never securities transfers.
  // Other accounts keep the activity restrictions for their tracking mode.
  const filteredAccounts = useMemo(
    () =>
      accounts.filter((acc) =>
        isTransfer && isLiabilityAccountType(acc.accountType)
          ? transferMode === "cash"
          : restrictionAllowsType(acc.restrictionLevel, activityType),
      ),
    [accounts, activityType, isTransfer, transferMode],
  );
  const assetCurrency = watch("currency");
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);

  // BUY/SELL asset type (stock/option/bond)
  const isBuyOrSell = TRADE_ACTIVITY_TYPES.includes(activityType);
  const assetType = isBuyOrSell ? ((watch("assetType" as any) as string) ?? "stock") : "stock";
  const symbolInstrumentType = watch("symbolInstrumentType" as any) as string | undefined;
  const isOption = assetType === "option";
  const isBond = assetType === "bond";
  const isManualForType = isManualAsset && !isBond;

  // Option fields for total calculation
  const optQuantity = isBuyOrSell ? watch("quantity") : undefined;
  const optUnitPrice = isBuyOrSell ? watch("unitPrice") : undefined;
  const optFee = isBuyOrSell ? watch("fee") : undefined;
  const optTax = isBuyOrSell ? watch("tax") : undefined;
  const optMultiplier = isOption ? ((watch("contractMultiplier" as any) as number) ?? 100) : 1;

  // Transfer state
  const isExternal = isTransfer ? ((watch("isExternal" as any) as boolean) ?? false) : false;
  const direction = isTransfer ? ((watch("direction" as any) as string) ?? "out") : null;
  // The field's label, which its picker screen also takes as its title.
  const accountLabel =
    isTransfer && isExternal
      ? direction === "in"
        ? t("activity:form.label_to_account")
        : t("activity:form.label_from_account")
      : isTransfer && !isExternal
        ? t("activity:form.label_from_account")
        : t("activity:field_account");
  const isSecuritiesTransfer = isTransfer && transferMode === "securities";
  const isCashTransfer = isTransfer && transferMode === "cash";
  const [toAccountSheetOpen, setToAccountSheetOpen] = useState(false);

  const subtype = watch("subtype");
  const sellAssetId = watch("existingAssetId") || watch("assetId") || "";
  const sellExchangeMic = watch("exchangeMic");
  const sellDefaults = form.formState.defaultValues;
  const isLongSell =
    activityType === ActivityType.SELL && !isOption && subtype !== ACTIVITY_SUBTYPES.POSITION_OPEN;
  const sellHoldings = useSellHoldings({
    accountId: accountId ?? "",
    assetId: sellAssetId,
    exchangeMic: sellExchangeMic,
    originalActivity,
    originalAssetId:
      sellDefaults?.existingAssetId ||
      (sellDefaults && "assetId" in sellDefaults ? sellDefaults.assetId : "") ||
      "",
    enabled: isLongSell,
  });
  const numberFormatting = useNumberFormatting();
  const isDividendActivity = activityType === ActivityType.DIVIDEND;
  const isInterestActivity = activityType === ActivityType.INTEREST;
  const isDividendAssetIncome =
    isDividendActivity &&
    (subtype === ACTIVITY_SUBTYPES.DRIP || subtype === ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND);
  const isStakingReward = isInterestActivity && subtype === ACTIVITY_SUBTYPES.STAKING_REWARD;
  const isAssetBackedIncome = isDividendAssetIncome || isStakingReward;
  const incomeMode = subtype ?? INCOME_MODE_CASH;

  const isCreditActivity = activityType === ActivityType.CREDIT;
  const isAdjustmentActivity = activityType === ActivityType.ADJUSTMENT;
  const adjustmentAssetId = isAdjustmentActivity ? watch("assetId") : undefined;
  const adjustmentAmount = isAdjustmentActivity ? watch("amount") : undefined;
  const isCashAdjustment =
    isAdjustmentActivity && !!isEditing && !adjustmentAssetId?.trim() && adjustmentAmount != null;
  const isFeeActivity = activityType === ActivityType.FEE;
  const isTaxActivity = activityType === ActivityType.TAX;
  const isIncomeActivity = isDividendActivity || isInterestActivity;
  const needsTax = isBuyOrSell || isIncomeActivity;
  const needsAssetSymbol =
    (SYMBOL_FIELD_ACTIVITY_TYPES.includes(activityType) && !isCashAdjustment) ||
    isStakingReward ||
    isSecuritiesTransfer;
  const needsQuantity =
    TRADE_ACTIVITY_TYPES.includes(activityType) ||
    isSecuritiesTransfer ||
    (isAdjustmentActivity && !isCashAdjustment) ||
    isAssetBackedIncome;
  const needsUnitPrice =
    TRADE_ACTIVITY_TYPES.includes(activityType) ||
    isAssetBackedIncome ||
    (isSecuritiesTransfer && isExternal && direction === "in");
  const needsInternalCashTransferAmounts = isCashTransfer && !isExternal;
  const needsAmount =
    isBuyOrSell ||
    AMOUNT_FIELD_ACTIVITY_TYPES.includes(activityType) ||
    isCashAdjustment ||
    (isCashTransfer && !needsInternalCashTransferAmounts);
  const { formatAmount } = useAmountFormatting();
  // One calculation feeds both the auto-fill effect below and the "use
  // calculated total" affordance that mirrors the desktop TradeTotalInput.
  const calculatedTradeCash = useMemo(
    () =>
      isBuyOrSell
        ? calculateTradeFinalCash({
            activityType: activityType === ActivityType.BUY ? ActivityType.BUY : ActivityType.SELL,
            instrumentType: symbolInstrumentType ?? assetType,
            quantity,
            unitPrice,
            fee: optFee,
            tax: optTax,
            contractMultiplier: isOption ? optMultiplier : undefined,
            currency,
          })
        : undefined,
    [
      isBuyOrSell,
      activityType,
      symbolInstrumentType,
      assetType,
      quantity,
      unitPrice,
      optFee,
      optTax,
      isOption,
      optMultiplier,
      currency,
    ],
  );
  const calculatedTradeAmount =
    calculatedTradeCash === undefined ? undefined : Math.abs(calculatedTradeCash);
  const isTradeDebit =
    calculatedTradeCash === undefined ? activityType === ActivityType.BUY : calculatedTradeCash < 0;
  const applyCalculatedTradeTotal = () => {
    if (calculatedTradeAmount === undefined) return;
    amountWasEdited.current = false;
    setValue("amount", calculatedTradeAmount, {
      shouldDirty: true,
      shouldValidate: false,
    });
  };
  const needsFee =
    FEE_FIELD_ACTIVITY_TYPES.includes(activityType) && !needsInternalCashTransferAmounts;

  const needsSplitRatio = activityType === ActivityType.SPLIT;

  const transferModeItems = [
    { value: "cash" as const, label: t("activity:form.transfer_mode_cash") },
    { value: "securities" as const, label: t("activity:form.transfer_mode_securities") },
  ];

  const dividendModeItems = [
    { value: INCOME_MODE_CASH, label: t("activity:form.type_cash") },
    { value: ACTIVITY_SUBTYPES.DRIP, label: t("activity:form.type_drip") },
    { value: ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND, label: t("activity:form.type_in_kind") },
  ];

  const interestModeItems = [
    { value: INCOME_MODE_CASH, label: t("activity:form.type_cash") },
    { value: ACTIVITY_SUBTYPES.STAKING_REWARD, label: t("activity:form.type_staking_reward") },
  ];

  const handleIncomeModeChange = (mode: string) => {
    setValue("subtype" as any, mode === INCOME_MODE_CASH ? null : mode, {
      shouldDirty: true,
      shouldValidate: true,
    });
    if (mode === INCOME_MODE_CASH) {
      setValue("quantity" as any, undefined, { shouldDirty: true, shouldValidate: false });
      setValue("unitPrice" as any, undefined, { shouldDirty: true, shouldValidate: false });
    }
  };

  const handleTransferModeChange = (mode: string) => {
    setValue("transferMode" as any, mode, { shouldValidate: false });
    if (mode === "cash") {
      setValue("assetId" as any, null);
      setValue("existingAssetId" as any, undefined);
      setValue("exchangeMic" as any, undefined);
      setValue("symbolQuoteCcy" as any, undefined);
      setValue("symbolInstrumentType" as any, undefined);
      setValue("assetMetadata" as any, undefined);
      setValue("quantity" as any, null);
      setValue("unitPrice" as any, null);
    } else {
      setValue("amount" as any, null);
    }
  };

  const handleExternalChange = (checked: boolean) => {
    setValue("isExternal" as any, checked, { shouldValidate: false });
    if (checked) {
      const externalAccountId =
        direction === "in" ? toAccountId || accountId : accountId || toAccountId;
      if (externalAccountId) {
        setValue("accountId", externalAccountId);
      }
      setValue("toAccountId" as any, "");
    } else {
      if (direction === "in") {
        if (accountId) {
          setValue("toAccountId" as any, accountId);
        }
        setValue("accountId", "");
      } else {
        setValue("toAccountId" as any, "");
      }
    }
  };

  const handleDirectionChange = (value: string) => {
    setValue("direction" as any, value, { shouldValidate: false });
    // Update activityType based on direction
    setValue(
      "activityType",
      value === "in" ? (ActivityType.TRANSFER_IN as any) : (ActivityType.TRANSFER_OUT as any),
      { shouldValidate: false },
    );
  };

  const handleAssetTypeChange = (value: AssetType) => {
    if (value === "option") {
      setValue("quoteMode" as any, QuoteMode.MARKET);
      setValue("assetKind" as any, "OPTION");
    } else if (value === "bond") {
      setValue("quoteMode" as any, QuoteMode.MANUAL);
      setValue("assetKind" as any, "BOND");
    } else {
      setValue("quoteMode" as any, QuoteMode.MARKET);
      setValue("assetKind" as any, undefined);
    }
    // Reset the trade intent (Sell Short / Buy to Cover / option Open-Close) so
    // a stale subtype never carries across asset types.
    setValue("subtype" as any, null);
    setValue("assetId" as any, "");
    setValue("existingAssetId" as any, undefined);
    setValue("exchangeMic" as any, undefined);
    setValue("symbolQuoteCcy" as any, undefined);
    setValue("symbolInstrumentType" as any, undefined);
    setValue("assetMetadata" as any, undefined);
  };

  const toAccountOptions = filteredAccounts.filter(
    (acc) => transferMode === "cash" || acc.value !== accountId,
  );
  const isSameAccountCashTransfer =
    needsInternalCashTransferAmounts && !!accountId && accountId === toAccountId;

  useActivityCurrency(form, filteredAccounts, {
    isEditing,
    trackCurrencyChanges: !isTransfer || isExternal,
  });

  const selectedAccount = filteredAccounts.find((acc) => acc.value === accountId);
  // Cash income asks for the amount received; credit-card interest is a charge.
  // Cards are blocked for new entries, so look the account up unfiltered.
  const isReceivedIncome =
    isIncomeActivity &&
    !isAssetBackedIncome &&
    !(
      isInterestActivity &&
      isLiabilityAccountType(accounts.find((acc) => acc.value === accountId)?.accountType)
    );
  // Cash income is entered before tax; interest also shows a fee, which comes off too.
  const incomeAmounts = useIncomeAmounts(form, {
    enabled: isReceivedIncome,
    includeFee: needsFee,
    typedLast: incomeAmountTypedLast,
  });
  const destinationAccount = filteredAccounts.find((acc) => acc.value === toAccountId);
  const accountCurrency = selectedAccount?.currency;
  const effectiveSourceCurrency = sourceCurrency || accountCurrency || currency;
  const effectiveDestinationCurrency =
    destinationCurrency || destinationAccount?.currency || effectiveSourceCurrency;
  const isCrossCurrencyInternalCash =
    needsInternalCashTransferAmounts &&
    Boolean(effectiveSourceCurrency) &&
    Boolean(effectiveDestinationCurrency) &&
    effectiveSourceCurrency !== effectiveDestinationCurrency;
  const baseCurrency = settings?.baseCurrency;
  const displayAccountText = selectedAccount
    ? `${selectedAccount.label} (${selectedAccount.currency})`
    : t("activity:select_account_placeholder");

  useInternalTransferCurrencies(form, filteredAccounts, {
    enabled: needsInternalCashTransferAmounts,
    isEditing,
    sourceAccountField: "accountId",
  });

  useEffect(() => {
    if (!needsInternalCashTransferAmounts || isCrossCurrencyInternalCash) return;
    if (sourceAmount != null && sourceAmount > 0) {
      setValue("destinationAmount" as any, sourceAmount, {
        shouldDirty: false,
        shouldValidate: false,
      });
      setValue("amount" as any, sourceAmount, {
        shouldDirty: false,
        shouldValidate: false,
      });
    }
  }, [isCrossCurrencyInternalCash, needsInternalCashTransferAmounts, setValue, sourceAmount]);

  const roundTransferValue = (value: number, precision = 6) =>
    Number(Number(value).toFixed(precision));

  const handleSourceAmountChange = (value: number | null | undefined, isUserEdit = true) => {
    if (!isUserEdit) return;
    const rate = getCalculationRate(
      transferRate,
      Number(getValues("sourceAmount" as any)),
      Number(getValues("destinationAmount" as any)),
    );
    setValue("sourceAmount" as any, value, { shouldDirty: true, shouldValidate: false });
    setValue("amount" as any, value, { shouldDirty: true, shouldValidate: false });
    if (!value || value <= 0) return;
    if (isCrossCurrencyInternalCash) {
      if (rate) {
        setValue("destinationAmount" as any, roundTransferValue(value * rate), {
          shouldDirty: true,
          shouldValidate: false,
        });
      }
    } else {
      setValue("destinationAmount" as any, value, {
        shouldDirty: true,
        shouldValidate: false,
      });
    }
  };

  const handleDestinationAmountChange = (value: number | null | undefined, isUserEdit = true) => {
    if (!isUserEdit) return;
    setValue("destinationAmount" as any, value, { shouldDirty: true, shouldValidate: false });
    const sent = Number(sourceAmount);
    const received = Number(value);
    if (sent > 0 && received > 0) {
      setValue("transferRate" as any, getTransferRate(sent, received), {
        shouldDirty: true,
        shouldValidate: false,
      });
    }
  };

  const handleFxRateChange = (value: number | null | undefined, isUserEdit = true) => {
    if (!isUserEdit) return;
    setValue("transferRate" as any, value ?? undefined, {
      shouldDirty: true,
      shouldValidate: false,
    });
    const sent = Number(sourceAmount);
    const rate = Number(value);
    if (sent > 0 && rate > 0) {
      setValue("destinationAmount" as any, roundTransferValue(sent * rate), {
        shouldDirty: true,
        shouldValidate: false,
      });
    }
  };

  useEffect(() => {
    if (amountWasEdited.current || (!isBuyOrSell && !isAssetBackedIncome)) return;
    const shouldDirty = ["quantity", "unitPrice", "fee", "tax", "contractMultiplier"].some(
      (field) => getFieldState(field as any).isDirty,
    );
    // An existing final amount remains authoritative until the user changes an
    // input that participates in the session-local calculation.
    if (isEditing && !shouldDirty) return;
    const computedAmount = isBuyOrSell
      ? calculatedTradeAmount
      : calculateIncomeFinalAmount({
          quantity,
          unitPrice,
          instrumentType: symbolInstrumentType,
          currency,
        });
    if (computedAmount === undefined || Number(getValues("amount")) === computedAmount) return;
    setValue("amount" as any, computedAmount, {
      shouldDirty,
      shouldValidate: false,
    });
  }, [
    calculatedTradeAmount,
    currency,
    symbolInstrumentType,
    getFieldState,
    getValues,
    isAssetBackedIncome,
    isBuyOrSell,
    isEditing,
    quantity,
    setValue,
    unitPrice,
  ]);

  // Quantity label adapts to asset type
  const quantityLabel = isAssetBackedIncome
    ? t("activity:form.label_received_quantity")
    : isOption
      ? t("activity:form.label_contracts")
      : isBond
        ? t("activity:form.label_bonds")
        : t("activity:field_shares");
  const isFmvPriceLabel = isAssetBackedIncome && subtype !== ACTIVITY_SUBTYPES.DRIP;
  const priceLabel = isAssetBackedIncome
    ? subtype === ACTIVITY_SUBTYPES.DRIP
      ? t("activity:form.label_reinvestment_price")
      : t("activity:form.label_fmv_per_unit")
    : isOption
      ? t("activity:form.label_premium_share")
      : isSecuritiesTransfer
        ? t("activity:form.label_cost_basis")
        : t("activity:form.label_price");

  // Toggle shown in the "Asset & Account" card header: transfer mode for
  // transfers. Asset type (Stock/Option/Bond) renders as a full-width row
  // inside the section instead (see below).
  const headerAction = isTransfer ? (
    <AnimatedToggleGroup
      items={transferModeItems}
      value={transferMode ?? "cash"}
      onValueChange={handleTransferModeChange}
      size="sm"
      rounded="lg"
    />
  ) : null;

  // Stock/Option/Bond selector — full-width segmented control on mobile.
  const assetTypeSelector =
    isBuyOrSell && !isEditing ? (
      <AssetTypeSelector
        control={control as any}
        name={"assetType" as any}
        onValueChange={handleAssetTypeChange}
        className="w-full"
      />
    ) : null;

  const detailsTitle = isBuyOrSell
    ? t("activity:form.section_trade")
    : isSecuritiesTransfer
      ? t("activity:form.section_securities")
      : needsSplitRatio
        ? t("activity:form.section_split")
        : isIncomeActivity
          ? t("activity:form.section_income")
          : t("activity:form.section_amount");

  const hasValueFields =
    needsQuantity ||
    needsAmount ||
    needsInternalCashTransferAmounts ||
    needsSplitRatio ||
    needsFee ||
    needsTax ||
    isFeeActivity;

  // Fee + Tax share a row when both are present (e.g. trades, interest).
  const showFeeOptional = !isFeeActivity && needsFee;
  const feeOptionalField = (
    <FormField
      control={control}
      name="fee"
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-base leading-none font-medium">
            {t("activity:mobile_fee_optional")}
          </FormLabel>
          <FormControl>
            <MoneyInput
              {...field}
              onValueChange={(value, isUserEdit) => {
                field.onChange(value);
                if (isUserEdit) incomeAmounts.onChargeChange();
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
  const taxField = (
    <FormField
      control={control}
      name="tax"
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-base leading-none font-medium">
            {isIncomeActivity
              ? t("activity:mobile_form.withholding_tax_optional")
              : t("activity:mobile_form.tax_optional")}
          </FormLabel>
          <FormControl>
            <MoneyInput
              {...field}
              onValueChange={(value, isUserEdit) => {
                field.onChange(value);
                if (isUserEdit) incomeAmounts.onChargeChange();
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const amountField = (
    <FormField
      control={control}
      name="amount"
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-base leading-none font-medium">
            {isReceivedIncome
              ? t("activity:form.received_amount")
              : activityType === ActivityType.DIVIDEND
                ? t("activity:field_dividend_amount")
                : activityType === ActivityType.INTEREST
                  ? t("activity:field_interest_amount")
                  : isTaxActivity
                    ? t("activity:field_tax_amount")
                    : isCreditActivity
                      ? t("activity:mobile_form.credit_amount")
                      : t("activity:form.label_amount")}
          </FormLabel>
          <FormControl>
            <MoneyInput
              {...field}
              onValueChange={(value, isUserEdit) => {
                field.onChange(value);
                if (!isUserEdit) return;
                amountWasEdited.current = true;
                if (isReceivedIncome) incomeAmounts.onReceivedAmountChange(value);
              }}
            />
          </FormControl>
          {isReceivedIncome && (
            <FormDescription className="text-xs">
              {t("activity:form.help_total_credit")}
            </FormDescription>
          )}
          {isBuyOrSell && amountWasEdited.current && calculatedTradeAmount !== undefined && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              onClick={applyCalculatedTradeTotal}
            >
              {t("activity:form.use_calculated_total", {
                amount: formatAmount(calculatedTradeAmount, currency ?? "", Boolean(currency)),
              })}
            </button>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
  const grossAmountField = (
    <FormField
      control={control}
      name={"grossAmount" as any}
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-base leading-none font-medium">
            {t("activity:form.label_amount_before_tax")}
          </FormLabel>
          <FormControl>
            <MoneyInput
              {...field}
              onValueChange={(value, isUserEdit) => {
                field.onChange(value);
                if (isUserEdit) incomeAmounts.onGrossAmountChange(value);
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <ScrollArea>
        <div className="form-mobile-spacing pb-4">
          <FormSection title={t("activity:form.section_asset_account")} action={headerAction}>
            {assetTypeSelector}
            {/* External checkbox + direction (transfers) */}
            {isTransfer && (
              <div className="flex items-center gap-4">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="isExternal"
                    checked={isExternal}
                    onCheckedChange={(checked) => handleExternalChange(!!checked)}
                  />
                  <Label htmlFor="isExternal" className="cursor-pointer text-sm font-normal">
                    {t("activity:form.external_transfer")}
                  </Label>
                </div>
                {isExternal && (
                  <>
                    <span className="text-muted-foreground">|</span>
                    <RadioGroup
                      value={direction ?? "out"}
                      onValueChange={handleDirectionChange}
                      className="flex gap-3"
                    >
                      <div className="flex items-center space-x-1.5">
                        <RadioGroupItem value="in" id="mobile-direction-in" />
                        <Label
                          htmlFor="mobile-direction-in"
                          className="cursor-pointer text-sm font-normal"
                        >
                          {t("activity:form.transfer_direction_in")}
                        </Label>
                      </div>
                      <div className="flex items-center space-x-1.5">
                        <RadioGroupItem value="out" id="mobile-direction-out" />
                        <Label
                          htmlFor="mobile-direction-out"
                          className="cursor-pointer text-sm font-normal"
                        >
                          {t("activity:form.transfer_direction_out")}
                        </Label>
                      </div>
                    </RadioGroup>
                  </>
                )}
              </div>
            )}

            {isDividendActivity && (
              <div className="space-y-2">
                <FormLabel className="text-base font-medium">
                  {t("activity:form.dividend_type")}
                </FormLabel>
                <RadioGroup
                  value={incomeMode}
                  onValueChange={handleIncomeModeChange}
                  className="flex flex-wrap gap-4"
                >
                  {dividendModeItems.map((item) => {
                    const id = `mobile-dividend-type-${item.value.toLowerCase().replaceAll("_", "-")}`;
                    return (
                      <div key={item.value} className="flex items-center space-x-2">
                        <RadioGroupItem value={item.value} id={id} />
                        <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
                          {item.label}
                        </Label>
                      </div>
                    );
                  })}
                </RadioGroup>
              </div>
            )}

            {isInterestActivity && (
              <div className="space-y-2">
                <FormLabel className="text-base font-medium">
                  {t("activity:form.interest_type")}
                </FormLabel>
                <RadioGroup
                  value={incomeMode}
                  onValueChange={handleIncomeModeChange}
                  className="flex flex-wrap gap-4"
                >
                  {interestModeItems.map((item) => {
                    const id = `mobile-interest-type-${item.value.toLowerCase().replaceAll("_", "-")}`;
                    return (
                      <div key={item.value} className="flex items-center space-x-2">
                        <RadioGroupItem value={item.value} id={id} />
                        <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
                          {item.label}
                        </Label>
                      </div>
                    );
                  })}
                </RadioGroup>
              </div>
            )}

            {/* Account — for transfers, label changes based on external/direction */}
            <FormField
              control={control}
              name="accountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-base leading-none font-medium">
                    {accountLabel}
                  </FormLabel>
                  <FormControl>
                    <Button
                      variant="field"
                      role="combobox"
                      size="lg"
                      className="w-full justify-between"
                      onClick={() => setAccountSheetOpen(true)}
                      type="button"
                      aria-haspopup="dialog"
                      aria-expanded={accountSheetOpen}
                    >
                      <span className={!field.value ? "text-muted-foreground" : ""}>
                        {displayAccountText}
                      </span>
                      <Icons.ChevronRight className="ms-2 h-4 w-4 shrink-0 opacity-50 rtl:rotate-180" />
                    </Button>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* To Account — internal transfers only */}
            {isTransfer && !isExternal && (
              <FormField
                control={control}
                name={"toAccountId" as any}
                render={({ field }) => {
                  const toAccount = filteredAccounts.find((acc) => acc.value === field.value);
                  const toDisplayText = toAccount
                    ? `${toAccount.label} (${toAccount.currency})`
                    : t("activity:mobile_form.select_destination_account");
                  return (
                    <FormItem>
                      <FormLabel className="text-base leading-none font-medium">
                        {t("activity:form.label_to_account")}
                      </FormLabel>
                      <FormControl>
                        <Button
                          variant="field"
                          role="combobox"
                          size="lg"
                          className="w-full justify-between"
                          onClick={() => setToAccountSheetOpen(true)}
                          type="button"
                          aria-haspopup="dialog"
                          aria-expanded={toAccountSheetOpen}
                        >
                          <span className={!field.value ? "text-muted-foreground" : ""}>
                            {toDisplayText}
                          </span>
                          <Icons.ChevronRight className="ms-2 h-4 w-4 shrink-0 opacity-50 rtl:rotate-180" />
                        </Button>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            )}

            {isSameAccountCashTransfer && <InternalTransferCurrencyFields />}

            {/* Date */}
            <FormField
              control={control}
              name="activityDate"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel className="text-base leading-none font-medium">
                    {t("activity:mobile_date_time")}
                  </FormLabel>
                  <DatePickerInput
                    onChange={(date: Date | undefined) => field.onChange(date)}
                    value={field.value}
                    disabled={field.disabled}
                    enableTime={true}
                    timeGranularity="minute"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Asset Symbol / Option Contract Fields */}
            {needsAssetSymbol &&
              (isOption ? (
                <OptionContractFields
                  underlyingName={"underlyingSymbol" as any}
                  strikePriceName={"strikePrice" as any}
                  expirationDateName={"expirationDate" as any}
                  optionTypeName={"optionType" as any}
                  currencyName="currency"
                  exchangeMicName={"exchangeMic" as any}
                  quoteCcyName={"symbolQuoteCcy" as any}
                  unitPriceName={"unitPrice" as any}
                />
              ) : (
                <SymbolSearch
                  name="assetId"
                  label={
                    isStakingReward
                      ? t("activity:form.label_reward_asset")
                      : t("activity:form.label_symbol")
                  }
                  isManualAsset={isManualForType}
                  exchangeMicName="exchangeMic"
                  quoteModeName="quoteMode"
                  currencyName="currency"
                  quoteCcyName="symbolQuoteCcy"
                  instrumentTypeName="symbolInstrumentType"
                  existingAssetIdName="existingAssetId"
                  assetMetadataName="assetMetadata"
                  defaultCurrency={accountCurrency}
                  labelClassName="text-base leading-none font-medium"
                />
              ))}
          </FormSection>

          {hasValueFields && (
            <FormSection title={detailsTitle}>
              {/* Trade intent — Sell/Sell Short (stock), Open/Close (option). Bonds have none. */}
              {isBuyOrSell && !isBond && (
                <div className="-mt-1">
                  {isOption ? (
                    <PositionIntentSelector control={control as any} name={"subtype" as any} />
                  ) : (
                    <StockTradeIntentSelector
                      control={control as any}
                      name={"subtype" as any}
                      side={activityType === ActivityType.SELL ? "sell" : "buy"}
                      labelClassName="text-base leading-none font-medium"
                    />
                  )}
                </div>
              )}
              {/* Quantity and Unit Price */}
              {needsQuantity && (
                <>
                  <div className={needsUnitPrice ? "grid grid-cols-2 gap-3" : ""}>
                    <FormField
                      control={control}
                      name="quantity"
                      render={({ field }) => (
                        <FormItem>
                          <div
                            className={cn(
                              "flex flex-wrap items-center justify-between gap-2",
                              isLongSell ? "min-h-11" : "min-h-7",
                            )}
                          >
                            <FormLabel className="text-base leading-none font-medium">
                              {quantityLabel}
                            </FormLabel>
                            <SellAllButton
                              availableQuantity={sellHoldings.availableQuantity}
                              holdingKey={JSON.stringify([
                                accountId,
                                sellAssetId,
                                sellExchangeMic,
                                subtype,
                                activityType,
                              ])}
                              hidden={!isLongSell}
                              disabled={
                                !accountId ||
                                !sellAssetId ||
                                sellHoldings.isLoading ||
                                sellHoldings.isFetching ||
                                sellHoldings.isError
                              }
                            />
                          </div>
                          <FormControl>
                            <QuantityInput {...field} />
                          </FormControl>
                          {isLongSell &&
                            accountId &&
                            sellAssetId &&
                            !sellHoldings.isLoading &&
                            !sellHoldings.isError && (
                              <FormDescription>
                                {t("activity:form.available_amount", {
                                  amount: numberFormatting.formatQuantity(
                                    sellHoldings.availableQuantity,
                                  ),
                                })}
                              </FormDescription>
                            )}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {needsUnitPrice && (
                      <FormField
                        control={control}
                        name="unitPrice"
                        render={({ field }) => (
                          <FormItem>
                            <div
                              className={cn(
                                "flex items-center",
                                isLongSell ? "min-h-11" : "min-h-7",
                              )}
                            >
                              {isFmvPriceLabel ? (
                                <FmvPerUnitLabel />
                              ) : (
                                <FormLabel className="text-base leading-none font-medium">
                                  {priceLabel}
                                </FormLabel>
                              )}
                            </div>
                            <FormControl>
                              <MoneyInput {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </div>

                  {/* Shares breakdown for options */}
                  {isOption && optQuantity && (
                    <div className="text-muted-foreground -mt-2 flex items-center gap-1.5 px-1 text-xs">
                      <span>
                        {t("activity:form.shares_count", {
                          count: Number(optQuantity) * (Number(optMultiplier) || 100),
                        })}
                      </span>
                      <span>·</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        {...register("contractMultiplier" as any, { valueAsNumber: true })}
                        readOnly={isEditing}
                        className="hover:border-input focus:border-input focus:bg-background focus:ring-ring h-5 w-14 rounded border border-transparent bg-transparent px-1 text-center text-xs tabular-nums focus:ring-1 focus:outline-none"
                        aria-label={t("activity:form.contract_multiplier")}
                      />
                      <span>x</span>
                    </div>
                  )}
                </>
              )}

              {/* Option Total Premium/Credit */}
              {isOption && optQuantity && optUnitPrice && (
                <div className="bg-muted/50 border-border rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        {isTradeDebit
                          ? t("activity:form.total_debit")
                          : t("activity:form.total_credit")}
                      </span>
                      <p className="text-muted-foreground mt-0.5 truncate text-xs tabular-nums">
                        {Number(optQuantity)} × {Number(optUnitPrice)} ×{" "}
                        {Number(optMultiplier) || 100}
                        {Number(optFee) > 0 && (
                          <>
                            {" "}
                            {activityType === ActivityType.BUY ? "+" : "−"} {Number(optFee)}
                          </>
                        )}
                        {Number(optTax) > 0 && (
                          <>
                            {" "}
                            {activityType === ActivityType.BUY ? "+" : "−"} {Number(optTax)}
                          </>
                        )}
                      </p>
                    </div>
                    <span className="text-lg font-semibold tabular-nums">
                      {formatAmount(calculatedTradeAmount ?? 0, currency ?? "", Boolean(currency))}
                    </span>
                  </div>
                </div>
              )}

              {/* Amount; cash income asks for it before tax here and shows the
                  received amount after the tax */}
              {needsAmount && (isReceivedIncome ? grossAmountField : amountField)}

              {needsInternalCashTransferAmounts && (
                <div className="space-y-3">
                  {isCrossCurrencyInternalCash ? (
                    <>
                      <FormField
                        control={control}
                        name={"sourceAmount" as any}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-base leading-none font-medium">
                              {t("activity:form.label_sent", {
                                currency: effectiveSourceCurrency,
                              })}
                            </FormLabel>
                            <FormControl>
                              <MoneyInput
                                {...field}
                                onValueChange={handleSourceAmountChange}
                                aria-label={t("activity:form.sent_amount")}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={control}
                        name={"destinationAmount" as any}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-base leading-none font-medium">
                              {t("activity:form.label_received", {
                                currency: effectiveDestinationCurrency,
                              })}
                            </FormLabel>
                            <FormControl>
                              <MoneyInput
                                {...field}
                                onValueChange={handleDestinationAmountChange}
                                aria-label={t("activity:form.received_amount")}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  ) : (
                    <FormField
                      control={control}
                      name={"sourceAmount" as any}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-base leading-none font-medium">
                            {t("activity:form.label_amount")} ({effectiveSourceCurrency})
                          </FormLabel>
                          <FormControl>
                            <MoneyInput
                              {...field}
                              onValueChange={handleSourceAmountChange}
                              aria-label={t("activity:form.label_amount")}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {isCrossCurrencyInternalCash && (
                    <FormField
                      control={control}
                      name={"transferRate" as any}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-base leading-none font-medium">
                            {t("activity:form.label_transfer_rate")}
                            <span className="text-muted-foreground ms-2 text-xs font-normal">
                              1 {effectiveSourceCurrency} ={" "}
                              {Number(field.value) > 0 ? field.value : "?"}{" "}
                              {effectiveDestinationCurrency}
                            </span>
                          </FormLabel>
                          <FormControl>
                            <MoneyInput
                              {...field}
                              onValueChange={handleFxRateChange}
                              maxDecimalPlaces={8}
                              aria-label={t("activity:form.label_transfer_rate")}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              )}

              {/* Split Ratio */}
              {needsSplitRatio && (
                <FormField
                  control={control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base leading-none font-medium">
                        {t("activity:form.label_split_ratio")}
                      </FormLabel>
                      <FormControl>
                        <QuantityInput
                          placeholder={t("activity:split_ratio_placeholder")}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {/* Fee + Tax — paired in a row when both are shown */}
              {showFeeOptional && needsTax ? (
                <div className="grid grid-cols-2 gap-3">
                  {feeOptionalField}
                  {taxField}
                </div>
              ) : (
                <>
                  {showFeeOptional && feeOptionalField}
                  {needsTax && taxField}
                </>
              )}
              {needsAmount && isReceivedIncome && amountField}
              {isFeeActivity && (
                <FormField
                  control={control}
                  name="fee"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base leading-none font-medium">
                        {t("activity:field_fee_amount")}
                      </FormLabel>
                      <FormControl>
                        <MoneyInput {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </FormSection>
          )}

          {/* Advanced options (currency, FX rate, subtype) and notes, collapsed by default */}
          <AdvancedOptionsSection
            variant="mobile"
            dashed
            title={t("activity:form.section_advanced_notes")}
            currencyName="currency"
            fxRateName="fxRate"
            subtypeName="subtype"
            activityType={activityType as ActivityType}
            assetCurrency={assetCurrency}
            accountCurrency={accountCurrency}
            baseCurrency={baseCurrency}
            showSubtype={!isDividendActivity && !isInterestActivity}
            showCurrency={!isTransfer || isExternal}
            showFxRate={!isTransfer || isExternal}
          >
            {needsInternalCashTransferAmounts && !isSameAccountCashTransfer && (
              <InternalTransferCurrencyFields />
            )}
            {/* Comment */}
            <FormField
              control={control}
              name="comment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-base leading-none font-medium">
                    {t("activity:mobile_description_optional")}
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("activity:mobile_description_placeholder")}
                      className="min-h-25 resize-none text-base sm:text-sm"
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </AdvancedOptionsSection>
        </div>
      </ScrollArea>

      {/* Account pickers open as screens of the form's sheet; they render there,
          not in this hidden box. */}
      <div className="hidden">
        <MobileAccountSheet
          accounts={filteredAccounts}
          value={accountId}
          title={accountLabel}
          open={accountSheetOpen}
          onOpenChange={setAccountSheetOpen}
          onSelect={(accountValue) => {
            setValue("accountId", accountValue);
            setAccountSheetOpen(false);
          }}
        />
        {isTransfer && !isExternal && (
          <MobileAccountSheet
            accounts={toAccountOptions}
            value={toAccountId}
            title={t("activity:form.label_to_account")}
            open={toAccountSheetOpen}
            onOpenChange={setToAccountSheetOpen}
            onSelect={(accountValue) => {
              setValue("toAccountId" as any, accountValue);
              setToAccountSheetOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

interface MobileAccountSheetProps {
  accounts: AccountSelectOption[];
  title: string;
  value?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (accountValue: string) => void;
}

function MobileAccountSheet({
  accounts,
  title,
  value,
  open,
  onOpenChange,
  onSelect,
}: MobileAccountSheetProps) {
  const { t } = useTranslation();
  // Sorted under their groups when they span more than one, as the expense form's are.
  const groups = useMemo(() => {
    const byGroup = new Map<string, AccountSelectOption[]>();
    for (const account of accounts) {
      const key = account.group?.trim() ?? "";
      byGroup.set(key, [...(byGroup.get(key) ?? []), account]);
    }
    return byGroup.size < 2
      ? [{ heading: undefined, items: accounts }]
      : [...byGroup].map(([group, items]) => ({
          heading: group || t("dashboard:uncategorized"),
          items,
        }));
  }, [accounts, t]);
  // A long list gets a search, as the category and symbol pickers have.
  const showSearch = accounts.length > 8;

  return (
    <SheetScreen open={open} onOpenChange={onOpenChange} title={title}>
      <Command className="h-auto min-h-0 flex-1 rounded-none bg-transparent [&_[data-slot=command-input-wrapper]]:shrink-0">
        {showSearch && <CommandInput placeholder={t("common:search_accounts")} />}
        <CommandList className="max-h-none min-h-0 flex-1">
          {groups.map((group, index) => (
            <CommandGroup key={group.heading ?? index} heading={group.heading}>
              {group.items.map((account) => (
                <CommandItem
                  key={account.value}
                  value={account.value}
                  keywords={[account.label]}
                  onSelect={() => onSelect(account.value)}
                  className="flex items-center gap-2"
                >
                  <AccountTypeIconTile accountType={account.accountType} />
                  <span className="min-w-0 flex-1 truncate">{account.label}</span>
                  <span className="text-muted-foreground shrink-0 text-sm">{account.currency}</span>
                  {account.value === value ? (
                    <Icons.Check
                      data-slot="command-item-check"
                      className="text-muted-foreground h-4 w-4 shrink-0"
                    />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </SheetScreen>
  );
}
