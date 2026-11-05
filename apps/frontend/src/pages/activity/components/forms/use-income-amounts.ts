import {
  calculateIncomeGrossAmount,
  calculateIncomeReceivedAmount,
} from "@/lib/activity-final-amount";
import { useEffect, useRef, type RefObject } from "react";
import type { FieldValues, Path, PathValue, UseFormReturn } from "react-hook-form";

type IncomeAmountField = "amount" | "grossAmount" | "tax" | "fee";

/** Which of the two amounts the user typed last. */
export type IncomeAmountTypedLast = "gross" | "received";

interface UseIncomeAmountsOptions {
  /** True while the form asks for a cash payment's amount before tax. */
  enabled: boolean;
  /** True when the form shows a fee field next to the tax. */
  includeFee?: boolean;
  /**
   * Owned by the form root when the fields' component can unmount mid-entry
   * (a phone form's steps), so the choice survives coming back to the step.
   */
  typedLast?: RefObject<IncomeAmountTypedLast>;
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
  { enabled, includeFee = false, typedLast: rootTypedLast }: UseIncomeAmountsOptions,
) {
  const ownTypedLast = useRef<IncomeAmountTypedLast>("gross");
  const typedLast = rootTypedLast ?? ownTypedLast;

  const read = (name: IncomeAmountField): unknown => form.getValues(name as Path<T>);
  const write = (name: IncomeAmountField, value: number | undefined) =>
    form.setValue(name as Path<T>, value as PathValue<T, Path<T>>, {
      shouldDirty: true,
      shouldValidate: false,
    });
  const charges = () => ({ tax: read("tax"), fee: includeFee ? read("fee") : undefined });
  // A money input cannot show a negative amount, so charges above the amount
  // before tax show as nothing received; the forms' charge rule explains why.
  const receivedFrom = (grossAmount: unknown) => {
    const received = calculateIncomeReceivedAmount({ grossAmount, ...charges() });
    return received === undefined ? undefined : Math.max(received, 0);
  };

  // Brings the amount the user did not type last in line with the charges that
  // apply now, writing only what changes.
  const reconcile = () => {
    const writeIfChanged = (name: "amount" | "grossAmount", value: number | undefined) => {
      if (read(name) !== value) write(name, value);
    };
    if (typedLast.current === "received") {
      const receivedAmount = read("amount");
      if (receivedAmount == null) return;
      writeIfChanged("grossAmount", calculateIncomeGrossAmount({ receivedAmount, ...charges() }));
    } else {
      const grossAmount = read("grossAmount");
      if (grossAmount == null) return;
      writeIfChanged("amount", receivedFrom(grossAmount));
    }
  };

  // When the fields appear (opening a saved row, or switching to a cash
  // payment), rebuild the amount before tax from the received amount as the
  // field's starting value, so showing it is not an edit to discard on close.
  // An amount already there stays, as what the user typed: a phone step shown
  // again remounts this, possibly for another type whose charges differ (only
  // interest shows a fee), so the other amount is brought back in line.
  // Hidden, the amount is cleared.
  useEffect(() => {
    const current = read("grossAmount");
    if (!enabled) {
      if (current !== undefined) {
        form.setValue("grossAmount" as Path<T>, undefined as PathValue<T, Path<T>>, {
          shouldDirty: false,
          shouldValidate: false,
        });
      }
      return;
    }
    if (current != null) {
      reconcile();
      return;
    }
    typedLast.current = "gross";
    const rebuilt = calculateIncomeGrossAmount({ receivedAmount: read("amount"), ...charges() });
    if (rebuilt !== undefined) {
      form.resetField("grossAmount" as Path<T>, {
        defaultValue: rebuilt as PathValue<T, Path<T>>,
      });
    }
    // Runs only when the fields appear or disappear: a form from useFormContext
    // can be a new object on every render, and the helpers read live values.
  }, [enabled]);

  const onGrossAmountChange = (grossAmount: number | null | undefined) => {
    typedLast.current = "gross";
    write("amount", receivedFrom(grossAmount));
  };

  const onReceivedAmountChange = (receivedAmount: number | null | undefined) => {
    typedLast.current = "received";
    write("grossAmount", calculateIncomeGrossAmount({ receivedAmount, ...charges() }));
  };

  /** Call after the tax or fee field has stored its new value. */
  const onChargeChange = () => {
    if (enabled) reconcile();
  };

  return { onGrossAmountChange, onReceivedAmountChange, onChargeChange };
}
