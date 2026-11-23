import { Button } from "@wealthfolio/ui/components/ui/button";
import { useEffect, useRef } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { DECIMAL_PRECISION } from "@/lib/constants";

interface SellAllButtonProps {
  availableQuantity: number;
  /** The account, asset and position intent whose quantity was filled. */
  holdingKey: string;
  disabled?: boolean;
  hidden?: boolean;
}

export function SellAllButton({
  availableQuantity,
  holdingKey,
  disabled,
  hidden,
}: SellAllButtonProps) {
  const { t } = useTranslation();
  const { watch, setValue } = useFormContext<{ quantity?: number }>();
  const quantity = watch("quantity");
  const lastFill = useRef<{ holdingKey: string; quantity: number } | null>(null);

  useEffect(() => {
    const filled = lastFill.current;
    if (!filled) return;
    if (filled.holdingKey !== holdingKey) {
      // A copied balance belongs to its account and asset. Keep user edits.
      if (quantity === filled.quantity) {
        setValue("quantity", undefined, { shouldDirty: true, shouldValidate: true });
      }
      lastFill.current = null;
    } else if (quantity !== filled.quantity) {
      lastFill.current = null;
    }
  }, [holdingKey, quantity, setValue]);

  if (hidden) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={
        disabled ||
        !Number.isFinite(availableQuantity) ||
        availableQuantity <= 0 ||
        // The input must be able to represent the whole position without rounding.
        Number(availableQuantity.toFixed(DECIMAL_PRECISION)) !== availableQuantity
      }
      onClick={() => {
        lastFill.current = { holdingKey, quantity: availableQuantity };
        setValue("quantity", availableQuantity, { shouldDirty: true, shouldValidate: true });
      }}
    >
      {t("activity:form.sell_all")}
    </Button>
  );
}
