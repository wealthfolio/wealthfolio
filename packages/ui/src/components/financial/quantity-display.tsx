import { useNumberFormatting } from "../formatting-provider";

interface QuantityDisplayProps {
  value: number;
  isHidden: boolean;
}

export function QuantityDisplay({ value, isHidden }: QuantityDisplayProps) {
  const { formatQuantity } = useNumberFormatting();
  return <span>{isHidden ? "••••" : formatQuantity(value)}</span>;
}
