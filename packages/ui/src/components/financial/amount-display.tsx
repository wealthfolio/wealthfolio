import { cn } from "../../lib/utils";
import { useAmountFormatting } from "../formatting-provider";

interface AmountDisplayProps {
  value: number;
  currency: string;
  isHidden?: boolean;
  displayCurrency?: boolean;
  colorFormat?: boolean;
  invertColor?: boolean;
  className?: string;
}

export function AmountDisplay({
  value,
  currency = "USD",
  isHidden,
  displayCurrency = true,
  colorFormat,
  invertColor = false,
  className,
}: AmountDisplayProps) {
  const { formatAmount } = useAmountFormatting();
  const formattedAmount = formatAmount(value, currency, displayCurrency);
  const positive = invertColor ? "text-loss" : "text-gain";
  const negative = invertColor ? "text-gain" : "text-loss";
  const colorClass = colorFormat ? (value >= 0 ? positive : negative) : "";

  return <span className={cn(colorClass, className)}>{isHidden ? "••••" : formattedAmount}</span>;
}
