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
  const successBg = invertColor ? "bg-destructive/10" : "bg-success/10";
  const destructiveBg = invertColor ? "bg-success/10" : "bg-destructive/10";
  return (
    <div
      className={cn(
        "amount inline-flex items-center justify-end text-right text-sm",
        displayValue > 0 ? successColor : displayValue < 0 ? destructiveColor : "text-foreground",
        variant === "badge" && [
          "rounded-md py-px pl-[9px] pr-[12px] font-light",
          displayValue > 0 ? successBg : displayValue < 0 ? destructiveBg : "bg-foreground/10",
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
