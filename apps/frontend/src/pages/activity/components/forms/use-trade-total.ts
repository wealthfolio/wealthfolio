import { calculateTradeFinalCash, isStoredTradeAmountCustom } from "@/lib/activity-final-amount";
import { ActivityType } from "@/lib/constants";
import { useMemo, useState } from "react";

interface UseTradeTotalOptions {
  side: "buy" | "sell";
  isEditing: boolean;
  /** The stored total when editing an existing activity. */
  defaultAmount: unknown;
  /** The resolved asset's instrument type beats the form radio: an option
   * picked via symbol search must price at its contract multiplier even
   * when the radio still says "stock". Pass `symbolInstrumentType ?? assetType`. */
  instrumentType: string;
  quantity: number | undefined;
  unitPrice: number | undefined;
  fee: number | undefined;
  tax: number | undefined;
  isOption: boolean;
  contractMultiplier: number | undefined;
  /** The activity currency, whose minor unit the calculated total rounds to. */
  currency: string | undefined;
}

/**
 * Shared BUY/SELL trade-total policy: the calculated preview, custom-mode
 * state, and the submit-time amount rewrite. One implementation keeps the
 * buy and sell forms' semantics provably identical.
 *
 * Attestation is NOT decided here: a form save is a review of the whole form
 * (the total is visible, typed or calculated), so the shared submit layer
 * attests every form submission - see `useActivityForm` / the mobile form.
 */
export function useTradeTotal({
  side,
  isEditing,
  defaultAmount,
  instrumentType,
  quantity,
  unitPrice,
  fee,
  tax,
  isOption,
  contractMultiplier,
  currency,
}: UseTradeTotalOptions) {
  // Editing starts in custom mode only when the stored total actually
  // differs from the calculation - a total that equals it was never custom,
  // and freezing it would let a routine quantity/fee correction resubmit a
  // stale amount. An explicit stored zero (e.g. gifted shares) is a custom
  // value, not a missing one. A new activity follows the calculation until
  // the user takes it over.
  const [isCustomAmount, setIsCustomAmount] = useState(
    () =>
      isEditing &&
      isStoredTradeAmountCustom({
        storedAmount: defaultAmount,
        activityType: side === "buy" ? ActivityType.BUY : ActivityType.SELL,
        instrumentType,
        quantity,
        unitPrice,
        fee,
        tax,
        contractMultiplier: isOption ? contractMultiplier : undefined,
        currency,
      }),
  );

  const calculatedCash = useMemo(
    () =>
      calculateTradeFinalCash({
        activityType: side === "buy" ? ActivityType.BUY : ActivityType.SELL,
        instrumentType,
        quantity,
        unitPrice,
        fee,
        tax,
        // Only options carry a contract multiplier. The field keeps its 100
        // default for every asset type, so passing it unconditionally would
        // price a stock at 100x.
        contractMultiplier: isOption ? contractMultiplier : undefined,
        currency,
      }),
    [side, instrumentType, quantity, unitPrice, fee, tax, isOption, contractMultiplier, currency],
  );
  const calculatedAmount = calculatedCash === undefined ? undefined : Math.abs(calculatedCash);
  // A sell whose charges exceed its proceeds is cash OUT: the field is a
  // debit even though the side is "sell", and the label must not promise a
  // credit the ledger will book as a debit.
  const isDebit = calculatedCash === undefined ? side === "buy" : calculatedCash < 0;

  /**
   * Submit-time rewrite. The preview is intentionally not the persistence
   * authority: the backend uses the resolved asset multiplier unless the user
   * explicitly entered a custom final total. On an edit, null asks the backend
   * to recalculate, where omission would silently keep the old stored amount.
   */
  const applyTradeTotal = (data: { amount?: number | null }) => {
    data.amount = isCustomAmount ? (data.amount ?? null) : isEditing ? null : undefined;
  };

  return {
    isCustomAmount,
    onCustomChange: setIsCustomAmount,
    calculatedAmount,
    applyTradeTotal,
    isDebit,
  };
}
