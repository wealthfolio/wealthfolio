import { useHoldings } from "@/hooks/use-holdings";
import { QuoteMode } from "@/lib/constants";
import { invalidTypeError, requiredError } from "@/lib/zod-errors";
import { zodResolver } from "@hookform/resolvers/zod";
import { Spinner, useNumberFormatting } from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { FormProvider, useForm, type Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  AccountSelect,
  createValidatedSubmit,
  DatePicker,
  FormSection,
  NotesInput,
  QuantityInput,
  SymbolSearch,
  type AccountSelectOption,
} from "./fields";
import { assetMetadataSchema } from "./schemas";

// Translated message helper (see buy-form for rationale).
type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

const units = (t: MsgFn) =>
  z.coerce
    .number({
      error: invalidTypeError(
        msg(t, "activity:form.err_quantity_number", "Quantity must be a number."),
      ),
    })
    .positive({
      message: msg(t, "activity:form.err_quantity_gt_zero", "Quantity must be greater than 0."),
    });

/**
 * A conversion: units of one asset leave and units of another arrive, in one
 * account on one day, keeping their cost (engine rules R7.5). Saved as two
 * ADJUSTMENT rows, CONVERSION_OUT and CONVERSION_IN.
 */
export const createConversionFormSchema = (t?: TFunction) =>
  z
    .object({
      accountId: z.string().min(1, {
        message: msg(t, "activity:form.err_select_account", "Please select an account."),
      }),
      activityDate: z.date({
        error: requiredError(msg(t, "activity:form.err_select_date", "Please select a date.")),
      }),
      fromAssetId: z.string().min(1, {
        message: msg(t, "activity:form.err_select_symbol", "Please select a symbol."),
      }),
      fromExistingAssetId: z.string().nullable().optional(),
      fromQuantity: units(t),
      fromCurrency: z.string().nullable().optional(),
      fromExchangeMic: z.string().nullable().optional(),
      fromSymbolQuoteCcy: z.string().nullable().optional(),
      fromSymbolInstrumentType: z.string().nullable().optional(),
      fromAssetMetadata: assetMetadataSchema,
      // A custom asset's pricing (MANUAL), as the symbol search sets it.
      fromQuoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).optional(),
      toAssetId: z.string().min(1, {
        message: msg(t, "activity:form.err_select_symbol", "Please select a symbol."),
      }),
      toExistingAssetId: z.string().nullable().optional(),
      toQuantity: units(t),
      toCurrency: z.string().nullable().optional(),
      toExchangeMic: z.string().nullable().optional(),
      toSymbolQuoteCcy: z.string().nullable().optional(),
      toSymbolInstrumentType: z.string().nullable().optional(),
      toAssetMetadata: assetMetadataSchema,
      toQuoteMode: z.enum([QuoteMode.MARKET, QuoteMode.MANUAL]).optional(),
      comment: z.string().optional().nullable(),
    })
    .refine(
      (data) => {
        const same = (a?: string | null, b?: string | null) =>
          (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();
        // Two existing assets differ by id, even with one symbol on two venues.
        if (data.fromExistingAssetId && data.toExistingAssetId) {
          return data.fromExistingAssetId !== data.toExistingAssetId;
        }
        return !(
          same(data.fromAssetId, data.toAssetId) && same(data.fromExchangeMic, data.toExchangeMic)
        );
      },
      {
        message: msg(
          t,
          "activity:form.err_conversion_same_asset",
          "Choose a different asset to convert into.",
        ),
        path: ["toAssetId"],
      },
    );

// English messages; used by tests and type inference.
export const conversionFormSchema = createConversionFormSchema();

export type ConversionFormValues = z.infer<typeof conversionFormSchema>;

interface ConversionFormProps {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<ConversionFormValues>;
  onSubmit: (data: ConversionFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}

export function ConversionForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
}: ConversionFormProps) {
  const { t } = useTranslation(["activity"]);
  const formatting = useNumberFormatting();
  const schema = useMemo(() => createConversionFormSchema(t), [t]);

  const form = useForm<ConversionFormValues>({
    resolver: zodResolver(schema) as Resolver<ConversionFormValues>,
    mode: "onSubmit",
    defaultValues: {
      accountId: accounts.length === 1 ? accounts[0].value : "",
      activityDate: new Date(),
      fromAssetId: "",
      fromExistingAssetId: null,
      fromQuantity: undefined,
      toAssetId: "",
      toExistingAssetId: null,
      toQuantity: undefined,
      comment: null,
      ...defaultValues,
    },
  });

  const { watch } = form;
  const accountId = watch("accountId");
  const fromAssetId = watch("fromAssetId");
  const fromExistingAssetId = watch("fromExistingAssetId");
  const fromQuantity = watch("fromQuantity");

  // Today's holdings: a warning only, since the conversion may be dated in
  // the past. The engine decides when it folds, from the history.
  const { holdings, isLoading: isHoldingsLoading } = useHoldings({ type: "account", accountId });
  const heldQuantity = useMemo(() => {
    // An existing asset is found by id: one symbol can name two listings.
    const holding = fromExistingAssetId
      ? holdings.find(
          (h) => h.instrument?.id === fromExistingAssetId || h.id === fromExistingAssetId,
        )
      : fromAssetId
        ? holdings.find((h) => h.instrument?.symbol === fromAssetId)
        : undefined;
    const held = holding?.quantity ?? 0;
    const sameAsset = fromExistingAssetId
      ? fromExistingAssetId === defaultValues?.fromExistingAssetId
      : fromAssetId === defaultValues?.fromAssetId;
    const isSameEditedHolding = isEditing && accountId === defaultValues?.accountId && sameAsset;
    return isSameEditedHolding ? held + Math.abs(Number(defaultValues?.fromQuantity) || 0) : held;
  }, [
    holdings,
    fromAssetId,
    fromExistingAssetId,
    isEditing,
    accountId,
    defaultValues?.accountId,
    defaultValues?.fromAssetId,
    defaultValues?.fromExistingAssetId,
    defaultValues?.fromQuantity,
  ]);
  const quantity = Number(fromQuantity);
  const convertsMoreThanHeld =
    !isHoldingsLoading && !!fromAssetId && quantity > 0 && quantity > heldQuantity;

  const handleSubmit = createValidatedSubmit(form, async (data) => {
    await onSubmit(data);
  });

  return (
    <FormProvider {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormSection title={t("activity:form.section_conversion")}>
          <p className="text-muted-foreground text-sm">{t("activity:form.conversion_hint")}</p>
          <AccountSelect name="accountId" accounts={accounts} />
          <DatePicker name="activityDate" label={t("activity:field_date")} />
        </FormSection>

        <FormSection title={t("activity:form.section_conversion_from")}>
          <SymbolSearch
            name="fromAssetId"
            label={t("activity:form.label_symbol")}
            exchangeMicName="fromExchangeMic"
            quoteModeName="fromQuoteMode"
            isManualAsset={watch("fromQuoteMode") === QuoteMode.MANUAL}
            currencyName="fromCurrency"
            quoteCcyName="fromSymbolQuoteCcy"
            instrumentTypeName="fromSymbolInstrumentType"
            existingAssetIdName="fromExistingAssetId"
            assetMetadataName="fromAssetMetadata"
          />
          <QuantityInput name="fromQuantity" label={t("activity:form.label_quantity")} />
          {convertsMoreThanHeld && (
            <Alert variant="warning">
              <Icons.AlertTriangle />
              <AlertDescription>
                {t("activity:form.warn_converting_more_than_held", {
                  converting: formatting.formatDecimal(quantity),
                  available: formatting.formatDecimal(heldQuantity),
                })}
              </AlertDescription>
            </Alert>
          )}
        </FormSection>

        <FormSection title={t("activity:form.section_conversion_to")}>
          <SymbolSearch
            name="toAssetId"
            label={t("activity:form.label_symbol")}
            exchangeMicName="toExchangeMic"
            quoteModeName="toQuoteMode"
            isManualAsset={watch("toQuoteMode") === QuoteMode.MANUAL}
            currencyName="toCurrency"
            quoteCcyName="toSymbolQuoteCcy"
            instrumentTypeName="toSymbolInstrumentType"
            existingAssetIdName="toExistingAssetId"
            assetMetadataName="toAssetMetadata"
          />
          <QuantityInput name="toQuantity" label={t("activity:form.label_quantity")} />
        </FormSection>

        <NotesInput
          name="comment"
          label={t("activity:form.label_notes")}
          placeholder={t("activity:form.placeholder_note")}
        />

        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
              {t("activity:cancel")}
            </Button>
          )}
          <Button type="submit" disabled={isLoading}>
            {isLoading && <Spinner className="me-2 h-4 w-4" />}
            {isEditing ? (
              <Icons.Check className="me-2 h-4 w-4" />
            ) : (
              <Icons.Plus className="me-2 h-4 w-4" />
            )}
            {isEditing
              ? t("activity:form.button_update")
              : t("activity:form.button_add_conversion")}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
