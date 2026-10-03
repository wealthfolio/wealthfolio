import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { parseISO } from "date-fns";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { applyLoanAction } from "@/adapters";
import type { LoanAction } from "@/adapters/shared/alternative-assets";
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
import { loanBalanceUserNote } from "../lib/loan-balance";
import { confirmedLoanBalances } from "../lib/loan-presentation";
import {
  CloseLoanDialog,
  RecalculateScheduleDialog,
  LoanBalanceEventDialog,
} from "../components/loan-action-dialogs";
import { RenewLoanDialog, type LoanRenewalInput } from "../components/renew-loan-dialog";
import { isStaleLoanError, loanErrorText } from "../components/loan-error-text";

import { LoanEventSheet, type LoanSheetEntry } from "../components/loan-event-sheet";

export interface LoanActionCallbacks {
  editEvent: (index: number) => void;
  editBalance: (quote: Quote) => void;
  confirmBalance: () => void;
  extraPayment: () => void;
  renew: () => void;
  recalculate: () => void;
  close: () => void;
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
    await run(
      mode === "balance_correction"
        ? { type: "confirm_balance", date, balance: amount }
        : { type: "extra_repayment", date, amount },
    );
    setBalanceCorrectionOpen(false);
    setExtraRepaymentOpen(false);
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
    confirmBalance: () => setBalanceCorrectionOpen(true),
    extraPayment: () => setExtraRepaymentOpen(true),
    renew: () => setRenewLoanOpen(true),
    recalculate: () => setRecalculateScheduleOpen(true),
    close: () => setCloseLoanOpen(true),
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
            confirmations={confirmedLoanBalances(quoteHistory, today)}
            onSubmit={(date, amount) => handleBalanceEvent("extra_repayment", date, amount)}
          />
        </>
      ) : null,
  };
}
