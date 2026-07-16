import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Switch } from "@wealthfolio/ui/components/ui/switch";

import { newAccountSchema } from "@/lib/schemas";
import { AccountType } from "@/lib/constants";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { cn } from "@/lib/utils";
import {
  CurrencyInput,
  RadioGroup,
  RadioGroupItem,
  ResponsiveSelect,
  ToggleGroup,
  ToggleGroupItem,
  type ResponsiveSelectOption,
} from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";

import { useAccountMutations } from "./use-account-mutations";

const CASH_ALLOCATION_DEFAULT_VALUE = "__default__";
const CASH_FIXED_INCOME_CATEGORY_ID = "FIXED_INCOME";

function getCashCategoryFromMeta(meta?: string | null): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    const allocation = parsed.allocation as Record<string, unknown> | undefined;
    return (allocation?.cashCategoryId as string) ?? null;
  } catch {
    return null;
  }
}

function setCashCategoryInMeta(meta: string | null | undefined, categoryId: string | null): string {
  let parsed: Record<string, unknown> = {};
  if (meta) {
    try {
      parsed = JSON.parse(meta) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  if (categoryId) {
    parsed.allocation = { cashCategoryId: categoryId };
  } else {
    delete parsed.allocation;
  }
  return JSON.stringify(parsed);
}

function getSelectableCashCategoryFromMeta(meta?: string | null): string {
  const categoryId = getCashCategoryFromMeta(meta);
  return categoryId === CASH_FIXED_INCOME_CATEGORY_ID
    ? CASH_FIXED_INCOME_CATEGORY_ID
    : CASH_ALLOCATION_DEFAULT_VALUE;
}

const accountTypeIcons = {
  [AccountType.SECURITIES]: Icons.Briefcase,
  [AccountType.CASH]: Icons.DollarSign,
  [AccountType.CREDIT_CARD]: Icons.CreditCard,
  [AccountType.CRYPTOCURRENCY]: Icons.Bitcoin,
} as const;

const formCardClassName =
  "rounded-xl border border-border bg-background p-4 sm:p-5 dark:border-border/70 dark:bg-muted/20";
const formSectionLabelClassName =
  "text-muted-foreground text-xs font-semibold uppercase tracking-[0.18em]";
const trackingOptionClassName =
  "hover:bg-accent/50 relative flex cursor-pointer gap-3 rounded-xl border bg-card p-4 transition-colors dark:bg-muted/20 dark:hover:bg-muted/30";
const cashClassificationItemClassName =
  "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground h-9 rounded-md text-sm data-[state=on]:shadow-sm dark:data-[state=on]:bg-secondary dark:data-[state=on]:text-foreground";

// Input type (what the form receives)
type AccountFormInput = z.input<typeof newAccountSchema>;
// Output type after zod parsing (with defaults applied)
type AccountFormOutput = z.output<typeof newAccountSchema>;

interface AccountFormlProps {
  defaultValues?: AccountFormInput;
  onSuccess?: () => void;
}

export function AccountForm({ defaultValues, onSuccess = () => undefined }: AccountFormlProps) {
  const { t } = useTranslation();
  const { createAccountMutation, updateAccountMutation } = useAccountMutations({ onSuccess });

  const accountTypes: ResponsiveSelectOption[] = useMemo(
    () => [
      { label: t("settings:accounts_form_type_securities"), value: "SECURITIES" },
      { label: t("settings:accounts_form_type_cash"), value: "CASH" },
      { label: t("settings:accounts_form_type_credit_card"), value: "CREDIT_CARD" },
      { label: t("settings:accounts_form_type_crypto"), value: "CRYPTOCURRENCY" },
    ],
    [t],
  );

  // Track initial tracking mode to detect changes
  const initialTrackingMode = defaultValues?.trackingMode;
  const needsSetup = initialTrackingMode === "NOT_SET" || initialTrackingMode === undefined;

  // State for mode switch confirmation dialog
  const [showModeConfirmation, setShowModeConfirmation] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<AccountFormOutput | null>(null);

  const form = useForm<AccountFormInput, unknown, AccountFormOutput>({
    resolver: zodResolver(newAccountSchema),
    defaultValues: {
      ...defaultValues,
      // Don't default to any mode if account needs setup (must come after spread)
      trackingMode: needsSetup ? undefined : defaultValues?.trackingMode,
    },
  });

  const currentTrackingMode = form.watch("trackingMode");
  const currentAccountType = form.watch("accountType");
  const isCreditCardAccount = currentAccountType === AccountType.CREDIT_CARD;
  const isCashAccount = currentAccountType === AccountType.CASH;

  const { data: assetClassesTaxonomy } = useTaxonomy(isCashAccount ? "asset_classes" : null);
  const fixedIncomeCategoryName = useMemo(() => {
    return (
      assetClassesTaxonomy?.categories.find(
        (c) => !c.parentId && c.id === CASH_FIXED_INCOME_CATEGORY_ID,
      )?.name ?? t("settings:accounts.form_cash_classification_fixed_income")
    );
  }, [assetClassesTaxonomy, t]);

  useEffect(() => {
    if (isCreditCardAccount && currentTrackingMode !== "TRANSACTIONS") {
      form.setValue("trackingMode", "TRANSACTIONS", { shouldDirty: true, shouldValidate: true });
    }
  }, [currentTrackingMode, form, isCreditCardAccount]);

  // Perform the actual submit (after confirmation if needed)
  // Returns a promise when updating so it can be chained with other operations
  const doSubmit = useCallback(
    (data: AccountFormOutput, options?: { async?: boolean }) => {
      const { id, trackingMode, ...rest } = data;

      if (id) {
        if (options?.async) {
          return updateAccountMutation.mutateAsync({
            id,
            trackingMode,
            ...rest,
          });
        }
        return updateAccountMutation.mutate({ id, trackingMode, ...rest });
      }
      return createAccountMutation.mutate({ trackingMode, ...rest });
    },
    [createAccountMutation, updateAccountMutation],
  );

  function onSubmit(data: AccountFormOutput) {
    // Check if this is an existing account (update) and mode is switching from HOLDINGS to TRANSACTIONS
    const isExistingAccount = !!data.id;
    const isSwitchingFromHoldingsToTransactions =
      !needsSetup && initialTrackingMode === "HOLDINGS" && data.trackingMode === "TRANSACTIONS";

    if (isExistingAccount && isSwitchingFromHoldingsToTransactions) {
      // Show confirmation dialog
      setPendingFormData(data);
      setShowModeConfirmation(true);
      return;
    }

    // Otherwise, submit directly
    doSubmit(data);
  }

  // Handle confirmation dialog actions
  const handleConfirmModeSwitch = async () => {
    setShowModeConfirmation(false);
    if (pendingFormData?.id) {
      try {
        // Save all account details including tracking mode
        await doSubmit(pendingFormData, { async: true });
      } finally {
        setPendingFormData(null);
      }
    }
  };

  const handleCancelModeSwitch = () => {
    setShowModeConfirmation(false);
    setPendingFormData(null);
    // Revert the tracking mode in the form
    form.setValue("trackingMode", initialTrackingMode);
  };

  const formTitle = defaultValues?.id
    ? t("settings:accounts_form_update_title")
    : t("settings:accounts_form_add_title");
  const formDescription = defaultValues?.id
    ? t("settings:accounts_form_update_description")
    : t("settings:accounts_form_add_description");
  const AccountTypeIcon = accountTypeIcons[currentAccountType] ?? Icons.Wallet;

  return (
    <Form {...form}>
      <form
        data-testid="account-form"
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-6 p-5 sm:p-6"
      >
        <DialogHeader className="pr-10 text-left">
          <div className="flex items-start gap-3">
            <div className="bg-muted flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
              <AccountTypeIcon className="text-muted-foreground h-5 w-5" />
            </div>
            <div className="min-w-0 space-y-1">
              <DialogTitle>{formTitle}</DialogTitle>
              <DialogDescription>{formDescription}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
          <input type="hidden" name="id" />
          <section className={formCardClassName}>
            <h3 className={formSectionLabelClassName}>{t("settings:accounts.form_identity")}</h3>
            <div className="mt-4 grid gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings:accounts_form_name_label")}</FormLabel>
                    <FormControl>
                      <Input
                        data-testid="account-name-input"
                        placeholder={t("settings:accounts_form_name_placeholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="group"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("settings:accounts_form_group_label")}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t("settings:accounts_form_group_placeholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{t("settings:accounts_form_type_label")}</FormLabel>
                    <FormControl>
                      <ResponsiveSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        options={accountTypes}
                        placeholder={t("settings:accounts_form_type_placeholder")}
                        sheetTitle={t("settings:accounts_form_type_sheet_title")}
                        sheetDescription={t("settings:accounts_form_type_sheet_description")}
                        triggerClassName="h-11"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {!defaultValues?.id ? (
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>{t("settings:accounts_form_currency_label")}</FormLabel>
                      <FormControl>
                        <CurrencyInput
                          data-testid="account-currency-select"
                          value={field.value}
                          onChange={(value: string) => field.onChange(value)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}

              {isCashAccount && (
                <div className="flex flex-col gap-2">
                  <div>
                    <label className="text-sm font-medium">
                      {t("settings:accounts.form_cash_classification_label")}
                    </label>
                    <p className="text-muted-foreground text-xs">
                      {t("settings:accounts.form_cash_classification_description")}
                    </p>
                  </div>
                  <ToggleGroup
                    type="single"
                    aria-label={t("settings:accounts.form_cash_classification_aria")}
                    value={getSelectableCashCategoryFromMeta(form.watch("meta"))}
                    onValueChange={(v) => {
                      if (!v) return;
                      const categoryId = v === CASH_ALLOCATION_DEFAULT_VALUE ? null : v;
                      const updatedMeta = setCashCategoryInMeta(form.getValues("meta"), categoryId);
                      form.setValue("meta", updatedMeta, { shouldDirty: true });
                    }}
                    className="bg-muted grid h-11 grid-cols-2 rounded-lg p-1"
                  >
                    <ToggleGroupItem
                      value={CASH_ALLOCATION_DEFAULT_VALUE}
                      className={cashClassificationItemClassName}
                    >
                      {t("settings:accounts.form_cash_classification_cash")}
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value={CASH_FIXED_INCOME_CATEGORY_ID}
                      className={cashClassificationItemClassName}
                    >
                      {fixedIncomeCategoryName}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              )}
            </div>
          </section>

          <div className="grid content-start gap-4">
            <FormField
              control={form.control}
              name="trackingMode"
              render={({ field }) => (
                <FormItem className={cn(formCardClassName, "space-y-4")}>
                  <FormLabel className={formSectionLabelClassName}>
                    {t("settings:accounts.form_tracking_mode_label")}
                  </FormLabel>
                  {needsSetup && !currentTrackingMode && (
                    <Alert
                      variant="warning"
                      className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
                    >
                      <Icons.AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        {t("settings:accounts.form_tracking_setup_hint")}{" "}
                        <a
                          href="https://wealthfolio.app/docs/concepts/activity-types"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-foreground underline"
                        >
                          {t("settings:accounts.form_learn_more")}
                        </a>
                      </AlertDescription>
                    </Alert>
                  )}
                  <FormControl>
                    <RadioGroup
                      onValueChange={field.onChange}
                      value={field.value}
                      className="grid gap-3"
                    >
                      <label
                        data-testid="tracking-mode-transactions"
                        className={cn(
                          trackingOptionClassName,
                          field.value === "TRANSACTIONS"
                            ? "border-primary bg-primary/5 dark:border-foreground/60 dark:bg-secondary/30"
                            : "border-border",
                        )}
                      >
                        <RadioGroupItem value="TRANSACTIONS" className="mt-0.5" />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">
                            {t("settings:accounts.form_tracking_transactions_title")}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {t("settings:accounts.form_tracking_transactions_description")}
                          </span>
                        </div>
                      </label>
                      {!isCreditCardAccount && (
                        <label
                          data-testid="tracking-mode-holdings"
                          className={cn(
                            trackingOptionClassName,
                            field.value === "HOLDINGS"
                              ? "border-primary bg-primary/5 dark:border-foreground/60 dark:bg-secondary/30"
                              : "border-border",
                          )}
                        >
                          <RadioGroupItem value="HOLDINGS" className="mt-0.5" />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {t("settings:accounts.form_tracking_holdings_title")}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {t("settings:accounts.form_tracking_holdings_description")}
                            </span>
                          </div>
                        </label>
                      )}
                    </RadioGroup>
                  </FormControl>
                  {field.value === "HOLDINGS" && (
                    <Alert
                      variant="warning"
                      className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
                    >
                      <Icons.AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        {t("settings:accounts.form_tracking_holdings_warning")}{" "}
                        <a
                          href="https://wealthfolio.app/docs/concepts/activity-types"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-foreground underline"
                        >
                          {t("settings:accounts.form_learn_more")}
                        </a>
                      </AlertDescription>
                    </Alert>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <section className={formCardClassName}>
              <h3 className={formSectionLabelClassName}>
                {t("settings:accounts.form_visibility")}
              </h3>
              <div className="mt-4 grid gap-4">
                <FormField
                  control={form.control}
                  name="isActive"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-4 space-y-0">
                      <div className="min-w-0">
                        <FormLabel className="text-sm font-normal">
                          {t("settings:accounts.form_hide_label")}
                          <span className="text-muted-foreground ml-1 text-xs font-normal">
                            {t("settings:accounts.form_hide_hint")}
                          </span>
                        </FormLabel>
                        <FormMessage />
                      </div>
                      <FormControl>
                        <Switch
                          checked={!field.value}
                          onCheckedChange={(checked) => field.onChange(!checked)}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {defaultValues?.id && (
                  <FormField
                    control={form.control}
                    name="isArchived"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between gap-4 space-y-0">
                        <div className="min-w-0">
                          <FormLabel className="text-sm font-normal">
                            {t("settings:accounts.form_archive_label")}
                            <span className="text-muted-foreground ml-1 text-xs font-normal">
                              {t("settings:accounts.form_archive_hint")}
                            </span>
                          </FormLabel>
                          <FormMessage />
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                )}
              </div>
            </section>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button data-testid="account-cancel-button" type="button" variant="outline">
              {t("settings:accounts_cancel_button")}
            </Button>
          </DialogClose>
          <Button
            data-testid="account-submit-button"
            type="submit"
            disabled={needsSetup && !currentTrackingMode}
          >
            {defaultValues?.id ? (
              <Icons.Save className="h-4 w-4" />
            ) : (
              <Icons.Plus className="h-4 w-4" />
            )}
            <span>
              {defaultValues?.id
                ? t("settings:accounts_form_update_title")
                : t("settings:accounts_form_add_title")}
            </span>
          </Button>
        </DialogFooter>
      </form>

      {/* Mode Switch Confirmation Dialog */}
      <AlertDialog open={showModeConfirmation} onOpenChange={setShowModeConfirmation}>
        <AlertDialogContent className="max-w-105 gap-0 overflow-hidden p-0">
          <div className="px-5 pb-4 pt-5">
            <AlertDialogHeader className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100/30 dark:bg-orange-100/20">
                  <Icons.ArrowRightLeft className="h-4 w-4 text-orange-500 dark:text-orange-300" />
                </div>
                <AlertDialogTitle className="text-base font-semibold">
                  {t("settings:accounts.mode_switch_title")}
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription>
                {t("settings:accounts.mode_switch_description")}
              </AlertDialogDescription>
            </AlertDialogHeader>

            {/* Checklist */}
            <div className="mt-4 rounded-lg border border-orange-100/40 bg-orange-100/30 p-3 dark:border-orange-100/20 dark:bg-orange-100/20">
              <p className="mb-2 text-xs font-medium text-orange-600 dark:text-orange-200">
                {t("settings:accounts.mode_switch_checklist_title")}
              </p>
              <ul className="space-y-2 text-[13px]">
                <li className="flex items-start gap-2">
                  <Icons.Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    {t("settings:accounts.mode_switch_checklist_recorded")}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Icons.Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    {t("settings:accounts.mode_switch_checklist_accurate")}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    {t("settings:accounts.mode_switch_checklist_gaps")}
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <AlertDialogFooter className="bg-muted/30 border-t px-5 py-3">
            <AlertDialogCancel onClick={handleCancelModeSwitch}>
              {t("settings:accounts.mode_switch_keep_holdings")}
            </AlertDialogCancel>
            <Button onClick={handleConfirmModeSwitch}>
              {t("settings:accounts.mode_switch_confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  );
}
