import * as React from "react";
import { cn } from "../../lib/utils";
import { useLocalizationSettings, useNumberFormatting } from "../formatting-provider";

type GainPercentVariant = "text" | "badge";

interface GainPercentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  animated?: boolean;
  variant?: GainPercentVariant;
  showSign?: boolean;
  invertColor?: boolean;
}

function normalizeDisplayPercent(value: number) {
  return Math.abs(value) < 0.00005 ? 0 : value;
}

function AnimatedNumber({
  value,
  locale,
  showSign,
  fallback,
}: {
  value: number;
  locale: string;
  showSign: boolean;
  fallback: string;
}) {
  const [NumberFlow, setNumberFlow] = React.useState<typeof import("@number-flow/react").default | null>(null);

  React.useEffect(() => {
    import("@number-flow/react").then((module) => {
      setNumberFlow(module.default);
    });
  }, []);

  if (!NumberFlow) {
    return <span>{fallback}</span>;
  }

  return (
    <NumberFlow
      value={value}
      animated={true}
      format={{
        style: "percent",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        signDisplay: showSign ? "exceptZero" : "never",
      }}
      locales={locale}
    />
  );
}

export function GainPercent({
  value,
  animated = false,
  variant = "text",
  showSign = true,
  invertColor = false,
  className,
  ...props
}: GainPercentProps) {
  const { locale } = useLocalizationSettings();
  const { formatPercent } = useNumberFormatting();
  const displayValue = normalizeDisplayPercent(value);
  const gainColor = invertColor ? "text-loss" : "text-gain";
  const lossColor = invertColor ? "text-gain" : "text-loss";
  // The badge sits on the gain or loss subtle surface with its text colour; text on a
  // 10% tint of itself stays under 4.5:1.
  const gainBadge = invertColor
    ? "bg-loss-subtle text-loss-subtle-foreground"
    : "bg-gain-subtle text-gain-subtle-foreground";
  const lossBadge = invertColor
    ? "bg-gain-subtle text-gain-subtle-foreground"
    : "bg-loss-subtle text-loss-subtle-foreground";
  return (
    <div
      className={cn(
        "amount inline-flex items-center justify-end text-end text-sm",
        displayValue > 0 ? gainColor : displayValue < 0 ? lossColor : "text-foreground",
        variant === "badge" && [
          "ps-2.25 rounded-md py-px pe-3 font-light",
          displayValue > 0 ? gainBadge : displayValue < 0 ? lossBadge : "bg-foreground/10",
        ],
        className,
      )}
      {...props}
    >
      {animated ? (
        <AnimatedNumber
          value={displayValue}
          locale={locale}
          showSign={showSign}
          fallback={formatPercent(displayValue, {
            signDisplay: showSign ? "exceptZero" : "never",
          })}
        />
      ) : (
        formatPercent(displayValue, { signDisplay: showSign ? "exceptZero" : "never" })
      )}
    </div>
  );
}
