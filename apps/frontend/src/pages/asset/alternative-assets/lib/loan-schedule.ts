import { recalculateLoan } from "@/adapters";
import {
  LOAN_PROJECTION_METADATA_KEY,
  type LoanMetadata,
  type LoanProjectionMetadata,
} from "./loan-events";
/** Resolve the saved creation payment against the dated ledger, not just the preview formula. */
export async function initialLoanProjection(
  metadata: LoanMetadata,
  projection: LoanProjectionMetadata,
): Promise<LoanProjectionMetadata> {
  const result = await recalculateLoan({
    metadata: { ...metadata, [LOAN_PROJECTION_METADATA_KEY]: projection },
    balances: [],
    asOf: String(metadata.origination_date),
    annualRate: projection.annualRate,
  });
  if (!result) throw new Error("Unavailable loan payment");
  // Preserve the larger half-monthly accelerated payment. The dated solver is
  // the minimum needed to cover stub interest and cent postings at the horizon.
  const paymentAmount =
    projection.frequency === "accelerated_biweekly"
      ? Math.max(result.paymentAmount, Math.round(projection.paymentAmount * 100) / 100)
      : result.paymentAmount;
  return { ...projection, paymentAmount };
}
