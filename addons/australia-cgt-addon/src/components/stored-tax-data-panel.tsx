import { Button } from "@wealthfolio/ui";
import { formatAud } from "../lib/format";
import type { AustraliaCgtAddonData } from "../lib/tax-data";

interface StoredTaxDataPanelProps {
  taxData: AustraliaCgtAddonData;
  onClear(): void;
  onDeleteAmma(statementId: string): void;
  onDeleteCpi(quarter: string): void;
  onDeleteSnapshot(parcelId: string): void;
  onDeleteAcquisitionOverride(parcelId: string): void;
}

export function StoredTaxDataPanel({
  taxData,
  onClear,
  onDeleteAmma,
  onDeleteCpi,
  onDeleteSnapshot,
  onDeleteAcquisitionOverride,
}: StoredTaxDataPanelProps) {
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        <span>AMMA statements: {taxData.ammaStatements.length}</span>
        <span>AMIT adjustments: {taxData.amitAdjustments.length}</span>
        <span>2027 snapshots: {taxData.transitionSnapshots.length}</span>
        <span>Acquisition overrides: {taxData.acquisitionOverrides.length}</span>
        <Button onClick={onClear} size="sm" variant="ghost">
          Clear local tax data
        </Button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="bg-background rounded-md border p-3">
          <h3 className="text-sm font-medium">Stored AMMA statements</h3>
          <div className="mt-2 divide-y text-sm">
            {taxData.ammaStatements.map((statement) => (
              <div key={statement.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="font-medium">
                    {statement.parcelId ?? statement.holdingKey} · {statement.incomeYear}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Taxable {formatAud(statement.taxableIncome)} · Cash{" "}
                    {formatAud(statement.cashDistribution)} · Franking{" "}
                    {formatAud(statement.frankingCredits)} · AMIT{" "}
                    {formatAud(statement.amitCostBaseIncrease - statement.amitCostBaseDecrease)}
                  </p>
                </div>
                <Button
                  aria-label={`Delete AMMA ${statement.id}`}
                  onClick={() => onDeleteAmma(statement.id)}
                  size="sm"
                  variant="ghost"
                >
                  Delete
                </Button>
              </div>
            ))}
            {taxData.ammaStatements.length === 0 ? (
              <p className="text-muted-foreground py-2 text-xs">No AMMA statements saved.</p>
            ) : null}
          </div>
        </div>

        <div className="bg-background rounded-md border p-3">
          <h3 className="text-sm font-medium">Stored CPI observations</h3>
          <div className="mt-2 divide-y text-sm">
            {taxData.cpiSeries.map((observation) => (
              <div
                key={observation.quarter}
                className="flex items-center justify-between gap-3 py-2"
              >
                <p>
                  {observation.quarter} · {observation.value} · {observation.source}
                </p>
                <Button
                  aria-label={`Delete CPI ${observation.quarter}`}
                  onClick={() => onDeleteCpi(observation.quarter)}
                  size="sm"
                  variant="ghost"
                >
                  Delete
                </Button>
              </div>
            ))}
            {taxData.cpiSeries.length === 0 ? (
              <p className="text-muted-foreground py-2 text-xs">No CPI observations saved.</p>
            ) : null}
          </div>
        </div>

        <div className="bg-background rounded-md border p-3">
          <h3 className="text-sm font-medium">Stored 2027 snapshots</h3>
          <div className="mt-2 divide-y text-sm">
            {taxData.transitionSnapshots.map((snapshot) => (
              <div key={snapshot.parcelId} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="font-medium">{snapshot.parcelId}</p>
                  <p className="text-muted-foreground text-xs">
                    {snapshot.symbol} · {snapshot.account} · {formatAud(snapshot.marketValueAt2027)}
                  </p>
                </div>
                <Button
                  aria-label={`Delete snapshot ${snapshot.parcelId}`}
                  onClick={() => onDeleteSnapshot(snapshot.parcelId)}
                  size="sm"
                  variant="ghost"
                >
                  Delete
                </Button>
              </div>
            ))}
            {taxData.transitionSnapshots.length === 0 ? (
              <p className="text-muted-foreground py-2 text-xs">No snapshots saved.</p>
            ) : null}
          </div>
        </div>

        <div className="bg-background rounded-md border p-3">
          <h3 className="text-sm font-medium">Stored acquisition overrides</h3>
          <div className="mt-2 divide-y text-sm">
            {taxData.acquisitionOverrides.map((override) => (
              <div key={override.parcelId} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="font-medium">{override.parcelId}</p>
                  <p className="text-muted-foreground text-xs">
                    {override.symbol} · {override.account} · {override.acquisitionDate}
                  </p>
                </div>
                <Button
                  aria-label={`Delete acquisition override ${override.parcelId}`}
                  onClick={() => onDeleteAcquisitionOverride(override.parcelId)}
                  size="sm"
                  variant="ghost"
                >
                  Delete
                </Button>
              </div>
            ))}
            {taxData.acquisitionOverrides.length === 0 ? (
              <p className="text-muted-foreground py-2 text-xs">No acquisition overrides saved.</p>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
