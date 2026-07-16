import * as React from "react";
import { cn, formatPercent } from "../../lib/utils";

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

function AnimatedNumber({ value }: { value: number }) {
  const [NumberFlow, setNumberFlow] = React.useState<React.ComponentType<any> | null>(null);

  const absValue = Math.abs(value * 100);
  React.useEffect(() => {
    import("@number-flow/react").then((module) => {
      setNumberFlow(module.default);
    });
  }, []);

  if (!NumberFlow) {
    return (
      <span>
        {absValue.toLocaleString(typeof navigator !== "undefined" ? navigator.language : "en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </span>
    );
  }

  return (
    <NumberFlow
      value={absValue}
      animated={true}
      format={{
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }}
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
        <>
          {showSign && (displayValue > 0 ? "+" : displayValue < 0 ? "-" : null)}
          <AnimatedNumber value={displayValue} />%
        </>
      ) : (
        <>
          {showSign && (displayValue > 0 ? "+" : displayValue < 0 ? "-" : null)}
          {formatPercent(Math.abs(displayValue))}
        </>
      )}
    </div>
  );
}
