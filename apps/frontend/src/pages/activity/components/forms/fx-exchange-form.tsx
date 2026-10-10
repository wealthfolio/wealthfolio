import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FormProvider, useForm, useFormContext, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@wealthfolio/ui";
import { CurrencyInput } from "@wealthfolio/ui/components/financial";
import { useActivityCurrency } from "../../hooks/use-activity-currency";
import {
  AccountSelect,
  AmountInput,
  DatePicker,
  FormSection,
  NotesInput,
  createValidatedSubmit,
  type AccountSelectOption,
} from "./fields";

export const createFxExchangeFormSchema = (t?: TFunction) => {
  const positive = t ? t("activity:fx_exchange.positive") : "Enter a positive amount";
  const currency = t ? t("activity:form.err_currency_required") : "Currency is required";
  return z
    .object({
      accountId: z
        .string()
        .min(1, t ? t("activity:form.err_select_account") : "Please select an account"),
      activityDate: z.date(),
      amount: z.coerce.number().finite().positive(positive),
      currency: z.string().regex(/^[A-Z]{3}$/, currency),
      destinationAmount: z.coerce.number().finite().positive(positive),
      destinationCurrency: z.string().regex(/^[A-Z]{3}$/, currency),
      comment: z.string().nullable().optional(),
    })
    .refine((value) => value.currency !== value.destinationCurrency, {
      path: ["destinationCurrency"],
      message: t ? t("activity:fx_exchange.different") : "Choose a different currency",
    });
};

export const fxExchangeFormSchema = createFxExchangeFormSchema();
export type FxExchangeFormValues = z.infer<typeof fxExchangeFormSchema>;

// Shared by the desktop form and the mobile wizard; no execution quotes or FX overrides.
export function FxExchangeFields({
  accounts,
  isEditing = false,
}: {
  accounts: AccountSelectOption[];
  isEditing?: boolean;
}) {
  const { t } = useTranslation();
  const form = useFormContext<FxExchangeFormValues>();
  useActivityCurrency(form, accounts, { isEditing, trackCurrencyChanges: false });
  const [amount, currency, received, destination] = form.watch([
    "amount",
    "currency",
    "destinationAmount",
    "destinationCurrency",
  ]);
  const rate = Number(amount) > 0 ? Number(received) / Number(amount) : 0;
  return (
    <>
      <FormSection title={t("activity:form.section_account")}>
        <AccountSelect name="accountId" accounts={accounts} />
        <DatePicker name="activityDate" label={t("activity:field_date")} />
      </FormSection>
      <p className="text-muted-foreground text-sm">{t("activity:fx_exchange.help")}</p>
      {(
        [
          ["amount", "currency", "sent"],
          ["destinationAmount", "destinationCurrency", "received"],
        ] as const
      ).map(([amountName, currencyName, label]) => (
        <FormSection key={amountName} title={t(`activity:fx_exchange.${label}`)}>
          <FormField
            control={form.control}
            name={currencyName}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("activity:form.currency")}</FormLabel>
                <FormControl>
                  <CurrencyInput
                    value={field.value ?? ""}
                    onChange={field.onChange}
                    data-testid={`fx-${currencyName}`}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <AmountInput
            maxDecimalPlaces={8}
            name={amountName}
            label={t(`activity:fx_exchange.${label}`)}
            currency={currencyName === "currency" ? currency : destination}
          />
        </FormSection>
      ))}
      {Number.isFinite(rate) && rate > 0 && currency && destination && (
        <p className="text-muted-foreground text-sm" data-testid="fx-execution-rate">
          {t("activity:fx_exchange.rate")}: 1 {currency} ={" "}
          {rate.toLocaleString(undefined, { maximumFractionDigits: 8 })} {destination}
        </p>
      )}
      <NotesInput name="comment" label={t("activity:form.label_notes")} />
    </>
  );
}

export function FxExchangeForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
}: {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<FxExchangeFormValues>;
  onSubmit: (data: FxExchangeFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}) {
  const { t } = useTranslation();
  const schema = useMemo(() => createFxExchangeFormSchema(t), [t]);
  const form = useForm<FxExchangeFormValues>({
    resolver: zodResolver(schema) as Resolver<FxExchangeFormValues>,
    defaultValues: {
      accountId: accounts.length === 1 ? accounts[0].value : "",
      activityDate: new Date(),
      currency: "",
      destinationCurrency: "",
      ...defaultValues,
    },
  });
  return (
    <FormProvider {...form}>
      <form className="space-y-4" onSubmit={createValidatedSubmit(form, onSubmit)}>
        <FxExchangeFields accounts={accounts} isEditing={isEditing} />
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
              {t("activity:cancel")}
            </Button>
          )}
          <Button type="submit" disabled={isLoading}>
            {isEditing ? t("activity:form.button_update") : t("activity:fx_exchange.add")}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
