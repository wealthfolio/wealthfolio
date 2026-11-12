import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarDate } from "@internationalized/date";
import { useMemo, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

import {
  Badge,
  Checkbox,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
  DatePickerInput,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  Spinner,
  Switch,
  useAmountFormatting,
} from "@wealthfolio/ui";

import { getZonedDateParts } from "@/features/spending/lib/timezone";
import { AccountPurpose, accountSupportsPurpose } from "@/lib/constants";
import { createContributionLimitSchema, newContributionLimitSchema } from "@/lib/schemas";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Account } from "@/lib/types";
import { parseAccountIds } from "../contribution-limit-accounts";
import { hasFormerDefaultDates } from "../contribution-limit-dates";
import { useContributionLimitMutations } from "../use-contribution-limit-mutations";
import { MoneyInput } from "@wealthfolio/ui";

type NewContributionLimit = z.infer<typeof newContributionLimitSchema>;

type ContributionLimitFormValues = Omit<NewContributionLimit, "limitAmount"> & {
  limitAmount?: number;
};

interface ContributionLimitFormProps {
  defaultValues?: ContributionLimitFormValues;
  /** Accounts offered for the limit; only those that can hold contributions are listed. */
  accounts?: Account[];
  onSuccess?: () => void;
}

/** Local midnight on 1 January and 31 December, as the date picker gives for a picked day. */
function yearStartAndEnd(year: number) {
  return { startDate: new Date(year, 0, 1), endDate: new Date(year, 11, 31) };
}

/**
 * A saved date's day in `timezone`, as the date picker gives that day. A Date
 * (the add dialog's defaults) is already a picked day.
 */
function savedDateToPickerDay(saved: string | Date, timezone: string) {
  if (saved instanceof Date) return saved;
  const date = new Date(saved);
  // An unreadable date stays as it is for the form to reject.
  if (Number.isNaN(date.getTime())) return date;
  const { year, month, day } = getZonedDateParts(date, timezone);
  return new Date(year, month - 1, day);
}

/** Start of the picked day in `timezone`, moving forward if DST skips midnight. */
function pickerDayToSavedDate(picked: Date, timezone: string) {
  return new CalendarDate(picked.getFullYear(), picked.getMonth() + 1, picked.getDate())
    .toDate(timezone)
    .toISOString();
}

export function ContributionLimitForm({
  defaultValues,
  accounts = [],
  onSuccess = () => {},
}: ContributionLimitFormProps) {
  const { t } = useTranslation();
  const amountFormatting = useAmountFormatting();
  const eligibleAccounts = accounts.filter((account) =>
    accountSupportsPurpose(account, AccountPurpose.CONTRIBUTION_LIMITS),
  );
  const [accountSearch, setAccountSearch] = useState("");
  // Accounts ticked when the form opened come first; ticking more doesn't reorder the list.
  const [initiallySelected] = useState(() => new Set(parseAccountIds(defaultValues?.accountIds)));
  const orderedAccounts = [
    ...eligibleAccounts.filter((account) => initiallySelected.has(account.id)),
    ...eligibleAccounts.filter((account) => !initiallySelected.has(account.id)),
  ];
  const { addContributionLimitMutation, updateContributionLimitMutation } =
    useContributionLimitMutations();

  const schema = useMemo(() => createContributionLimitSchema(t), [t]);
  // Saved dates are days in the app's timezone, as deposits are counted; an
  // unset timezone uses UTC, matching the deposit service.
  const { settings } = useSettingsContext();
  const timezone = settings?.timezone?.trim() || "UTC";
  // Limits are set and counted in the base currency.
  const currency = settings?.baseCurrency ?? "USD";

  // A saved limit keeps each date it has; one without dates, or with the
  // former noon-UTC defaults that stand for its year, starts with its year's.
  const savedStart = defaultValues?.startDate;
  const savedEnd = defaultValues?.endDate;
  const savedYear = defaultValues?.contributionYear;
  const hasSavedDates =
    (savedStart || savedEnd) &&
    !(
      savedYear &&
      typeof savedStart === "string" &&
      typeof savedEnd === "string" &&
      hasFormerDefaultDates({
        contributionYear: savedYear,
        startDate: savedStart,
        endDate: savedEnd,
      })
    );
  const form = useForm<NewContributionLimit>({
    resolver: zodResolver(schema) as Resolver<NewContributionLimit>,
    defaultValues: {
      ...defaultValues,
      ...(hasSavedDates
        ? {
            startDate: savedStart ? savedDateToPickerDay(savedStart, timezone) : undefined,
            endDate: savedEnd ? savedDateToPickerDay(savedEnd, timezone) : undefined,
          }
        : savedYear
          ? yearStartAndEnd(savedYear)
          : {}),
    },
  });

  // Changing the year moves the dates to that year.
  const updateDatesBasedOnYear = (year: number | undefined) => {
    if (!year || isNaN(year)) return;
    const { startDate, endDate } = yearStartAndEnd(year);
    form.setValue("startDate", startDate);
    form.setValue("endDate", endDate);
  };

  async function onSubmit(data: NewContributionLimit) {
    const { id, ...rest } = data;

    // Save each picked day at its start in the app's timezone (RFC 3339).
    const formattedData = {
      ...rest,
      startDate:
        rest.startDate instanceof Date
          ? pickerDayToSavedDate(rest.startDate, timezone)
          : rest.startDate,
      endDate:
        rest.endDate instanceof Date ? pickerDayToSavedDate(rest.endDate, timezone) : rest.endDate,
    };

    // Finishes once the save itself ends rather than from a callback passed to
    // mutate(): React Query skips those while a phone screen is out of sight,
    // which left the form open, ready to add the limit a second time.
    try {
      if (id) {
        await updateContributionLimitMutation.mutateAsync({ id, updatedLimit: formattedData });
      } else {
        await addContributionLimitMutation.mutateAsync(formattedData);
      }
      onSuccess();
    } catch {
      // The mutation reports the error; the form stays open to try again.
    }
  }

  const isSaving =
    addContributionLimitMutation.isPending || updateContributionLimitMutation.isPending;
  const query = accountSearch.trim().toLocaleLowerCase();
  const visibleAccounts = orderedAccounts.filter(
    (account) => !query || account.name.toLocaleLowerCase().includes(query),
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="w-full space-y-6">
        <DialogHeader>
          {/* On phones the title is centered; equal side room keeps it clear of the close button. */}
          <DialogTitle className="text-xl font-semibold max-sm:px-10">
            {defaultValues?.id
              ? t("settings:limits_form_update_title")
              : t("settings:limits_form_add_title")}
          </DialogTitle>
          {!defaultValues?.id && (
            <DialogDescription>{t("settings:limits_form_add_description")}</DialogDescription>
          )}
        </DialogHeader>

        <input type="hidden" name="id" />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
          <FormField
            control={form.control}
            name="groupName"
            render={({ field }) => (
              <FormItem className="sm:col-span-3">
                <FormLabel>{t("settings:limits_form_group_name_label")}</FormLabel>
                <FormControl>
                  <Input
                    placeholder={t("settings:limits_form_group_name_placeholder")}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="limitAmount"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>{t("settings:limits_form_limit_amount_label")}</FormLabel>
                {/* Styled as the other fields: same fill, height, border, corners and focus ring. */}
                <InputGroup className="bg-input-bg h-input-height has-[input:focus-visible]:outline-ring rounded-(--control-radius) border-(color:--field-border) shadow-(--field-shadow) has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-solid">
                  <InputGroupAddon align="inline-start">
                    <InputGroupText>
                      {amountFormatting.formatCurrencySymbol(currency)}
                    </InputGroupText>
                  </InputGroupAddon>
                  <FormControl>
                    <MoneyInput
                      data-slot="input-group-control"
                      className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent ps-1 text-start shadow-none ring-0 focus-visible:outline-none"
                      placeholder={t("settings:limits_form_limit_amount_placeholder")}
                      thousandSeparator
                      {...field}
                    />
                  </FormControl>
                </InputGroup>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)]">
            <FormField
              control={form.control}
              name="contributionYear"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings:limits_form_year_label")}</FormLabel>
                  <FormControl>
                    <MoneyInput
                      className="text-start"
                      placeholder={t("settings:limits_form_year_placeholder")}
                      maxDecimalPlaces={0}
                      value={field.value}
                      onValueChange={(value, isUserEdit) => {
                        if (isUserEdit && value !== field.value) {
                          updateDatesBasedOnYear(value);
                        }
                        field.onChange(value);
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="startDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings:limits_form_start_date_label")}</FormLabel>
                  <FormControl>
                    <DatePickerInput
                      onChange={(date: Date | undefined) => field.onChange(date)}
                      value={field.value as Date | undefined}
                      disabled={field.disabled}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="endDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings:limits_form_end_date_label")}</FormLabel>
                  <FormControl>
                    <DatePickerInput
                      onChange={(date: Date | undefined) => field.onChange(date)}
                      value={field.value as Date | undefined}
                      disabled={field.disabled}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {t("settings:limits_form_date_description")}
          </p>
        </div>

        <FormField
          control={form.control}
          name="isRecurring"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <FormLabel>{t("settings:limits_form_recurring_label")}</FormLabel>
                <FormDescription className="text-xs">
                  {t("settings:limits_form_recurring_description")}
                </FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="accountIds"
          render={({ field }) => {
            // Ids the list doesn't show (an account no longer eligible) are kept.
            const selected = parseAccountIds(field.value);
            const selectedCount = eligibleAccounts.filter((account) =>
              selected.includes(account.id),
            ).length;
            const toggle = (accountId: string) =>
              field.onChange(
                (selected.includes(accountId)
                  ? selected.filter((id) => id !== accountId)
                  : [...selected, accountId]
                ).join(","),
              );
            return (
              <FormItem className="border-t pt-5">
                <div className="flex items-baseline justify-between gap-3">
                  <p id="contribution-limit-accounts-label" className="text-sm font-medium">
                    {t("settings:limits_form_accounts_label")}
                  </p>
                  {eligibleAccounts.length > 0 && (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {t("settings:limits_form_accounts_selected", {
                        selected: selectedCount,
                        total: eligibleAccounts.length,
                      })}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  {t("settings:limits_form_accounts_description")}
                </p>
                {eligibleAccounts.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t("settings:limits_form_accounts_empty")}
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-lg border">
                    {eligibleAccounts.length > ACCOUNT_SEARCH_THRESHOLD && (
                      <div className="relative border-b">
                        <Icons.Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" />
                        <input
                          type="search"
                          value={accountSearch}
                          onChange={(event) => setAccountSearch(event.target.value)}
                          // Enter filters, as typing does; it doesn't save the limit.
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.preventDefault();
                          }}
                          placeholder={t("settings:limits_form_accounts_search")}
                          aria-label={t("settings:limits_form_accounts_search")}
                          className="placeholder:text-muted-foreground focus-visible:outline-ring h-10 w-full bg-transparent ps-9 pe-3 text-sm outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid"
                        />
                      </div>
                    )}
                    <div
                      role="group"
                      aria-labelledby="contribution-limit-accounts-label"
                      className="grid max-h-56 grid-cols-1 overflow-y-auto p-1 sm:grid-cols-2"
                    >
                      {visibleAccounts.length === 0 ? (
                        <p className="text-muted-foreground col-span-full px-2.5 py-3 text-sm">
                          {t("settings:limits_form_accounts_no_match")}
                        </p>
                      ) : (
                        visibleAccounts.map((account) => (
                          <label
                            key={account.id}
                            className="hover:bg-muted/50 flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2"
                          >
                            <Checkbox
                              checked={selected.includes(account.id)}
                              onCheckedChange={() => toggle(account.id)}
                            />
                            <span className="min-w-0 truncate text-sm">
                              <bdi>{account.name}</bdi>
                            </span>
                            {!account.isActive && (
                              <Badge variant="warning-subtle" className="shrink-0">
                                {t("settings:accounts.badge_hidden")}
                              </Badge>
                            )}
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </FormItem>
            );
          }}
        />

        <DialogFooter>
          <DialogTrigger render={<Button variant="outline" type="button" />}>
            {t("common:cancel")}
          </DialogTrigger>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? (
              <>
                <Spinner className="me-2 h-4 w-4" />
                {defaultValues?.id
                  ? t("settings:limits_form_updating")
                  : t("settings:limits_form_saving")}
              </>
            ) : defaultValues?.id ? (
              t("settings:limits_form_update_button")
            ) : (
              t("common:save")
            )}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

/** Above this many accounts, the list gets a search field. */
const ACCOUNT_SEARCH_THRESHOLD = 8;
