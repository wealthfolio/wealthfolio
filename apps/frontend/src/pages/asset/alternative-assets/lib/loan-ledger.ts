import { isClosedLoanBalance } from "./loan-balance";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import type { Quote } from "@/lib/types";
import { classifyLoanBalance } from "./loan-balance";
import {
  readActiveLoanProjection,
  readLoanEvents,
  type LoanEvent,
  type LoanPaymentFrequency,
} from "./loan-events";
import {
  balanceAt,
  confirmedLoanBalances,
  loanBalanceTimeline,
  loanMilestones,
} from "./loan-presentation";

export type LoanLedgerEntry =
  | {
      kind: "start";
      date: string;
      balance: number | null;
      annualRate: number | null;
      paymentAmount?: number;
      frequency?: LoanPaymentFrequency;
      scheduledPayoff?: string;
    }
  | {
      kind: "payment";
      date: string;
      balance: number;
      payment: number;
      principal: number;
      interest: number;
    }
  | {
      kind: "event";
      date: string;
      balance: number | null;
      event: LoanEvent;
      index: number;
      /** Applied total for this date; recorded event amounts remain available for editing. */
      extraTotalForDate?: number;
    }
  | {
      kind: "balance";
      date: string;
      balance: number;
      quote: Quote;
      adjustment?: number;
      type: "balance_correction" | "extra_repayment" | "closed";
    }
  | { kind: "maturity"; date: string; balance: number | null };

export type LoanLedgerView = "past" | "upcoming" | "events";

export interface LoanLedgerYear {
  year: string;
  entries: LoanLedgerEntry[];
  paid: number;
  principal: number;
  interest: number;
  extra: number;
  endBalance: number | null;
}

// Same-day order follows the engine: term changes, the payment, extra repayments,
// then the confirmed closing balance.
const KIND_ORDER: Record<LoanLedgerEntry["kind"], number> = {
  start: 0,
  event: 1,
  payment: 2,
  balance: 3,
  maturity: 4,
};
const rank = (entry: LoanLedgerEntry) =>
  entry.kind === "event" && entry.event.type === "extra_repayment" ? 2.5 : KIND_ORDER[entry.kind];
const chronological = (a: LoanLedgerEntry, b: LoanLedgerEntry) =>
  a.date.localeCompare(b.date) || rank(a) - rank(b);

/** One chronological ledger of scheduled payments, recorded events and confirmed balances. */
export function buildLoanLedger(
  calculation: LoanCalculation | null | undefined,
  quotes: Quote[],
  metadata: Record<string, unknown>,
  today: string,
): LoanLedgerEntry[] {
  const points = loanBalanceTimeline(calculation, quotes, today);
  const at = (date: string) => balanceAt(points, date);
  const origination =
    typeof metadata.origination_date === "string" ? metadata.origination_date : undefined;
  const confirmed = confirmedLoanBalances(quotes, today);
  const entries: LoanLedgerEntry[] = [];

  if (origination) {
    const original = Number(metadata.original_amount ?? metadata.purchase_price);
    const projection = readActiveLoanProjection(metadata);
    const rate = projection?.annualRate ?? Number(metadata.interest_rate);
    entries.push({
      kind: "start",
      date: origination,
      balance: Number.isFinite(original) && original > 0 ? original : at(origination),
      annualRate: Number.isFinite(rate) ? rate : null,
      paymentAmount: projection?.paymentAmount,
      frequency: projection?.frequency,
      scheduledPayoff: loanMilestones(calculation, metadata, today).horizon,
    });
  }
  for (const row of calculation?.rows ?? []) {
    if (!row.scheduledPayment || row.payment <= 0) continue;
    entries.push({
      kind: "payment",
      date: row.date,
      balance: row.balance,
      payment: row.payment - row.extraPayment,
      principal: row.principal - row.extraPayment,
      interest: row.interest,
    });
  }
  for (const quote of confirmed) {
    const date = quote.timestamp.slice(0, 10);
    // Even an origination-day confirmation remains authoritative and editable.
    entries.push({
      kind: "balance",
      date,
      balance: Math.abs(quote.close),
      quote,
      adjustment: calculation?.rows.find((row) => row.date === date && row.confirmed)
        ?.balanceAdjustment,
      type: isClosedLoanBalance(quote)
        ? "closed"
        : classifyLoanBalance(quote) === "extra_repayment"
          ? "extra_repayment"
          : "balance_correction",
    });
  }
  readLoanEvents(metadata).forEach((event, index) => {
    entries.push({
      kind: "event",
      date: event.effectiveDate,
      balance: at(event.effectiveDate),
      event,
      index,
      ...(event.type === "extra_repayment"
        ? {
            extraTotalForDate: calculation?.rows.find((row) => row.date === event.effectiveDate)
              ?.extraPayment,
          }
        : {}),
    });
  });
  const { maturity, upcomingRenewal } = loanMilestones(calculation, metadata, today);
  if (
    maturity &&
    upcomingRenewal &&
    !entries.some(
      (entry) =>
        entry.kind === "event" && entry.event.type === "renewal" && entry.date === maturity,
    )
  )
    entries.push({ kind: "maturity", date: maturity, balance: at(maturity) });

  return entries.sort(chronological);
}

/** Past and event views read newest first; upcoming reads forward from today. */
export function loanLedgerView(
  entries: LoanLedgerEntry[],
  view: LoanLedgerView,
  today: string,
): LoanLedgerEntry[] {
  if (view === "upcoming") return entries.filter((entry) => entry.date > today);
  const visible =
    view === "events"
      ? entries.filter((entry) => entry.kind !== "payment")
      : entries.filter((entry) => entry.date <= today);
  return [...visible].reverse();
}

/** Group entries by calendar year, keeping their order, with totals for the shown entries. */
// Runs of plain payments longer than this collapse behind a "more payments" row.
const PAYMENT_RUN_LIMIT = 2;

/** A ledger entry, or the row standing in for the rest of a collapsed payment run. */
export type LoanLedgerItem = LoanLedgerEntry | { more: string; count: number };

/**
 * Collapse each run of consecutive payments longer than the limit to its first payment and
 * a "more" row, unless the run is open. A run's key is `${group}:${first payment date}`.
 */
export function collapsePaymentRuns(
  group: string,
  entries: LoanLedgerEntry[],
  openRuns: ReadonlySet<string>,
): LoanLedgerItem[] {
  const items: LoanLedgerItem[] = [];
  let run: LoanLedgerEntry[] = [];
  const flush = () => {
    const key = `${group}:${run[0]?.date}`;
    if (run.length <= PAYMENT_RUN_LIMIT || openRuns.has(key)) items.push(...run);
    else items.push(run[0], { more: key, count: run.length - 1 });
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === "payment") run.push(entry);
    else {
      flush();
      items.push(entry);
    }
  }
  flush();
  return items;
}

export function groupLoanLedger(entries: LoanLedgerEntry[]): LoanLedgerYear[] {
  const years: LoanLedgerYear[] = [];
  const countedExtraDates = new Set<string>();
  for (const entry of entries) {
    const year = entry.date.slice(0, 4);
    let group = years.at(-1);
    if (group?.year !== year) {
      group = { year, entries: [], paid: 0, principal: 0, interest: 0, extra: 0, endBalance: null };
      years.push(group);
    }
    group.entries.push(entry);
    if (entry.kind === "payment") {
      group.paid += entry.payment;
      group.principal += entry.principal;
      group.interest += entry.interest;
    }
    if (entry.kind === "event" && entry.event.type === "extra_repayment") {
      if (entry.extraTotalForDate == null) group.extra += entry.event.amount;
      else if (!countedExtraDates.has(entry.date)) {
        group.extra += entry.extraTotalForDate;
        countedExtraDates.add(entry.date);
      }
    }
  }
  for (const group of years) {
    const last = group.entries
      .filter((entry) => entry.balance != null)
      .sort(chronological)
      .at(-1);
    group.endBalance = last?.balance ?? null;
  }
  return years;
}
