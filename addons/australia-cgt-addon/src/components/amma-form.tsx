import { Button } from "@wealthfolio/ui";

interface AmmaFormProps {
  parcelId: string;
  incomeYear: string;
  taxableIncome: number;
  cashDistribution: number;
  frankingCredits: number;
  increase: number;
  decrease: number;
  canSave: boolean;
  onParcelIdChange(value: string): void;
  onIncomeYearChange(value: string): void;
  onTaxableIncomeChange(value: number): void;
  onCashDistributionChange(value: number): void;
  onFrankingCreditsChange(value: number): void;
  onIncreaseChange(value: number): void;
  onDecreaseChange(value: number): void;
  onSave(): void;
}

export function AmmaForm({
  parcelId,
  incomeYear,
  taxableIncome,
  cashDistribution,
  frankingCredits,
  increase,
  decrease,
  canSave,
  onParcelIdChange,
  onIncomeYearChange,
  onTaxableIncomeChange,
  onCashDistributionChange,
  onFrankingCreditsChange,
  onIncreaseChange,
  onDecreaseChange,
  onSave,
}: AmmaFormProps) {
  return (
    <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
      <h3 className="font-medium">AMMA / AMIT</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Choose a parcel from the matched lots or holding parcels below, then enter the AMIT
        cost-base movement from the AMMA statement.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          aria-label="AMMA parcel ID"
          className="rounded-md border bg-transparent px-3 py-2"
          list="australia-cgt-all-parcels"
          placeholder="Parcel ID"
          value={parcelId}
          onChange={(event) => onParcelIdChange(event.target.value)}
        />
        <input
          aria-label="AMMA income year"
          className="rounded-md border bg-transparent px-3 py-2"
          value={incomeYear}
          onChange={(event) => onIncomeYearChange(event.target.value)}
        />
        <input
          aria-label="AMMA taxable income"
          className="rounded-md border bg-transparent px-3 py-2"
          inputMode="decimal"
          type="number"
          value={taxableIncome}
          onChange={(event) => onTaxableIncomeChange(Number(event.target.value))}
        />
        <input
          aria-label="AMMA cash distribution"
          className="rounded-md border bg-transparent px-3 py-2"
          inputMode="decimal"
          type="number"
          value={cashDistribution}
          onChange={(event) => onCashDistributionChange(Number(event.target.value))}
        />
        <input
          aria-label="AMMA franking credits"
          className="rounded-md border bg-transparent px-3 py-2"
          inputMode="decimal"
          type="number"
          value={frankingCredits}
          onChange={(event) => onFrankingCreditsChange(Number(event.target.value))}
        />
        <input
          aria-label="AMIT cost base increase"
          className="rounded-md border bg-transparent px-3 py-2"
          inputMode="decimal"
          type="number"
          value={increase}
          onChange={(event) => onIncreaseChange(Number(event.target.value))}
        />
        <input
          aria-label="AMIT cost base decrease"
          className="rounded-md border bg-transparent px-3 py-2"
          inputMode="decimal"
          type="number"
          value={decrease}
          onChange={(event) => onDecreaseChange(Number(event.target.value))}
        />
      </div>
      <Button className="mt-3" disabled={!canSave} onClick={onSave} variant="outline">
        Save AMMA statement
      </Button>
    </div>
  );
}
