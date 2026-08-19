import { cn } from "../../lib/utils";
import { useAmountFormatting } from "../formatting-provider";

interface PriceDisplayProps {
  value: number;
  currency: string;
  isHidden?: boolean;
  displayCurrency?: boolean;
  className?: string;
}

export function PriceDisplay({
  value,
  currency = "USD",
  isHidden,
  displayCurrency = true,
  className,
}: PriceDisplayProps) {
  const { formatPrice } = useAmountFormatting();
  return <span className={cn(className)}>{isHidden ? "••••" : formatPrice(value, currency, displayCurrency)}</span>;
}
