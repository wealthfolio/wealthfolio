import { useSettings } from "@/hooks/use-settings";
import { ACTIVITY_SUBTYPES, ActivityType, InstrumentType, QuoteMode } from "@/lib/constants";
import { zodResolver } from "@hookform/resolvers/zod";
import { AnimatedToggleGroup } from "@wealthfolio/ui/components/ui/animated-toggle-group";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { FormProvider, useForm, type Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { useActivityCurrency } from "../../hooks/use-activity-currency";
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

export type AdjustmentMode = "cash" | "securities";

type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

const assetMetadataSchema = z
  .object({
    name: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    exchangeMic: z.string().nullable().optional(),
    providerId: z.string().nullable().optional(),
    providerSymbol: z.string().nullable().optional(),
  })
  .optional();

export const createAdjustmentFormSchema = (t?: TFunction) =>
  z
    .object({
      adjustmentMode: z.enum(["cash", "securities"]).default("cash"),
      accountId: z.string().min(1, {
        message: msg(t, "activity:form.err_select_account", "Please select an account."),
      }),
      activityDate: z.date({
        required_error: msg(t, "activity:form.err_select_date", "Please select a date."),
      }),
      amount: z.coerce
        .number({
          invalid_type_error: msg(t, "activity:form.err_amount_number", "Amount must be a number."),
        })
        .nonnegative({
          message: msg(t, "activity:form.err_amount_non_negative", "Amount must be non-negative."),
        })
        .optional()
        .nullable(),
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
        .nonnegative()
        .optional()
        .nullable(),
      unitPrice: z.coerce
        .number({
          invalid_type_error: msg(t, "activity:form.err_price_number", "Price must be a number."),
        })
        .nonnegative()
        .optional()
        .nullable(),
      comment: z.string().optional().nullable(),
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
        .optional()
        .nullable(),
      subtype: z.string().optional().nullable(),
      quoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).default(QuoteMode.MARKET),
      exchangeMic: z.string().nullable().optional(),
      symbolQuoteCcy: z.string().nullable().optional(),
      symbolInstrumentType: z.string().nullable().optional(),
      assetMetadata: assetMetadataSchema,
    })
    .superRefine((data, ctx) => {
      if (data.adjustmentMode === "securities" && !data.assetId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assetId"],
          message: msg(t, "activity:form.err_select_symbol", "Please select a symbol."),
        });
      }

      if (data.subtype?.trim().toUpperCase() === ACTIVITY_SUBTYPES.OPTION_EXPIRY) {
        if (data.adjustmentMode !== "securities") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["assetId"],
            message: msg(t, "activity:form.err_select_symbol", "Please select a symbol."),
          });
        }
        if (
          data.symbolInstrumentType?.trim() &&
          data.symbolInstrumentType.trim().toUpperCase() !== InstrumentType.OPTION
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["assetId"],
            message: msg(
              t,
              "activity:form.err_option_type_required",
              "An option asset is required.",
            ),
          });
        }
        if (!(data.quantity != null && data.quantity > 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["quantity"],
            message: msg(t, "activity:form.err_enter_quantity", "Please enter a quantity."),
          });
        }
      }
    });

export const adjustmentFormSchema = createAdjustmentFormSchema();

export type AdjustmentFormValues = z.infer<typeof adjustmentFormSchema>;

interface AdjustmentFormProps {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<AdjustmentFormValues>;
  onSubmit: (data: AdjustmentFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}

export function AdjustmentForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
}: AdjustmentFormProps) {
  const { t } = useTranslation(["activity"]);
  const { data: settings } = useSettings();
  const baseCurrency = settings?.baseCurrency;
  const schema = useMemo(() => createAdjustmentFormSchema(t), [t]);

  const initialAccountId =
    defaultValues?.accountId ?? (accounts.length === 1 ? accounts[0].value : "");
  const initialAccount = accounts.find((account) => account.value === initialAccountId);
  const initialCurrency = defaultValues?.currency?.trim() || initialAccount?.currency;

  const form = useForm<AdjustmentFormValues>({
    resolver: zodResolver(schema) as Resolver<AdjustmentFormValues>,
    mode: "onSubmit",
    defaultValues: {
      adjustmentMode: "cash",
      accountId: initialAccountId,
      activityDate: new Date(),
      amount: null,
      assetId: null,
      quantity: null,
      unitPrice: null,
      comment: null,
      fxRate: undefined,
      subtype: null,
      quoteMode: QuoteMode.MARKET,
      ...defaultValues,
      currency: defaultValues?.currency?.trim() || initialCurrency,
    },
  });

  useActivityCurrency(form, accounts, { isEditing });

  const adjustmentMode = form.watch("adjustmentMode");
  const accountId = form.watch("accountId");
  const currency = form.watch("currency");
  const subtype = form.watch("subtype");
  const symbolInstrumentType = form.watch("symbolInstrumentType");
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.value === accountId),
    [accounts, accountId],
  );
  const accountCurrency = selectedAccount?.currency;
  const isCashMode = adjustmentMode === "cash";
  const subtypeOptions = useMemo(() => {
    const currentSubtype = subtype?.trim();
    const isCurrentOptionExpiry = currentSubtype?.toUpperCase() === ACTIVITY_SUBTYPES.OPTION_EXPIRY;
    const canSelectOptionExpiry =
      symbolInstrumentType?.trim().toUpperCase() === InstrumentType.OPTION || isCurrentOptionExpiry;
    const options: string[] = canSelectOptionExpiry
      ? [isCurrentOptionExpiry && currentSubtype ? currentSubtype : ACTIVITY_SUBTYPES.OPTION_EXPIRY]
      : [];
    if (currentSubtype && !options.includes(currentSubtype)) {
      return [currentSubtype, ...options];
    }
    return options;
  }, [subtype, symbolInstrumentType]);

  const handleModeChange = (mode: AdjustmentMode) => {
    form.setValue("adjustmentMode", mode, { shouldValidate: false });
    if (mode === "cash") {
      form.setValue("assetId", null);
      form.setValue("existingAssetId", undefined);
      form.setValue("exchangeMic", undefined);
      form.setValue("symbolQuoteCcy", undefined);
      form.setValue("symbolInstrumentType", undefined);
      form.setValue("assetMetadata", undefined);
      form.setValue("quantity", null);
      form.setValue("unitPrice", null);
      if (subtype?.trim().toUpperCase() === ACTIVITY_SUBTYPES.OPTION_EXPIRY) {
        form.setValue("subtype", null);
      }
    }
  };

  const handleSubmit = createValidatedSubmit(form, async (data) => {
    if (data.adjustmentMode === "securities" && !data.symbolQuoteCcy && data.currency) {
      data.symbolQuoteCcy = data.currency;
    }
    await onSubmit(data);
  });

  const modeItems = [
    { value: "cash" as const, label: t("activity:form.transfer_mode_cash") },
    { value: "securities" as const, label: t("activity:form.transfer_mode_securities") },
  ];

  return (
    <FormProvider {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormSection
          title={t("activity:type_adjustment")}
          action={
            <AnimatedToggleGroup
              items={modeItems}
              value={adjustmentMode}
              onValueChange={handleModeChange}
              size="sm"
              rounded="lg"
            />
          }
        >
          <AccountSelect name="accountId" accounts={accounts} />
          <DatePicker name="activityDate" label={t("activity:field_date")} />
        </FormSection>

        <FormSection
          title={
            isCashMode ? t("activity:form.section_amount") : t("activity:form.section_securities")
          }
        >
          {isCashMode ? (
            <AmountInput
              name="amount"
              label={t("activity:form.label_amount")}
              currency={currency}
            />
          ) : (
            <>
              <SymbolSearch
                name="assetId"
                isManualAsset={form.watch("quoteMode") === QuoteMode.MANUAL}
                exchangeMicName="exchangeMic"
                quoteModeName="quoteMode"
                currencyName="currency"
                quoteCcyName="symbolQuoteCcy"
                instrumentTypeName="symbolInstrumentType"
                existingAssetIdName="existingAssetId"
                assetMetadataName="assetMetadata"
              />
              <input type="hidden" {...form.register("assetMetadata.name")} />
              <input type="hidden" {...form.register("assetMetadata.kind")} />
              <input type="hidden" {...form.register("symbolQuoteCcy")} />
              <input type="hidden" {...form.register("symbolInstrumentType")} />
              <input type="hidden" {...form.register("existingAssetId")} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <QuantityInput name="quantity" label={t("activity:form.label_quantity")} />
                <AmountInput
                  name="unitPrice"
                  label={t("activity:form.label_price")}
                  currency={currency}
                  maxDecimalPlaces={4}
                />
              </div>
              <AmountInput
                name="amount"
                label={t("activity:form.label_amount")}
                currency={currency}
              />
            </>
          )}
        </FormSection>

        <AdvancedOptionsSection
          title={t("activity:form.section_advanced_notes")}
          dashed
          currencyName="currency"
          fxRateName="fxRate"
          subtypeName="subtype"
          activityType={ActivityType.ADJUSTMENT}
          subtypeOptions={subtypeOptions}
          accountCurrency={accountCurrency}
          baseCurrency={baseCurrency}
          showSubtype={!isCashMode}
        >
          <NotesInput
            name="comment"
            label={t("activity:form.label_notes")}
            placeholder={t("activity:form.placeholder_note")}
          />
        </AdvancedOptionsSection>

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
            {isEditing
              ? t("activity:form.button_update")
              : t("activity:form.button_add_prefixed", { action: t("activity:type_adjustment") })}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
