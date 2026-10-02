import { useState } from "react";
import { loanErrorText } from "./loan-error-text";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import {
  Button,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  MoneyInput,
  DatePickerInput,
  ResponsiveSelect,
  Textarea,
} from "@wealthfolio/ui";
import { Sheet, SheetDescription, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { LoanInterestMethodSelect } from "./loan-interest-method-select";
import {
  LoanSheetContent,
  LoanSheetHeader,
  LoanSheetBody,
  LoanSheetFooter,
} from "./loan-sheet-content";
import { inheritedLoanSettings } from "../lib/loan-event-editing";
import {
  isLoanInterestMethod,
  isLoanEvent,
  type LoanMetadata,
  type LoanEvent,
} from "../lib/loan-events";
import { formatDateISO } from "@/lib/utils";

/** A confirmed balance edited in this sheet. It is saved as a quote, never as a loan event. */
export interface LoanBalanceDraft {
  type: "balance_correction";
  effectiveDate: string;
  balance: number;
  note?: string;
}
export type LoanSheetEntry = LoanEvent | LoanBalanceDraft;

function isLoanSheetEntry(value: unknown): value is LoanSheetEntry {
  if (isLoanEvent(value)) return true;
  const draft = value as Partial<LoanBalanceDraft> | null;
  return (
    draft?.type === "balance_correction" &&
    typeof draft.effectiveDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveDate) &&
    typeof draft.balance === "number" &&
    Number.isFinite(draft.balance) &&
    draft.balance >= 0
  );
}

interface LoanEventSheetProps {
  event: LoanSheetEntry;
  originationDate?: string;
  metadata?: LoanMetadata;
  eventIndex?: number;
  onClose: () => void;
  onSave: (entry: LoanSheetEntry | null) => Promise<void>;
}
export function LoanEventSheet({
  event,
  originationDate,
  metadata = {},
  eventIndex = -1,
  onClose,
  onSave,
}: LoanEventSheetProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fields = [
    { name: "effectiveDate", label: t("asset:loanOverview.effective_date"), type: "date" },
    ...("amount" in event
      ? [{ name: "amount", label: t("asset:loanActions.extra_repayment"), type: "number" }]
      : []),
    ...("balance" in event
      ? [{ name: "balance", label: t("asset:loanOverview.confirmed_balance"), type: "number" }]
      : []),
    ...("annualRate" in event
      ? [{ name: "annualRate", label: t("asset:altContent.interest_rate"), type: "number" }]
      : []),
    ...("paymentAmount" in event || event.type === "renewal"
      ? [{ name: "paymentAmount", label: t("asset:loanOverview.regular_payment"), type: "number" }]
      : []),
    ...(event.type === "renewal"
      ? [{ name: "termEndDate", label: t("asset:loanOverview.next_renewal"), type: "date" }]
      : []),
  ];
  const toEvent = (values: Record<string, string>) => {
    const next: Record<string, unknown> = { ...event };
    for (const { name, type } of fields) {
      if (
        !values[name] &&
        (name === "termEndDate" || (name === "paymentAmount" && event.type === "renewal"))
      )
        delete next[name];
      else
        next[name] =
          type === "number" ? (values[name] ? Number(values[name]) : Number.NaN) : values[name];
    }
    if ("frequency" in event || event.type === "renewal") {
      if (values.frequency) next.frequency = values.frequency;
      else delete next.frequency;
    }
    if (event.type === "renewal") {
      if (values.interestMethod) next.interestMethod = values.interestMethod;
      else delete next.interestMethod;
    }
    next.note = values.note ?? "";
    return next;
  };
  const schema = z.record(z.string(), z.string()).superRefine((values, ctx) => {
    const next = toEvent(values);
    if (
      !isLoanSheetEntry(next) ||
      (originationDate && values.effectiveDate < originationDate) ||
      values.effectiveDate > formatDateISO(new Date()) ||
      (values.termEndDate && values.termEndDate <= values.effectiveDate)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveDate"],
        message: t("asset:loanEvents.invalid"),
      });
    }
  });
  const form = useForm<Record<string, string>>({
    resolver: zodResolver(schema),
    defaultValues: {
      ...Object.fromEntries(fields.map(({ name }) => [name, ""])),
      frequency: "",
      interestMethod: "",
      note: "",
      ...Object.fromEntries(Object.entries(event).map(([key, value]) => [key, String(value)])),
    },
  });
  const inherited = inheritedLoanSettings(metadata, eventIndex, form.watch("effectiveDate"));
  const busy = form.formState.isSubmitting || deleting;
  const save = async (replacement: LoanSheetEntry | null) => {
    setError(null);
    try {
      await onSave(replacement);
      onClose();
    } catch (cause) {
      setError(loanErrorText(t, cause, "asset:loanEvents.failed"));
    }
  };
  return (
    <Sheet open onOpenChange={(open) => !open && !busy && onClose()}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{t("asset:loanEvents.edit")}</SheetTitle>
          <SheetDescription>{t(`asset:loanOverview.event_${event.type}`)}</SheetDescription>
        </LoanSheetHeader>
        <Form {...form}>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={form.handleSubmit(async (values) => {
              const next = toEvent(values);
              if (isLoanSheetEntry(next)) await save(next);
            })}
          >
            <LoanSheetBody className="space-y-5">
              {fields.map(({ name, label, type }) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{label}</FormLabel>
                      <FormControl>
                        {type === "date" ? (
                          <DatePickerInput
                            value={field.value || undefined}
                            onChange={(date) => field.onChange(date ? formatDateISO(date) : "")}
                            onBlur={field.onBlur}
                            aria-label={label}
                            disabled={busy}
                          />
                        ) : (
                          <MoneyInput
                            name={field.name}
                            ref={field.ref}
                            value={field.value ?? ""}
                            onValueChange={(value, isUserEdit) => {
                              if (isUserEdit) field.onChange(value == null ? "" : String(value));
                            }}
                            onBlur={field.onBlur}
                            maxDecimalPlaces={name === "annualRate" ? 4 : 2}
                            aria-label={label}
                            disabled={busy}
                          />
                        )}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              {("frequency" in event || event.type === "renewal") && (
                <FormField
                  control={form.control}
                  name="frequency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("asset:loanActions.payment_frequency")}</FormLabel>
                      <FormControl>
                        <ResponsiveSelect
                          aria-label={t("asset:loanActions.payment_frequency")}
                          value={field.value || inherited.frequency}
                          onValueChange={field.onChange}
                          disabled={busy}
                          sheetTitle={t("asset:loanActions.payment_frequency")}
                          options={["monthly", "biweekly", "accelerated_biweekly"].map((value) => ({
                            value,
                            label: t(`asset:loanActions.${value}`),
                          }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              {event.type === "renewal" && (
                <FormField
                  control={form.control}
                  name="interestMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("asset:loanInterest.method")}</FormLabel>
                      <FormControl>
                        <LoanInterestMethodSelect
                          value={
                            isLoanInterestMethod(field.value)
                              ? field.value
                              : inherited.interestMethod
                          }
                          onChange={field.onChange}
                          disabled={busy}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:detailsSheet.notes")}</FormLabel>
                    <FormControl>
                      <Textarea {...field} value={field.value ?? ""} disabled={busy} rows={3} />
                    </FormControl>
                  </FormItem>
                )}
              />
              {error && (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
            </LoanSheetBody>
            <LoanSheetFooter className="flex-wrap">
              {confirmDelete && (
                <p className="text-muted-foreground w-full text-sm">
                  {t("asset:loanEvents.delete_warning")}
                </p>
              )}
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  setDeleting(true);
                  await save(null);
                  setDeleting(false);
                }}
              >
                {t(confirmDelete ? "asset:loanEvents.confirm_delete" : "common:delete")}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("common:save")}
              </Button>
            </LoanSheetFooter>
          </form>
        </Form>
      </LoanSheetContent>
    </Sheet>
  );
}
