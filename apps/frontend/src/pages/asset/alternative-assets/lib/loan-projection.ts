import type { Quote } from "@/lib/types";
import { isValid, parseISO } from "date-fns";
import { getLatestCurrentLoanBalance } from "./loan-balance";
import {
  calculateLoanEndDate,
  projectLoanFromEvents,
  type DatedLoanProjectionRow,
  type LoanProjection,
} from "./loan-calculator";
import {
  readLoanEvents,
  readLoanProjectionMetadata,
  type LoanPaymentFrequency,
} from "./loan-events";
import { getRemainingScheduleWindow } from "./loan-schedule";

export interface RemainingLoanProjection {
  latestBalance: Quote;
  annualRate: number;
  paymentAmount: number;
  frequency: LoanPaymentFrequency;
  projection: LoanProjection;
}

/**
 * Build the only forward-looking projection used by liability UI consumers.
 * Confirmed balances remain authoritative; events already reflected by the
 * latest balance update the active terms but are not applied to the balance a
 * second time.
 */
export function getRemainingLoanProjection(
  metadata: Record<string, unknown>,
  quoteHistory: Quote[],
): RemainingLoanProjection | null {
  const storedProjection = readLoanProjectionMetadata(metadata);
  const latestBalance = getLatestCurrentLoanBalance(quoteHistory);
  if (!storedProjection || !latestBalance || Math.abs(latestBalance.close) <= 0) return null;

  const latestDay = latestBalance.timestamp.slice(0, 10);
  const events = readLoanEvents(metadata);
  let annualRate = storedProjection.annualRate;
  let paymentAmount = storedProjection.paymentAmount;
  let frequency = storedProjection.frequency;
  let termEndDate = storedProjection.termEndDate;

  for (const event of events) {
    if (event.effectiveDate > latestDay) continue;
    switch (event.type) {
      case "rate_change":
        annualRate = event.annualRate;
        break;
      case "payment_change":
        paymentAmount = event.paymentAmount;
        break;
      case "payment_frequency_change":
        frequency = event.frequency;
        break;
      case "renewal":
        annualRate = event.annualRate;
        paymentAmount = event.paymentAmount ?? paymentAmount;
        frequency = event.frequency ?? frequency;
        termEndDate = event.termEndDate ?? termEndDate;
        break;
      case "balance_correction":
      case "extra_repayment":
        break;
    }
  }

  const metadataEndDate = typeof metadata.end_date === "string" ? metadata.end_date : undefined;
  const parsedFirstPaymentDate = parseISO(storedProjection.firstPaymentDate);
  const parsedEndDate = parseOptionalDate(metadataEndDate ?? termEndDate);
  const contractualEndDate =
    parsedEndDate ??
    (storedProjection.paymentCount
      ? calculateLoanEndDate(parsedFirstPaymentDate, storedProjection.paymentCount, frequency)
      : null);
  if (!contractualEndDate) return null;

  const remainingWindow = getRemainingScheduleWindow(
    parsedFirstPaymentDate,
    new Date(latestBalance.timestamp),
    contractualEndDate,
    frequency,
  );
  if (!remainingWindow) return null;

  const projection = projectLoanFromEvents({
    principal: Math.abs(latestBalance.close),
    annualRate,
    paymentAmount,
    paymentCount: remainingWindow.paymentCount,
    frequency,
    firstPaymentDate: remainingWindow.firstPaymentDate,
    events: events.filter((event) => event.effectiveDate > latestDay),
  });

  return { latestBalance, annualRate, paymentAmount, frequency, projection };
}

function parseOptionalDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

export interface LoanChartPoint {
  timestamp: string;
  totalValue: number;
}

export interface LoanChartData {
  data: LoanChartPoint[];
  splitPercent: number;
  todayTimestamp: string | null;
}

/** Merge confirmed history with rows produced by the shared projection engine. */
export function buildLoanChartData(
  historicalData: LoanChartPoint[],
  projectedRows: DatedLoanProjectionRow[],
  now = new Date(),
): LoanChartData {
  const confirmed = historicalData
    .filter((point) => new Date(point.timestamp) <= now)
    .map((point) => ({ ...point }));
  const confirmedDays = new Set(confirmed.map((point) => point.timestamp.slice(0, 10)));
  const projected = projectedRows
    .filter((row) => !confirmedDays.has(formatLocalDay(row.paymentDate)))
    .map((row) => ({
      timestamp: row.paymentDate.toISOString(),
      totalValue: row.closingBalance,
    }));
  const data = [...confirmed, ...projected].sort(
    (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
  if (data.length === 0) return { data: [], splitPercent: 100, todayTimestamp: null };

  let lastElapsedIndex = -1;
  for (let index = 0; index < data.length; index += 1) {
    if (new Date(data[index].timestamp) <= now) lastElapsedIndex = index;
  }
  const hasFuture = lastElapsedIndex >= 0 && lastElapsedIndex < data.length - 1;
  if (!hasFuture) {
    return {
      data,
      splitPercent: 100,
      todayTimestamp: lastElapsedIndex >= 0 ? data[lastElapsedIndex].timestamp : null,
    };
  }

  return {
    data,
    splitPercent: data.length === 1 ? 100 : (lastElapsedIndex / (data.length - 1)) * 100,
    todayTimestamp: data[lastElapsedIndex].timestamp,
  };
}

function formatLocalDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
