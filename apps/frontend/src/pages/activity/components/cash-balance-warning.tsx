import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, Icons } from "@wealthfolio/ui";
import { ActivityType } from "@/lib/constants";
import { useCashBalanceValidation } from "../hooks/use-cash-balance-validation";
import { NewActivityFormValues } from "./forms/schemas";

export function CashBalanceWarning() {
  const { t } = useTranslation();
  const { watch } = useFormContext<NewActivityFormValues>();
  const activityType = watch("activityType");
  const { isValid, warning, isLoading, hasAccount, hasValues } = useCashBalanceValidation();

  // Only show for BUY activities with insufficient funds
  if (activityType !== ActivityType.BUY || !hasAccount || !hasValues || isLoading || isValid) {
    return null;
  }

  if (!warning) {
    return null;
  }

  return (
    <Alert variant="warning">
      <Icons.AlertTriangle className="h-4 w-4" />
      <AlertDescription className="text-sm">
        <strong>{t("activity:cash_balance_insufficient")}</strong> {warning}
        <p>{t("activity:cash_balance_shortfall_hint")}</p>
      </AlertDescription>
    </Alert>
  );
}
