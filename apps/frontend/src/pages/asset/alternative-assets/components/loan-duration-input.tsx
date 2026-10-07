import { useTranslation } from "react-i18next";
import { QuantityInput } from "@wealthfolio/ui";
import { cn } from "@/lib/utils";

interface LoanDurationInputProps {
  /** Accessible name of the pair, e.g. "Amortization". */
  label: string;
  years?: number | string | null;
  months?: number | string | null;
  onYearsChange: (value: number | undefined) => void;
  onMonthsChange: (value: number | undefined) => void;
  /** Lets a form label focus the years input. */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
}

/** Years plus months, as loan agreements state amortization and loan terms. */
export function LoanDurationInput({
  label,
  years,
  months,
  onYearsChange,
  onMonthsChange,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  className,
}: LoanDurationInputProps) {
  const { t } = useTranslation();
  const part = (
    value: LoanDurationInputProps["years"],
    onChange: (value: number | undefined) => void,
    unit: "years" | "months",
  ) => (
    <div className="relative">
      <QuantityInput
        id={unit === "years" ? id : undefined}
        aria-label={t(`asset:loanActions.${unit}`)}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        value={value}
        onValueChange={onChange}
        maxDecimalPlaces={0}
        placeholder="0"
        className={cn("pr-14", className)}
      />
      <span
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm"
      >
        {t(`asset:loanActions.${unit}_short`)}
      </span>
    </div>
  );
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2">
      {part(years, onYearsChange, "years")}
      {part(months, onMonthsChange, "months")}
    </div>
  );
}
