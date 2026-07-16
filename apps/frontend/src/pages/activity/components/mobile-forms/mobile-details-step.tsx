import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { AnimatedToggleGroup } from "@wealthfolio/ui/components/ui/animated-toggle-group";
import { ACTIVITY_SUBTYPES, ActivityType, QuoteMode } from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  AdvancedOptionsSection,
  FormSection,
  SymbolSearch,
  AssetTypeSelector,
  OptionContractFields,
  PositionIntentSelector,
  StockTradeIntentSelector,
  type AssetType,
  type AccountSelectOption,
} from "../forms/fields";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import {
  Button,
  DatePickerInput,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Icons,
  MoneyInput,
  QuantityInput,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { useEffect, useMemo, useState } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { restrictionAllowsType } from "@/lib/activity-restrictions";
import { roundDecimal } from "@/lib/utils";
import type { NewActivityFormValues } from "../forms/schemas";

interface MobileDetailsStepProps {
  accounts: AccountSelectOption[];
  activityType: string;
  isEditing?: boolean;
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
      <FormLabel className="text-base font-medium">
        {t("activity:form.label_fmv_per_unit")}
      </FormLabel>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
            aria-label={t("activity:form.more_info_about", {
              label: t("activity:form.label_fmv_per_unit"),
            })}
          >
            <Icons.Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {t("activity:form.help_fmv_per_unit")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function MobileDetailsStep({ accounts, activityType, isEditing }: MobileDetailsStepProps) {
  const { t } = useTranslation();
  const { control, getFieldState, getValues, watch, setValue, register } =
    useFormContext<NewActivityFormValues>();
  const { settings } = useSettingsContext();
  const isManualAsset = watch("quoteMode") === QuoteMode.MANUAL;
  const accountId = watch("accountId");
  const toAccountId = watch("toAccountId" as any) as string | undefined;
  const currency = watch("currency");
  const quantity = watch("quantity");
  const unitPrice = watch("unitPrice");
  const sourceAmount = watch("sourceAmount" as any) as number | null | undefined;
  const fxRate = watch("fxRate" as any) as number | null | undefined;
  const sourceCurrency = watch("sourceCurrency" as any) as string | undefined;
  const destinationCurrency = watch("destinationCurrency" as any) as string | undefined;

  // Filter accounts by activity type (exclude HOLDINGS accounts for unsupported types)
  const filteredAccounts = useMemo(
    () => accounts.filter((acc) => restrictionAllowsType(acc.restrictionLevel, activityType)),
    [accounts, activityType],
  );
  const assetCurrency = watch("currency");
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);

  // BUY/SELL asset type (stock/option/bond)
  const isBuyOrSell = TRADE_ACTIVITY_TYPES.includes(activityType);
  const assetType = isBuyOrSell ? ((watch("assetType" as any) as string) ?? "stock") : "stock";
  const isOption = assetType === "option";
  const isBond = assetType === "bond";
  const isManualForType = isManualAsset && !isBond;

  // Option fields for total calculation
  const optQuantity = isBuyOrSell ? watch("quantity") : undefined;
  const optUnitPrice = isBuyOrSell ? watch("unitPrice") : undefined;
  const optFee = isBuyOrSell ? watch("fee") : undefined;
  const optTax = isBuyOrSell ? watch("tax") : undefined;
  const optMultiplier = isOption ? ((watch("contractMultiplier" as any) as number) ?? 100) : 1;

  const optionTotal = useMemo(() => {
    if (!isOption || !optQuantity || !optUnitPrice) return 0;
    const q = Number(optQuantity) || 0;
    const p = Number(optUnitPrice) || 0;
    const f = Number(optFee) || 0;
    const t = Number(optTax) || 0;
    const m = Number(optMultiplier) || 100;
    return activityType === ActivityType.BUY ? q * p * m + f + t : q * p * m - f - t;
  }, [isOption, optQuantity, optUnitPrice, optFee, optTax, optMultiplier, activityType]);

  // Transfer state
  const isTransfer = TRANSFER_ACTIVITY_TYPES.includes(activityType);
  const transferMode = isTransfer ? ((watch("transferMode" as any) as string) ?? "cash") : null;
  const isExternal = isTransfer ? ((watch("isExternal" as any) as boolean) ?? false) : false;
  const direction = isTransfer ? ((watch("direction" as any) as string) ?? "out") : null;
  const isSecuritiesTransfer = isTransfer && transferMode === "securities";
  const isCashTransfer = isTransfer && transferMode === "cash";
  const [toAccountSheetOpen, setToAccountSheetOpen] = useState(false);

  const subtype = watch("subtype");
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
  const isFeeActivity = activityType === ActivityType.FEE;
  const isTaxActivity = activityType === ActivityType.TAX;
  const isIncomeActivity = isDividendActivity || isInterestActivity;
  const needsTax = isBuyOrSell || isIncomeActivity;
  const needsAssetSymbol =
    SYMBOL_FIELD_ACTIVITY_TYPES.includes(activityType) || isStakingReward || isSecuritiesTransfer;
  const needsQuantity =
    TRADE_ACTIVITY_TYPES.includes(activityType) ||
    isSecuritiesTransfer ||
    isAdjustmentActivity ||
    isAssetBackedIncome;
  const needsUnitPrice =
    TRADE_ACTIVITY_TYPES.includes(activityType) ||
    isAssetBackedIncome ||
    (isSecuritiesTransfer && isExternal && direction === "in");
  const needsInternalCashTransferAmounts = isCashTransfer && !isExternal;
  const needsAmount =
    AMOUNT_FIELD_ACTIVITY_TYPES.includes(activityType) ||
    (isCashTransfer && !needsInternalCashTransferAmounts);
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

  // Filter destination accounts to exclude source account (for internal transfers)
  const toAccountOptions = filteredAccounts.filter((acc) => acc.value !== accountId);

  const selectedAccount = filteredAccounts.find((acc) => acc.value === accountId);
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

  // Backfill currency for preselected accounts when options arrive asynchronously.
  useEffect(() => {
    if (!accountId) return;
    const selected = filteredAccounts.find((account) => account.value === accountId);
    if (!selected) return;

    const currentCurrency = currency?.trim();
    if (currentCurrency === selected.currency) return;

    const shouldAutoSetCurrency = !getFieldState("currency").isDirty || !currentCurrency;
    if (!shouldAutoSetCurrency) return;

    setValue("currency", selected.currency, {
      shouldDirty: false,
      shouldValidate: true,
    });
    if (!isExternal) {
      setValue("sourceCurrency" as any, selected.currency, {
        shouldDirty: false,
        shouldValidate: false,
      });
    }
  }, [accountId, currency, filteredAccounts, getFieldState, isExternal, setValue]);

  useEffect(() => {
    if (!destinationAccount?.currency) return;
    setValue("destinationCurrency" as any, destinationAccount.currency, {
      shouldDirty: false,
      shouldValidate: false,
    });
  }, [destinationAccount?.currency, setValue]);

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

  const handleSourceAmountChange = (value: number | null | undefined) => {
    setValue("sourceAmount" as any, value, { shouldDirty: true, shouldValidate: false });
    setValue("amount" as any, value, { shouldDirty: true, shouldValidate: false });
    if (!value || value <= 0) return;
    if (isCrossCurrencyInternalCash) {
      const rate = Number(fxRate);
      if (rate > 0) {
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

  const handleDestinationAmountChange = (value: number | null | undefined) => {
    setValue("destinationAmount" as any, value, { shouldDirty: true, shouldValidate: false });
    const sent = Number(sourceAmount);
    const received = Number(value);
    if (sent > 0 && received > 0) {
      setValue("fxRate" as any, roundTransferValue(received / sent, 8), {
        shouldDirty: true,
        shouldValidate: false,
      });
    }
  };

  const handleFxRateChange = (value: number | null | undefined) => {
    setValue("fxRate" as any, value ?? undefined, { shouldDirty: true, shouldValidate: false });
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
    if (!isAssetBackedIncome) return;
    const q = Number(quantity);
    const p = Number(unitPrice);
    const currentAmount = Number(getValues("amount"));
    const quantityIsDirty = getFieldState("quantity").isDirty;
    const unitPriceIsDirty = getFieldState("unitPrice").isDirty;
    const shouldAutoSetAmount =
      quantityIsDirty || unitPriceIsDirty || !(Number.isFinite(currentAmount) && currentAmount > 0);
    if (q > 0 && p > 0 && shouldAutoSetAmount) {
      const computedAmount = roundDecimal(q * p);
      if (currentAmount !== computedAmount) {
        setValue("amount" as any, computedAmount, {
          shouldDirty: quantityIsDirty || unitPriceIsDirty,
          shouldValidate: false,
        });
      }
    }
  }, [getFieldState, getValues, isAssetBackedIncome, quantity, setValue, unitPrice]);

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
          <FormLabel className="text-base font-medium">
            {t("activity:mobile_fee_optional")}
          </FormLabel>
          <FormControl>
            <MoneyInput {...field} />
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
          <FormLabel className="text-base font-medium">
            {isIncomeActivity
              ? t("activity:mobile_form.withholding_tax_optional")
              : t("activity:mobile_form.tax_optional")}
          </FormLabel>
          <FormControl>
            <MoneyInput {...field} />
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
                  <FormLabel className="text-base font-medium">
                    {isTransfer && isExternal
                      ? direction === "in"
                        ? t("activity:form.label_to_account")
                        : t("activity:form.label_from_account")
                      : isTransfer && !isExternal
                        ? t("activity:form.label_from_account")
                        : t("activity:field_account")}
                  </FormLabel>
                  <FormControl>
                    <Button
                      variant="outline"
                      role="combobox"
                      size="lg"
                      className="w-full justify-between rounded-md font-normal"
                      onClick={() => setAccountSheetOpen(true)}
                      type="button"
                    >
                      <span className={!field.value ? "text-muted-foreground" : ""}>
                        {displayAccountText}
                      </span>
                      <Icons.ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
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
                      <FormLabel className="text-base font-medium">
                        {t("activity:form.label_to_account")}
                      </FormLabel>
                      <FormControl>
                        <Button
                          variant="outline"
                          role="combobox"
                          size="lg"
                          className="w-full justify-between rounded-md font-normal"
                          onClick={() => setToAccountSheetOpen(true)}
                          type="button"
                        >
                          <span className={!field.value ? "text-muted-foreground" : ""}>
                            {toDisplayText}
                          </span>
                          <Icons.ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            )}

            {/* Date */}
            <FormField
              control={control}
              name="activityDate"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel className="text-base font-medium">
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
                          <FormLabel className="text-base font-medium">{quantityLabel}</FormLabel>
                          <FormControl>
                            <QuantityInput {...field} />
                          </FormControl>
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
                            {isFmvPriceLabel ? (
                              <FmvPerUnitLabel />
                            ) : (
                              <FormLabel className="text-base font-medium">{priceLabel}</FormLabel>
                            )}
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
                        type="number"
                        {...register("contractMultiplier" as any, { valueAsNumber: true })}
                        className="hover:border-input focus:border-input focus:bg-background focus:ring-ring h-5 w-14 rounded border border-transparent bg-transparent px-1 text-center text-xs tabular-nums focus:outline-none focus:ring-1"
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
                      <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                        {activityType === ActivityType.BUY
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
                      {new Intl.NumberFormat("en-US", {
                        style: currency ? "currency" : "decimal",
                        currency: currency || undefined,
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(optionTotal)}
                    </span>
                  </div>
                </div>
              )}

              {/* Amount */}
              {needsAmount && (
                <FormField
                  control={control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">
                        {activityType === ActivityType.DIVIDEND
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
                        <MoneyInput {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {needsInternalCashTransferAmounts && (
                <div className="space-y-3">
                  {isCrossCurrencyInternalCash ? (
                    <>
                      <FormField
                        control={control}
                        name={"sourceAmount" as any}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-base font-medium">
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
                            <FormLabel className="text-base font-medium">
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
                          <FormLabel className="text-base font-medium">
                            {t("activity:form.label_amount")}
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
                      name={"fxRate" as any}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-base font-medium">
                            {t("activity:form.label_fx_rate")}
                            <span className="text-muted-foreground ml-2 text-xs font-normal">
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
                              aria-label={t("activity:form.label_fx_rate")}
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
                      <FormLabel className="text-base font-medium">
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
              {isFeeActivity && (
                <FormField
                  control={control}
                  name="fee"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">
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
            {/* Comment */}
            <FormField
              control={control}
              name="comment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-base font-medium">
                    {t("activity:mobile_description_optional")}
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("activity:mobile_description_placeholder")}
                      className="min-h-[100px] resize-none text-base sm:text-sm"
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

      {/* Hidden Account Sheets - Rendered outside scrollable area */}
      <div className="hidden">
        <MobileAccountSheet
          accounts={filteredAccounts}
          open={accountSheetOpen}
          onOpenChange={setAccountSheetOpen}
          onSelect={(accountValue) => {
            setValue("accountId", accountValue);
            const selected = filteredAccounts.find((account) => account.value === accountValue);
            const currentCurrency = getValues("currency")?.trim();
            const shouldAutoSetCurrency = !getFieldState("currency").isDirty || !currentCurrency;
            if (selected && shouldAutoSetCurrency) {
              setValue("currency", selected.currency, {
                shouldDirty: false,
                shouldValidate: true,
              });
            }
            setAccountSheetOpen(false);
          }}
        />
        {isTransfer && !isExternal && (
          <MobileAccountSheet
            accounts={toAccountOptions}
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (accountValue: string) => void;
}

function MobileAccountSheet({ accounts, open, onOpenChange, onSelect }: MobileAccountSheetProps) {
  const { t } = useTranslation();
  const handleAccountSelect = (account: AccountSelectOption) => {
    onSelect(account.value);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[70vh] p-0">
        <SheetHeader className="border-border border-b px-6 py-4">
          <SheetTitle>{t("activity:select_account")}</SheetTitle>
          <SheetDescription>{t("activity:mobile_choose_account")}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="h-[calc(70vh-5rem)] px-6 py-4">
          <div className="space-y-2">
            {accounts.map((account) => (
              <button
                key={account.value}
                onClick={() => handleAccountSelect(account)}
                className="card-mobile hover:bg-accent active:bg-accent/80 focus:border-primary flex w-full items-center gap-3 border border-transparent text-left transition-colors focus:outline-none"
              >
                <div className="bg-primary/10 flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full">
                  <Icons.Briefcase className="text-primary h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate font-medium">{account.label}</div>
                  <div className="text-muted-foreground mt-0.5 text-sm">{account.currency}</div>
                </div>
                <Icons.ChevronRight className="text-muted-foreground h-5 w-5 flex-shrink-0" />
              </button>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
