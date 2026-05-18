import { useState } from "react";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import TickerSearchInput from "@/components/ticker-search";
import type { SymbolSearchResult } from "@/lib/types";

export interface UnresolvedSymbol {
  csvSymbol: string;
  affectedCount?: number;
}

interface SymbolResolutionPanelProps {
  unresolvedSymbols: UnresolvedSymbol[];
  onApplyMappings: (mappings: Record<string, SymbolSearchResult>) => void;
}

function createManualSymbol(csvSymbol: string): SymbolSearchResult {
  // TODO: Same non-nullable values as in `create-custom-asset-dialog.tsx`. Maybe it makes sense to
  // unify this logic in one place?
  return {
    exchange: "MANUAL",
    shortName: csvSymbol,
    quoteType: "EQUITY",
    symbol: csvSymbol,
    index: "MANUAL",
    score: 0,
    typeDisplay: "Custom Asset",
    longName: csvSymbol,
    dataSource: "MANUAL",
    quoteMode: "MANUAL",
  };
}

export function SymbolResolutionPanel({
  unresolvedSymbols,
  onApplyMappings,
}: SymbolResolutionPanelProps) {
  const [mappings, setMappings] = useState<Record<string, SymbolSearchResult>>({});

  if (unresolvedSymbols.length === 0) return null;

  const resolvedCount = unresolvedSymbols.filter((s) => mappings[s.csvSymbol]).length;
  const totalAffectedRows = unresolvedSymbols.reduce((sum, s) => sum + (s.affectedCount ?? 0), 0);

  const handleMarkManual = (csvSymbol: string) => {
    // Create a manual symbol result
    setMappings((prev) => ({ ...prev, [csvSymbol]: createManualSymbol(csvSymbol) }));
  };

  const handleMarkAllManual = () => {
    const newMappings: Record<string, SymbolSearchResult> = {};
    unresolvedSymbols.forEach(({ csvSymbol }) => {
      newMappings[csvSymbol] = createManualSymbol(csvSymbol);
    });
    setMappings((prev) => ({ ...prev, ...newMappings }));
  };

  return (
    <div className="bg-warning/5 border-warning/20 rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icons.AlertTriangle className="text-warning h-4 w-4" />
          <h3 className="text-sm font-medium">
            {unresolvedSymbols.length} unrecognized{" "}
            {unresolvedSymbols.length === 1 ? "symbol" : "symbols"}
            {totalAffectedRows > 0 ? ` affecting ${totalAffectedRows} rows` : ""}
          </h3>
        </div>
        <Button variant="outline" size="sm" onClick={handleMarkAllManual} className="text-xs">
          Mark All Custom
        </Button>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        Search and map these symbols to the correct ticker or mark them custom, then apply. If you
        mark custom, an asset with this symbol will be automatically created during import. If the
        asset with this symbol already exists, it will be reused instead of creating a duplicate.
      </p>

      <div className="space-y-2">
        {unresolvedSymbols.map(({ csvSymbol, affectedCount }) => (
          <div key={csvSymbol} className="flex items-center gap-3">
            <code className="bg-muted w-28 shrink-0 truncate rounded px-1.5 py-0.5 text-xs font-semibold">
              {csvSymbol}
            </code>
            {affectedCount != null && (
              <span className="text-muted-foreground w-16 shrink-0 text-xs">
                {affectedCount} {affectedCount === 1 ? "row" : "rows"}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <TickerSearchInput
                defaultValue={csvSymbol}
                selectedResult={mappings[csvSymbol]}
                placeholder={`Search for ${csvSymbol}...`}
                onSelectResult={(_symbol, result) => {
                  if (result) {
                    setMappings((prev) => ({ ...prev, [csvSymbol]: result }));
                  }
                }}
                className="h-8 text-xs"
              />
            </div>
            {mappings[csvSymbol] ? (
              <Icons.CheckCircle className="text-success h-4 w-4 shrink-0" />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleMarkManual(csvSymbol)}
                className="h-8 shrink-0 px-2 text-xs"
              >
                Mark Custom
              </Button>
            )}
          </div>
        ))}
      </div>

      {resolvedCount > 0 && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => onApplyMappings(mappings)}>
            Apply {resolvedCount} {resolvedCount === 1 ? "mapping" : "mappings"}
          </Button>
        </div>
      )}
    </div>
  );
}
