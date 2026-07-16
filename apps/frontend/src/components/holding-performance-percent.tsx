import { cn } from "@/lib/utils";
import { GainPercent } from "@wealthfolio/ui";
import type { ComponentProps } from "react";

type HoldingPerformancePercentProps = Omit<ComponentProps<typeof GainPercent>, "value"> & {
  value?: number | null;
};

export function HoldingPerformancePercent({
  value,
  className,
  ...props
}: HoldingPerformancePercentProps) {
  if (value == null) {
    return <span className={cn("text-muted-foreground", className)}>-</span>;
  }

  return <GainPercent value={value} className={className} {...props} />;
}
