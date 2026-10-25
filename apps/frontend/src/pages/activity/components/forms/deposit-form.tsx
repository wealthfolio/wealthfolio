import { useSettings } from "@/hooks/use-settings";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Button,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FormProvider, useForm, type Resolver } from "react-hook-form";
import { z } from "zod";
import type { TFunction } from "i18next";
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
import { Spinner } from "@wealthfolio/ui";

// Translated message helper (see buy-form for rationale).
type MsgFn = TFunction | undefined;
const msg = (t: MsgFn, key: string, en: string) => (t ? t(key) : en);

// Zod schema factory for DepositForm validation. `t` optional so the exported
// static schema keeps English messages (used by tests and type inference).
export const createDepositFormSchema = (t?: TFunction) =>
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
    contributionYear: z.number().int().min(1900).max(3000).optional(),
    contributionType: z.enum(["employee", "employer"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    comment: z.string().optional().nullable(),
    // Advanced options
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
  });

// Zod schema for DepositForm validation (English messages; used by tests).
export const depositFormSchema = createDepositFormSchema();

export type DepositFormValues = z.infer<typeof depositFormSchema>;

interface DepositFormProps {
  accounts: AccountSelectOption[];
  defaultValues?: Partial<DepositFormValues>;
  onSubmit: (data: DepositFormValues) => void | Promise<void>;
  onCancel?: () => void;
  isLoading?: boolean;
  isEditing?: boolean;
}

export function DepositForm({
  accounts,
  defaultValues,
  onSubmit,
  onCancel,
  isLoading = false,
  isEditing = false,
}: DepositFormProps) {
  const { t } = useTranslation(["activity"]);
  const { data: settings } = useSettings();
  const baseCurrency = settings?.baseCurrency;

  const schema = useMemo(() => createDepositFormSchema(t), [t]);
  const contributionYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const latestYear = Math.max(currentYear + 1, defaultValues?.contributionYear ?? currentYear);

    return Array.from({ length: latestYear - 1900 + 1 }, (_, index) => latestYear - index);
  }, [defaultValues?.contributionYear]);
  const contributionYearItems = useMemo(
    () => [
      {
        value: "activity-date-year",
        label: t("activity:form.option_contribution_year_activity_date"),
      },
      ...contributionYears.map((year) => ({ value: year.toString(), label: year.toString() })),
    ],
    [contributionYears, t],
  );

  // Compute initial account and currency for defaultValues
  const initialAccountId =
    defaultValues?.accountId ?? (accounts.length === 1 ? accounts[0].value : "");
  const initialAccount = accounts.find((a) => a.value === initialAccountId);
  const initialCurrency = defaultValues?.currency?.trim() || initialAccount?.currency;

  const form = useForm<DepositFormValues>({
    resolver: zodResolver(schema) as Resolver<DepositFormValues>,
    mode: "onSubmit", // Validate only on submit - works correctly with default values
    defaultValues: {
      accountId: initialAccountId,
      activityDate: new Date(),
      amount: undefined,
      contributionYear: undefined,
      contributionType: undefined,
      metadata: {},
      comment: null,
      fxRate: undefined,
      ...defaultValues,
      currency: defaultValues?.currency?.trim() || initialCurrency,
    },
  });

  useActivityCurrency(form, accounts, { isEditing });

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
          <AccountSelect name="accountId" accounts={accounts} />
          <DatePicker name="activityDate" label={t("activity:field_date")} />
          <FormField
            control={form.control}
            name="contributionYear"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("activity:form.label_contribution_year")}</FormLabel>
                <FormControl>
                  <Select
                    items={contributionYearItems}
                    value={field.value?.toString() ?? "activity-date-year"}
                    onValueChange={(value) =>
                      field.onChange(value === "activity-date-year" ? undefined : Number(value))
                    }
                  >
                    <SelectTrigger
                      ref={field.ref}
                      aria-label={t("activity:form.label_contribution_year")}
                      data-testid="contribution-year-picker"
                      onBlur={field.onBlur}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="activity-date-year">
                        {t("activity:form.option_contribution_year_activity_date")}
                      </SelectItem>
                      {contributionYears.map((year) => (
                        <SelectItem key={year} value={year.toString()}>
                          {year}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormDescription>{t("activity:form.help_contribution_year")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="contributionType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("activity:form.label_contribution_type")}</FormLabel>
                <FormControl>
                  <Select
                    value={field.value ?? "unclassified"}
                    onValueChange={(value) =>
                      field.onChange(
                        value === "employee" || value === "employer" ? value : undefined,
                      )
                    }
                  >
                    <SelectTrigger aria-label={t("activity:form.label_contribution_type")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unclassified">
                        {t("activity:form.option_contribution_type_unclassified")}
                      </SelectItem>
                      <SelectItem value="employee">
                        {t("activity:form.option_contribution_type_employee")}
                      </SelectItem>
                      <SelectItem value="employer">
                        {t("activity:form.option_contribution_type_employer")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormDescription>{t("activity:form.help_contribution_type")}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </FormSection>

        <FormSection title={t("activity:form.section_amount")}>
          <AmountInput name="amount" label={t("activity:form.label_amount")} currency={currency} />
        </FormSection>

        {/* Advanced options (currency, FX rate) and notes, collapsed by default */}
        <AdvancedOptionsSection
          title={t("activity:form.section_advanced_notes")}
          dashed
          currencyName="currency"
          fxRateName="fxRate"
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
            {isLoading && <Spinner className="me-2 h-4 w-4" />}
            {isEditing ? (
              <Icons.Check className="me-2 h-4 w-4" />
            ) : (
              <Icons.Plus className="me-2 h-4 w-4" />
            )}
            {isEditing ? t("activity:form.button_update") : t("activity:form.button_add_deposit")}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
