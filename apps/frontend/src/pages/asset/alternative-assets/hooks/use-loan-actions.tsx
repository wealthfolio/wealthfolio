import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseISO } from "date-fns";
import { calculateLoan, recalculateLoan } from "@/adapters";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { useQuoteMutations } from "../../hooks/use-quote-mutations";
import { useAlternativeAssetMutations } from "./use-alternative-asset-mutations";
import { loanCalculationRequest, useLoanCalculation } from "./use-loan-calculation";
import {
  readActiveLoanProjection,
  canRenewLoan,
  appendLoanEvent,
  readLoanEvents,
  LOAN_RENEWAL_MATURITY_METADATA_KEY,
  type LoanEvent,
  type LoanMetadata,
} from "../lib/loan-events";
import {
  getLatestCurrentLoanBalance,
  loanEventProvenance,
  loanBalanceUserNote,
  editedLoanBalanceNotes,
} from "../lib/loan-balance";
import { hasBalanceDateConflict } from "../lib/loan-balance-editing";
import { confirmedLoanBalances } from "../lib/loan-presentation";
import {
  CloseLoanDialog,
  RecalculateScheduleDialog,
  RenewLoanDialog,
  LoanBalanceEventDialog,
  type LoanRenewalInput,
} from "../components/loan-action-dialogs";

import { LoanEventSheet, type LoanSheetEntry } from "../components/loan-event-sheet";
import { changeLoanEvent } from "../lib/loan-event-editing";

export interface LoanActionCallbacks {
  editEvent: (index: number) => void;
  editBalance: (quote: Quote) => void;
  confirmBalance: () => void;
  extraPayment: () => void;
  renew: () => void;
  recalculate: () => void;
  close: () => void;
}

function serializeLoanMetadataValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
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
  const currentBalance = calculation?.currentBalance ?? Math.abs(Number(holding?.marketValue ?? 0));
  const activeInterestRate = calculation?.annualRate ?? Number(metadata.interest_rate ?? 0);
  const endDate = storedProjection?.amortizationEndDate
    ? parseISO(storedProjection.amortizationEndDate)
    : null;
  const loanOriginationDate =
    typeof metadata.origination_date === "string" ? metadata.origination_date : undefined;
  // Loan sheets close on success, like event edits, so the generic quote toasts stay off.
  const { saveQuoteMutation, deleteQuoteMutation, invalidateQuoteQueries } = useQuoteMutations(
    assetId,
    { invalidateOnSuccess: false, notifyOnSuccess: false },
  );
  const { updateMetadataMutation } = useAlternativeAssetMutations();
  const [editingEvent, setEditingEvent] = useState<{ index: number; event: LoanEvent } | null>(
    null,
  );
  const handleEditEvent = async (replacement: LoanSheetEntry | null) => {
    if (!editingEvent || !holding || replacement?.type === "balance_correction") return;
    const next = changeLoanEvent(metadata, editingEvent.index, editingEvent.event, replacement);
    if (replacement?.type === "extra_repayment" && storedProjection) {
      const without = changeLoanEvent(metadata, editingEvent.index, editingEvent.event, null);
      const available = await calculateLoan(
        loanCalculationRequest(without, quoteHistory, replacement.effectiveDate),
      );
      if (!available || replacement.amount > available.currentBalance)
        throw new Error(t("asset:loanActions.validation.amount_exceeds_balance"));
    }
    await updateMetadataMutation.mutateAsync({
      assetId,
      metadata: Object.fromEntries(
        Object.entries(next).map(([key, value]) => [key, serializeLoanMetadataValue(value)]),
      ),
    });
    await invalidateQuoteQueries();
    setEditingEvent(null);
  };
  // Confirmed balances are quotes; they reuse the event sheet as a balance confirmation.
  const [editingBalance, setEditingBalance] = useState<Quote | null>(null);
  const handleEditBalance = async (replacement: LoanSheetEntry | null) => {
    if (!editingBalance) return;
    if (replacement && replacement.type !== "balance_correction") return;
    const previousDate = editingBalance.timestamp.slice(0, 10);
    if (
      replacement &&
      hasBalanceDateConflict(quoteHistory, editingBalance, replacement.effectiveDate)
    ) {
      throw new Error(t("asset:loanEvents.balance_date_occupied"));
    }
    if (replacement) {
      const date = replacement.effectiveDate;
      await saveQuoteMutation.mutateAsync({
        ...editingBalance,
        id: date === previousDate ? editingBalance.id : `${assetId}_${date}_MANUAL`,
        timestamp: `${date}T00:00:00Z`,
        open: replacement.balance,
        high: replacement.balance,
        low: replacement.balance,
        close: replacement.balance,
        adjclose: replacement.balance,
        notes: editedLoanBalanceNotes(editingBalance, replacement.balance, replacement.note),
      });
    }
    if (replacement?.effectiveDate !== previousDate)
      await deleteQuoteMutation.mutateAsync(editingBalance.id);
    await invalidateQuoteQueries();
    setEditingBalance(null);
  };
  const [closeLoanOpen, setCloseLoanOpen] = useState(false);
  const [recalculateScheduleOpen, setRecalculateScheduleOpen] = useState(false);
  const [renewLoanOpen, setRenewLoanOpen] = useState(false);
  const [balanceCorrectionOpen, setBalanceCorrectionOpen] = useState(false);
  const [extraRepaymentOpen, setExtraRepaymentOpen] = useState(false);

  const handleCloseLoan = async (date: Date) => {
    if (!holding) return;
    const quote: Quote = {
      id: "",
      createdAt: new Date().toISOString(),
      dataSource: "MANUAL",
      timestamp: `${formatDateISO(date)}T00:00:00Z`,
      assetId,
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      adjclose: 0,
      volume: 0,
      currency: holding.currency,
      notes: "loan_closed",
    };
    await saveQuoteMutation.mutateAsync(quote);
    await invalidateQuoteQueries();
    setCloseLoanOpen(false);
  };

  const handleRecalculateSchedule = async (newRate: number, effectiveDate: Date) => {
    if (!holding) return;
    const effectiveDay = formatDateISO(effectiveDate);
    const result = await recalculateLoan({
      ...loanCalculationRequest(metadata, quoteHistory, effectiveDay),
      annualRate: newRate,
    });
    if (!result) throw new Error(t("asset:loanEvents.invalid"));
    const payment = result.paymentAmount;
    let next = appendLoanEvent(metadata, {
      type: "rate_change",
      effectiveDate: effectiveDay,
      annualRate: newRate,
    });
    next = appendLoanEvent(next, {
      type: "payment_change",
      effectiveDate: effectiveDay,
      paymentAmount: payment,
    });
    await updateMetadataMutation.mutateAsync({
      assetId,
      metadata: Object.fromEntries(
        Object.entries(next).map(([key, value]) => [key, serializeLoanMetadataValue(value)]),
      ),
    });
    await invalidateQuoteQueries();
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
    const day = formatDateISO(effectiveDate);
    // The statement balance goes first: manual quotes are keyed by day, so a retry
    // after a failed renewal replaces it rather than duplicating it.
    if (balance !== undefined) {
      const existing = quoteHistory.find((quote) => quote.timestamp.slice(0, 10) === day);
      const provenance = { close: balance, notes: loanEventProvenance("balance_correction") };
      await saveQuoteMutation.mutateAsync({
        id: "",
        createdAt: new Date().toISOString(),
        dataSource: "MANUAL",
        timestamp: `${day}T00:00:00Z`,
        assetId,
        open: balance,
        high: balance,
        low: balance,
        close: balance,
        adjclose: balance,
        volume: 0,
        currency: holding.currency,
        notes: editedLoanBalanceNotes(provenance, balance, loanBalanceUserNote(existing?.notes)),
      });
    }
    const metadata = { ...(holding.metadata || {}) } as LoanMetadata;
    const nextMetadata = appendLoanEvent(metadata, {
      type: "renewal",
      effectiveDate: day,
      annualRate,
      ...(interestMethod ? { interestMethod } : {}),
      ...(frequency ? { frequency } : {}),
      ...(paymentAmount !== undefined ? { paymentAmount } : {}),
      ...(termEndDate ? { termEndDate: formatDateISO(termEndDate) } : {}),
    });
    const updates: Record<string, string> = Object.fromEntries(
      Object.entries(nextMetadata).map(([key, value]) => [key, serializeLoanMetadataValue(value)]),
    );
    // Only the latest dated renewal may replace the current term's maturity.
    const latestRenewal = readLoanEvents(nextMetadata)
      .filter((event) => event.type === "renewal")
      .at(-1);
    if (termEndDate && latestRenewal?.effectiveDate === day) {
      updates[LOAN_RENEWAL_MATURITY_METADATA_KEY] = formatDateISO(termEndDate);
    }
    await updateMetadataMutation.mutateAsync({ assetId, metadata: updates });
    await invalidateQuoteQueries();
    setRenewLoanOpen(false);
  };

  const handleBalanceEvent = async (
    mode: "balance_correction" | "extra_repayment",
    effectiveDate: Date,
    amount: number,
  ) => {
    if (!holding) return;
    const effectiveDay = formatDateISO(effectiveDate);
    if (loanOriginationDate && effectiveDay < loanOriginationDate)
      throw new Error(t("asset:loanEvents.invalid"));
    const calculation = await calculateLoan(
      loanCalculationRequest(metadata, quoteHistory, effectiveDay),
    );
    // Quotes are recorded on UTC calendar days, regardless of the user's timezone.
    const recordedBalance = getLatestCurrentLoanBalance(
      quoteHistory,
      new Date(`${effectiveDay}T23:59:59.999Z`),
    );
    if (mode === "extra_repayment" && !calculation && (storedProjection || !recordedBalance))
      throw new Error(t("asset:loanEvents.invalid"));
    const balanceAtDate = calculation?.currentBalance ?? Math.abs(recordedBalance?.close ?? 0);
    if (mode === "extra_repayment" && (amount <= 0 || amount > balanceAtDate))
      throw new Error(t("asset:loanActions.validation.amount_exceeds_balance"));
    const newBalance = mode === "balance_correction" ? amount : Math.max(0, balanceAtDate - amount);

    // Calculated loans store extra repayments as events; everything else is a confirmed balance.
    if (mode === "extra_repayment" && calculation) {
      const nextMetadata = appendLoanEvent(metadata, {
        type: "extra_repayment",
        effectiveDate: effectiveDay,
        amount,
      });
      await updateMetadataMutation.mutateAsync({
        assetId,
        metadata: Object.fromEntries(
          Object.entries(nextMetadata).map(([key, value]) => [
            key,
            serializeLoanMetadataValue(value),
          ]),
        ),
      });
    } else
      await saveQuoteMutation.mutateAsync({
        id: "",
        createdAt: new Date().toISOString(),
        dataSource: "MANUAL",
        timestamp: `${effectiveDay}T00:00:00Z`,
        assetId,
        open: newBalance,
        high: newBalance,
        low: newBalance,
        close: newBalance,
        adjclose: newBalance,
        volume: 0,
        currency: holding.currency,
        notes: loanEventProvenance(mode),
      });
    await invalidateQuoteQueries();
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
            confirmations={confirmedLoanBalances(quoteHistory, formatDateISO(new Date()))}
            onSubmit={(date, amount) => handleBalanceEvent("extra_repayment", date, amount)}
          />
        </>
      ) : null,
  };
}
