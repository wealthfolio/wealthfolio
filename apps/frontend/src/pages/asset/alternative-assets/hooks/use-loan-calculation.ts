import { useQuery } from "@tanstack/react-query";
import { calculateLoan, getLoanPayments } from "@/adapters";
import type { LoanPayment } from "@/adapters/shared/alternative-assets";
import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Quote } from "@/lib/types";
import {
  appendLoanEvent,
  readActiveLoanProjection,
  type LoanInterestMethod,
  type LoanPaymentFrequency,
} from "../lib/loan-events";

/** Today in the settings timezone: the day holdings and net worth value loans on. */
export function useLoanToday(): string {
  const { settings } = useSettingsContext();
  return formatZonedDateKey(new Date(), settings?.timezone);
}

export function loanCalculationRequest(
  metadata: Record<string, unknown>,
  quotes: Quote[],
  asOf: string,
  payments: LoanPayment[] = [],
) {
  return {
    metadata,
    balances: quotes.map((quote) => ({
      date: quote.timestamp.slice(0, 10),
      balance: Math.abs(quote.close),
      notes: quote.notes,
    })),
    asOf,
    payments,
  };
}

/**
 * Preview a drafted renewal: the renewal is added at its date, and a stated
 * balance replaces any balance recorded that day.
 */
export function loanRenewalEstimateRequest(
  metadata: Record<string, unknown>,
  quotes: Quote[],
  renewal: {
    effectiveDate: string;
    annualRate: number;
    frequency?: LoanPaymentFrequency;
    interestMethod?: LoanInterestMethod;
    balance?: number;
  },
  payments: LoanPayment[] = [],
) {
  const { effectiveDate: day, annualRate, frequency, interestMethod, balance } = renewal;
  return {
    ...loanCalculationRequest(
      appendLoanEvent(metadata, {
        type: "renewal",
        effectiveDate: day,
        annualRate,
        ...(frequency ? { frequency } : {}),
        ...(interestMethod ? { interestMethod } : {}),
      }),
      balance === undefined
        ? quotes
        : [
            ...quotes.filter((quote) => quote.timestamp.slice(0, 10) !== day),
            { timestamp: `${day}T00:00:00Z`, close: balance } as Quote,
          ],
      day,
      payments,
    ),
    annualRate,
  };
}

/** Withdrawals tagged as payments on this loan, as the backend counts them. */
export function useLoanPayments(assetId: string, enabled = true) {
  return useQuery({
    queryKey: [QueryKeys.ASSET_DATA, assetId, "loan-payments"],
    queryFn: () => getLoanPayments(assetId),
    enabled: enabled && !!assetId,
  });
}

export function useLoanCalculation(
  assetId: string,
  metadata: Record<string, unknown>,
  quotes: Quote[],
  enabled = true,
  asOf?: string,
) {
  const today = useLoanToday();
  const calculated = enabled && !!readActiveLoanProjection(metadata);
  const payments = useLoanPayments(assetId, calculated);
  const request = loanCalculationRequest(metadata, quotes, asOf ?? today, payments.data ?? []);
  return useQuery({
    queryKey: [QueryKeys.ASSET_DATA, assetId, "loan-calculation", request],
    queryFn: () => calculateLoan(request),
    // Wait for payments so the balance is never shown without them first.
    enabled: calculated && payments.isFetched,
  });
}
