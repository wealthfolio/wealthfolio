import { useSettings } from "@/hooks/use-settings";
import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import { roundDecimal } from "@/lib/utils";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
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

// Non-UI sentinel for the "cash" income mode (not a DB value; internal only).
const INCOME_MODE_CASH = "CASH";

// Translated message helper (see buy-form for rationale).
type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

// Zod schema factory for DividendForm validation. `t` optional so the exported
// static schema keeps English messages (used by tests and type inference).
export const createDividendFormSchema = (t?: TFunction) =>
  z
    .object({
      accountId: z.string().min(1, {
        message: msg(t, "activity:form.err_select_account", "Please select an account."),
      }),
      symbol: z
        .string()
        .min(1, { message: msg(t, "activity:form.err_enter_symbol", "Please enter a symbol.") }),
      existingAssetId: z.string().nullable().optional(),
      exchangeMic: z.string().nullable().optional(),
      activityDate: z.date({
        required_error: msg(t, "activity:form.err_select_date", "Please select a date."),
      }),
      amount: z.coerce
        .number({
          required_error: msg(t, "activity:form.err_enter_amount", "Please enter an amount."),
          invalid_type_error: msg(t, "activity:form.err_amount_number", "Amount must be a number."),
        })
        .positive({
          message: msg(t, "activity:form.err_amount_gt_zero", "Amount must be greater than 0."),
        }),
      tax: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_withholding_tax_number",
            "Withholding tax must be a number.",
          ),
        })
        .min(0, {
          message: msg(
            t,
            "activity:form.err_withholding_tax_non_negative",
            "Withholding tax must be non-negative.",
          ),
        })
        .default(0),
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
      unitPrice: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_fmv_number",
            "FMV per unit must be a number.",
          ),
        })
        .positive({
          message: msg(t, "activity:form.err_fmv_gt_zero", "FMV per unit must be greater than 0."),
        })
        .optional(),
      quantity: z.coerce
        .number({
          invalid_type_error: msg(
            t,
            "activity:form.err_received_quantity_number",
            "Received quantity must be a number.",
          ),
        })
        .positive({
          message: msg(
            t,
            "activity:form.err_received_quantity_gt_zero",
            "Received quantity must be greater than 0.",
          ),
        })
        .optional(),
      symbolQuoteCcy: z.string().nullable().optional(),
      symbolInstrumentType: z.string().nullable().optional(),
    })
    .superRefine((data, ctx) => {
      const isAssetBacked =
        data.subtype === ACTIVITY_SUBTYPES.DRIP ||
        data.subtype === ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND;
      if (!isAssetBacked) return;

      if (!data.quantity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["quantity"],
          message: msg(
            t,
            "activity:form.err_received_quantity_required",
            "Received quantity is required.",
          ),
        });
      }
      if (!data.unitPrice) {
        if (data.amount) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unitPrice"],
          message: msg(
            t,
            "activity:form.err_enter_dividend_or_fmv",
            "Enter either dividend amount or FMV per unit.",
          ),
        });
      }
    });

// Zod schema for DividendForm validation (English messages; used by tests).
export const dividendFormSchema = createDividendFormSchema();

export type DividendFormValues = z.infer<typeof dividendFormSchema>;

interface DividendFormProps {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<DividendFormValues>;
  onSubmit: (data: DividendFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
  /** Whether to show manual symbol input instead of search */
  isManualSymbol?: boolean;
  /** Asset currency (from selected symbol) for advanced options */
  assetCurrency?: string;
}

export function DividendForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
  isManualSymbol = false,
  assetCurrency,
}: DividendFormProps) {
  const { t } = useTranslation(["activity"]);
  const { data: settings } = useSettings();
  const baseCurrency = settings?.baseCurrency;

  const schema = useMemo(() => createDividendFormSchema(t), [t]);
  const fmvHelpText = t("activity:form.help_fmv_per_unit");

  // Compute initial account and currency for defaultValues
  const initialAccountId =
    defaultValues?.accountId ?? (accounts.length === 1 ? accounts[0].value : "");
  const initialAccount = accounts.find((a) => a.value === initialAccountId);
  const initialCurrency =
    defaultValues?.currency?.trim() || assetCurrency?.trim() || initialAccount?.currency;

  const form = useForm<DividendFormValues>({
    resolver: zodResolver(schema) as Resolver<DividendFormValues>,
    mode: "onSubmit", // Validate only on submit - works correctly with default values
    defaultValues: {
      accountId: initialAccountId,
      symbol: "",
      activityDate: new Date(),
      amount: undefined,
      tax: 0,
      comment: null,
      fxRate: undefined,
      subtype: null,
      ...defaultValues,
      currency: defaultValues?.currency?.trim() || initialCurrency,
    },
  });

  const { watch } = form;
  const { getFieldState, getValues, setValue } = form;
  const accountId = watch("accountId");
  const currency = watch("currency");
  const subtype = watch("subtype");
  const quantity = watch("quantity");
  const unitPrice = watch("unitPrice");
  const isAssetBacked =
    subtype === ACTIVITY_SUBTYPES.DRIP || subtype === ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND;
  const dividendMode = subtype ?? INCOME_MODE_CASH;

  useEffect(() => {
    if (!isAssetBacked) return;
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
        setValue("amount", computedAmount, {
          shouldDirty: quantityIsDirty || unitPriceIsDirty,
          shouldValidate: false,
        });
      }
    }
  }, [getFieldState, getValues, isAssetBacked, quantity, setValue, unitPrice]);

  const handleDividendModeChange = (value: string) => {
    setValue("subtype", value === INCOME_MODE_CASH ? null : value, {
      shouldDirty: true,
      shouldValidate: true,
    });
    if (value === INCOME_MODE_CASH) {
      setValue("quantity", undefined, { shouldDirty: true, shouldValidate: false });
      setValue("unitPrice", undefined, { shouldDirty: true, shouldValidate: false });
    }
  };

  // Get account currency from selected account
  const selectedAccount = useMemo(
    () => accounts.find((a) => a.value === accountId),
    [accounts, accountId],
  );
  const accountCurrency = selectedAccount?.currency;

  const handleSubmit = createValidatedSubmit(form, async (data) => {
    await onSubmit(data);
  });

  return (
    <FormProvider {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormSection title={t("activity:form.section_asset_account")}>
          {/* Symbol Search/Input */}
          <SymbolSearch
            name="symbol"
            label={t("activity:form.label_asset")}
            isManualAsset={isManualSymbol}
            exchangeMicName="exchangeMic"
            currencyName="currency"
            quoteCcyName="symbolQuoteCcy"
            instrumentTypeName="symbolInstrumentType"
            existingAssetIdName="existingAssetId"
          />
          <input type="hidden" {...form.register("symbolQuoteCcy")} />
          <input type="hidden" {...form.register("symbolInstrumentType")} />
          <input type="hidden" {...form.register("existingAssetId")} />

          <AccountSelect name="accountId" accounts={accounts} currencyName="currency" />
          <DatePicker name="activityDate" label={t("activity:field_date")} />
        </FormSection>

        <FormSection title={t("activity:form.section_dividend")}>
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("activity:form.dividend_type")}</div>
            <RadioGroup
              value={dividendMode}
              onValueChange={handleDividendModeChange}
              className="flex flex-wrap gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value={INCOME_MODE_CASH} id="dividend-type-cash" />
                <Label htmlFor="dividend-type-cash" className="cursor-pointer text-sm font-normal">
                  {t("activity:form.type_cash")}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value={ACTIVITY_SUBTYPES.DRIP} id="dividend-type-drip" />
                <Label htmlFor="dividend-type-drip" className="cursor-pointer text-sm font-normal">
                  {t("activity:form.type_drip")}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem
                  value={ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND}
                  id="dividend-type-in-kind"
                />
                <Label
                  htmlFor="dividend-type-in-kind"
                  className="cursor-pointer text-sm font-normal"
                >
                  {t("activity:form.type_in_kind")}
                </Label>
              </div>
            </RadioGroup>
          </div>

          {isAssetBacked && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <QuantityInput
                name="quantity"
                data-testid="received-quantity-input"
                label={
                  subtype === ACTIVITY_SUBTYPES.DRIP
                    ? t("activity:form.label_reinvested_quantity")
                    : t("activity:form.label_received_quantity")
                }
              />
              <AmountInput
                name="unitPrice"
                data-testid="fmv-per-unit-input"
                label={
                  subtype === ACTIVITY_SUBTYPES.DRIP
                    ? t("activity:form.label_reinvestment_price")
                    : t("activity:form.label_fmv_per_unit")
                }
                labelHelpText={subtype === ACTIVITY_SUBTYPES.DRIP ? undefined : fmvHelpText}
                maxDecimalPlaces={4}
                currency={currency}
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <AmountInput
              name="amount"
              data-testid={isAssetBacked ? "dividend-amount-input" : undefined}
              label={
                isAssetBacked
                  ? t("activity:form.label_dividend_amount")
                  : t("activity:form.label_amount")
              }
              currency={currency}
            />
            <AmountInput
              name="tax"
              label={t("activity:form.label_withholding_tax")}
              currency={currency}
            />
          </div>
        </FormSection>

        {/* Advanced options (currency, FX rate) and notes, collapsed by default */}
        <AdvancedOptionsSection
          title={t("activity:form.section_advanced_notes")}
          dashed
          currencyName="currency"
          fxRateName="fxRate"
          activityType={ActivityType.DIVIDEND}
          assetCurrency={assetCurrency}
          accountCurrency={accountCurrency}
          baseCurrency={baseCurrency}
          showSubtype={false}
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
            {isEditing ? t("activity:form.button_update") : t("activity:form.button_add_dividend")}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
