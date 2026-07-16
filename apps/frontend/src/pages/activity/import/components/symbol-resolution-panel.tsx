import { useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
            {t("activity:import.symbolPanel.unrecognized", { count: unresolvedSymbols.length })}
            {totalAffectedRows > 0
              ? t("activity:import.symbolPanel.affectingRows", { count: totalAffectedRows })
              : ""}
          </h3>
        </div>
        <Button variant="outline" size="sm" onClick={handleMarkAllManual} className="text-xs">
          {t("activity:import.symbolPanel.markAllCustom")}
        </Button>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        {t("activity:import.symbolPanel.description")}
      </p>

      <div className="space-y-2">
        {unresolvedSymbols.map(({ csvSymbol, affectedCount }) => (
          <div key={csvSymbol} className="flex items-center gap-3">
            <code className="bg-muted w-28 shrink-0 truncate rounded px-1.5 py-0.5 text-xs font-semibold">
              {csvSymbol}
            </code>
            {affectedCount != null && (
              <span className="text-muted-foreground w-16 shrink-0 text-xs">
                {t("activity:import.symbolPanel.rows", { count: affectedCount })}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <TickerSearchInput
                defaultValue={csvSymbol}
                selectedResult={mappings[csvSymbol]}
                placeholder={t("activity:import.symbolPanel.searchFor", { symbol: csvSymbol })}
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
                {t("activity:import.symbolPanel.markCustom")}
              </Button>
            )}
          </div>
        ))}
      </div>

      {resolvedCount > 0 && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => onApplyMappings(mappings)}>
            {t("activity:import.symbolPanel.applyMappings", { count: resolvedCount })}
          </Button>
        </div>
      )}
    </div>
  );
}
