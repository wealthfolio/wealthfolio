import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createActivity, updateActivity } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
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
  isCashActivityIncome,
  isSpendingAccountType,
} from "../lib/constants";
import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";

const formSchema = z.object({
  id: z.string().optional(),
  accountId: z.string().min(1, { message: "Please select an account." }),
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
  activityDate: z.date({ required_error: "Pick a date" }),
  amount: z.coerce.number().min(0.01, { message: "Amount must be greater than zero." }),
  notes: z.string().optional(),
  /** "<taxonomyId>:<categoryId>" or "" */
  category: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface CashActivityFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activity?: Activity & {
    categoryAssignmentId?: string;
    categoryTaxonomyId?: string;
    categoryId?: string;
  };
}

export function CashActivityForm({ open, onOpenChange, activity }: CashActivityFormProps) {
  const isEditing = !!activity?.id;
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

  const allCategoriesById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null; parentId: string | null }>();
    (spending.data?.categories ?? []).forEach((c) =>
      map.set(c.id, { name: c.name, color: c.color, parentId: c.parentId ?? null }),
    );
    (income.data?.categories ?? []).forEach((c) =>
      map.set(c.id, { name: c.name, color: c.color, parentId: c.parentId ?? null }),
    );
    return map;
  }, [spending.data?.categories, income.data?.categories]);

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
    }
  }, [open, activity, spendingAccounts, form]);

  const watchType = form.watch("activityType");
  const watchAccountId = form.watch("accountId");
  const selectedAccount = spendingAccounts.find((a) => a.id === watchAccountId);
  const activityTypeOptions = useMemo(() => {
    const options = getActivityTypesForAccount(selectedAccount?.accountType);
    const currentType = activity?.activityType as FormValues["activityType"] | undefined;
    return currentType && !options.includes(currentType) ? [...options, currentType] : options;
  }, [activity?.activityType, selectedAccount?.accountType]);
  const isIncomeType = isCashActivityIncome(
    watchType,
    selectedAccount?.accountType,
    activity?.subtype,
  );

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

      let saved: Activity;
      if (isEditing && activity?.id) {
        const update: ActivityUpdate = {
          id: activity.id,
          accountId: values.accountId,
          activityType: values.activityType,
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
      toast.success(isEditing ? "Activity updated." : "Activity created.");
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      toast.error(`Failed to save activity: ${(e as Error).message ?? e}`);
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEditing ? "Edit Transaction" : "Add Transaction"}</SheetTitle>
          <SheetDescription>
            {isEditing
              ? "Update an existing transaction."
              : "Add a new transaction on a tracked spending account."}
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => saveMutation.mutate(v))}
            className="mt-6 space-y-4 px-1"
          >
            <FormField
              control={form.control}
              name="accountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select an account" />
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

            <FormField
              control={form.control}
              name="activityType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {activityTypeOptions.map((t) => (
                        <SelectItem key={t} value={t}>
                          {getCashActivityLabel(t, selectedAccount?.accountType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="activityDate"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Date</FormLabel>
                  <DatePickerInput
                    value={field.value}
                    onChange={(d?: Date) => field.onChange(d)}
                    disabled={field.disabled}
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
                  <FormLabel>Amount</FormLabel>
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
                const currentCat = currentCatId ? allCategoriesById.get(currentCatId) : null;
                const currentParent = currentCat?.parentId
                  ? allCategoriesById.get(currentCat.parentId)
                  : null;
                return (
                  <FormItem>
                    <FormLabel>{isIncomeType ? "Income Source" : "Spending Category"}</FormLabel>
                    <QuickCategorizePopover
                      scope={isIncomeType ? "income" : "expense"}
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
                                ? `Change category (${currentCat.name})`
                                : "Pick a category"
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
                                Pick a category (optional)
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
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            <FormItem>
              <FormLabel>Event</FormLabel>
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
                        ? `Change event (${eventsById.get(eventId)?.name})`
                        : "Tag an event"
                    }
                  >
                    {(() => {
                      const ev = eventId ? eventsById.get(eventId) : null;
                      if (!ev) {
                        return (
                          <span className="text-muted-foreground">Tag an event (optional)</span>
                        );
                      }
                      const color =
                        eventTypeById.get(ev.eventTypeId)?.color ?? "var(--muted-foreground)";
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
                  <FormLabel>Notes / Payee</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="e.g., AMAZON*MARKETPLACE, STARBUCKS COFFEE"
                      className="resize-none"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <SheetFooter className="gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? (
                  <>
                    <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : isEditing ? (
                  "Update"
                ) : (
                  "Create"
                )}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
