import { cn, formatPrice } from "../../lib/utils";

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
  return <span className={cn(className)}>{isHidden ? "••••" : formatPrice(value, currency, displayCurrency)}</span>;
}
