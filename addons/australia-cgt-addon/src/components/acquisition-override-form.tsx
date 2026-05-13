import { Button } from "@wealthfolio/ui";

interface AcquisitionOverrideFormProps {
  parcelId: string;
  symbol: string;
  account: string;
  acquisitionDate: string;
  canSave: boolean;
  onParcelIdChange(value: string): void;
  onSymbolChange(value: string): void;
  onAccountChange(value: string): void;
  onAcquisitionDateChange(value: string): void;
  onSave(): void;
}

export function AcquisitionOverrideForm({
  parcelId,
  symbol,
  account,
  acquisitionDate,
  canSave,
  onParcelIdChange,
  onSymbolChange,
  onAccountChange,
  onAcquisitionDateChange,
  onSave,
}: AcquisitionOverrideFormProps) {
  return (
    <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
      <h3 className="font-medium">Aggregated Holding Acquisition</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Use this when Wealthfolio has a holding but not the original parcel acquisition date. A
        selected parcel fills the matching symbol and account.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input
          aria-label="Override parcel ID"
          className="rounded-md border bg-transparent px-3 py-2"
          list="australia-cgt-open-parcels"
          placeholder="Parcel ID"
          value={parcelId}
          onChange={(event) => onParcelIdChange(event.target.value)}
        />
        <input
          aria-label="Override symbol"
          className="rounded-md border bg-transparent px-3 py-2"
          placeholder="Symbol"
          value={symbol}
          onChange={(event) => onSymbolChange(event.target.value)}
        />
        <input
          aria-label="Override account"
          className="rounded-md border bg-transparent px-3 py-2"
          placeholder="Account"
          value={account}
          onChange={(event) => onAccountChange(event.target.value)}
        />
        <input
          aria-label="Override acquisition date"
          className="rounded-md border bg-transparent px-3 py-2"
          type="date"
          value={acquisitionDate}
          onChange={(event) => onAcquisitionDateChange(event.target.value)}
        />
      </div>
      <Button className="mt-3" disabled={!canSave} onClick={onSave} variant="outline">
        Save acquisition date
      </Button>
    </div>
  );
}
