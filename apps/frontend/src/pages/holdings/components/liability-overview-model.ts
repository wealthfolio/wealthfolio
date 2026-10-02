import { differenceInCalendarDays, parseISO } from "date-fns";
import type { AlternativeAssetHolding } from "@/lib/types";
import {
  readActiveLoanProjection,
  LOAN_RENEWAL_MATURITY_METADATA_KEY,
  getLoanFrequencyAtDate,
  readLoanEvents,
  type LoanPaymentFrequency,
} from "@/pages/asset/alternative-assets/lib/loan-events";
import { getLoanPeriodsPerYear } from "@/pages/asset/alternative-assets/lib/loan-calculator";
import { RENEWAL_SOON_DAYS } from "@/pages/asset/alternative-assets/lib/loan-presentation";

/** A manually tracked balance older than this asks for an update. */
const STALE_MANUAL_DAYS = 180;

export type LiabilityStatus = "paid_off" | "renewal_due" | "renew_soon" | "update_balance";

export interface LiabilityCardModel {
  type: string;
  balance: number;
  original: number | null;
  /** Share of the original principal repaid, 0–1. */
  paidShare: number | null;
  /** Balance comes from a recorded payment schedule rather than manual updates. */
  scheduled: boolean;
  /** Terms in effect today, from the projection and dated events. */
  rate: number | null;
  payment: number | null;
  frequency: LoanPaymentFrequency | null;
  status: LiabilityStatus | null;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function liabilityCardModel(
  holding: AlternativeAssetHolding,
  today: string,
): LiabilityCardModel {
  const metadata = holding.metadata ?? {};
  const projection = readActiveLoanProjection(metadata);
  const subType = metadata.sub_type ?? metadata.liability_type;
  const balance = Math.abs(Number(holding.marketValue) || 0);
  const original = positive(metadata.original_amount ?? metadata.purchase_price);
  let rate =
    projection?.annualRate ??
    (Number.isFinite(Number(metadata.interest_rate)) ? Number(metadata.interest_rate) : null);
  let payment = projection?.paymentAmount ?? null;
  for (const event of readLoanEvents(metadata)) {
    if (event.effectiveDate > today) break;
    if (event.type === "rate_change" || event.type === "renewal") rate = event.annualRate;
    if (event.type === "payment_change") payment = event.paymentAmount;
    if (event.type === "renewal" && event.paymentAmount !== undefined)
      payment = event.paymentAmount;
  }
  const maturity = metadata[LOAN_RENEWAL_MATURITY_METADATA_KEY];
  const daysToMaturity =
    typeof maturity === "string"
      ? differenceInCalendarDays(parseISO(maturity), parseISO(today))
      : Number.NaN;
  const daysSinceUpdate = differenceInCalendarDays(
    parseISO(today),
    parseISO(holding.valuationDate.slice(0, 10)),
  );
  const status: LiabilityStatus | null =
    balance === 0
      ? "paid_off"
      : daysToMaturity < 0
        ? "renewal_due"
        : daysToMaturity <= RENEWAL_SOON_DAYS
          ? "renew_soon"
          : !projection && daysSinceUpdate > STALE_MANUAL_DAYS
            ? "update_balance"
            : null;
  return {
    type: typeof subType === "string" && subType ? subType : "other",
    balance,
    original,
    paidShare: original ? Math.max(0, Math.min(1, (original - balance) / original)) : null,
    scheduled: !!projection,
    rate: rate != null && Number.isFinite(rate) ? rate : null,
    payment: projection && payment != null && payment > 0 ? payment : null,
    frequency: projection ? getLoanFrequencyAtDate(metadata, today) : null,
    status,
  };
}

export interface LiabilitySummary {
  owed: number;
  paidDown: number;
  /** Share repaid across liabilities with a known original amount. */
  overall: number | null;
  /** Scheduled payments converted to a monthly amount. */
  monthly: number;
}

/** Totals for liabilities in one currency; mixed currencies cannot be added up here. */
export function liabilitySummary(models: LiabilityCardModel[]): LiabilitySummary {
  const withOriginal = models.filter((model) => model.original != null);
  const original = withOriginal.reduce((sum, model) => sum + model.original!, 0);
  const paidDown = withOriginal.reduce(
    (sum, model) => sum + Math.max(0, model.original! - model.balance),
    0,
  );
  return {
    owed: models.reduce((sum, model) => sum + model.balance, 0),
    paidDown,
    overall: original > 0 ? paidDown / original : null,
    monthly: models.reduce(
      (sum, model) =>
        model.payment != null && model.frequency && model.balance > 0
          ? sum + (model.payment * getLoanPeriodsPerYear(model.frequency)) / 12
          : sum,
      0,
    ),
  };
}
