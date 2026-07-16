import { useSettings } from "@/hooks/use-settings";
import { isSecuritiesTransfer } from "@/lib/activity-utils";
import { ActivityType, isLiabilityAccountType, QuoteMode } from "@/lib/constants";
import { formatAmount } from "@/lib/utils";
import { zodResolver } from "@hookform/resolvers/zod";
import { AnimatedToggleGroup } from "@wealthfolio/ui/components/ui/animated-toggle-group";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  MoneyInput,
} from "@wealthfolio/ui";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FormProvider, useForm, type Resolver } from "react-hook-form";
import { z } from "zod";
import type { TFunction } from "i18next";
import {
  AccountSelect,
  AdvancedOptionsSection,
  AmountInput,
  createValidatedSubmit,
  DatePicker,
  FormSection,
  NotesInput,
  QuantityInput,
  SymbolSearch,
  type AccountSelectOption,
} from "./fields";

export type TransferMode = "cash" | "securities";
export type TransferDirection = "in" | "out";

// Translated message helper (see buy-form for rationale).
type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

// Asset metadata schema for custom assets
const assetMetadataSchema = z
  .object({
    name: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    exchangeMic: z.string().nullable().optional(),
    providerId: z.string().nullable().optional(),
    providerSymbol: z.string().nullable().optional(),
  })
  .optional();

// Zod schema factory for TransferForm validation. `t` optional so the exported
// static schema keeps English messages (used by tests and type inference).
export const createTransferFormSchema = (t?: TFunction) =>
  z
    .object({
      isExternal: z.boolean().default(false),
      direction: z.enum(["in", "out"]).default("in"),
      accountId: z.string().optional(), // For external transfers (single account)
      fromAccountId: z.string().optional(), // For internal transfers
      toAccountId: z.string().optional(), // For internal transfers
      activityDate: z.date({
        required_error: msg(t, "activity:form.err_select_date", "Please select a date."),
      }),
      transferMode: z.enum(["cash", "securities"]).default("cash"),
      amount: z.coerce
        .number({
          invalid_type_error: msg(t, "activity:form.err_amount_number", "Amount must be a number."),
        })
        .positive({
          message: msg(t, "activity:form.err_amount_gt_zero", "Amount must be greater than 0."),
        })
        .optional()
        .nullable(),
      sourceAmount: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_sent_amount_number",
            "Sent amount must be a number.",
          ),
        })
        .positive({
          message: msg(
            t,
            "activity:form.err_sent_amount_gt_zero",
            "Sent amount must be greater than 0.",
          ),
        })
        .optional()
        .nullable(),
      destinationAmount: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_received_amount_number",
            "Received amount must be a number.",
          ),
        })
        .positive({
          message: msg(
            t,
            "activity:form.err_received_amount_gt_zero",
            "Received amount must be greater than 0.",
          ),
        })
        .optional()
        .nullable(),
      sourceCurrency: z.string().optional(),
      destinationCurrency: z.string().optional(),
      // Fields for security transfers
      assetId: z.string().optional().nullable(),
      existingAssetId: z.string().nullable().optional(),
      quantity: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_quantity_number",
            "Quantity must be a number.",
          ),
        })
        .positive({
          message: msg(t, "activity:form.err_quantity_gt_zero", "Quantity must be greater than 0."),
        })
        .optional()
        .nullable(),
      unitPrice: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_cost_basis_number",
            "Cost basis must be a number.",
          ),
        })
        .positive({
          message: msg(
            t,
            "activity:form.err_cost_basis_gt_zero",
            "Cost basis must be greater than 0.",
          ),
        })
        .optional()
        .nullable(),
      comment: z.string().optional().nullable(),
      // Advanced options
      currency: z.string().min(1, {
        message: msg(t, "activity:form.err_currency_required", "Currency is required."),
      }),
      fxRate: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_fxrate_number",
            "FX Rate must be a number.",
          ),
        })
        .positive({
          message: msg(t, "activity:form.err_fxrate_positive", "FX Rate must be positive."),
        })
        .optional(),
      subtype: z.string().optional().nullable(),
      // Internal field for manual quote mode
      quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
      exchangeMic: z.string().nullable().optional(),
      symbolQuoteCcy: z.string().nullable().optional(),
      symbolInstrumentType: z.string().nullable().optional(),
      // Asset metadata for custom assets (name, etc.)
      assetMetadata: assetMetadataSchema,
    })
    // External transfer requires accountId
    .refine(
      (data) => {
        if (data.isExternal) {
          return data.accountId != null && data.accountId.length > 0;
        }
        return true;
      },
      {
        message: msg(t, "activity:form.err_select_account", "Please select an account."),
        path: ["accountId"],
      },
    )
    // Internal transfer requires fromAccountId
    .refine(
      (data) => {
        if (!data.isExternal) {
          return data.fromAccountId != null && data.fromAccountId.length > 0;
        }
        return true;
      },
      {
        message: msg(
          t,
          "activity:form.err_select_source_account",
          "Please select a source account.",
        ),
        path: ["fromAccountId"],
      },
    )
    // Internal transfer requires toAccountId
    .refine(
      (data) => {
        if (!data.isExternal) {
          return data.toAccountId != null && data.toAccountId.length > 0;
        }
        return true;
      },
      {
        message: msg(
          t,
          "activity:form.err_select_destination_account",
          "Please select a destination account.",
        ),
        path: ["toAccountId"],
      },
    )
    // Internal transfer: accounts must be different
    .refine(
      (data) => {
        if (!data.isExternal) {
          return data.fromAccountId !== data.toAccountId;
        }
        return true;
      },
      {
        message: msg(
          t,
          "activity:form.err_accounts_different",
          "Source and destination accounts must be different.",
        ),
        path: ["toAccountId"],
      },
    )
    .refine(
      (data) => {
        // Cash mode requires amount
        if (data.transferMode === "cash" && data.isExternal) {
          return data.amount != null && data.amount > 0;
        }
        return true;
      },
      {
        message: msg(t, "activity:form.err_enter_amount", "Please enter an amount."),
        path: ["amount"],
      },
    )
    .refine(
      (data) => {
        if (data.transferMode === "cash" && !data.isExternal) {
          const sourceAmount = data.sourceAmount ?? data.amount;
          return sourceAmount != null && sourceAmount > 0;
        }
        return true;
      },
      {
        message: msg(t, "activity:form.err_enter_amount", "Please enter an amount."),
        path: ["sourceAmount"],
      },
    )
    .refine(
      (data) => {
        if (
          data.transferMode === "cash" &&
          !data.isExternal &&
          data.sourceCurrency &&
          data.destinationCurrency &&
          data.sourceCurrency !== data.destinationCurrency
        ) {
          return data.destinationAmount != null && data.destinationAmount > 0;
        }
        return true;
      },
      {
        message: msg(
          t,
          "activity:form.err_enter_received_amount",
          "Please enter a received amount.",
        ),
        path: ["destinationAmount"],
      },
    )
    .refine(
      (data) => {
        // Securities mode requires assetId
        if (data.transferMode === "securities") {
          return data.assetId != null && data.assetId.length > 0;
        }
        return true;
      },
      {
        message: msg(t, "activity:form.err_select_symbol", "Please select a symbol."),
        path: ["assetId"],
      },
    )
    .refine(
      (data) => {
        // Securities mode requires quantity
        if (data.transferMode === "securities") {
          return data.quantity != null && data.quantity > 0;
        }
        return true;
      },
      {
        message: msg(t, "activity:form.err_enter_quantity", "Please enter a quantity."),
        path: ["quantity"],
      },
    )
    .refine(
      (data) => {
        // Cost basis required only for external transfer in with securities
        // Backend calculates cost basis for transfer out from existing holdings
        if (data.transferMode === "securities" && data.isExternal && data.direction === "in") {
          return data.unitPrice != null && data.unitPrice > 0;
        }
        return true;
      },
      {
        message: msg(t, "activity:form.err_enter_cost_basis", "Please enter a cost basis."),
        path: ["unitPrice"],
      },
    );

// Zod schema for TransferForm validation (English messages; used by tests).
export const transferFormSchema = createTransferFormSchema();

export type TransferFormValues = z.infer<typeof transferFormSchema>;

interface TransferFormProps {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<TransferFormValues> & {
    transferMode?: TransferMode;
    isExternal?: boolean;
    direction?: TransferDirection;
  };
  onSubmit: (data: TransferFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
  /** Asset currency (from selected symbol) for advanced options */
  assetCurrency?: string;
}

export function TransferForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
  assetCurrency,
}: TransferFormProps) {
  const { t } = useTranslation(["activity"]);
  const { data: settings } = useSettings();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const schema = useMemo(() => createTransferFormSchema(t), [t]);

  // Compute initial account and currency for defaultValues
  const initialFromAccountId = defaultValues?.fromAccountId ?? "";
  const initialAccountId = defaultValues?.accountId ?? "";
  const initialAccount = accounts.find(
    (a) => a.value === initialFromAccountId || a.value === initialAccountId,
  );
  const initialCurrency =
    defaultValues?.currency?.trim() || assetCurrency?.trim() || initialAccount?.currency;

  // Determine initial external state
  const initialIsExternal = defaultValues?.isExternal ?? false;
  const initialDirection: TransferDirection = defaultValues?.direction ?? "in";
  const initialActivityType =
    initialDirection === "in" ? ActivityType.TRANSFER_IN : ActivityType.TRANSFER_OUT;

  // Determine initial transfer mode from defaults
  const initialTransferMode: TransferMode =
    defaultValues?.transferMode ??
    (isSecuritiesTransfer(
      initialActivityType,
      defaultValues?.assetId ?? undefined,
      defaultValues?.assetId ?? undefined,
    )
      ? "securities"
      : "cash");

  const form = useForm<TransferFormValues>({
    resolver: zodResolver(schema) as Resolver<TransferFormValues>,
    mode: "onSubmit", // Validate only on submit - works correctly with default values
    defaultValues: {
      isExternal: initialIsExternal,
      direction: initialDirection,
      accountId: initialAccountId,
      fromAccountId: initialFromAccountId,
      toAccountId: "",
      activityDate: new Date(),
      transferMode: initialTransferMode,
      amount: undefined,
      sourceAmount: undefined,
      destinationAmount: undefined,
      sourceCurrency: initialCurrency,
      destinationCurrency: undefined,
      assetId: null,
      quantity: null,
      unitPrice: null,
      comment: null,
      fxRate: undefined,
      subtype: null,
      quoteMode: QuoteMode.MARKET,
      exchangeMic: undefined,
      ...defaultValues,
      currency: defaultValues?.currency?.trim() || initialCurrency,
    },
  });

  const { watch, setValue } = form;
  const isExternal = watch("isExternal");
  const direction = watch("direction");
  const accountId = watch("accountId");
  const fromAccountId = watch("fromAccountId");
  const toAccountId = watch("toAccountId");
  const currency = watch("currency");
  const quoteMode = watch("quoteMode");
  const transferMode = watch("transferMode");
  const amount = watch("amount");
  const sourceAmount = watch("sourceAmount");
  const sourceCurrency = watch("sourceCurrency");
  const destinationCurrency = watch("destinationCurrency");
  const fxRate = watch("fxRate");
  const assetId = watch("assetId");
  const quantity = watch("quantity");
  const isManualAsset = quoteMode === QuoteMode.MANUAL;
  const isCashMode = transferMode === "cash";
  const sourceAccountOptions = useMemo(
    () => accounts.filter((account) => !isLiabilityAccountType(account.accountType)),
    [accounts],
  );
  const destinationAccountOptions = isCashMode ? accounts : sourceAccountOptions;
  const externalAccountOptions =
    direction === "out" ? sourceAccountOptions : destinationAccountOptions;

  // Get account currency from selected account (internal: fromAccount, external: accountId)
  const selectedAccount = useMemo(
    () => accounts.find((a) => a.value === (isExternal ? accountId : fromAccountId)),
    [accounts, fromAccountId, accountId, isExternal],
  );
  const accountCurrency = selectedAccount?.currency;
  const destinationAccount = useMemo(
    () => accounts.find((a) => a.value === toAccountId),
    [accounts, toAccountId],
  );
  const isInternalCashTransfer = !isExternal && isCashMode;
  const isCreditCardPayment =
    isInternalCashTransfer && isLiabilityAccountType(destinationAccount?.accountType);
  const effectiveSourceCurrency = sourceCurrency || accountCurrency || currency || baseCurrency;
  const effectiveDestinationCurrency =
    destinationCurrency || destinationAccount?.currency || effectiveSourceCurrency;
  const isCrossCurrencyInternalCash =
    isInternalCashTransfer &&
    Boolean(effectiveSourceCurrency) &&
    Boolean(effectiveDestinationCurrency) &&
    effectiveSourceCurrency !== effectiveDestinationCurrency;

  const roundTransferValue = (value: number, precision = 6) =>
    Number(Number(value).toFixed(precision));

  const handleSourceAmountChange = (value: number | null | undefined) => {
    setValue("sourceAmount", value, { shouldDirty: true, shouldValidate: false });
    setValue("amount", value, { shouldDirty: true, shouldValidate: false });
    if (!value || value <= 0) return;
    if (isCrossCurrencyInternalCash) {
      const rate = Number(fxRate);
      if (Number.isFinite(rate) && rate > 0) {
        setValue("destinationAmount", roundTransferValue(value * rate), {
          shouldDirty: true,
          shouldValidate: false,
        });
      }
    } else {
      setValue("destinationAmount", value, { shouldDirty: true, shouldValidate: false });
    }
  };

  const handleDestinationAmountChange = (value: number | null | undefined) => {
    setValue("destinationAmount", value, { shouldDirty: true, shouldValidate: false });
    const sent = Number(sourceAmount);
    const received = Number(value);
    if (sent > 0 && received > 0) {
      setValue("fxRate", roundTransferValue(received / sent, 8), {
        shouldDirty: true,
        shouldValidate: false,
      });
    }
  };

  const handleFxRateChange = (value: number | null | undefined) => {
    setValue("fxRate", value ?? undefined, { shouldDirty: true, shouldValidate: false });
    const sent = Number(sourceAmount);
    const rate = Number(value);
    if (sent > 0 && rate > 0) {
      setValue("destinationAmount", roundTransferValue(sent * rate), {
        shouldDirty: true,
        shouldValidate: false,
      });
    }
  };

  useEffect(() => {
    if (!accountCurrency) return;
    if (!isExternal) {
      setValue("sourceCurrency", accountCurrency, { shouldDirty: false, shouldValidate: false });
    }
    if (!currency || (!isExternal && currency !== accountCurrency)) {
      setValue("currency", accountCurrency, { shouldDirty: false, shouldValidate: false });
    }
  }, [accountCurrency, currency, isExternal, setValue]);

  useEffect(() => {
    if (!destinationAccount?.currency) return;
    setValue("destinationCurrency", destinationAccount.currency, {
      shouldDirty: false,
      shouldValidate: false,
    });
  }, [destinationAccount?.currency, setValue]);

  useEffect(() => {
    if (isCashMode) return;

    if (destinationAccount && isLiabilityAccountType(destinationAccount.accountType)) {
      setValue("toAccountId", "", { shouldDirty: true, shouldValidate: false });
    }

    if (
      isExternal &&
      direction === "in" &&
      selectedAccount &&
      isLiabilityAccountType(selectedAccount.accountType)
    ) {
      setValue("accountId", "", { shouldDirty: true, shouldValidate: false });
    }
  }, [destinationAccount, direction, isCashMode, isExternal, selectedAccount, setValue]);

  useEffect(() => {
    if (!isInternalCashTransfer || isCrossCurrencyInternalCash) return;
    if (sourceAmount != null && sourceAmount > 0) {
      setValue("destinationAmount", sourceAmount, {
        shouldDirty: false,
        shouldValidate: false,
      });
    }
  }, [isCrossCurrencyInternalCash, isInternalCashTransfer, setValue, sourceAmount]);

  // Toggle items for transfer mode
  const transferModeItems = [
    { value: "cash" as const, label: t("activity:form.transfer_mode_cash") },
    { value: "securities" as const, label: t("activity:form.transfer_mode_securities") },
  ];

  // Handle transfer mode change
  const handleTransferModeChange = (mode: TransferMode) => {
    setValue("transferMode", mode, { shouldValidate: false });
    // Clear irrelevant fields when switching modes
    if (mode === "cash") {
      setValue("assetId", null);
      setValue("existingAssetId", undefined);
      setValue("exchangeMic", undefined);
      setValue("symbolQuoteCcy", undefined);
      setValue("symbolInstrumentType", undefined);
      setValue("assetMetadata", undefined);
      setValue("quantity", null);
      setValue("unitPrice", null);
    } else {
      setValue("amount", null);
      if (destinationAccount && isLiabilityAccountType(destinationAccount.accountType)) {
        setValue("toAccountId", "");
      }
      if (
        isExternal &&
        direction === "in" &&
        selectedAccount &&
        isLiabilityAccountType(selectedAccount.accountType)
      ) {
        setValue("accountId", "");
      }
    }
  };

  // Handle external toggle change
  const handleExternalChange = (checked: boolean) => {
    setValue("isExternal", checked, { shouldValidate: false });
    // Reset account fields when toggling
    if (checked) {
      // Switching to external: keep the account from the side represented by the direction.
      const externalAccountId =
        direction === "in"
          ? toAccountId || accountId || fromAccountId
          : fromAccountId || accountId || toAccountId;
      if (externalAccountId) {
        setValue("accountId", externalAccountId);
      }
      setValue("fromAccountId", "");
      setValue("toAccountId", "");
    } else {
      // Switching to internal: put the account back on the side represented by the direction.
      if (accountId) {
        if (direction === "in") {
          setValue("toAccountId", accountId);
        } else {
          setValue("fromAccountId", accountId);
        }
      }
      setValue("accountId", "");
    }
  };

  // Handle direction change
  const handleDirectionChange = (value: string) => {
    setValue("direction", value as TransferDirection, { shouldValidate: false });
  };

  // Generate dynamic submit button text
  const getSubmitButtonText = () => {
    if (isEditing) return t("activity:form.button_update");

    const actionPrefix = isCreditCardPayment
      ? t("activity:form.button_payment")
      : isExternal
        ? direction === "in"
          ? t("activity:form.button_transfer_in")
          : t("activity:form.button_transfer_out")
        : t("activity:form.button_transfer");

    const displayAmount = isInternalCashTransfer ? sourceAmount : amount;
    if (isCashMode && displayAmount && displayAmount > 0) {
      const displayCurrency = initialCurrency || accountCurrency || baseCurrency;
      return `${actionPrefix} ${formatAmount(displayAmount, displayCurrency, false)}`;
    }

    if (!isCashMode && assetId && quantity && quantity > 0) {
      return `${actionPrefix} ${quantity} ${assetId}`;
    }

    return isCreditCardPayment
      ? t("activity:form.button_add_payment")
      : isExternal
        ? t("activity:form.button_add_prefixed", { action: actionPrefix })
        : t("activity:form.button_add_transfer");
  };

  // Filter destination accounts to exclude source account (for internal transfers)
  const toAccountOptions = destinationAccountOptions.filter((acc) => acc.value !== fromAccountId);

  const handleSubmit = createValidatedSubmit(form, async (data) => {
    // Ensure symbolQuoteCcy is set — manual/custom symbols leave it undefined
    if (!data.symbolQuoteCcy && data.currency) {
      data.symbolQuoteCcy = data.currency;
    }
    await onSubmit(data);
  });

  return (
    <FormProvider {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormSection
          title={t("activity:form.section_transfer")}
          action={
            <AnimatedToggleGroup
              items={transferModeItems}
              value={transferMode}
              onValueChange={handleTransferModeChange}
              size="sm"
              rounded="lg"
            />
          }
        >
          {/* External Transfer Option */}
          <div className="flex items-center gap-4">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="isExternal"
                checked={isExternal}
                onCheckedChange={handleExternalChange}
              />
              <Label htmlFor="isExternal" className="cursor-pointer text-sm font-normal">
                {t("activity:form.external_transfer")}
              </Label>
            </div>

            {/* Direction selector (only for external) */}
            {isExternal && (
              <>
                <span className="text-muted-foreground">|</span>
                <RadioGroup
                  value={direction}
                  onValueChange={handleDirectionChange}
                  className="flex gap-3"
                >
                  <div className="flex items-center space-x-1.5">
                    <RadioGroupItem value="in" id="direction-in" />
                    <Label htmlFor="direction-in" className="cursor-pointer text-sm font-normal">
                      {t("activity:form.transfer_direction_in")}
                    </Label>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <RadioGroupItem value="out" id="direction-out" />
                    <Label htmlFor="direction-out" className="cursor-pointer text-sm font-normal">
                      {t("activity:form.transfer_direction_out")}
                    </Label>
                  </div>
                </RadioGroup>
              </>
            )}
          </div>

          {/* Account Selection - conditional based on external flag */}
          {isExternal ? (
            <AccountSelect
              key={`external-${transferMode}-${direction}-${accountId || "none"}`}
              name="accountId"
              accounts={externalAccountOptions}
              currencyName="currency"
              label={
                direction === "in"
                  ? t("activity:form.label_to_account")
                  : t("activity:form.label_from_account")
              }
              placeholder={t("activity:form.placeholder_select_account")}
            />
          ) : (
            <>
              {/* From Account Selection */}
              <AccountSelect
                name="fromAccountId"
                accounts={sourceAccountOptions}
                currencyName="currency"
                label={t("activity:form.label_from_account")}
                placeholder={t("activity:form.placeholder_select_source_account")}
              />

              {/* To Account Selection */}
              <AccountSelect
                key={`to-${transferMode}-${fromAccountId || "none"}-${toAccountId || "none"}`}
                name="toAccountId"
                accounts={toAccountOptions}
                label={t("activity:form.label_to_account")}
                placeholder={t("activity:form.placeholder_select_destination_account")}
              />
            </>
          )}

          {/* Date Picker */}
          <DatePicker name="activityDate" label={t("activity:field_date")} />
        </FormSection>

        <FormSection
          title={
            isCashMode ? t("activity:form.section_amount") : t("activity:form.section_securities")
          }
        >
          {/* Securities mode: Symbol and Quantity at top */}
          {!isCashMode && (
            <>
              <SymbolSearch
                name="assetId"
                isManualAsset={isManualAsset}
                exchangeMicName="exchangeMic"
                quoteModeName="quoteMode"
                currencyName="currency"
                quoteCcyName="symbolQuoteCcy"
                instrumentTypeName="symbolInstrumentType"
                existingAssetIdName="existingAssetId"
                assetMetadataName="assetMetadata"
              />
              {/* Hidden fields to register assetMetadata for react-hook-form */}
              <input type="hidden" {...form.register("assetMetadata.name")} />
              <input type="hidden" {...form.register("assetMetadata.kind")} />
              <input type="hidden" {...form.register("symbolQuoteCcy")} />
              <input type="hidden" {...form.register("symbolInstrumentType")} />
              <input type="hidden" {...form.register("existingAssetId")} />
              <QuantityInput name="quantity" label={t("activity:form.label_quantity")} />
              {/* Cost basis only needed for external transfer in - backend calculates for transfer out */}
              {isExternal && direction === "in" && (
                <AmountInput
                  name="unitPrice"
                  label={t("activity:form.label_cost_basis")}
                  data-testid="cost-basis-input"
                  maxDecimalPlaces={4}
                  currency={currency}
                />
              )}
            </>
          )}

          {/* Cash mode: Amount */}
          {isCashMode &&
            (isInternalCashTransfer ? (
              <div className="space-y-3">
                {isCrossCurrencyInternalCash ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="sourceAmount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {t("activity:form.label_sent", { currency: effectiveSourceCurrency })}
                          </FormLabel>
                          <FormControl>
                            <MoneyInput
                              ref={field.ref}
                              name={field.name}
                              value={field.value}
                              onValueChange={handleSourceAmountChange}
                              placeholder="0.00"
                              aria-label={t("activity:form.sent_amount")}
                              data-testid="sent-amount-input"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="destinationAmount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {t("activity:form.label_received", {
                              currency: effectiveDestinationCurrency,
                            })}
                          </FormLabel>
                          <FormControl>
                            <MoneyInput
                              ref={field.ref}
                              name={field.name}
                              value={field.value}
                              onValueChange={handleDestinationAmountChange}
                              placeholder="0.00"
                              aria-label={t("activity:form.received_amount")}
                              data-testid="received-amount-input"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                ) : (
                  <FormField
                    control={form.control}
                    name="sourceAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t("activity:form.label_amount")}</FormLabel>
                        <FormControl>
                          <MoneyInput
                            ref={field.ref}
                            name={field.name}
                            value={field.value}
                            onValueChange={handleSourceAmountChange}
                            placeholder="0.00"
                            aria-label={t("activity:form.label_amount")}
                            data-testid="input-amount"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {isCrossCurrencyInternalCash && (
                  <FormField
                    control={form.control}
                    name="fxRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {t("activity:form.label_fx_rate")}
                          <span className="text-muted-foreground ml-2 text-xs font-normal">
                            {t("activity:form.fx_conversion", {
                              from: effectiveSourceCurrency,
                              rate: Number(field.value) > 0 ? field.value : "?",
                              to: effectiveDestinationCurrency,
                            })}
                          </span>
                        </FormLabel>
                        <FormControl>
                          <MoneyInput
                            ref={field.ref}
                            name={field.name}
                            value={field.value}
                            onValueChange={handleFxRateChange}
                            placeholder="1.0000"
                            maxDecimalPlaces={8}
                            aria-label={t("activity:form.label_fx_rate")}
                            data-testid="fx-rate-input"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
            ) : (
              <AmountInput
                name="amount"
                label={t("activity:form.label_amount")}
                currency={currency}
              />
            ))}
        </FormSection>

        {/* Advanced options (currency, FX rate, subtype) and notes, collapsed by default */}
        <AdvancedOptionsSection
          title={t("activity:form.section_advanced_notes")}
          dashed
          currencyName="currency"
          fxRateName="fxRate"
          subtypeName="subtype"
          activityType={ActivityType.TRANSFER_IN}
          assetCurrency={assetCurrency}
          accountCurrency={accountCurrency}
          baseCurrency={baseCurrency}
          showCurrency={isExternal}
          showFxRate={isExternal}
        >
          <NotesInput
            name="comment"
            label={t("activity:form.label_notes")}
            placeholder={t("activity:form.placeholder_note")}
          />
        </AdvancedOptionsSection>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
              {t("activity:cancel")}
            </Button>
          )}
          <Button type="submit" disabled={isLoading}>
            {isLoading && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {isEditing ? (
              <Icons.Check className="mr-2 h-4 w-4" />
            ) : (
              <Icons.Plus className="mr-2 h-4 w-4" />
            )}
            {getSubmitButtonText()}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
