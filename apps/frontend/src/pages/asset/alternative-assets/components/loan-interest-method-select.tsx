import { useTranslation } from "react-i18next";
import { ResponsiveSelect } from "@wealthfolio/ui";
import { isLoanInterestMethod, type LoanInterestMethod } from "../lib/loan-events";

export function LoanInterestMethodSelect({
  value = "nominal_periodic",
  onChange,
  disabled,
}: {
  value?: LoanInterestMethod;
  disabled?: boolean;
  onChange: (value: LoanInterestMethod) => void;
}) {
  const { t } = useTranslation();
  return (
    <ResponsiveSelect
      disabled={disabled}
      aria-label={t("asset:loanInterest.method")}
      value={value}
      onValueChange={(next) => isLoanInterestMethod(next) && onChange(next)}
      options={["nominal_periodic", "monthly", "semiannual"].map((method) => ({
        value: method,
        label: t(`asset:loanInterest.${method}`),
      }))}
      sheetTitle={t("asset:loanInterest.method")}
    />
  );
}
