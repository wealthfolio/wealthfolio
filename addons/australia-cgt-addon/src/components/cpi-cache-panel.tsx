import { Button } from "@wealthfolio/ui";
import type { CpiObservation } from "../lib/tax-data";

interface CpiCachePanelProps {
  cpiSeries: CpiObservation[];
  refreshError: string | null;
  onRefresh(): void;
  onSaveSample(): void;
}

export function CpiCachePanel({
  cpiSeries,
  refreshError,
  onRefresh,
  onSaveSample,
}: CpiCachePanelProps) {
  return (
    <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
      <h3 className="font-medium">CPI Cache</h3>
      <p className="text-muted-foreground mt-2">Cached observations: {cpiSeries.length}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={onRefresh} variant="outline">
          Refresh ABS CPI
        </Button>
        <Button onClick={onSaveSample} variant="ghost">
          Insert demo CPI row
        </Button>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Demo CPI is synthetic test data. Use Refresh ABS CPI for real cache values.
      </p>
      {refreshError ? <p className="text-destructive mt-2">{refreshError}</p> : null}
    </div>
  );
}
