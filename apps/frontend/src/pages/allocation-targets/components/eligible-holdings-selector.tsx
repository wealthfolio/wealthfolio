import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "@wealthfolio/ui";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@wealthfolio/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import type { Holding } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getEligibleHoldings, groupEligibleHoldings } from "./eligible-holdings";

function groupLabel(key: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    EQUITY: t("allocation:eligibleHoldings.groups.equity"),
    BOND: t("allocation:eligibleHoldings.groups.bond"),
    CRYPTO: t("allocation:eligibleHoldings.groups.crypto"),
    OPTION: t("allocation:eligibleHoldings.groups.option"),
    METAL: t("allocation:eligibleHoldings.groups.metal"),
    FX: t("allocation:eligibleHoldings.groups.fx"),
    OTHER: t("allocation:eligibleHoldings.groups.other"),
  };
  return labels[key] ?? key;
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        selected ? "border-foreground bg-foreground text-background" : "border-border",
      )}
    >
      <Icons.Check className={cn("h-3 w-3", !selected && "opacity-0")} />
    </span>
  );
}

export interface EligibleHoldingsSelectorProps {
  holdings: Holding[];
  excludedAssetIds: ReadonlySet<string>;
  onToggle: (assetId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

export function EligibleHoldingsSelector({
  holdings,
  excludedAssetIds,
  onToggle,
  onSelectAll,
  onClear,
}: EligibleHoldingsSelectorProps) {
  const { t } = useTranslation();
  const eligibleHoldings = useMemo(() => getEligibleHoldings(holdings), [holdings]);
  const groupedHoldings = useMemo(
    () => groupEligibleHoldings(eligibleHoldings),
    [eligibleHoldings],
  );
  const selectedCount = eligibleHoldings.reduce(
    (count, holding) => count + (excludedAssetIds.has(holding.assetId) ? 0 : 1),
    0,
  );
  const allSelected = eligibleHoldings.length > 0 && selectedCount === eligibleHoldings.length;
  const summary = allSelected
    ? t("allocation:eligibleHoldings.allSelected")
    : t("allocation:eligibleHoldings.selectedCount", {
        selected: selectedCount,
        total: eligibleHoldings.length,
      });
  const label = t("allocation:eligibleHoldings.label");

  return (
    <div className="mt-4">
      <div className="text-muted-foreground font-mono text-xs uppercase tracking-[0.14em]">
        {t("allocation:eligibleHoldings.label")}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("allocation:eligibleHoldings.triggerLabel", { label, summary })}
            className="border-border/70 hover:border-foreground/40 mt-1.5 flex w-full items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-2.5 text-left transition-colors"
          >
            <span className="text-foreground min-w-0 truncate font-mono text-sm font-semibold tabular-nums">
              {summary}
            </span>
            <Icons.ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(420px,calc(100vw-2rem))] p-0">
          <Command>
            <CommandInput placeholder={t("allocation:eligibleHoldings.searchPlaceholder")} />
            <CommandList className="max-h-[min(60vh,360px)]">
              <CommandEmpty>{t("allocation:eligibleHoldings.noMatches")}</CommandEmpty>
              {groupedHoldings.map((group) => (
                <CommandGroup key={group.key} heading={groupLabel(group.key, t)}>
                  {group.holdings.map((holding) => {
                    const selected = !excludedAssetIds.has(holding.assetId);
                    const details = [holding.exchangeMic, holding.currency]
                      .filter((value): value is string => Boolean(value))
                      .join(" · ");
                    return (
                      <CommandItem
                        key={holding.assetId}
                        value={holding.assetId}
                        keywords={[
                          holding.symbol,
                          holding.name ?? "",
                          holding.exchangeMic ?? "",
                          holding.currency,
                        ]}
                        onSelect={() => onToggle(holding.assetId)}
                        aria-label={t("allocation:eligibleHoldings.rowLabel", {
                          symbol: holding.symbol,
                          name: holding.name ?? "",
                          details,
                          state: t(
                            selected
                              ? "allocation:eligibleHoldings.selected"
                              : "allocation:eligibleHoldings.notSelected",
                          ),
                        })}
                        className="gap-2"
                      >
                        <SelectionMark selected={selected} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-xs font-semibold">
                            {holding.symbol}
                          </span>
                          {holding.name && (
                            <span className="text-muted-foreground block truncate text-xs">
                              {holding.name}
                            </span>
                          )}
                          <span className="text-muted-foreground/80 block truncate font-mono text-[11px]">
                            {details}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
            <CommandSeparator />
            <div className="text-muted-foreground flex items-center justify-between px-3 py-2 font-mono text-[11px]">
              <span className="tabular-nums">
                {t("allocation:eligibleHoldings.selectedCount", {
                  selected: selectedCount,
                  total: eligibleHoldings.length,
                })}
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onSelectAll}
                  className="hover:text-foreground rounded px-1.5 py-0.5 transition-colors"
                >
                  {t("allocation:eligibleHoldings.selectAll")}
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="hover:text-foreground rounded px-1.5 py-0.5 transition-colors"
                >
                  {t("allocation:eligibleHoldings.clear")}
                </button>
              </span>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedCount === 0 && (
        <p className="text-destructive mt-2 font-mono text-xs">
          {t("allocation:eligibleHoldings.emptyGuidance")}
        </p>
      )}
    </div>
  );
}
