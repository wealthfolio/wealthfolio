import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { parseISO } from "date-fns";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { applyLoanAction, createActivity, linkLoanPayment } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { QueryKeys } from "@/lib/query-keys";
import type { LoanAction, PaymentAllocation } from "@/adapters/shared/alternative-assets";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { useQuoteMutations } from "../../hooks/use-quote-mutations";
import { invalidateAlternativeAssetQueries } from "./use-alternative-asset-mutations";
import { useLoanCalculation, useLoanToday } from "./use-loan-calculation";
import {
  readActiveLoanProjection,
  canRenewLoan,
  readLoanEvents,
  LOAN_RENEWAL_MATURITY_METADATA_KEY,
  type LoanEvent,
} from "../lib/loan-events";
import { paymentAccounts } from "../lib/loan-payments";
import { loanBalanceUserNote } from "../lib/loan-balance";
import { balanceAt, confirmedLoanBalances, loanBalanceTimeline } from "../lib/loan-presentation";
import {
  CloseLoanDialog,
  RecalculateScheduleDialog,
  LoanBalanceEventDialog,
} from "../components/loan-action-dialogs";
import { RenewLoanDialog, type LoanRenewalInput } from "../components/renew-loan-dialog";
import { isStaleLoanError, loanErrorText } from "../components/loan-error-text";

import { LoanEventSheet, type LoanSheetEntry } from "../components/loan-event-sheet";
import { LoanPaymentsSheet } from "../components/loan-payments-sheet";

export interface LoanActionCallbacks {
  editEvent: (index: number) => void;
  /** Link or unlink the withdrawals paying an instalment, or extra principal when null. */
  editPayments: (dueDate: string | null, allocations: PaymentAllocation[]) => void;
  editBalance: (quote: Quote) => void;
  confirmBalance: () => void;
  extraPayment: () => void;
  renew: () => void;
  recalculate: () => void;
  close: () => void;
  /** Record a dated payment change, as repeated payment differences suggest. */
  changePayment: (date: string, paymentAmount: number) => Promise<void>;
}

/** One owner at the asset page level, shared by the header and both tabs. */
export function useLoanActions(
  holding: AlternativeAssetHolding | null | undefined,
  quoteHistory: Quote[],
) {
  const { t } = useTranslation();
  const assetId = holding?.id ?? "";
  const isLiability = holding?.kind.toLowerCase() === "liability";
  const metadata = useMemo(() => holding?.metadata ?? {}, [holding?.metadata]);
  const storedProjection = readActiveLoanProjection(metadata);
  const { data: calculation } = useLoanCalculation(assetId, metadata, quoteHistory, isLiability);
  const today = useLoanToday();
  const currentBalance = calculation?.currentBalance ?? Math.abs(Number(holding?.marketValue ?? 0));
  const activeInterestRate = calculation?.annualRate ?? Number(metadata.interest_rate ?? 0);
  const endDate = storedProjection?.amortizationEndDate
    ? parseISO(storedProjection.amortizationEndDate)
    : null;
  const loanOriginationDate =
    typeof metadata.origination_date === "string" ? metadata.origination_date : undefined;
  const queryClient = useQueryClient();
  const { invalidateQuoteQueries } = useQuoteMutations(assetId);
  const refresh = () =>
    Promise.all([invalidateAlternativeAssetQueries(queryClient), invalidateQuoteQueries()]);
  // The backend checks each action against the stored loan and applies it in one transaction.
  const run = async (action: LoanAction) => {
    try {
      await applyLoanAction(assetId, action);
    } catch (cause) {
      if (isStaleLoanError(cause)) await refresh();
      throw cause;
    }
    await refresh();
  };
  const [editingEvent, setEditingEvent] = useState<{ index: number; event: LoanEvent } | null>(
    null,
  );
  const handleEditEvent = async (replacement: LoanSheetEntry | null) => {
    if (!editingEvent || !holding || replacement?.type === "balance_correction") return;
    await run({
      type: "edit_event",
      index: editingEvent.index,
      original: editingEvent.event,
      replacement,
    });
    setEditingEvent(null);
  };
  // Confirmed balances are quotes; they reuse the event sheet as a balance confirmation.
  const [editingBalance, setEditingBalance] = useState<Quote | null>(null);
  const handleEditBalance = async (replacement: LoanSheetEntry | null) => {
    if (!editingBalance) return;
    if (replacement && replacement.type !== "balance_correction") return;
    await run({
      type: "edit_balance",
      quoteId: editingBalance.id,
      replacement: replacement
        ? {
            date: replacement.effectiveDate,
            balance: replacement.balance,
            note: replacement.note ?? "",
          }
        : null,
    });
    setEditingBalance(null);
  };
  const [editingPayments, setEditingPayments] = useState<{
    dueDate: string | null;
    allocations: PaymentAllocation[];
  } | null>(null);
  const { accounts } = useAccounts({ filterActive: false });
  // Paid from applies only while its account can take payments.
  const paymentAccount = paymentAccounts(accounts, holding?.currency ?? "").find(
    (account) => account.id === metadata.payment_account_id,
  );
  const paymentAccountId = paymentAccount?.id;
  const paidFrom = paymentAccount?.name;
  const [closeLoanOpen, setCloseLoanOpen] = useState(false);
  const [recalculateScheduleOpen, setRecalculateScheduleOpen] = useState(false);
  const [renewLoanOpen, setRenewLoanOpen] = useState(false);
  const [balanceCorrectionOpen, setBalanceCorrectionOpen] = useState(false);
  const [extraRepaymentOpen, setExtraRepaymentOpen] = useState(false);

  const handleCloseLoan = async (date: Date) => {
    if (!holding) return;
    try {
      await run({ type: "close", date: formatDateISO(date) });
      setCloseLoanOpen(false);
    } catch (cause) {
      toast({ title: loanErrorText(t, cause, "asset:loanEvents.failed"), variant: "destructive" });
    }
  };

  const handleRecalculateSchedule = async (newRate: number, effectiveDate: Date) => {
    if (!holding) return;
    await run({ type: "recalculate", date: formatDateISO(effectiveDate), annualRate: newRate });
    setRecalculateScheduleOpen(false);
  };

  const handleRenewLoan = async ({
    effectiveDate,
    annualRate,
    paymentAmount,
    frequency,
    interestMethod,
    termEndDate,
    balance,
  }: LoanRenewalInput) => {
    if (!holding) return;
    await run({
      type: "renew",
      date: formatDateISO(effectiveDate),
      annualRate,
      paymentAmount,
      frequency,
      interestMethod,
      termEndDate: termEndDate ? formatDateISO(termEndDate) : undefined,
      balance,
    });
    setRenewLoanOpen(false);
  };

  const handleBalanceEvent = async (
    mode: "balance_correction" | "extra_repayment",
    effectiveDate: Date,
    amount: number,
  ) => {
    if (!holding) return;
    const date = formatDateISO(effectiveDate);
    if (mode === "extra_repayment" && paymentAccountId && storedProjection) {
      await recordExtraWithdrawal(paymentAccountId, date, amount);
    } else {
      await run(
        mode === "balance_correction"
          ? { type: "confirm_balance", date, balance: amount }
          : { type: "extra_repayment", date, amount },
      );
    }
    setBalanceCorrectionOpen(false);
    setExtraRepaymentOpen(false);
  };

  // With a "Paid from" account, the withdrawal is the repayment. It is checked
  // against the balance first, so the usual refusal never leaves a withdrawal behind.
  const recordExtraWithdrawal = async (accountId: string, date: string, amount: number) => {
    // The engine counts no payment before its history starts, so cash would leave
    // without the debt changing; a loan event before origination is refused too.
    const start = calculation?.calculationStartDate ?? loanOriginationDate;
    if (start && date < start) throw new Error("LOAN_INVALID");
    const balance = balanceAt(loanBalanceTimeline(calculation, quoteHistory, today), date);
    if (balance != null && amount > balance) throw new Error("LOAN_AMOUNT_EXCEEDS_BALANCE");
    // Linking would refuse a withdrawal that is an extra repayment already recorded.
    const cents = (value: number) => Math.round(value * 100);
    const recorded = readLoanEvents(metadata).some(
      (event) =>
        event.type === "extra_repayment" &&
        event.effectiveDate === date &&
        cents(event.amount) === cents(amount),
    );
    if (recorded) throw new Error("LOAN_EXTRA_ALREADY_RECORDED");
    const withdrawal = await createActivity({
      accountId,
      activityType: "WITHDRAWAL",
      activityDate: date,
      amount,
      currency: holding!.currency,
    });
    try {
      await linkLoanPayment(withdrawal.id, {
        type: "link",
        loanId: assetId,
        appliesTo: "extra",
        escrow: 0,
      });
    } finally {
      // Refresh either way: an unlinked withdrawal is then offered for linking.
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] }),
      ]);
    }
  };

  const isMortgage = (metadata.sub_type ?? metadata.liability_type) === "mortgage";
  const availability = {
    mortgage: isMortgage,
    recalculate: !!storedProjection,
    renew: canRenewLoan(metadata),
  };
  const actions: LoanActionCallbacks = {
    editEvent: (index) => {
      const event = readLoanEvents(metadata)[index];
      if (event) setEditingEvent({ index, event });
    },
    editBalance: setEditingBalance,
    editPayments: (dueDate, allocations) => setEditingPayments({ dueDate, allocations }),
    confirmBalance: () => setBalanceCorrectionOpen(true),
    extraPayment: () => setExtraRepaymentOpen(true),
    renew: () => setRenewLoanOpen(true),
    recalculate: () => setRecalculateScheduleOpen(true),
    close: () => setCloseLoanOpen(true),
    changePayment: async (date, paymentAmount) => {
      try {
        await run({ type: "change_payment", date, paymentAmount });
      } catch (cause) {
        toast({
          title: loanErrorText(t, cause, "asset:loanEvents.failed"),
          variant: "destructive",
        });
      }
    },
  };
  return {
    actions,
    availability,
    dialogs:
      isLiability && holding ? (
        <>
          {editingEvent && (
            <LoanEventSheet
              key={JSON.stringify(editingEvent)}
              event={editingEvent.event}
              metadata={metadata}
              eventIndex={editingEvent.index}
              originationDate={loanOriginationDate}
              onClose={() => setEditingEvent(null)}
              onSave={handleEditEvent}
            />
          )}
          {editingPayments && (
            <LoanPaymentsSheet
              loanId={assetId}
              currency={holding.currency}
              paymentAccountId={paymentAccountId}
              dueDate={editingPayments.dueDate}
              allocations={editingPayments.allocations}
              onClose={() => setEditingPayments(null)}
            />
          )}
          {editingBalance && (
            <LoanEventSheet
              key={editingBalance.id}
              event={{
                type: "balance_correction",
                effectiveDate: editingBalance.timestamp.slice(0, 10),
                balance: Math.abs(editingBalance.close),
                note: loanBalanceUserNote(editingBalance.notes),
              }}
              originationDate={loanOriginationDate}
              onClose={() => setEditingBalance(null)}
              onSave={handleEditBalance}
            />
          )}
          <CloseLoanDialog
            open={closeLoanOpen}
            onOpenChange={setCloseLoanOpen}
            onSubmit={handleCloseLoan}
            originationDate={loanOriginationDate ? parseISO(loanOriginationDate) : null}
          />
          <RecalculateScheduleDialog
            open={recalculateScheduleOpen}
            onOpenChange={setRecalculateScheduleOpen}
            currency={holding.currency}
            interestRate={activeInterestRate}
            endDate={endDate}
            assetId={assetId}
            metadata={metadata}
            quoteHistory={quoteHistory}
            onSubmit={handleRecalculateSchedule}
          />
          <RenewLoanDialog
            open={renewLoanOpen}
            onOpenChange={setRenewLoanOpen}
            assetId={assetId}
            currency={holding.currency}
            interestRate={activeInterestRate}
            metadata={metadata}
            quoteHistory={quoteHistory}
            maturity={
              typeof metadata[LOAN_RENEWAL_MATURITY_METADATA_KEY] === "string"
                ? parseISO(metadata[LOAN_RENEWAL_MATURITY_METADATA_KEY])
                : null
            }
            mortgage={isMortgage}
            onSubmit={handleRenewLoan}
          />
          <LoanBalanceEventDialog
            open={balanceCorrectionOpen}
            onOpenChange={setBalanceCorrectionOpen}
            mode="balance_correction"
            currentBalance={currentBalance}
            currency={holding.currency}
            onSubmit={(date, amount) => handleBalanceEvent("balance_correction", date, amount)}
          />
          <LoanBalanceEventDialog
            open={extraRepaymentOpen}
            onOpenChange={setExtraRepaymentOpen}
            mode="extra_repayment"
            currentBalance={currentBalance}
            currency={holding.currency}
            paidFrom={storedProjection ? paidFrom : undefined}
            confirmations={confirmedLoanBalances(quoteHistory, today)}
            onSubmit={(date, amount) => handleBalanceEvent("extra_repayment", date, amount)}
          />
        </>
      ) : null,
  };
}
