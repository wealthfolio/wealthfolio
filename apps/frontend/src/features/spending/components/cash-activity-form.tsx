import { getCategoryLabel } from "@/lib/taxonomy-labels";

import { isActivityEditCancelled, useActivitySplitReview } from "./activity-split-review-provider";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useEffectOnChange } from "@/hooks/use-effect-on-change";
import { createActivity, findTransferMatchCandidates, updateActivity } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport, usePlatform } from "@/hooks/use-platform";
import { accountPickerItems } from "@/components/account-picker-items";
import { DiscardChangesDialog } from "@/components/discard-changes-dialog";
import { TypeChoice } from "@/components/type-choice";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type {
  Account,
  Activity,
  ActivityCreate,
  ActivityUpdate,
  TaxonomyCategory,
} from "@/lib/types";
import { getEffectiveType } from "@/lib/types";
import { invalidTypeError, requiredError } from "@/lib/zod-errors";

import {
  Alert,
  AlertDescription,
  Button,
  DatePickerInput,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRowGroup,
  FormRowLabel,
  FormRowValue,
  formRowClassName,
  formRowValueClassName,
  Icons,
  MoneyInput,
  RadioGroup,
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
  SheetScreen,
  SheetTitle,
  Textarea,
  Spinner,
  useAmountFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";

import {
  assignActivityCategory,
  setActivityEvent,
  unassignActivityCategory,
} from "../adapters/cash-activities";
import { useActivityPayee } from "../hooks/use-activity-payee";
import { PAYEES_TAXONOMY_ID, setActivityPayee } from "../lib/payee";
import { PayeeField } from "./payee-field";
import {
  getActivityTypesForAccount,
  getCashActivityLabel,
  isCreditCardAccountType,
  isCashActivityIncome,
  isCashActivityOutflow,
  isSpendingAccountType,
} from "../lib/constants";
import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { useSettings } from "@/hooks/use-settings";
import { AdvancedOptionsSection } from "@/pages/activity/components/forms/fields/advanced-options-section";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { CategoryIconTile } from "./category-chips";
import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";
import type { ActivitySplit, CashFlowBucket } from "../types/cash-activity";
import {
  cashActivityFlowMetadata,
  describeTypeChange,
  linkableTransferType,
  resolveCashActivitySubtype,
} from "../lib/cash-activity-form-utils";

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
    activityDate: z.date({ error: requiredError(t("spending:cashForm.pickDate")) }),
    amount: z.coerce.number().min(0, { message: t("spending:cashForm.amountNonNegative") }),
    notes: z.string().optional(),
    // Advanced options. Currency defaults to the account's, so the common case
    // never sees these; a foreign charge on a domestic card needs both.
    currency: z.string().optional(),
    fxRate: z.coerce
      .number({ error: invalidTypeError(t("activity:form.err_fxrate_number")) })
      .positive({ message: t("activity:form.err_fxrate_positive") })
      .optional(),
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
  currency?: string;
  fxRate?: number;
  notes?: string;
  category?: string;
}

function getMobileTypeIcon(type: FormValues["activityType"]) {
  switch (type) {
    case "DEPOSIT":
      return Icons.ArrowDownLeft;
    case "WITHDRAWAL":
      return Icons.ArrowUpRight;
    case "INTEREST":
      return Icons.Percent;
    case "CREDIT":
      return Icons.Coins;
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
    splits?: ActivitySplit[];
    categoryAssignmentId?: string;
    categoryTaxonomyId?: string;
    categoryId?: string;
  };
  /** Called when user selects Transfer in creation mode; receives the selected spending account id */
  onTransferClick?: (accountId: string) => void;
  /**
   * Called to link the saved row with the other account's side, a transfer's
   * other leg. `counterpartId` is the suggested match to select. When the
   * form saved the row first, `saved` is the row as it is now.
   */
  onLinkTransfer?: (counterpartId?: string, saved?: Activity) => void;
  /** A known creation action opens directly on its details. */
  intent?: "expense" | "income";
}

/**
 * What the saves of one opening of the form have got to write. A save writes
 * the transaction, then its category, event and payee, and can fail between
 * two of them: the next one starts from what is on file by then.
 */
interface SaveSession {
  /** The new transaction, once a save has created it. */
  createdId: string | null;
  /** An edit is on file that the lists have not been refreshed for. */
  unrefreshed: boolean;
  /** A save succeeded while this was still the form's opening, and closed it. */
  closedBySave: boolean;
  /** Each one as last written; unset while it is still as the form opened with. */
  written: {
    /** `taxonomyId:categoryId`, or "" for none. */
    category?: string;
    eventId?: string | null;
    payeeName?: string;
  };
}
const newSaveSession = (): SaveSession => ({
  createdId: null,
  unrefreshed: false,
  closedBySave: false,
  written: {},
});

export function CashActivityForm({
  open,
  onOpenChange,
  activity,
  onTransferClick,
  onLinkTransfer,
  intent,
}: CashActivityFormProps) {
  const { t } = useTranslation();
  const pickerId = useId();
  const reviewEdits = useActivitySplitReview();
  const formSchema = useMemo(() => buildFormSchema(t), [t]);
  const isEditing = !!activity?.id;
  // The type the row shows: a synced row keeps its source type and stores the
  // user's choice as an override, which is the one to edit and compare with.
  const savedType = activity
    ? (getEffectiveType(activity) as FormValues["activityType"])
    : undefined;
  const isQuickEntry = !isEditing && !!intent;
  const initialType = intent === "income" ? "DEPOSIT" : "WITHDRAWAL";
  const isMobile = useIsMobileViewport();
  const [currentStep, setCurrentStep] = useState<1 | 2>(isEditing || isQuickEntry ? 2 : 1);
  const qc = useQueryClient();
  const { accounts } = useAccounts({ filterActive: false });
  const { settings } = useSpendingSettings();
  const { data: appSettings } = useSettings();
  const baseCurrency = appSettings?.baseCurrency;
  const trackedAccountIds = settings?.accountIds;
  const spendingAccounts = useMemo(() => {
    const tracked = new Set(trackedAccountIds ?? []);
    return (accounts ?? []).filter(
      (a: Account) =>
        isSpendingAccountType(a.accountType) &&
        (tracked.has(a.id) || a.id === activity?.accountId) &&
        (a.isActive || a.id === activity?.accountId) &&
        (!isQuickEntry || intent !== "income" || !isCreditCardAccountType(a.accountType)),
    );
  }, [accounts, activity?.accountId, trackedAccountIds, isQuickEntry, intent]);

  const accountItems = useMemo(
    () =>
      spendingAccounts.map((acc) => ({ value: acc.id, label: `${acc.name} (${acc.currency})` })),
    [spendingAccounts],
  );
  // The phone screen lists each account with its type icon and currency, under its
  // group when the accounts span more than one. Keyed on the label string, not `t`,
  // so the items keep their identity across renders.
  const uncategorizedLabel = t("dashboard:uncategorized");
  const accountScreenItems = useMemo(
    () => accountPickerItems(spendingAccounts, uncategorizedLabel),
    [spendingAccounts, uncategorizedLabel],
  );

  // Used only to look up the selected category's name/color for the trigger label.
  // QuickCategorizePopover loads its own data internally.
  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);

  const allCategoriesById = useMemo(() => {
    const map = new Map<string, TaxonomyCategory>();
    [
      ...(spending.data?.categories ?? []),
      ...(income.data?.categories ?? []),
      ...(savings.data?.categories ?? []),
    ].forEach((c) => map.set(c.id, c));
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
  // The payee is kept beside the form for the same reason: it is saved as an
  // assignment, after the activity. `savedPayeeName` is what is on file.
  const { payees, payeeName: savedPayeeName } = useActivityPayee(activity?.id ?? null);
  const [payeeName, setPayeeName] = useState(savedPayeeName);
  // The payee on file can load after the user has picked one: it seeds the
  // field only until they do.
  const payeeEdited = useRef(false);
  // A save that failed part-way has written some of the transaction. The next
  // one carries on from there: it does not create the transaction again, and it
  // compares each choice with what was written, not with what the form opened
  // with. The record belongs to one opening of the form: a save still running
  // when the form is opened again reports to the opening it started in.
  const session = useRef(newSaveSession());
  useEffectOnChange(() => {
    if (open) payeeEdited.current = false;
    session.current = newSaveSession();
  }, [open, activity?.id]);
  useEffect(() => {
    if (open && !payeeEdited.current) setPayeeName(savedPayeeName);
  }, [open, activity?.id, savedPayeeName]);
  const changePayeeName = (name: string) => {
    payeeEdited.current = true;
    setPayeeName(name);
  };
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(false);
  // The amount starts at 0 in the form, but shows as an empty field with a grey "0"
  // hint until something is typed, and again once it is cleared.
  const [amountTyped, setAmountTyped] = useState(false);
  const [amountFocused, setAmountFocused] = useState(false);
  // iOS shows no caret for a field focused without a tap, so while the amount has
  // focus but has not been tapped, a drawn caret stands in for it.
  const [amountTapped, setAmountTapped] = useState(false);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const { isIOS } = usePlatform();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema) as Resolver<FormValues>,
    defaultValues: {
      accountId: activity?.accountId ?? "",
      activityType: savedType ?? initialType,
      activityDate: activity?.activityDate ? new Date(activity.activityDate) : new Date(),
      amount: activity?.amount != null ? Math.abs(parseFloat(activity.amount)) : 0,
      currency: activity?.currency ?? "",
      fxRate: activity?.fxRate != null ? Number(activity.fxRate) : undefined,
      notes: activity?.notes ?? "",
      category:
        activity?.categoryTaxonomyId && activity?.categoryId
          ? `${activity.categoryTaxonomyId}:${activity.categoryId}`
          : "",
    },
  });

  useEffectOnChange(() => {
    if (open) {
      form.reset({
        accountId:
          activity?.accountId ??
          (isQuickEntry && spendingAccounts.length !== 1 ? "" : (spendingAccounts[0]?.id ?? "")),
        activityType: savedType ?? initialType,
        activityDate: activity?.activityDate ? new Date(activity.activityDate) : new Date(),
        amount: activity?.amount != null ? Math.abs(parseFloat(activity.amount)) : 0,
        // Seeded from the activity, not the account: recomputing it on save is
        // what would silently turn a 9.59 USD charge into 9.59 CAD.
        currency: activity?.currency ?? "",
        fxRate: activity?.fxRate != null ? Number(activity.fxRate) : undefined,
        notes: activity?.notes ?? "",
        category:
          activity?.categoryTaxonomyId && activity?.categoryId
            ? `${activity.categoryTaxonomyId}:${activity.categoryId}`
            : "",
      });
      setEventId(activity?.eventId ?? null);
      setCurrentStep(activity?.id || isQuickEntry ? 2 : 1);
      // A new session starts on the form, with the amount's placeholder showing.
      setMoreOptionsOpen(false);
      setConfirmDiscard(false);
      setAmountTyped(false);
      setAmountTapped(false);
    }
  }, [open, activity, savedType, spendingAccounts, form, initialType, isQuickEntry]);

  const watchType = form.watch("activityType");
  const watchAccountId = form.watch("accountId");
  const selectedAccount = spendingAccounts.find((a) => a.id === watchAccountId);
  const isCreditCardAccount = isCreditCardAccountType(selectedAccount?.accountType);
  const transferActionLabel = isCreditCardAccount
    ? t("spending:cashForm.recordPayment")
    : t("spending:cashForm.transferBetween");
  const activityTypeOptions = useMemo<FormValues["activityType"][]>(() => {
    const options = getActivityTypesForAccount(selectedAccount?.accountType);
    const currentType = savedType;
    const all = currentType && !options.includes(currentType) ? [...options, currentType] : options;
    // A saved row can become a transfer, or stop being one. A new transfer has
    // two sides, so it is entered with the transfer action instead.
    return isEditing ? all : all.filter((t) => t !== "TRANSFER_IN" && t !== "TRANSFER_OUT");
  }, [savedType, isEditing, selectedAccount?.accountType]);
  const mobileTypeOptions = useMemo(
    () =>
      activityTypeOptions.map((type) => ({
        type,
        label: getCashActivityLabel(
          t,
          type,
          selectedAccount?.accountType,
          resolveCashActivitySubtype({
            activityType: type,
            accountType: selectedAccount?.accountType,
            existingActivityType: savedType,
            existingSubtype: activity?.subtype,
          }),
        ),
        description: getMobileTypeDescription(type, t),
        Icon: getMobileTypeIcon(type),
      })),
    [activityTypeOptions, selectedAccount?.accountType, savedType, activity?.subtype, t],
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
  // A phone row shares its width with the choice, so plain spending says "Category".
  const categoryRowLabel =
    isMobile && cashFlowBucket !== "saving" && !isIncomeType
      ? t("spending:filters.category")
      : categoryLabel;

  useEffect(() => {
    if (!selectedAccount) return;
    if (!activityTypeOptions.includes(watchType)) {
      form.setValue("activityType", activityTypeOptions[0]);
    }
  }, [activityTypeOptions, form, selectedAccount, watchType]);

  const invalidateSaved = () => {
    invalidateSpendingCaches(qc);
    // A new name becomes a new payee, which the suggestions and filters list.
    qc.invalidateQueries({ queryKey: QueryKeys.taxonomy(PAYEES_TAXONOMY_ID) });
    qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
    qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
  };
  const saveMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const saving = session.current;
      const dateStr = values.activityDate.toISOString();
      const account = spendingAccounts.find((a) => a.id === values.accountId);
      // The account's currency is only the default. Taking it unconditionally
      // rewrote an existing activity's currency on every save, turning a 9.59
      // USD charge on a CAD card into 9.59 CAD without changing the number.
      const currency = values.currency?.trim() || account?.currency || "USD";
      // A rate converts `currency` into the ACCOUNT's currency, so it holds only
      // while both ends are the pair it was entered against. Moving the activity
      // to a differently-denominated account leaves a seeded rate describing a
      // pair that no longer exists, and the field is collapsed by default — so a
      // USD->CAD rate would be reread as USD->EUR rather than questioned. A rate
      // the user typed themselves is theirs to keep.
      const seededRate = activity?.fxRate != null ? Number(activity.fxRate) : undefined;
      const seededAgainst = activity
        ? spendingAccounts.find((a) => a.id === activity.accountId)?.currency
        : undefined;
      const rateHolds =
        values.fxRate !== seededRate ||
        (activity?.currency === currency && seededAgainst === account?.currency);
      // Only meaningful when the money moved in something other than the
      // account's own currency; otherwise the rate is 1 and worth nothing.
      const fxRate = currency !== account?.currency && rateHolds ? (values.fxRate ?? null) : null;
      const subtype = resolveCashActivitySubtype({
        activityType: values.activityType,
        accountType: account?.accountType,
        existingActivityType: savedType,
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
          fxRate,
          comment: values.notes ?? null,
          metadata: cashActivityFlowMetadata(
            values.activityType,
            subtype,
            activity?.metadata,
            savedType,
          ),
        };
        const [reviewed] = await reviewEdits([update]);
        saved = await updateActivity(reviewed);
        saving.unrefreshed = true;
      } else {
        const create: ActivityCreate = {
          accountId: values.accountId,
          activityType: values.activityType,
          subtype,
          activityDate: dateStr,
          amount: values.amount,
          currency,
          fxRate,
          comment: values.notes ?? null,
          metadata: cashActivityFlowMetadata(values.activityType, subtype),
        };
        if (saving.createdId) {
          // An earlier attempt created it: bring it up to what the form says now.
          saved = await updateActivity({ id: saving.createdId, ...create });
        } else {
          saved = await createActivity(create);
          saving.createdId = saved.id;
        }
      }
      // What is on file to compare against: what an earlier attempt wrote, or
      // else what the form opened with.
      const written = saving.written;

      // Sync category assignment
      const newCategory = values.category;
      const oldCategory =
        written.category ??
        (activity?.categoryTaxonomyId && activity?.categoryId
          ? `${activity.categoryTaxonomyId}:${activity.categoryId}`
          : "");
      if (newCategory !== oldCategory) {
        if (oldCategory) {
          const [oldTax] = oldCategory.split(":");
          await unassignActivityCategory(saved.id, oldTax);
          written.category = "";
        }
        if (newCategory) {
          const [tax, cat] = newCategory.split(":");
          await assignActivityCategory(saved.id, tax, cat);
          written.category = newCategory;
        }
      }

      // Sync event_id if changed
      const oldEventId =
        written.eventId !== undefined ? written.eventId : (activity?.eventId ?? null);
      if (eventId !== oldEventId) {
        await setActivityEvent(saved.id, eventId);
        written.eventId = eventId;
      }

      // Sync the payee if changed
      const newPayeeName = payeeName.trim();
      if (newPayeeName !== (written.payeeName ?? savedPayeeName)) {
        await setActivityPayee(saved.id, payeeName, payees);
        written.payeeName = newPayeeName;
      }

      saving.createdId = null;
      return saved;
    },
    // The opening the save belongs to and what it says once saved, for when it
    // ends in another opening, which can be of another kind of entry.
    onMutate: () => ({
      owner: session.current,
      savedMessage: isEditing
        ? t("spending:cashForm.activityUpdated")
        : intent === "expense"
          ? t("spending:cashForm.expenseAdded")
          : intent === "income"
            ? t("spending:cashForm.incomeAdded")
            : t("spending:cashForm.activityCreated"),
    }),
    onSuccess: (_saved, _values, { owner, savedMessage }) => {
      owner.unrefreshed = false;
      invalidateSaved();
      toast.success(savedMessage);
      // A form dismissed or opened again since is not this save's to close.
      if (owner === session.current) {
        owner.closedBySave = true;
        onOpenChange(false);
      }
    },
    onError: (e: unknown, _values, context) => {
      if (isActivityEditCancelled(e)) return;
      // The transaction itself may have been created before the step that failed.
      // A failed edit is refreshed when the form is dismissed instead: a refreshed
      // activity would reset the fields being retried. Already dismissed, there
      // is nothing to reset and no later dismissal to refresh it.
      const owner = context?.owner;
      if (owner?.createdId || (owner?.unrefreshed && owner !== session.current)) {
        invalidateSaved();
      }
      toast.error(t("spending:cashForm.saveFailed", { message: (e as Error).message ?? e }));
    },
  });

  const isMobileCreate = isMobile && !isEditing;
  const showChoiceFields = isQuickEntry || !isMobileCreate || currentStep === 1;
  const showDetailsFields = isQuickEntry || !isMobileCreate || currentStep === 2;
  const focusAmountOnShow = open && isMobileCreate && (isQuickEntry || currentStep === 2);

  // A new entry on a phone opens on the amount with its caret showing. Moving on
  // from the type step removes the focused Next button; focusing the amount in the
  // same commit keeps the sheet from moving focus to itself.
  useLayoutEffect(() => {
    if (focusAmountOnShow) amountInputRef.current?.focus({ preventScroll: true });
  }, [focusAmountOnShow]);

  const handleMobileNext = async () => {
    const isValid = await form.trigger(["accountId", "activityType"]);
    if (isValid) setCurrentStep(2);
  };

  // Read during render so the form tracks them for the close check below.
  // A successful save closes the sheet itself; a failed one leaves the input to protect.
  const { dirtyFields } = form.formState;
  // Closes the form on the user's word. A save still running is then no longer
  // this form's: it must not close, or navigate away from, what is opened next.
  const dismiss = () => {
    if (session.current.unrefreshed) invalidateSaved();
    session.current = newSaveSession();
    onOpenChange(false);
  };
  // Whether the category, event or payee differs from what is on file. After a
  // save that failed part-way that is what it wrote, so a choice put back to
  // what the form opened with is unsaved too.
  const hasUnsavedLabels = () => {
    const { written } = session.current;
    return (
      (written.category !== undefined && form.getValues("category") !== written.category) ||
      eventId !== (written.eventId !== undefined ? written.eventId : (activity?.eventId ?? null)) ||
      payeeName.trim() !== (written.payeeName ?? savedPayeeName)
    );
  };
  const handleSheetOpenChange = (next: boolean) => {
    // Typed input is kept unless the user says to drop it. Picking the type of a new
    // entry is not input; changing an existing one's type, or its event, is.
    const hasUnsavedInput =
      Object.keys(dirtyFields).some((field) => isEditing || field !== "activityType") ||
      hasUnsavedLabels();
    if (!next && hasUnsavedInput) {
      setConfirmDiscard(true);
      return;
    }
    if (next) onOpenChange(next);
    else dismiss();
  };

  const handleTransferAction = async () => {
    if (!onTransferClick) return;
    const isValid = await form.trigger("accountId");
    if (!isValid || !watchAccountId) return;
    dismiss();
    onTransferClick(watchAccountId);
  };

  // Category and event match the account select. On phones each opens a screen
  // of the sheet, which the forward chevron says.
  const pickerTriggerClassName = "w-full justify-between";
  const pickerChevron = isMobile ? (
    <Icons.ChevronRight
      className="ms-2 h-4 w-4 shrink-0 opacity-50 rtl:rotate-180"
      aria-hidden="true"
    />
  ) : (
    <Icons.ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
  );

  const amountField = (
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
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  // Each field once; desktop stacks them as labelled fields, phones as rows.
  const accountField = (
    <FormField
      control={form.control}
      name="accountId"
      render={({ field }) => (
        <FormItem className={cn(isMobile && "gap-0")}>
          <FormLabel className={cn(isMobile && "sr-only")}>{t("common:account")}</FormLabel>
          <Select
            items={isMobile ? accountScreenItems : accountItems}
            onValueChange={field.onChange}
            value={field.value}
          >
            <FormControl>
              <SelectTrigger className={cn(isMobile && formRowClassName)}>
                {isMobile && <FormRowLabel>{t("common:account")}</FormRowLabel>}
                <SelectValue
                  className={cn(isMobile && formRowValueClassName)}
                  placeholder={t("spending:cashForm.selectAccount")}
                />
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
          <FormMessage className={cn(isMobile && "px-4 pb-2")} />
        </FormItem>
      )}
    />
  );

  const typeGridField = (
    <FormField
      control={form.control}
      name="activityType"
      render={({ field }) => (
        <FormItem>
          <FormLabel id={`${pickerId}-title`} className="text-lg leading-none font-semibold">
            {t("spending:cashForm.selectType")}
          </FormLabel>
          <FormControl>
            <RadioGroup
              aria-labelledby={`${pickerId}-title`}
              className="grid-cols-2 gap-2 pb-1"
              onValueChange={field.onChange}
              value={field.value}
            >
              {mobileTypeOptions.map(({ type, label, description, Icon }) => (
                <TypeChoice
                  key={type}
                  id={`${pickerId}-${type}`}
                  value={type}
                  label={label}
                  description={description}
                  icon={Icon}
                  selected={field.value === type}
                />
              ))}
            </RadioGroup>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const typeSelectField = (
    <FormField
      control={form.control}
      name="activityType"
      render={({ field }) => (
        <FormItem className={cn(isMobile && "gap-0")}>
          <FormLabel className={cn(isMobile && "sr-only")}>{t("common:type")}</FormLabel>
          <Select
            items={mobileTypeOptions.map(({ type, label }) => ({
              value: type,
              label,
            }))}
            onValueChange={field.onChange}
            value={field.value}
          >
            <FormControl>
              <SelectTrigger className={cn(isMobile && formRowClassName)}>
                {isMobile && <FormRowLabel>{t("common:type")}</FormRowLabel>}
                <SelectValue className={cn(isMobile && formRowValueClassName)} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {mobileTypeOptions.map(({ type, label }) => (
                <SelectItem key={type} value={type}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const transferButtonField =
    !isEditing && onTransferClick ? (
      <FormItem>
        <FormLabel>
          {isCreditCardAccount ? t("spending:cashForm.payment") : t("spending:cashForm.transfer")}
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
    ) : null;

  // Changing a saved row's type says how reports will count it, before saving.
  const typeChange =
    isEditing && activity
      ? describeTypeChange(
          { activityType: savedType ?? activity.activityType, subtype: activity.subtype },
          {
            activityType: watchType,
            subtype: resolveCashActivitySubtype({
              activityType: watchType,
              accountType: selectedAccount?.accountType,
              existingActivityType: savedType,
              existingSubtype: activity.subtype,
            }),
          },
          selectedAccount?.accountType,
        )
      : null;
  // A card's payment and advance notes already say which way the balance goes.
  const balanceNote = !isCreditCardAccount
    ? t("spending:cashForm.typeChange.reversesBalance")
    : typeChange?.effect === "cardPayment" || typeChange?.effect === "cardAdvance"
      ? null
      : isCashActivityOutflow(watchType, selectedAccount?.accountType)
        ? t("spending:cashForm.typeChange.owesMore")
        : t("spending:cashForm.typeChange.owesLess");
  const typeChangeNotice = typeChange ? (
    <Alert>
      <Icons.Info className="h-4 w-4" aria-hidden="true" />
      <AlertDescription>
        {[
          typeChange.effect && t(`spending:cashForm.typeChange.${typeChange.effect}`),
          typeChange.reversesBalance && balanceNote,
        ]
          .filter(Boolean)
          .join(" ")}
      </AlertDescription>
    </Alert>
  ) : null;

  // A transfer's other side: the account the money came from or went to. A
  // saved row links as the transfer it would become. When the chosen transfer
  // is a different one, such as a card advance made a payment, the row saves
  // the change first and then links. The account must be unchanged.
  const isTransferChoice = watchType === "TRANSFER_IN" || watchType === "TRANSFER_OUT";
  // A card's transfer has no category, nor has a neutral row until its type
  // changes. A bank's one-sided transfer still counts under its category.
  const showNeutralCategory =
    (isTransferChoice && isCreditCardAccount) || (isNeutralBucket && watchType === savedType);
  const canLink =
    isEditing &&
    !!activity?.id &&
    !!onLinkTransfer &&
    isTransferChoice &&
    watchAccountId === activity.accountId &&
    !!savedType;
  const linkSavesFirst =
    canLink && linkableTransferType(savedType, selectedAccount?.accountType) !== watchType;
  const { data: savedSuggestion } = useQuery({
    queryKey: ["transfer-match-suggestion", activity?.id, savedType],
    queryFn: async () => {
      const [first] = await findTransferMatchCandidates({
        activityId: activity!.id,
        windowDays: 7,
        limit: 1,
        includeCashFlows: true,
      });
      return first ?? null;
    },
    enabled: open && canLink && !linkSavesFirst,
    staleTime: 30_000,
  });
  const formatting = useAmountFormatting();
  const dateFormatting = useDateFormatting();
  // The query keeps its last answer once disabled: a match found for the
  // saved row's own transfer doesn't fit a different one chosen since.
  const suggestedMatch = linkSavesFirst ? null : savedSuggestion;
  const suggestedAccount = suggestedMatch
    ? accounts?.find((account) => account.id === suggestedMatch.activity.accountId)
    : undefined;
  const linkRowLabel =
    watchType === "TRANSFER_OUT"
      ? t("spending:cashForm.linkRow.sentTo")
      : isCreditCardAccount
        ? t("spending:cashForm.linkRow.paidFrom")
        : t("spending:cashForm.linkRow.receivedFrom");
  // Leaving for the link sheet drops what was typed here, so it asks first.
  const [pendingLink, setPendingLink] = useState<{ counterpartId?: string } | null>(null);
  const startLink = (counterpartId?: string) => {
    if (linkSavesFirst) {
      // A form dismissed or opened again while it saves no longer leads to the link.
      const owner = session.current;
      void form.handleSubmit(async (values) => {
        const saved = await saveMutation.mutateAsync(values).catch(() => null);
        if (saved && owner.closedBySave) onLinkTransfer?.(undefined, saved);
      })();
      return;
    }
    const hasOtherInput =
      Object.keys(dirtyFields).some((field) => field !== "activityType") || hasUnsavedLabels();
    if (hasOtherInput) {
      setPendingLink({ counterpartId });
      return;
    }
    dismiss();
    onLinkTransfer?.(counterpartId);
  };
  const linkField = canLink ? (
    <FormItem className={cn(isMobile && "gap-0")}>
      <FormLabel className={cn(isMobile && "sr-only")}>{linkRowLabel}</FormLabel>
      <Button
        type="button"
        variant="field"
        className={isMobile ? formRowClassName : pickerTriggerClassName}
        onClick={() => startLink()}
        disabled={saveMutation.isPending}
      >
        {isMobile && <FormRowLabel>{linkRowLabel}</FormRowLabel>}
        <span className={cn("text-muted-foreground truncate", isMobile && "ms-auto")}>
          {t("spending:cashForm.linkRow.untracked")}
        </span>
        {pickerChevron}
      </Button>
      {suggestedMatch && suggestedAccount ? (
        <div
          className={cn(
            "text-muted-foreground flex items-center justify-between gap-2 text-sm",
            isMobile && "px-4 py-2",
          )}
        >
          <span className="min-w-0 truncate">
            {t("spending:cashForm.linkRow.suggested", {
              account: suggestedAccount.name,
              date: dateFormatting.formatDate(suggestedMatch.activity.activityDate),
              amount: formatting.formatAmount(
                Math.abs(Number(suggestedMatch.activity.amount ?? 0)),
                suggestedMatch.activity.currency,
              ),
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => startLink(suggestedMatch.activity.id)}
            disabled={saveMutation.isPending}
          >
            <Icons.Link className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t("spending:cashForm.linkRow.link")}
          </Button>
        </div>
      ) : null}
      {!isMobile && (
        <p className="text-muted-foreground text-xs">
          {linkSavesFirst
            ? t("spending:cashForm.linkRow.savesFirst")
            : t("spending:cashForm.linkRow.hint")}
        </p>
      )}
    </FormItem>
  ) : null;

  const transferCard = onTransferClick ? (
    <button
      type="button"
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-4 text-start transition-all",
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
  ) : null;

  const dateField = (
    <FormField
      control={form.control}
      name="activityDate"
      render={({ field }) => (
        <FormItem
          className={cn(
            "flex flex-col",
            isMobile && "min-h-14 flex-row flex-wrap items-center gap-x-3 gap-y-0 px-4",
          )}
        >
          <FormLabel className={cn(isMobile && "shrink-0 text-base font-normal")}>
            {t("common:date")}
          </FormLabel>
          <DatePickerInput
            value={field.value}
            onChange={(d?: Date) => field.onChange(d)}
            disabled={field.disabled}
            enableTime
            appearance={isMobile ? "row" : "field"}
            className={cn(isMobile && "ms-auto min-w-0")}
          />
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const categoryField = (
    <FormField
      control={form.control}
      name="category"
      render={({ field }) => {
        const [, currentCatId] = field.value?.split(":") ?? [];
        const currentCat = currentCatId ? allCategoriesById.get(currentCatId) : null;
        const currentParent = currentCat?.parentId
          ? allCategoriesById.get(currentCat.parentId)
          : null;
        const currentCatLabel = currentCat
          ? getCategoryLabel(t, currentCat.taxonomyId, currentCat.id, currentCat.name)
          : "";
        const currentParentLabel = currentParent
          ? getCategoryLabel(t, currentParent.taxonomyId, currentParent.id, currentParent.name)
          : "";
        const neutralLabel =
          watchType === "TRANSFER_IN" || watchType === "TRANSFER_OUT"
            ? t("spending:cashForm.neutralTransfer")
            : t("spending:transactions.neutral");
        return (
          <FormItem className={cn(isMobile && "gap-0")}>
            {" "}
            <FormLabel className={cn(isMobile && "sr-only")}>
              {showNeutralCategory ? t("spending:filters.category") : categoryLabel}
            </FormLabel>
            {(activity?.splits?.length ?? 0) > 0 ? (
              <p
                className={cn(
                  "text-muted-foreground rounded-md border px-3 py-2 text-sm",
                  isMobile && "rounded-none border-0 px-4 py-3",
                )}
              >
                {t("spending:split.categoryProtected")}
              </p>
            ) : showNeutralCategory ? (
              <div
                className={cn(
                  "border-input bg-muted/40 text-muted-foreground h-input-height flex items-center rounded-md border px-3 py-2 text-sm",
                  isMobile && formRowClassName,
                )}
              >
                {isMobile && <FormRowLabel>{t("spending:filters.category")}</FormRowLabel>}
                {/* On a phone the value sits at the row's end, like the other rows'. */}
                {isMobile ? <FormRowValue>{neutralLabel}</FormRowValue> : neutralLabel}
              </div>
            ) : (
              <QuickCategorizePopover
                title={categoryRowLabel}
                scope={categoryScope}
                selectedCategoryId={currentCatId ?? null}
                onSelect={(tax, catId) => field.onChange(`${tax}:${catId}`)}
                onClear={() => field.onChange("")}
                trigger={
                  <FormControl>
                    <Button
                      type="button"
                      variant="field"
                      className={isMobile ? formRowClassName : pickerTriggerClassName}
                      aria-label={
                        currentCat
                          ? t("spending:transactions.changeCategory", {
                              name: currentCatLabel,
                            })
                          : t("spending:cashForm.pickCategory")
                      }
                    >
                      {isMobile && <FormRowLabel>{categoryRowLabel}</FormRowLabel>}
                      {currentCat ? (
                        <span
                          className={cn(
                            "flex min-w-0 items-center gap-2",
                            isMobile && "text-muted-foreground ms-auto",
                          )}
                        >
                          <CategoryIconTile
                            icon={currentCat.icon ?? null}
                            color={currentCat.color ?? null}
                            className="h-5 w-5"
                            iconClassName="h-3 w-3"
                          />
                          <span className="truncate">
                            {/* A phone row has room for the choice alone, not its path. */}
                            {currentParent && !isMobile ? `${currentParentLabel} / ` : ""}
                            {currentCatLabel}
                          </span>
                        </span>
                      ) : (
                        <span className={cn("text-muted-foreground", isMobile && "ms-auto")}>
                          {isMobile
                            ? t("spending:cashForm.none")
                            : t("spending:cashForm.pickCategoryOptional")}
                        </span>
                      )}
                      {pickerChevron}
                    </Button>
                  </FormControl>
                }
              />
            )}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );

  const eventField = (
    <FormItem className={cn(isMobile && "gap-0")}>
      {" "}
      <FormLabel className={cn(isMobile && "sr-only")}>{t("spending:filters.event")}</FormLabel>
      <QuickEventPopover
        title={t("spending:filters.event")}
        selectedEventId={eventId}
        onSelect={setEventId}
        onClear={() => setEventId(null)}
        defaultDate={form.watch("activityDate") ?? undefined}
        trigger={
          <Button
            type="button"
            variant="field"
            className={isMobile ? formRowClassName : pickerTriggerClassName}
            aria-label={
              eventId && eventsById.get(eventId)
                ? t("spending:transactions.changeEvent", {
                    name: eventsById.get(eventId)?.name,
                  })
                : t("spending:cashForm.tagAnEvent")
            }
          >
            {isMobile && <FormRowLabel>{t("spending:filters.event")}</FormRowLabel>}
            {(() => {
              const ev = eventId ? eventsById.get(eventId) : null;
              if (!ev) {
                return (
                  <span className={cn("text-muted-foreground", isMobile && "ms-auto")}>
                    {isMobile
                      ? t("spending:cashForm.none")
                      : t("spending:cashForm.tagEventOptional")}
                  </span>
                );
              }
              const color = eventTypeById.get(ev.eventTypeId)?.color ?? "var(--muted-foreground)";
              return (
                <span
                  className={cn(
                    "flex min-w-0 items-center gap-2",
                    isMobile && "text-muted-foreground ms-auto",
                  )}
                >
                  {" "}
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{ev.name}</span>
                </span>
              );
            })()}
            {pickerChevron}
          </Button>
        }
      />
    </FormItem>
  );

  const payeeField = (
    <PayeeField value={payeeName} onChange={changePayeeName} payees={payees} isMobile={isMobile} />
  );

  const notesField = (
    <FormField
      control={form.control}
      name="notes"
      render={({ field }) => (
        <FormItem>
          {/* Labelled on phones too: the placeholder alone does not say what goes here. */}
          <FormLabel className={cn(isMobile && "px-4 pt-3.5 text-base font-normal")}>
            {t("spending:cashForm.notesPayee")}
          </FormLabel>
          <FormControl>
            <Textarea
              placeholder={t("spending:cashForm.notesPlaceholder")}
              className={cn(
                "resize-none",
                isMobile &&
                  "min-h-16 rounded-none border-0 bg-transparent px-4 pt-1 shadow-none pointer-coarse:focus-visible:outline-none dark:bg-transparent",
              )}
              {...field}
            />
          </FormControl>
          <FormMessage className={cn(isMobile && "px-4 pb-2")} />
        </FormItem>
      )}
    />
  );

  // On phones the amount leads the form, large and centred.
  const amountHero = (
    <FormField
      control={form.control}
      name="amount"
      render={({ field }) => (
        <FormItem className="items-center gap-1 py-2 text-center">
          <FormLabel className="sr-only">{t("common:amount")}</FormLabel>
          <div
            className="font-heading relative w-full text-[length:var(--text-display)] leading-[1.1] tracking-[-0.03em] tabular-nums"
            onPointerDown={() => setAmountTapped(true)}
            onFocus={() => setAmountFocused(true)}
          >
            <FormControl>
              <MoneyInput
                ref={amountInputRef}
                value={field.value === 0 && !amountTyped ? undefined : field.value}
                onValueChange={(v: number | undefined) => {
                  setAmountTyped(v !== undefined);
                  field.onChange(v ?? 0);
                }}
                placeholder=""
                onBlur={() => {
                  setAmountFocused(false);
                  setAmountTapped(false);
                  field.onBlur();
                }}
                className="font-heading h-auto border-0 bg-transparent px-0 text-center text-[length:var(--text-display)] leading-[1.1] tracking-[-0.03em] tabular-nums shadow-none focus-visible:outline-none dark:bg-transparent"
              />
            </FormControl>
            {/* The "0" hint sits beside the field rather than in it: an empty centred
                field puts its caret at the centre, so while a caret shows the hint
                moves just before it instead of under it. */}
            {field.value === 0 && !amountTyped && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <span
                  className={cn(
                    "text-muted-foreground/60",
                    amountFocused &&
                      "-translate-x-[calc(50%+0.06em)] rtl:translate-x-[calc(50%+0.06em)]",
                  )}
                >
                  0
                </span>
                {isIOS && amountFocused && !amountTapped && (
                  <span
                    data-amount-caret
                    className="bg-primary absolute start-1/2 h-[0.8em] w-0.5 animate-[caret-blink_1.1s_step-end_infinite] rounded-full motion-reduce:animate-none"
                  />
                )}
              </span>
            )}
          </div>
          {selectedAccount?.currency && (
            <p className="text-muted-foreground text-sm">{selectedAccount.currency}</p>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const desktopFields = (
    <div className="space-y-4">
      {isQuickEntry && amountField}
      {showChoiceFields && (
        <>
          {accountField}
          {!isQuickEntry && (
            <>
              {isMobileCreate ? (
                typeGridField
              ) : (
                <>
                  {typeSelectField}
                  {typeChangeNotice}
                  {linkField}
                  {/* Transfer button — creation only, redirects to the full transfer form */}
                  {transferButtonField}
                </>
              )}
              {isMobileCreate && transferCard}
            </>
          )}
        </>
      )}
      {showDetailsFields && (
        <>
          {dateField}
          {!isQuickEntry && amountField}
          {categoryField}
          {eventField}
          {payeeField}
          {notesField}
          {/* Collapsed by default, so the everyday case — a charge in
    the account's own currency — never sees it. Open, it
    covers a foreign charge on a domestic card, which the
    backend has always stored but the form could not enter.
    Notes stays outside: the payee is what identifies a
    spending row, not an advanced detail. */}
          <AdvancedOptionsSection
            currencyName="currency"
            fxRateName="fxRate"
            accountCurrency={selectedAccount?.currency}
            baseCurrency={baseCurrency}
            showSubtype={false}
            variant={isMobile ? "mobile" : "desktop"}
            dashed
          />
        </>
      )}
    </div>
  );

  // Phones: the amount first, then iOS-style rows that open as screens of the
  // sheet; currency and FX sit behind one row instead of a collapsible box.
  const mobileFields = (
    <div className="space-y-4 p-4">
      {(isQuickEntry || showDetailsFields) && amountHero}
      {showChoiceFields && isMobileCreate && !isQuickEntry ? (
        <>
          <FormRowGroup>{accountField}</FormRowGroup>
          {typeGridField}
          {transferCard}
        </>
      ) : (
        <FormRowGroup>
          {showChoiceFields && accountField}
          {showChoiceFields && !isQuickEntry && !isMobileCreate && typeSelectField}
          {showDetailsFields && dateField}
          {showDetailsFields && categoryField}
          {showDetailsFields && eventField}
        </FormRowGroup>
      )}
      {showChoiceFields && !isQuickEntry && !isMobileCreate && typeChangeNotice}
      {showChoiceFields && !isQuickEntry && !isMobileCreate && linkField && (
        <FormRowGroup>{linkField}</FormRowGroup>
      )}
      {showChoiceFields && !isQuickEntry && !isMobileCreate && transferButtonField}
      {showDetailsFields && (
        <>
          <FormRowGroup>{payeeField}</FormRowGroup>
          <FormRowGroup>{notesField}</FormRowGroup>
          <FormRowGroup>
            <button
              type="button"
              className={formRowClassName}
              aria-haspopup="dialog"
              aria-expanded={moreOptionsOpen}
              onClick={() => setMoreOptionsOpen(true)}
            >
              <FormRowLabel>{t("activity:form.advanced_options")}</FormRowLabel>
              <FormRowValue>{form.watch("currency") || selectedAccount?.currency}</FormRowValue>
              <Icons.ChevronRight
                className="h-4 w-4 shrink-0 opacity-50 rtl:rotate-180"
                aria-hidden="true"
              />
            </button>
          </FormRowGroup>
          <SheetScreen
            open={moreOptionsOpen}
            onOpenChange={setMoreOptionsOpen}
            title={t("activity:form.advanced_options")}
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <AdvancedOptionsSection
                currencyName="currency"
                fxRateName="fxRate"
                accountCurrency={selectedAccount?.currency}
                baseCurrency={baseCurrency}
                showSubtype={false}
                variant="mobile"
                bare
              />
            </div>
          </SheetScreen>
        </>
      )}
    </div>
  );

  return (
    <>
      <Sheet open={open} onOpenChange={handleSheetOpenChange}>
        <SheetContent
          side={isMobile ? "bottom" : "inline-end"}
          // Opening focuses the sheet's first control, which would take focus from
          // the amount; the effect above covers moving on from the type step.
          initialFocus={focusAmountOnShow ? amountInputRef : undefined}
          className={cn(
            isMobile
              ? "rounded-t-4xl mx-1 flex flex-col overflow-hidden p-0 [--overlay-max-height:90dvh]"
              : "flex w-full flex-col overflow-hidden sm:max-w-md",
          )}
        >
          <SheetHeader
            floating={isMobile}
            className={cn("shrink-0", isMobile && "px-6 py-4 text-center")}
          >
            <div className={cn(isMobile && "flex flex-col items-center space-y-2")}>
              <SheetTitle>
                {isEditing
                  ? t("spending:cashForm.editTitle")
                  : intent === "expense"
                    ? t("spending:cashForm.addExpense")
                    : intent === "income"
                      ? t("spending:cashForm.addIncome")
                      : t("spending:cashForm.addTitle")}
              </SheetTitle>
              {isMobileCreate && !isQuickEntry && (
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
                  ? "flex min-h-0 flex-auto flex-col"
                  : "mt-6 min-h-0 flex-1 overflow-y-auto px-1 pb-1",
              )}
            >
              {/* On phones the header floats over this scroll area, which starts below it. */}
              <div
                className={cn(
                  isMobile &&
                    "pt-(--sheet-header-height) scroll-pt-(--sheet-header-height) min-h-0 flex-auto overflow-y-auto",
                )}
              >
                {isMobile ? mobileFields : desktopFields}
              </div>

              {isMobile ? (
                <SheetFooter className="shrink-0 border-t px-6 py-4 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
                  <div className="flex w-full gap-3">
                    {currentStep > 1 && !isEditing && !isQuickEntry && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setCurrentStep(1)}
                        className="flex-1"
                        disabled={saveMutation.isPending}
                      >
                        <Icons.ArrowLeft className="me-2 h-4 w-4 rtl:rotate-180" />
                        {t("common:back")}
                      </Button>
                    )}

                    {/* Separate keys: reusing one element would turn the pressed Next into a
                      submit button before the click's default action runs, which submits. */}
                    {currentStep < 2 && !isEditing && !isQuickEntry ? (
                      <Button
                        key="next"
                        type="button"
                        onClick={handleMobileNext}
                        className="flex-1 font-medium"
                        disabled={!watchAccountId}
                      >
                        {t("common:next")}
                        <Icons.ArrowRight className="ms-2 h-4 w-4 rtl:rotate-180" />
                      </Button>
                    ) : (
                      <Button
                        key="submit"
                        type="submit"
                        className="flex-1 font-medium"
                        disabled={saveMutation.isPending}
                      >
                        {saveMutation.isPending ? (
                          <Spinner className="me-2 h-4 w-4" />
                        ) : (
                          <Icons.Check className="me-2 h-4 w-4" />
                        )}
                        {isEditing
                          ? t("spending:cashForm.updateTransaction")
                          : intent === "expense"
                            ? t("spending:cashForm.addExpense")
                            : intent === "income"
                              ? t("spending:cashForm.addIncome")
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
                    onClick={() => handleSheetOpenChange(false)}
                    disabled={saveMutation.isPending}
                  >
                    {t("common:cancel")}
                  </Button>
                  <Button type="submit" disabled={saveMutation.isPending}>
                    {saveMutation.isPending ? (
                      <>
                        <Spinner className="me-2 h-4 w-4" />
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
      <DiscardChangesDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        onDiscard={dismiss}
      />
      <DiscardChangesDialog
        open={!!pendingLink}
        onOpenChange={(next) => !next && setPendingLink(null)}
        onDiscard={() => {
          const counterpartId = pendingLink?.counterpartId;
          setPendingLink(null);
          dismiss();
          onLinkTransfer?.(counterpartId);
        }}
      />
    </>
  );
}
