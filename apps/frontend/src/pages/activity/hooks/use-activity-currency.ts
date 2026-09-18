import { useEffect } from "react";
import type { FieldPath, FieldValues, PathValue, UseFormReturn } from "react-hook-form";
import { getActivityCurrencyPatch } from "../activity-currency";
import type { AccountSelectOption } from "../components/forms/fields/account-select";

interface ActivityCurrencyOptions<T extends FieldValues> {
  isEditing?: boolean;
  accountField?: FieldPath<T>;
  // Internal transfers manage their own source/destination currencies and transfer rate.
  trackCurrencyChanges?: boolean;
}

export function useActivityCurrency<T extends FieldValues>(
  form: UseFormReturn<T>,
  accounts: AccountSelectOption[],
  {
    isEditing = false,
    accountField = "accountId" as FieldPath<T>,
    trackCurrencyChanges = true,
  }: ActivityCurrencyOptions<T> = {},
) {
  const { getValues, getFieldState, setValue, watch } = form;
  const currencyField = "currency" as FieldPath<T>;
  const fxRateField = "fxRate" as FieldPath<T>;

  useEffect(() => {
    const accountCurrency = (id: unknown) =>
      accounts.find((account) => account.value === id)?.currency;
    let previousAccountId = getValues(accountField);
    let previousCurrency = getValues(currencyField) as string | undefined;

    // Options can arrive after a preselected account. Loading an existing form is not an edit.
    const initialCurrency = accountCurrency(previousAccountId);
    if (!previousCurrency?.trim() && !getFieldState(currencyField).isDirty && initialCurrency) {
      previousCurrency = initialCurrency;
      setValue(currencyField, initialCurrency as PathValue<T, typeof currencyField>, {
        shouldDirty: false,
        shouldValidate: true,
      });
    }

    const subscription = watch((_, { name }) => {
      // reset() loads a new baseline; do not invalidate a newly loaded activity's rate.
      if (!name) {
        previousAccountId = getValues(accountField);
        previousCurrency = getValues(currencyField);
        return;
      }
      if (name !== accountField && name !== currencyField) return;
      const nextAccountId = getValues(accountField);
      const currency = getValues(currencyField) as string | undefined;
      const accountChanged = nextAccountId !== previousAccountId;
      const patch = getActivityCurrencyPatch({
        currency,
        previousCurrency: trackCurrencyChanges ? previousCurrency : undefined,
        accountCurrency: accountCurrency(nextAccountId),
        previousAccountCurrency: accountCurrency(previousAccountId),
        useAccountDefault:
          accountChanged &&
          ((!isEditing && !getFieldState(currencyField).isDirty) || !currency?.trim()),
      });
      // Advance before writing fields because setValue also notifies this subscription.
      previousAccountId = nextAccountId;
      previousCurrency = patch.currency ?? currency;
      if (patch.fxRate === null) {
        setValue(fxRateField, null as PathValue<T, typeof fxRateField>, {
          shouldDirty: true,
          shouldValidate: true,
        });
      }
      if (patch.currency !== undefined) {
        setValue(currencyField, patch.currency as PathValue<T, typeof currencyField>, {
          shouldDirty: false,
          shouldValidate: true,
        });
      }
    });
    return () => subscription.unsubscribe();
  }, [
    accounts,
    accountField,
    currencyField,
    fxRateField,
    getFieldState,
    getValues,
    isEditing,
    setValue,
    trackCurrencyChanges,
    watch,
  ]);
}
