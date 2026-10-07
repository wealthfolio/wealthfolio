import { useEffect } from "react";
import type { FieldPath, FieldValues, PathValue, UseFormReturn } from "react-hook-form";
import type { AccountSelectOption } from "../components/forms/fields/account-select";

export function getTransferRate(source?: number | null, destination?: number | null) {
  if (!source || source <= 0 || !destination || destination <= 0) return undefined;
  const rate = Number((destination / source).toFixed(8));
  // The optional display rate must not invalidate authoritative cash amounts.
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/**
 * The rate to calculate with. While the field still shows the rounded rate of
 * the current amounts, the exact ratio is used, so a rounded display rate never
 * changes cash amounts; a rate the user typed is used as typed.
 */
export function getCalculationRate(
  displayRate: unknown,
  source?: number | null,
  destination?: number | null,
) {
  const rate = Number(displayRate);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return source && destination && getTransferRate(source, destination) === rate
    ? destination / source
    : rate;
}

/** Cash currencies are user inputs; account currencies only seed untouched new forms. */
export function useInternalTransferCurrencies<T extends FieldValues>(
  form: UseFormReturn<T>,
  accounts: AccountSelectOption[],
  {
    enabled,
    isEditing = false,
    sourceAccountField,
  }: { enabled: boolean; isEditing?: boolean; sourceAccountField: FieldPath<T> },
) {
  const { getValues, getFieldState, setValue, watch } = form;

  useEffect(() => {
    if (!enabled) return;
    const read = (name: string) => getValues(name as FieldPath<T>);
    const write = (name: string, value: unknown, dirty = false) =>
      setValue(name as FieldPath<T>, value as PathValue<T, FieldPath<T>>, {
        shouldDirty: dirty,
        shouldValidate: false,
      });
    const defaultCurrency = (accountField: string, currencyField: string, changed = false) => {
      const currency = read(currencyField) as string | undefined;
      if (
        !currency?.trim() ||
        (changed && !isEditing && !getFieldState(currencyField as FieldPath<T>).isDirty)
      ) {
        const account = accounts.find((option) => option.value === read(accountField));
        if (account) write(currencyField, account.currency);
      }
    };
    const initialize = () => {
      defaultCurrency(sourceAccountField, "sourceCurrency");
      defaultCurrency("toAccountId", "destinationCurrency");
      if (read("sourceCurrency")) write("currency", read("sourceCurrency"));
      if (read("sourceCurrency") !== read("destinationCurrency") && read("transferRate") == null) {
        write("transferRate", getTransferRate(read("sourceAmount"), read("destinationAmount")));
      }
    };
    initialize();
    let previousSource = read("sourceCurrency");
    let previousDestination = read("destinationCurrency");
    let syncing = false;
    const subscription = watch((_, { name }) => {
      if (syncing) return;
      if (
        name &&
        ![sourceAccountField, "toAccountId", "sourceCurrency", "destinationCurrency"].includes(name)
      )
        return;
      syncing = true;
      try {
        if (!name) {
          // reset() loads a baseline, not a user currency change.
          initialize();
        } else {
          if (name === sourceAccountField)
            defaultCurrency(sourceAccountField, "sourceCurrency", true);
          if (name === "toAccountId") defaultCurrency("toAccountId", "destinationCurrency", true);
          const source = read("sourceCurrency");
          const destination = read("destinationCurrency");
          if (source !== previousSource || destination !== previousDestination) {
            write("transferRate", null, true);
            write("destinationAmount", source === destination ? read("sourceAmount") : null, true);
          }
          if (source) write("currency", source);
        }
        previousSource = read("sourceCurrency");
        previousDestination = read("destinationCurrency");
      } finally {
        syncing = false;
      }
    });
    return () => subscription.unsubscribe();
  }, [accounts, enabled, getFieldState, getValues, isEditing, setValue, sourceAccountField, watch]);
}
