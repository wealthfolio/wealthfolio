import { Button } from "@wealthfolio/ui";

interface TransitionSnapshotFormProps {
  parcelId: string;
  symbol: string;
  account: string;
  acquisitionDate: string;
  quantity: number;
  marketValue: number;
  canSave: boolean;
  onParcelIdChange(value: string): void;
  onSymbolChange(value: string): void;
  onAccountChange(value: string): void;
  onAcquisitionDateChange(value: string): void;
  onQuantityChange(value: number): void;
  onMarketValueChange(value: number): void;
  onSave(): void;
}

export function TransitionSnapshotForm({
  parcelId,
  symbol,
  account,
  acquisitionDate,
  quantity,
  marketValue,
  canSave,
  onParcelIdChange,
  onSymbolChange,
  onAccountChange,
  onAcquisitionDateChange,
  onQuantityChange,
  onMarketValueChange,
  onSave,
}: TransitionSnapshotFormProps) {
  return (
    <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
      <h3 className="font-medium">30 June 2027 Parcel Value</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Selecting a known parcel fills symbol, account, acquired date, and quantity; edit them only
        when the parcel was aggregated outside Wealthfolio.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          aria-label="Snapshot parcel ID"
          className="rounded-md border bg-transparent px-3 py-2"
          list="australia-cgt-open-parcels"
          placeholder="Parcel ID"
          value={parcelId}
          onChange={(event) => onParcelIdChange(event.target.value)}
        />
        <input
          aria-label="Snapshot symbol"
          className="rounded-md border bg-transparent px-3 py-2"
          placeholder="Symbol"
          value={symbol}
          onChange={(event) => onSymbolChange(event.target.value)}
        />
        <input
          aria-label="Snapshot account"
          className="rounded-md border bg-transparent px-3 py-2"
          placeholder="Account"
          value={account}
          onChange={(event) => onAccountChange(event.target.value)}
        />
        <input
          aria-label="Snapshot acquisition date"
          className="rounded-md border bg-transparent px-3 py-2"
          type="date"
          value={acquisitionDate}
          onChange={(event) => onAcquisitionDateChange(event.target.value)}
        />
        <input
          aria-label="Snapshot quantity"
          className="rounded-md border bg-transparent px-3 py-2"
          inputMode="decimal"
          type="number"
          value={quantity}
          onChange={(event) => onQuantityChange(Number(event.target.value))}
        />
        <input
          aria-label="Snapshot market value"
          className="rounded-md border bg-transparent px-3 py-2"
          inputMode="decimal"
          type="number"
          value={marketValue}
          onChange={(event) => onMarketValueChange(Number(event.target.value))}
        />
      </div>
      <Button className="mt-3" disabled={!canSave} onClick={onSave} variant="outline">
        Save 2027 snapshot
      </Button>
    </div>
  );
}
