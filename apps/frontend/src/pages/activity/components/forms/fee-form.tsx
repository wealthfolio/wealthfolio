import { useSettings } from "@/hooks/use-settings";
import { ActivityType } from "@/lib/constants";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useMemo } from "react";
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
  type AccountSelectOption,
} from "./fields";

// Translated message helper (see buy-form for rationale).
type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

// Zod schema factory for FeeForm validation. `t` optional so the exported
// static schema keeps English messages (used by tests and type inference).
export const createFeeFormSchema = (t?: TFunction) =>
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
      .positive({
        message: msg(t, "activity:form.err_amount_gt_zero", "Amount must be greater than 0."),
      }),
    comment: z.string().optional().nullable(),
    // Advanced options
    currency: z
      .string()
      .min(1, { message: msg(t, "activity:form.err_currency_required", "Currency is required.") }),
    subtype: z.string().optional().nullable(),
  });

// Zod schema for FeeForm validation (English messages; used by tests).
export const feeFormSchema = createFeeFormSchema();

export type FeeFormValues = z.infer<typeof feeFormSchema>;

interface FeeFormProps {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<FeeFormValues>;
  onSubmit: (data: FeeFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}

export function FeeForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
}: FeeFormProps) {
  const { t } = useTranslation(["activity"]);
  const { data: settings } = useSettings();
  const baseCurrency = settings?.baseCurrency;

  const schema = useMemo(() => createFeeFormSchema(t), [t]);

  // Compute initial account and currency for defaultValues
  const initialAccountId =
    defaultValues?.accountId ?? (accounts.length === 1 ? accounts[0].value : "");
  const initialAccount = accounts.find((a) => a.value === initialAccountId);
  const initialCurrency = defaultValues?.currency?.trim() || initialAccount?.currency;

  const form = useForm<FeeFormValues>({
    resolver: zodResolver(schema) as Resolver<FeeFormValues>,
    mode: "onSubmit", // Validate only on submit - works correctly with default values
    defaultValues: {
      accountId: initialAccountId,
      activityDate: new Date(),
      amount: undefined,
      comment: null,
      subtype: null,
      ...defaultValues,
      currency: defaultValues?.currency?.trim() || initialCurrency,
    },
  });

  const { watch } = form;
  const accountId = watch("accountId");
  const currency = watch("currency");

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
        <FormSection title={t("activity:form.section_account")}>
          <AccountSelect name="accountId" accounts={accounts} currencyName="currency" />
          <DatePicker name="activityDate" label={t("activity:field_date")} />
        </FormSection>

        <FormSection title={t("activity:form.section_amount")}>
          <AmountInput name="amount" label={t("activity:form.label_amount")} currency={currency} />
        </FormSection>

        {/* Advanced options (currency, subtype) and notes, collapsed by default */}
        <AdvancedOptionsSection
          title={t("activity:form.section_advanced_notes")}
          dashed
          currencyName="currency"
          subtypeName="subtype"
          activityType={ActivityType.FEE}
          accountCurrency={accountCurrency}
          baseCurrency={baseCurrency}
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
            {isEditing ? t("activity:form.button_update") : t("activity:form.button_add_fee")}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
