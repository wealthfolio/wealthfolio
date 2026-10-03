import { useQuery } from "@tanstack/react-query";
import { calculateLoan } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { Quote } from "@/lib/types";
import {
  appendLoanEvent,
  readActiveLoanProjection,
  type LoanInterestMethod,
  type LoanPaymentFrequency,
} from "../lib/loan-events";
import { formatDateISO } from "@/lib/utils";

export function loanCalculationRequest(
  metadata: Record<string, unknown>,
  quotes: Quote[],
  asOf = formatDateISO(new Date()),
) {
  return {
    metadata,
    balances: quotes.map((quote) => ({
      date: quote.timestamp.slice(0, 10),
      balance: Math.abs(quote.close),
      notes: quote.notes,
    })),
    asOf,
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
    ),
    annualRate,
  };
}

export function useLoanCalculation(
  assetId: string,
  metadata: Record<string, unknown>,
  quotes: Quote[],
  enabled = true,
  asOf?: string,
) {
  const request = loanCalculationRequest(metadata, quotes, asOf);
  return useQuery({
    queryKey: [QueryKeys.ASSET_DATA, assetId, "loan-calculation", request],
    queryFn: () => calculateLoan(request),
    enabled: enabled && !!readActiveLoanProjection(metadata),
  });
}
