import { useSettings } from "@/hooks/use-settings";
import { ActivityType } from "@/lib/constants";
import { zodResolver } from "@hookform/resolvers/zod";
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
  type AccountSelectOption,
} from "./fields";

type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

export const createCreditFormSchema = (t?: TFunction) =>
  z.object({
    accountId: z
      .string()
      .min(1, { message: msg(t, "activity:form.err_select_account", "Please select an account.") }),
    activityDate: z.date({
      required_error: msg(t, "activity:form.err_select_date", "Please select a date."),
    }),
    amount: z.coerce
      .number({
        required_error: msg(t, "activity:form.err_enter_amount", "Please enter an amount."),
        invalid_type_error: msg(t, "activity:form.err_amount_number", "Amount must be a number."),
      })
      .min(0, {
        message: msg(t, "activity:form.err_amount_non_negative", "Amount must be non-negative."),
      }),
    comment: z.string().optional().nullable(),
    currency: z
      .string()
      .min(1, { message: msg(t, "activity:form.err_currency_required", "Currency is required.") }),
    fxRate: z.coerce
      .number({
        invalid_type_error: msg(t, "activity:form.err_fxrate_number", "FX Rate must be a number."),
      })
      .positive({
        message: msg(t, "activity:form.err_fxrate_positive", "FX Rate must be positive."),
      })
      .optional()
      .nullable(),
    subtype: z.string().optional().nullable(),
  });

export const creditFormSchema = createCreditFormSchema();

export type CreditFormValues = z.infer<typeof creditFormSchema>;

interface CreditFormProps {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<CreditFormValues>;
  onSubmit: (data: CreditFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}

export function CreditForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
}: CreditFormProps) {
  const { t } = useTranslation(["activity"]);
  const { data: settings } = useSettings();
  const baseCurrency = settings?.baseCurrency;
  const schema = useMemo(() => createCreditFormSchema(t), [t]);

  const initialAccountId =
    defaultValues?.accountId ?? (accounts.length === 1 ? accounts[0].value : "");
  const initialAccount = accounts.find((account) => account.value === initialAccountId);
  const initialCurrency = defaultValues?.currency?.trim() || initialAccount?.currency;

  const form = useForm<CreditFormValues>({
    resolver: zodResolver(schema) as Resolver<CreditFormValues>,
    mode: "onSubmit",
    defaultValues: {
      accountId: initialAccountId,
      activityDate: new Date(),
      amount: undefined,
      comment: null,
      fxRate: undefined,
      subtype: null,
      ...defaultValues,
      currency: defaultValues?.currency?.trim() || initialCurrency,
    },
  });

  useActivityCurrency(form, accounts, { isEditing });

  const accountId = form.watch("accountId");
  const currency = form.watch("currency");
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.value === accountId),
    [accounts, accountId],
  );
  const accountCurrency = selectedAccount?.currency;

  const handleSubmit = createValidatedSubmit(form, async (data) => {
    await onSubmit(data);
  });

  return (
    <FormProvider {...form}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <FormSection title={t("activity:form.section_account")}>
          <AccountSelect name="accountId" accounts={accounts} />
          <DatePicker name="activityDate" label={t("activity:field_date")} />
        </FormSection>

        <FormSection title={t("activity:form.section_amount")}>
          <AmountInput name="amount" label={t("activity:form.label_amount")} currency={currency} />
        </FormSection>

        <AdvancedOptionsSection
          title={t("activity:form.section_advanced_notes")}
          dashed
          currencyName="currency"
          fxRateName="fxRate"
          subtypeName="subtype"
          activityType={ActivityType.CREDIT}
          accountCurrency={accountCurrency}
          baseCurrency={baseCurrency}
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
              : t("activity:form.button_add_prefixed", { action: t("activity:type_credit") })}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
