import { useSettings } from "@/hooks/use-settings";
import { isSecuritiesTransfer } from "@/lib/activity-utils";
import { ActivityType, QuoteMode } from "@/lib/constants";
import { formatAmount } from "@/lib/utils";
import { zodResolver } from "@hookform/resolvers/zod";
import { AnimatedToggleGroup } from "@wealthfolio/ui/components/ui/animated-toggle-group";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import { useMemo } from "react";
import { FormProvider, useForm, type Resolver } from "react-hook-form";
import { z } from "zod";
import {
  AccountSelect,
  AdvancedOptionsSection,
  AmountInput,
  createValidatedSubmit,
  DatePicker,
  NotesInput,
  QuantityInput,
  SymbolSearch,
  type AccountSelectOption,
} from "./fields";

export type TransferMode = "cash" | "securities";
export type TransferDirection = "in" | "out";

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

// Zod schema for TransferForm validation
export const transferFormSchema = z
  .object({
    isExternal: z.boolean().default(false),
    direction: z.enum(["in", "out"]).default("in"),
    accountId: z.string().optional(), // For external transfers (single account)
    fromAccountId: z.string().optional(), // For internal transfers
    toAccountId: z.string().optional(), // For internal transfers
    activityDate: z.date({ required_error: "Please select a date." }),
    transferMode: z.enum(["cash", "securities"]).default("cash"),
    amount: z.coerce
      .number({
        invalid_type_error: "Amount must be a number.",
      })
      .positive({ message: "Amount must be greater than 0." })
      .optional()
      .nullable(),
    // Fields for security transfers
    assetId: z.string().optional().nullable(),
    existingAssetId: z.string().nullable().optional(),
    quantity: z.coerce
      .number({
        invalid_type_error: "Quantity must be a number.",
      })
      .positive({ message: "Quantity must be greater than 0." })
      .optional()
      .nullable(),
    unitPrice: z.coerce
      .number({
        invalid_type_error: "Cost basis must be a number.",
      })
      .positive({ message: "Cost basis must be greater than 0." })
      .optional()
      .nullable(),
    comment: z.string().optional().nullable(),
    // Advanced options
    currency: z.string().min(1, { message: "Currency is required." }),
    fxRate: z.coerce
      .number({
        invalid_type_error: "FX Rate must be a number.",
      })
      .positive({ message: "FX Rate must be positive." })
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
      message: "Please select an account.",
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
      message: "Please select a source account.",
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
      message: "Please select a destination account.",
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
      message: "Source and destination accounts must be different.",
      path: ["toAccountId"],
    },
  )
  .refine(
    (data) => {
      // Cash mode requires amount
      if (data.transferMode === "cash") {
        return data.amount != null && data.amount > 0;
      }
      return true;
    },
    {
      message: "Please enter an amount.",
      path: ["amount"],
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
      message: "Please select a symbol.",
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
      message: "Please enter a quantity.",
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
      message: "Please enter a cost basis.",
      path: ["unitPrice"],
    },
  );

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
  const { data: settings } = useSettings();
  const baseCurrency = settings?.baseCurrency ?? "USD";

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
    resolver: zodResolver(transferFormSchema) as Resolver<TransferFormValues>,
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
  const currency = watch("currency");
  const quoteMode = watch("quoteMode");
  const transferMode = watch("transferMode");
  const amount = watch("amount");
  const assetId = watch("assetId");
  const quantity = watch("quantity");
  const isManualAsset = quoteMode === QuoteMode.MANUAL;
  const isCashMode = transferMode === "cash";

  // Get account currency from selected account (internal: fromAccount, external: accountId)
  const selectedAccount = useMemo(
    () => accounts.find((a) => a.value === (isExternal ? accountId : fromAccountId)),
    [accounts, fromAccountId, accountId, isExternal],
  );
  const accountCurrency = selectedAccount?.currency;

  // Toggle items for transfer mode
  const transferModeItems = [
    { value: "cash" as const, label: "Cash" },
    { value: "securities" as const, label: "Securities" },
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
    }
  };

  // Handle external toggle change
  const handleExternalChange = (checked: boolean) => {
    setValue("isExternal", checked, { shouldValidate: false });
    // Reset account fields when toggling
    if (checked) {
      // Switching to external: copy fromAccountId to accountId if set
      if (fromAccountId) {
        setValue("accountId", fromAccountId);
      }
      setValue("fromAccountId", "");
      setValue("toAccountId", "");
    } else {
      // Switching to internal: copy accountId to fromAccountId if set
      if (accountId) {
        setValue("fromAccountId", accountId);
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
    if (isEditing) return "Update";

    const actionPrefix = isExternal
      ? direction === "in"
        ? "Transfer In"
        : "Transfer Out"
      : "Transfer";

    if (isCashMode && amount && amount > 0) {
      const displayCurrency = initialCurrency || accountCurrency || baseCurrency;
      return `${actionPrefix} ${formatAmount(amount, displayCurrency, false)}`;
    }

    if (!isCashMode && assetId && quantity && quantity > 0) {
      return `${actionPrefix} ${quantity} ${assetId}`;
    }

    return isExternal ? `Add ${actionPrefix}` : "Add Transfer";
  };

  // Filter destination accounts to exclude source account (for internal transfers)
  const toAccountOptions = accounts.filter((acc) => acc.value !== fromAccountId);

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
        <Card>
          <CardContent className="space-y-6 pt-4">
            {/* Transfer Mode Toggle */}
            <div className="flex justify-center">
              <AnimatedToggleGroup
                items={transferModeItems}
                value={transferMode}
                onValueChange={handleTransferModeChange}
                size="sm"
                rounded="lg"
              />
            </div>

            {/* External Transfer Option */}
            <div className="flex items-center gap-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="isExternal"
                  checked={isExternal}
                  onCheckedChange={handleExternalChange}
                />
                <Label htmlFor="isExternal" className="cursor-pointer text-sm font-normal">
                  External transfer
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
                        In
                      </Label>
                    </div>
                    <div className="flex items-center space-x-1.5">
                      <RadioGroupItem value="out" id="direction-out" />
                      <Label htmlFor="direction-out" className="cursor-pointer text-sm font-normal">
                        Out
                      </Label>
                    </div>
                  </RadioGroup>
                </>
              )}
            </div>

            {/* Account Selection - conditional based on external flag */}
            {isExternal ? (
              <AccountSelect
                name="accountId"
                accounts={accounts}
                currencyName="currency"
                label={direction === "in" ? "To Account" : "From Account"}
                placeholder="Select account..."
              />
            ) : (
              <>
                {/* From Account Selection */}
                <AccountSelect
                  name="fromAccountId"
                  accounts={accounts}
                  currencyName="currency"
                  label="From Account"
                  placeholder="Select source account..."
                />

                {/* To Account Selection */}
                <AccountSelect
                  name="toAccountId"
                  accounts={toAccountOptions}
                  label="To Account"
                  placeholder="Select destination account..."
                />
              </>
            )}

            {/* Date Picker */}
            <DatePicker name="activityDate" label="Date" />

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
                <QuantityInput name="quantity" label="Quantity" />
                {/* Cost basis only needed for external transfer in - backend calculates for transfer out */}
                {isExternal && direction === "in" && (
                  <AmountInput
                    name="unitPrice"
                    label="Cost Basis"
                    maxDecimalPlaces={4}
                    currency={currency}
                  />
                )}
              </>
            )}

            {/* Cash mode: Amount */}
            {isCashMode && <AmountInput name="amount" label="Amount" currency={currency} />}

            {/* Advanced Options */}
            <AdvancedOptionsSection
              currencyName="currency"
              fxRateName="fxRate"
              subtypeName="subtype"
              activityType={ActivityType.TRANSFER_IN}
              assetCurrency={assetCurrency}
              accountCurrency={accountCurrency}
              baseCurrency={baseCurrency}
            />

            {/* Notes */}
            <NotesInput name="comment" label="Notes" placeholder="Add an optional note..." />
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
              Cancel
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
