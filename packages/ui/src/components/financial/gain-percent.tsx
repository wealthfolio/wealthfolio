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
  const successColor = invertColor ? "text-destructive" : "text-success";
  const destructiveColor = invertColor ? "text-success" : "text-destructive";
  // The badge sits on the status's subtle surface with its text colour; status text on
  // a 10% tint of itself stays under 4.5:1.
  const successBadge = invertColor
    ? "bg-destructive-subtle text-destructive-subtle-foreground"
    : "bg-success-subtle text-success-subtle-foreground";
  const destructiveBadge = invertColor
    ? "bg-success-subtle text-success-subtle-foreground"
    : "bg-destructive-subtle text-destructive-subtle-foreground";
  return (
    <div
      className={cn(
        "amount inline-flex items-center justify-end text-right text-sm",
        displayValue > 0 ? successColor : displayValue < 0 ? destructiveColor : "text-foreground",
        variant === "badge" && [
          "pl-2.25 rounded-md py-px pr-3 font-light",
          displayValue > 0 ? successBadge : displayValue < 0 ? destructiveBadge : "bg-foreground/10",
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
