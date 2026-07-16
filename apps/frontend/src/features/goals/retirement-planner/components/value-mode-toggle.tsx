import { AnimatedToggleGroup, formatCompactAmount } from "@wealthfolio/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useTranslation } from "react-i18next";

export type ChartValueMode = "real" | "nominal";

export function ValueModeToggle({
  value,
  onChange,
}: {
  value: ChartValueMode;
  onChange: (value: ChartValueMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <AnimatedToggleGroup<ChartValueMode>
      value={value}
      onValueChange={onChange}
      items={[
        { value: "real", label: t("goals:value_mode.todays_value") },
        { value: "nominal", label: t("goals:value_mode.nominal") },
      ]}
      size="xs"
      rounded="md"
      className="bg-muted/30 border max-sm:[&_button]:px-2 max-sm:[&_button]:text-[11px]"
    />
  );
}

export function ValueModeTooltip({
  valueMode,
  currency,
  todayValue,
  nominalValue,
  children,
}: {
  valueMode: ChartValueMode;
  currency: string;
  todayValue: number;
  nominalValue: number;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const showingLabel =
    valueMode === "real" ? t("goals:value_mode.todays_value") : t("goals:value_mode.nominal");
  const alternateLabel =
    valueMode === "real" ? t("goals:value_mode.nominal") : t("goals:value_mode.todays_value");
  const alternateValue = valueMode === "real" ? nominalValue : todayValue;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        <div className="text-[10px] font-semibold uppercase tracking-wider">
          {t("goals:value_mode.showing", { label: showingLabel })}
        </div>
        <div className="mt-1 tabular-nums">
          {alternateLabel}: {formatCompactAmount(alternateValue, currency)}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
