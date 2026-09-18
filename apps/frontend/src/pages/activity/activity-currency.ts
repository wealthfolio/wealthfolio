interface ActivityCurrencyChange {
  currency: string | undefined;
  previousCurrency: string | undefined;
  accountCurrency: string | undefined;
  previousAccountCurrency: string | undefined;
  useAccountDefault: boolean;
}

/** Account defaults never convert amounts; an FX override belongs to a currency pair. */
export function getActivityCurrencyPatch({
  currency,
  previousCurrency,
  accountCurrency,
  previousAccountCurrency,
  useAccountDefault,
}: ActivityCurrencyChange): { currency?: string; fxRate?: null } {
  const nextCurrency = useAccountDefault && accountCurrency ? accountCurrency : currency;
  const pairChanged =
    (previousAccountCurrency && accountCurrency && previousAccountCurrency !== accountCurrency) ||
    (previousCurrency && previousCurrency !== nextCurrency);

  return {
    ...(nextCurrency !== currency && { currency: nextCurrency }),
    ...(pairChanged && { fxRate: null }),
  };
}
