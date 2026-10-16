import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";

interface UnconvertedCurrenciesNoticeProps {
  currencies: string[];
  baseCurrency: string;
}

/** Names the currencies whose income the totals leave out for lack of an exchange rate. */
export function UnconvertedCurrenciesNotice({
  currencies,
  baseCurrency,
}: UnconvertedCurrenciesNoticeProps) {
  const { t, i18n } = useTranslation();

  if (currencies.length === 0) return null;

  return (
    <Alert variant="warning">
      <Icons.AlertTriangle />
      <AlertDescription>
        {t("income:unconverted_currencies", {
          count: currencies.length,
          currencies: new Intl.ListFormat(i18n.language).format(currencies),
          baseCurrency,
        })}
      </AlertDescription>
    </Alert>
  );
}
