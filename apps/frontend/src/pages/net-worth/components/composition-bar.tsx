import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { useMemo } from "react";
import { CATEGORY_CSS_COLORS, type ParsedNetWorth } from "./utils";

/** Slim stacked bar of asset composition (% of assets). The breakdown rows below act as its legend. */
export function CompositionBar({ data, className }: { data: ParsedNetWorth; className?: string }) {
  const items = useMemo(() => {
    if (data.assets.total === 0) return [];
    return data.assets.breakdown
      .filter((item) => item.value > 0)
      .map((item) => ({
        category: item.category,
        name: item.name,
        percentage: (item.value / data.assets.total) * 100,
      }))
      .sort((a, b) => b.percentage - a.percentage);
  }, [data]);

  if (items.length === 0) return null;

  return (
    <div className={`flex h-2 w-full overflow-hidden rounded-full ${className ?? ""}`}>
      {items.map((item, index) => (
        <TooltipProvider key={item.category} delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="h-full transition-opacity hover:opacity-80"
                style={{
                  width: `${item.percentage}%`,
                  minWidth: "2px",
                  backgroundColor: CATEGORY_CSS_COLORS[item.category] ?? "var(--muted-foreground)",
                  marginLeft: index > 0 ? "1px" : 0,
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              <span className="font-medium">{item.name}</span>
              <span className="text-muted-foreground ml-2">{item.percentage.toFixed(1)}%</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ))}
    </div>
  );
}
