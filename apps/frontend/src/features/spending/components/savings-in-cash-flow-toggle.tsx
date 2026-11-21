import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Switch } from "@wealthfolio/ui";

interface SavingsInCashFlowToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** The "Include savings" switch shown beside a cash flow view. */
export function SavingsInCashFlowToggle({
  checked,
  onCheckedChange,
}: SavingsInCashFlowToggleProps) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      title={t("spending:cashFlow.includeSavingsHint")}
    >
      <Switch
        id={id}
        size="sm"
        checked={checked}
        // The switch also passes event details; callers get the value alone.
        onCheckedChange={(next) => onCheckedChange(next)}
      />
      <label htmlFor={id} className="text-muted-foreground cursor-pointer text-xs">
        {t("spending:cashFlow.includeSavings")}
      </label>
    </div>
  );
}
