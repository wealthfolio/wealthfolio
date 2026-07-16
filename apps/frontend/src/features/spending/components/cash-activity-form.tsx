import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createActivity, updateActivity } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type { Account, Activity, ActivityCreate, ActivityUpdate } from "@/lib/types";

import {
  Button,
  DatePickerInput,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Icons,
  MoneyInput,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Textarea,
} from "@wealthfolio/ui";

import {
  assignActivityCategory,
  setActivityEvent,
  unassignActivityCategory,
} from "../adapters/cash-activities";
import {
  getActivityTypesForAccount,
  getCashActivityLabel,
  isCreditCardAccountType,
  isCashActivityIncome,
  isSpendingAccountType,
} from "../lib/constants";
import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";
import type { CashFlowBucket } from "../types/cash-activity";
import { resolveCashActivitySubtype } from "../lib/cash-activity-form-utils";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

function buildFormSchema(t: TFunction) {
  return z.object({
    id: z.string().optional(),
    accountId: z.string().min(1, { message: t("spending:cashForm.accountRequired") }),
    activityType: z.enum([
      "DEPOSIT",
      "WITHDRAWAL",
      "TRANSFER_IN",
      "TRANSFER_OUT",
      "FEE",
      "TAX",
      "INTEREST",
      "CREDIT",
    ]),
    activityDate: z.date({ required_error: t("spending:cashForm.pickDate") }),
    amount: z.coerce.number().min(0.01, { message: t("spending:cashForm.amountPositive") }),
    notes: z.string().optional(),
    /** "<taxonomyId>:<categoryId>" or "" */
    category: z.string().optional(),
  });
}

interface FormValues {
  id?: string;
  accountId: string;
  activityType:
    | "DEPOSIT"
    | "WITHDRAWAL"
    | "TRANSFER_IN"
    | "TRANSFER_OUT"
    | "FEE"
    | "TAX"
    | "INTEREST"
    | "CREDIT";
  activityDate: Date;
  amount: number;
  notes?: string;
  category?: string;
}

function getMobileTypeIcon(type: FormValues["activityType"]) {
  switch (type) {
    case "DEPOSIT":
      return Icons.ArrowDown;
    case "WITHDRAWAL":
      return Icons.ArrowUp;
    case "INTEREST":
      return Icons.Percent;
    case "CREDIT":
      return Icons.RefreshCw;
    case "FEE":
      return Icons.DollarSign;
    case "TAX":
      return Icons.Receipt;
    case "TRANSFER_IN":
    case "TRANSFER_OUT":
      return Icons.ArrowLeftRight;
  }
}

function getMobileTypeDescription(type: FormValues["activityType"], t: TFunction) {
  switch (type) {
    case "DEPOSIT":
      return t("spending:cashForm.descDeposit");
    case "WITHDRAWAL":
      return t("spending:cashForm.descWithdrawal");
    case "INTEREST":
      return t("spending:cashForm.descInterest");
    case "CREDIT":
      return t("spending:cashForm.descCredit");
    case "FEE":
      return t("spending:cashForm.descFee");
    case "TAX":
      return t("spending:cashForm.descTax");
    case "TRANSFER_IN":
    case "TRANSFER_OUT":
      return t("spending:cashForm.descTransfer");
  }
}

interface CashActivityFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activity?: Activity & {
    cashFlowBucket?: CashFlowBucket;
    categoryAssignmentId?: string;
    categoryTaxonomyId?: string;
    categoryId?: string;
  };
  /** Called when user selects Transfer in creation mode; receives the selected spending account id */
  onTransferClick?: (accountId: string) => void;
}

export function CashActivityForm({
  open,
  onOpenChange,
  activity,
  onTransferClick,
}: CashActivityFormProps) {
  const { t } = useTranslation();
  const formSchema = useMemo(() => buildFormSchema(t), [t]);
  const isEditing = !!activity?.id;
  const isMobile = useIsMobileViewport();
  const [currentStep, setCurrentStep] = useState<1 | 2>(isEditing ? 2 : 1);
  const qc = useQueryClient();
  const { accounts } = useAccounts({ filterActive: false });
  const { settings } = useSpendingSettings();
  const trackedAccountIds = settings?.accountIds;
  const spendingAccounts = useMemo(() => {
    const tracked = new Set(trackedAccountIds ?? []);
    return (accounts ?? []).filter(
      (a: Account) =>
        isSpendingAccountType(a.accountType) &&
        (tracked.has(a.id) || a.id === activity?.accountId) &&
        (a.isActive || a.id === activity?.accountId),
    );
  }, [accounts, activity?.accountId, trackedAccountIds]);

  // Used only to look up the selected category's name/color for the trigger label.
  // QuickCategorizePopover loads its own data internally.
  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);

  const allCategoriesById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null; parentId: string | null }>();
    (spending.data?.categories ?? []).forEach((c) =>
      map.set(c.id, { name: c.name, color: c.color, parentId: c.parentId ?? null }),
    );
    (income.data?.categories ?? []).forEach((c) =>
      map.set(c.id, { name: c.name, color: c.color, parentId: c.parentId ?? null }),
    );
    (savings.data?.categories ?? []).forEach((c) =>
      map.set(c.id, { name: c.name, color: c.color, parentId: c.parentId ?? null }),
    );
    return map;
  }, [spending.data?.categories, income.data?.categories, savings.data?.categories]);

  // Event lookup for the trigger label. Errors surface only via the
  // QuickEventPopover the user opens to pick an event (handled there);
  // the label render gracefully falls back to "Tag event" when events
  // can't load, so no inline error is needed in the form chrome.
  const { data: events = [] } = useSpendingEvents();
  const { data: eventTypes = [] } = useEventTypes();
  const eventsById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const eventTypeById = useMemo(() => new Map(eventTypes.map((t) => [t.id, t])), [eventTypes]);

  // Event id stored separately (not part of the form schema since it's persisted
  // via setActivityEvent rather than the activity create/update payload).
  const [eventId, setEventId] = useState<string | null>(activity?.eventId ?? null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      accountId: activity?.accountId ?? "",
      activityType: (activity?.activityType as FormValues["activityType"]) ?? "WITHDRAWAL",
      activityDate: activity?.activityDate ? new Date(activity.activityDate) : new Date(),
      amount: activity?.amount ? Math.abs(parseFloat(activity.amount)) : 0,
      notes: activity?.notes ?? "",
      category:
        activity?.categoryTaxonomyId && activity?.categoryId
          ? `${activity.categoryTaxonomyId}:${activity.categoryId}`
          : "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        accountId: activity?.accountId ?? spendingAccounts[0]?.id ?? "",
        activityType: (activity?.activityType as FormValues["activityType"]) ?? "WITHDRAWAL",
        activityDate: activity?.activityDate ? new Date(activity.activityDate) : new Date(),
        amount: activity?.amount ? Math.abs(parseFloat(activity.amount)) : 0,
        notes: activity?.notes ?? "",
        category:
          activity?.categoryTaxonomyId && activity?.categoryId
            ? `${activity.categoryTaxonomyId}:${activity.categoryId}`
            : "",
      });
      setEventId(activity?.eventId ?? null);
      setCurrentStep(activity?.id ? 2 : 1);
    }
  }, [open, activity, spendingAccounts, form]);

  const watchType = form.watch("activityType");
  const watchAccountId = form.watch("accountId");
  const selectedAccount = spendingAccounts.find((a) => a.id === watchAccountId);
  const isCreditCardAccount = isCreditCardAccountType(selectedAccount?.accountType);
  const transferActionLabel = isCreditCardAccount
    ? t("spending:cashForm.recordPayment")
    : t("spending:cashForm.transferBetween");
  const activityTypeOptions = useMemo(() => {
    const options = getActivityTypesForAccount(selectedAccount?.accountType);
    const currentType = activity?.activityType as FormValues["activityType"] | undefined;
    const all = currentType && !options.includes(currentType) ? [...options, currentType] : options;
    // In creation mode, hide TRANSFER_IN/OUT — user opens the full transfer form via button
    if (!isEditing) return all.filter((t) => t !== "TRANSFER_IN" && t !== "TRANSFER_OUT");
    return all;
  }, [activity?.activityType, isEditing, selectedAccount?.accountType]);
  const mobileTypeOptions = useMemo(
    () =>
      activityTypeOptions.map((type) => ({
        type,
        label: getCashActivityLabel(
          type,
          selectedAccount?.accountType,
          type === "CREDIT" && !isCreditCardAccountType(selectedAccount?.accountType)
            ? "REIMBURSEMENT"
            : undefined,
        ),
        description: getMobileTypeDescription(type, t),
        Icon: getMobileTypeIcon(type),
      })),
    [activityTypeOptions, selectedAccount?.accountType, t],
  );
  const isIncomeType = isCashActivityIncome(
    watchType,
    selectedAccount?.accountType,
    activity?.subtype,
  );
  const cashFlowBucket = activity?.cashFlowBucket;
  const isNeutralBucket = cashFlowBucket === "neutral";
  const categoryScope =
    cashFlowBucket === "saving" ? "saving" : isIncomeType ? "income" : "expense";
  const categoryLabel =
    cashFlowBucket === "saving"
      ? t("spending:cashForm.savingsCategory")
      : isIncomeType
        ? t("spending:cashForm.incomeSource")
        : t("spending:cashForm.spendingCategory");

  useEffect(() => {
    if (!selectedAccount) return;
    if (!activityTypeOptions.includes(watchType)) {
      form.setValue("activityType", activityTypeOptions[0]);
    }
  }, [activityTypeOptions, form, selectedAccount, watchType]);

  const saveMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const dateStr = values.activityDate.toISOString();
      const account = spendingAccounts.find((a) => a.id === values.accountId);
      const currency = account?.currency ?? "USD";
      const subtype = resolveCashActivitySubtype({
        activityType: values.activityType,
        accountType: account?.accountType,
        existingActivityType: activity?.activityType,
        existingSubtype: activity?.subtype,
      });

      let saved: Activity;
      if (isEditing && activity?.id) {
        const update: ActivityUpdate = {
          id: activity.id,
          accountId: values.accountId,
          activityType: values.activityType,
          subtype,
          activityDate: dateStr,
          amount: values.amount,
          currency,
          comment: values.notes ?? null,
        };
        saved = await updateActivity(update);
      } else {
        const create: ActivityCreate = {
          accountId: values.accountId,
          activityType: values.activityType,
          subtype,
          activityDate: dateStr,
          amount: values.amount,
          currency,
          comment: values.notes ?? null,
        };
        saved = await createActivity(create);
      }

      // Sync category assignment
      const newCategory = values.category;
      const oldCategory =
        activity?.categoryTaxonomyId && activity?.categoryId
          ? `${activity.categoryTaxonomyId}:${activity.categoryId}`
          : "";
      if (newCategory !== oldCategory) {
        if (oldCategory) {
          const [oldTax] = oldCategory.split(":");
          await unassignActivityCategory(saved.id, oldTax);
        }
        if (newCategory) {
          const [tax, cat] = newCategory.split(":");
          await assignActivityCategory(saved.id, tax, cat);
        }
      }

      // Sync event_id if changed
      const oldEventId = activity?.eventId ?? null;
      if (eventId !== oldEventId) {
        await setActivityEvent(saved.id, eventId);
      }

      return saved;
    },
    onSuccess: () => {
      invalidateSpendingCaches(qc);
      qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
      qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
      toast.success(
        isEditing ? t("spending:cashForm.activityUpdated") : t("spending:cashForm.activityCreated"),
      );
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      toast.error(t("spending:cashForm.saveFailed", { message: (e as Error).message ?? e }));
    },
  });

  const isMobileCreate = isMobile && !isEditing;
  const showChoiceFields = !isMobileCreate || currentStep === 1;
  const showDetailsFields = !isMobileCreate || currentStep === 2;

  const handleMobileNext = async () => {
    const isValid = await form.trigger(["accountId", "activityType"]);
    if (isValid) setCurrentStep(2);
  };

  const handleTransferAction = async () => {
    if (!onTransferClick) return;
    const isValid = await form.trigger("accountId");
    if (!isValid || !watchAccountId) return;
    onOpenChange(false);
    onTransferClick(watchAccountId);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          isMobile
            ? "rounded-t-4xl mx-1 flex h-[90vh] flex-col p-0"
            : "flex w-full flex-col overflow-hidden sm:max-w-md",
        )}
      >
        <SheetHeader className={cn(isMobile && "border-b px-6 py-4 text-center")}>
          <div className={cn(isMobile && "flex flex-col items-center space-y-2")}>
            <SheetTitle>
              {isEditing ? t("spending:cashForm.editTitle") : t("spending:cashForm.addTitle")}
            </SheetTitle>
            {isMobileCreate && (
              <div className="flex gap-1.5">
                {[1, 2].map((step) => (
                  <div
                    key={step}
                    className={cn(
                      "h-1.5 w-10 rounded-full transition-colors",
                      step === currentStep
                        ? "bg-primary"
                        : step < currentStep
                          ? "bg-primary/50"
                          : "bg-muted",
                    )}
                  />
                ))}
              </div>
            )}
            {!isMobileCreate && (
              <SheetDescription>
                {isEditing
                  ? t("spending:cashForm.editDescription")
                  : t("spending:cashForm.addDescription")}
              </SheetDescription>
            )}
          </div>
        </SheetHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))}
            className={cn(
              isMobile
                ? "flex min-h-0 flex-1 flex-col"
                : "mt-6 min-h-0 flex-1 overflow-y-auto px-1 pb-1",
            )}
          >
            <div className={cn(isMobile && "flex-1 overflow-y-auto")}>
              <div className={cn("space-y-4", isMobile && "p-4")}>
                {showChoiceFields && (
                  <>
                    <FormField
                      control={form.control}
                      name="accountId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("common:account")}</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder={t("spending:cashForm.selectAccount")} />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {spendingAccounts.map((acc) => (
                                <SelectItem key={acc.id} value={acc.id}>
                                  {acc.name} ({acc.currency})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {isMobileCreate ? (
                      <FormField
                        control={form.control}
                        name="activityType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-lg font-semibold">
                              {t("spending:cashForm.selectType")}
                            </FormLabel>
                            <FormControl>
                              <RadioGroup onValueChange={field.onChange} value={field.value}>
                                <div className="space-y-2">
                                  {mobileTypeOptions.map(({ type, label, description, Icon }) => (
                                    <div key={type}>
                                      <RadioGroupItem
                                        value={type}
                                        id={`spending-mobile-type-${type}`}
                                        className="peer sr-only"
                                      />
                                      <label
                                        htmlFor={`spending-mobile-type-${type}`}
                                        className={cn(
                                          "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-all",
                                          "hover:bg-muted/50",
                                          "peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/5",
                                          "active:scale-[0.98]",
                                        )}
                                      >
                                        <div className="mt-0.5 flex-shrink-0">
                                          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full transition-colors">
                                            <Icon className="text-muted-foreground h-5 w-5" />
                                          </div>
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <div className="text-foreground font-medium">{label}</div>
                                          <div className="text-muted-foreground mt-1 text-sm">
                                            {description}
                                          </div>
                                        </div>
                                      </label>
                                    </div>
                                  ))}
                                </div>
                              </RadioGroup>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    ) : (
                      <>
                        <FormField
                          control={form.control}
                          name="activityType"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t("common:type")}</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {activityTypeOptions.map((t) => (
                                    <SelectItem key={t} value={t}>
                                      {getCashActivityLabel(
                                        t,
                                        selectedAccount?.accountType,
                                        t === "CREDIT" &&
                                          !isCreditCardAccountType(selectedAccount?.accountType)
                                          ? "REIMBURSEMENT"
                                          : undefined,
                                      )}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        {/* Transfer button — creation only, redirects to the full transfer form */}
                        {!isEditing && onTransferClick && (
                          <FormItem>
                            <FormLabel>
                              {isCreditCardAccount
                                ? t("spending:cashForm.payment")
                                : t("spending:cashForm.transfer")}
                            </FormLabel>
                            <Button
                              type="button"
                              variant="outline"
                              className="w-full justify-start gap-2"
                              disabled={!watchAccountId}
                              onClick={handleTransferAction}
                            >
                              <Icons.ArrowLeftRight className="h-4 w-4" />
                              {transferActionLabel}
                            </Button>
                          </FormItem>
                        )}
                      </>
                    )}

                    {isMobileCreate && onTransferClick && (
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-all",
                          "hover:bg-muted/50 active:scale-[0.98]",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                        disabled={!watchAccountId}
                        onClick={handleTransferAction}
                      >
                        <div className="mt-0.5 flex-shrink-0">
                          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full transition-colors">
                            <Icons.ArrowLeftRight className="text-muted-foreground h-5 w-5" />
                          </div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground font-medium">{transferActionLabel}</div>
                          <div className="text-muted-foreground mt-1 text-sm">
                            {isCreditCardAccount
                              ? t("spending:cashForm.payCardDesc")
                              : t("spending:cashForm.descTransfer")}
                          </div>
                        </div>
                      </button>
                    )}
                  </>
                )}

                {showDetailsFields && (
                  <>
                    <FormField
                      control={form.control}
                      name="activityDate"
                      render={({ field }) => (
                        <FormItem className="flex flex-col">
                          <FormLabel>{t("common:date")}</FormLabel>
                          <DatePickerInput
                            value={field.value}
                            onChange={(d?: Date) => field.onChange(d)}
                            disabled={field.disabled}
                            enableTime
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="amount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("common:amount")}</FormLabel>
                          <FormControl>
                            <MoneyInput
                              value={field.value}
                              onValueChange={(v: number | undefined) => field.onChange(v ?? 0)}
                              placeholder="0.00"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="category"
                      render={({ field }) => {
                        const [, currentCatId] = field.value?.split(":") ?? [];
                        const currentCat = currentCatId
                          ? allCategoriesById.get(currentCatId)
                          : null;
                        const currentParent = currentCat?.parentId
                          ? allCategoriesById.get(currentCat.parentId)
                          : null;
                        return (
                          <FormItem>
                            <FormLabel>
                              {isNeutralBucket ? t("spending:filters.category") : categoryLabel}
                            </FormLabel>
                            {isNeutralBucket ? (
                              <div className="border-input bg-muted/40 text-muted-foreground h-input-height flex items-center rounded-md border px-3 py-2 text-sm">
                                {t("spending:cashForm.neutralTransfer")}
                              </div>
                            ) : (
                              <QuickCategorizePopover
                                scope={categoryScope}
                                selectedCategoryId={currentCatId ?? null}
                                onSelect={(tax, catId) => field.onChange(`${tax}:${catId}`)}
                                onClear={() => field.onChange("")}
                                trigger={
                                  <FormControl>
                                    <button
                                      type="button"
                                      className="border-input bg-input-bg dark:bg-input/30 hover:bg-accent/30 ring-offset-background focus:ring-ring h-input-height flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2"
                                      aria-label={
                                        currentCat
                                          ? t("spending:transactions.changeCategory", {
                                              name: currentCat.name,
                                            })
                                          : t("spending:cashForm.pickCategory")
                                      }
                                    >
                                      {currentCat ? (
                                        <span className="flex min-w-0 items-center gap-2">
                                          {currentCat.color && (
                                            <span
                                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                                              style={{ backgroundColor: currentCat.color }}
                                              aria-hidden="true"
                                            />
                                          )}
                                          <span className="truncate">
                                            {currentParent ? `${currentParent.name} / ` : ""}
                                            {currentCat.name}
                                          </span>
                                        </span>
                                      ) : (
                                        <span className="text-muted-foreground">
                                          {t("spending:cashForm.pickCategoryOptional")}
                                        </span>
                                      )}
                                      <Icons.ChevronDown
                                        className="ml-2 h-4 w-4 shrink-0 opacity-50"
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </FormControl>
                                }
                              />
                            )}
                            <FormMessage />
                          </FormItem>
                        );
                      }}
                    />

                    <FormItem>
                      <FormLabel>{t("spending:filters.event")}</FormLabel>
                      <QuickEventPopover
                        selectedEventId={eventId}
                        onSelect={setEventId}
                        onClear={() => setEventId(null)}
                        defaultDate={form.watch("activityDate") ?? undefined}
                        trigger={
                          <button
                            type="button"
                            className="border-input bg-input-bg dark:bg-input/30 hover:bg-accent/30 ring-offset-background focus:ring-ring h-input-height flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2"
                            aria-label={
                              eventId && eventsById.get(eventId)
                                ? t("spending:transactions.changeEvent", {
                                    name: eventsById.get(eventId)?.name,
                                  })
                                : t("spending:cashForm.tagAnEvent")
                            }
                          >
                            {(() => {
                              const ev = eventId ? eventsById.get(eventId) : null;
                              if (!ev) {
                                return (
                                  <span className="text-muted-foreground">
                                    {t("spending:cashForm.tagEventOptional")}
                                  </span>
                                );
                              }
                              const color =
                                eventTypeById.get(ev.eventTypeId)?.color ??
                                "var(--muted-foreground)";
                              return (
                                <span className="flex min-w-0 items-center gap-2">
                                  <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: color }}
                                    aria-hidden="true"
                                  />
                                  <span className="truncate">{ev.name}</span>
                                </span>
                              );
                            })()}
                            <Icons.ChevronDown
                              className="ml-2 h-4 w-4 shrink-0 opacity-50"
                              aria-hidden="true"
                            />
                          </button>
                        }
                      />
                    </FormItem>

                    <FormField
                      control={form.control}
                      name="notes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t("spending:cashForm.notesPayee")}</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder={t("spending:cashForm.notesPlaceholder")}
                              className="resize-none"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}
              </div>
            </div>

            {isMobile ? (
              <SheetFooter className="mt-auto border-t px-6 py-4 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
                <div className="flex w-full gap-3">
                  {currentStep > 1 && !isEditing && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setCurrentStep(1)}
                      className="flex-1"
                      disabled={saveMutation.isPending}
                    >
                      <Icons.ArrowLeft className="mr-2 h-4 w-4" />
                      {t("common:back")}
                    </Button>
                  )}

                  {currentStep < 2 && !isEditing ? (
                    <Button
                      type="button"
                      onClick={handleMobileNext}
                      className="flex-1 font-medium"
                      disabled={!watchAccountId}
                    >
                      {t("common:next")}
                      <Icons.ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      className="flex-1 font-medium"
                      disabled={saveMutation.isPending}
                    >
                      {saveMutation.isPending ? (
                        <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Icons.Check className="mr-2 h-4 w-4" />
                      )}
                      {isEditing
                        ? t("spending:cashForm.updateTransaction")
                        : t("spending:cashForm.createTransaction")}
                    </Button>
                  )}
                </div>
              </SheetFooter>
            ) : (
              <SheetFooter className="gap-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={saveMutation.isPending}
                >
                  {t("common:cancel")}
                </Button>
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? (
                    <>
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      {t("spending:common.saving")}
                    </>
                  ) : isEditing ? (
                    t("spending:common.update")
                  ) : (
                    t("spending:common.create")
                  )}
                </Button>
              </SheetFooter>
            )}
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
