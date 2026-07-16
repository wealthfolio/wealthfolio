import { useController, type Control, type FieldPath, type FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { AnimatedToggleGroup } from "@wealthfolio/ui";
import { ACTIVITY_SUBTYPES } from "@/lib/constants";
import { cn } from "@/lib/utils";

type StockTradeSide = "buy" | "sell";

// Sentinel for the "normal" (no subtype) option — AnimatedToggleGroup needs string values.
const NORMAL = "NORMAL";

interface StockTradeIntentSelectorProps<TFieldValues extends FieldValues = FieldValues> {
  control: Control<TFieldValues>;
  name?: FieldPath<TFieldValues>;
  side: StockTradeSide;
  className?: string;
  /** Hide the "Trade Type" label and render a compact toggle (for card headers) */
  hideLabel?: boolean;
}

export function StockTradeIntentSelector<TFieldValues extends FieldValues = FieldValues>({
  control,
  name = "subtype" as FieldPath<TFieldValues>,
  side,
  className,
  hideLabel = false,
}: StockTradeIntentSelectorProps<TFieldValues>) {
  const { t } = useTranslation(["activity"]);
  const { field } = useController({
    name,
    control,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defaultValue: null as any,
  });

  const shortValue =
    side === "sell" ? ACTIVITY_SUBTYPES.POSITION_OPEN : ACTIVITY_SUBTYPES.POSITION_CLOSE;
  const items =
    side === "sell"
      ? [
          { value: NORMAL, label: t("activity:form.intent_sell") },
          { value: shortValue, label: t("activity:form.button_sell_short") },
        ]
      : [
          { value: NORMAL, label: t("activity:form.intent_buy") },
          { value: shortValue, label: t("activity:form.button_buy_to_cover") },
        ];

  const selectedValue = field.value === shortValue ? shortValue : NORMAL;

  if (hideLabel) {
    return (
      <div role="group" aria-label={t("activity:form.trade_type")} className={className}>
        <AnimatedToggleGroup
          value={selectedValue}
          onValueChange={(value) => field.onChange(value === NORMAL ? null : value)}
          items={items}
          size="sm"
          rounded="lg"
          className="h-9"
        />
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={t("activity:form.trade_type")}
      className={cn("space-y-2", className)}
    >
      <span className="text-sm font-medium">{t("activity:form.trade_type")}</span>
      <AnimatedToggleGroup
        value={selectedValue}
        onValueChange={(value) => field.onChange(value === NORMAL ? null : value)}
        items={items}
        rounded="lg"
        className="grid h-10 w-full grid-cols-2"
      />
    </div>
  );
}
