import { useQuery } from "@tanstack/react-query";
import { calculateLoan } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { Quote } from "@/lib/types";
import { readActiveLoanProjection } from "../lib/loan-events";
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
