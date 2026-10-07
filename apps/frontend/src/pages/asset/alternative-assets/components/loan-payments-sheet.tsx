import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, parseISO } from "date-fns";
import { Button, Icons, useAmountFormatting, useDateFormatting } from "@wealthfolio/ui";
import { Sheet, SheetDescription, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { linkLoanPayment, searchActivities } from "@/adapters";
import type { PaymentAllocation } from "@/adapters/shared/alternative-assets";
import { useAccounts } from "@/hooks/use-accounts";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import { formatDateISO } from "@/lib/utils";
import { invalidateAlternativeAssetQueries } from "../hooks/use-alternative-asset-mutations";
import { activityDay, isPaymentCandidate } from "../lib/loan-payments";
import { loanErrorText } from "./loan-error-text";
import {
  LoanSheetBody,
  LoanSheetContent,
  LoanSheetFooter,
  LoanSheetHeader,
} from "./loan-sheet-content";

/** Withdrawals within this many days of a due date are offered for linking. */
const CANDIDATE_DAYS = 15;

interface LoanPaymentsSheetProps {
  loanId: string;
  currency: string;
  /** The loan's "Paid from" account, where untagged withdrawals are suggested. */
  paymentAccountId?: string;
  /** The instalment being paid, or null for extra principal paid from an account. */
  dueDate: string | null;
  /** Withdrawals already counted toward it. */
  allocations: PaymentAllocation[];
  onClose: () => void;
}

/** Links withdrawals to an instalment, or unlinks those already counted. */
export function LoanPaymentsSheet({
  loanId,
  currency,
  paymentAccountId,
  dueDate,
  allocations,
  onClose,
}: LoanPaymentsSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const dates = useDateFormatting();
  const { formatAmount } = useAmountFormatting();
  const { accounts } = useAccounts({ filterActive: false });
  const { settings } = useSettingsContext();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? t("asset:loanPayments.account");
  const day = (date: string) =>
    dates.formatCalendarDate(date, { day: "numeric", month: "short", year: "numeric" });

  const searchable = dueDate != null && paymentAccountId != null;
  const { data: candidates = [], isLoading } = useQuery({
    queryKey: [QueryKeys.ACTIVITIES, "loan-payment-candidates", paymentAccountId, dueDate],
    queryFn: async () => {
      const due = parseISO(dueDate!);
      // Pages are numbered from zero.
      const result = await searchActivities(
        0,
        50,
        {
          accountIds: paymentAccountId,
          activityTypes: "WITHDRAWAL",
          dateFrom: formatDateISO(addDays(due, -CANDIDATE_DAYS)),
          dateTo: formatDateISO(addDays(due, CANDIDATE_DAYS)),
        },
        "",
        { id: "date", desc: false },
      );
      return result.data.filter((activity) => isPaymentCandidate(activity, currency));
    },
    enabled: searchable,
  });

  const change = async (activityId: string, link: Parameters<typeof linkLoanPayment>[1]) => {
    setBusy(activityId);
    setError(null);
    try {
      await linkLoanPayment(activityId, link);
      await Promise.all([
        invalidateAlternativeAssetQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] }),
      ]);
      onClose();
    } catch (cause) {
      setError(loanErrorText(t, cause, "asset:loanEvents.failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && onClose()}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{t("asset:loanPayments.sheet_title")}</SheetTitle>
          <SheetDescription>
            {dueDate
              ? t("asset:loanPayments.instalment_due", { date: day(dueDate) })
              : t("asset:loanPayments.extra_description")}
          </SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody className="space-y-5">
          {allocations.length > 0 && (
            <section className="space-y-2" aria-label={t("asset:loanPayments.linked")}>
              <h3 className="text-sm font-medium">{t("asset:loanPayments.linked")}</h3>
              {allocations.map((allocation) => (
                <div
                  key={allocation.activityId}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <span>
                    {day(allocation.date)} · {accountName(allocation.accountId)}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">
                      {formatAmount(
                        allocation.applied + allocation.extra + allocation.escrow,
                        currency,
                      )}
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy != null}
                      onClick={() => change(allocation.activityId, { type: "unlink" })}
                    >
                      {busy === allocation.activityId && (
                        <Icons.Spinner className="mr-1 size-3 animate-spin" />
                      )}
                      {t("asset:loanPayments.unlink")}
                    </Button>
                  </span>
                </div>
              ))}
            </section>
          )}
          {dueDate != null && (
            <section className="space-y-2" aria-label={t("asset:loanPayments.candidates")}>
              <h3 className="text-sm font-medium">{t("asset:loanPayments.candidates")}</h3>
              {!paymentAccountId ? (
                <p className="text-muted-foreground text-sm">
                  {t("asset:loanPayments.needs_account")}
                </p>
              ) : isLoading ? (
                <Icons.Spinner className="text-muted-foreground size-4 animate-spin" />
              ) : candidates.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t("asset:loanPayments.no_candidates", {
                    account: accountName(paymentAccountId),
                    count: CANDIDATE_DAYS,
                  })}
                </p>
              ) : (
                candidates.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {day(activityDay(activity, settings?.timezone))}
                      {activity.comment ? ` · ${activity.comment}` : ""}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">
                        {formatAmount(Math.abs(Number(activity.amount ?? 0)), currency)}
                      </span>
                      <Button
                        size="xs"
                        disabled={busy != null}
                        onClick={() =>
                          change(activity.id, { type: "link", loanId, appliesTo: dueDate })
                        }
                      >
                        {busy === activity.id && (
                          <Icons.Spinner className="mr-1 size-3 animate-spin" />
                        )}
                        {t("asset:loanPayments.link")}
                      </Button>
                    </span>
                  </div>
                ))
              )}
            </section>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </LoanSheetBody>
        <LoanSheetFooter>
          <Button variant="outline" onClick={onClose} disabled={busy != null}>
            {t("common:close")}
          </Button>
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}
