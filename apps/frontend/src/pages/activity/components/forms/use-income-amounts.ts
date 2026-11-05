import {
  calculateIncomeGrossAmount,
  calculateIncomeReceivedAmount,
} from "@/lib/activity-final-amount";
import { useEffect, useRef } from "react";
import type { FieldValues, Path, PathValue, UseFormReturn } from "react-hook-form";

type IncomeAmountField = "amount" | "grossAmount" | "tax" | "fee";

interface UseIncomeAmountsOptions {
  /** True while the form asks for a cash payment's amount before tax. */
  enabled: boolean;
  /** True when the form shows a fee field next to the tax. */
  includeFee?: boolean;
}

/**
 * Links a cash dividend's or interest payment's amount before tax, its
 * withholding tax (and a fee the form shows) and the received amount. Only the
 * received amount is saved; the amount before tax is rebuilt from it when a row
 * is edited.
 *
 * Whichever amount the user typed last stays put: typing the amount before tax
 * works out the received amount, and typing the received amount (a statement
 * that shows cash after tax) works out the amount before tax. A tax or fee
 * change then moves the other one, so the two amounts always agree.
 */
export function useIncomeAmounts<T extends FieldValues>(
  form: UseFormReturn<T>,
  { enabled, includeFee = false }: UseIncomeAmountsOptions,
) {
  const typedLast = useRef<"gross" | "received">("gross");

  const read = (name: IncomeAmountField): unknown => form.getValues(name as Path<T>);
  const write = (name: IncomeAmountField, value: number | undefined, shouldDirty: boolean) =>
    form.setValue(name as Path<T>, value as PathValue<T, Path<T>>, {
      shouldDirty,
      shouldValidate: false,
    });
  const charges = () => ({ tax: read("tax"), fee: includeFee ? read("fee") : undefined });
  // A money input cannot show a negative amount, so charges above the amount
  // before tax show as nothing received; the form's tax rule explains why.
  const receivedFrom = (grossAmount: unknown) => {
    const received = calculateIncomeReceivedAmount({ grossAmount, ...charges() });
    return received === undefined ? undefined : Math.max(received, 0);
  };

  // Rebuild the amount before tax whenever the fields appear (opening a saved
  // row, or switching to a cash payment) and clear it while they are hidden,
  // so it never holds a stale figure.
  useEffect(() => {
    typedLast.current = "gross";
    write(
      "grossAmount",
      enabled
        ? calculateIncomeGrossAmount({ receivedAmount: read("amount"), ...charges() })
        : undefined,
      false,
    );
    // Runs only when the fields appear or disappear: a form from useFormContext
    // can be a new object on every render, and the helpers read live values.
  }, [enabled]);

  const onGrossAmountChange = (grossAmount: number | null | undefined) => {
    typedLast.current = "gross";
    write("amount", receivedFrom(grossAmount), true);
  };

  const onReceivedAmountChange = (receivedAmount: number | null | undefined) => {
    typedLast.current = "received";
    write("grossAmount", calculateIncomeGrossAmount({ receivedAmount, ...charges() }), true);
  };

  /** Call after the tax or fee field has stored its new value. */
  const onChargeChange = () => {
    if (!enabled) return;
    if (typedLast.current === "received") {
      const receivedAmount = read("amount");
      if (receivedAmount == null) return;
      write("grossAmount", calculateIncomeGrossAmount({ receivedAmount, ...charges() }), true);
    } else {
      const grossAmount = read("grossAmount");
      if (grossAmount == null) return;
      write("amount", receivedFrom(grossAmount), true);
    }
  };

  return { onGrossAmountChange, onReceivedAmountChange, onChargeChange };
}
