import { useAmountFormatting } from "@wealthfolio/ui";
import { useEffect, useState } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { AmountInput } from "./amount-input";

interface TradeTotalFormValues {
  amount?: number | null;
}

interface TradeTotalInputProps {
  side: "buy" | "sell";
  /** Preview computed from the trade details; undefined while they are incomplete. */
  calculatedAmount: number | undefined;
  /** True once the user owns the total. Lifted so the submit handler can read it. */
  isCustom: boolean;
  onCustomChange: (isCustom: boolean) => void;
  currency?: string;
  /** Computed cash direction: a sell whose charges exceed proceeds is a
   * debit, and the label must say so. Defaults to the side's usual
   * direction when not provided. */
  isDebit?: boolean;
  /** Decimals the total accepts; defaults to the currency's minor unit. */
  maxDecimalPlaces?: number;
}

/**
 * A trade's final cash total. The field follows the trade calculation until the
 * user edits it; an edited or imported total then stays put while quantity,
 * price, fees and taxes change. Clearing it, or using "use calculated", returns
 * the field to calculated mode.
 *
 * The displayed value is a preview only — the backend resolves the canonical
 * asset multiplier, so the submit handler sends a total only when `isCustom`.
 */
export function TradeTotalInput({
  side,
  calculatedAmount,
  isCustom,
  onCustomChange,
  currency,
  isDebit,
  maxDecimalPlaces,
}: TradeTotalInputProps) {
  const { t } = useTranslation(["activity"]);
  const { formatAmount } = useAmountFormatting();
  const { getValues, setValue } = useFormContext<TradeTotalFormValues>();
  // Backspacing to empty briefly reads as "no value". Deferring the refill to
  // blur keeps the calculated total from fighting the user mid-edit.
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    if (isCustom || isClearing || calculatedAmount === undefined) return;
    if (getValues("amount") === calculatedAmount) return;
    setValue("amount", calculatedAmount, { shouldDirty: false, shouldValidate: false });
  }, [calculatedAmount, getValues, isClearing, isCustom, setValue]);

  const useCalculatedTotal = () => {
    setIsClearing(false);
    onCustomChange(false);
  };

  const debit = isDebit ?? side === "buy";
  const label = debit ? "activity:form.total_debit" : "activity:form.total_credit";
  const helpText = debit ? "activity:form.help_total_debit" : "activity:form.help_total_credit";
  const formattedCalculatedAmount =
    calculatedAmount === undefined
      ? null
      : formatAmount(calculatedAmount, currency ?? "", Boolean(currency));
  return (
    <div className="space-y-1">
      <AmountInput<TradeTotalFormValues>
        name="amount"
        label={t(label)}
        labelHelpText={t(helpText)}
        currency={currency}
        maxDecimalPlaces={maxDecimalPlaces}
        placeholder={calculatedAmount?.toString()}
        onValueChange={(value) => {
          setIsClearing(value == null);
          onCustomChange(value != null);
        }}
        onBlur={() => setIsClearing(false)}
      />
      {/* Only an overridden total needs a caption, and the way back is the
          only thing worth saying about it. */}
      {isCustom && formattedCalculatedAmount && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
          onClick={useCalculatedTotal}
        >
          {t("activity:form.use_calculated_total", { amount: formattedCalculatedAmount })}
        </button>
      )}
    </div>
  );
}
