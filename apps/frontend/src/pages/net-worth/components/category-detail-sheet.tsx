import { buttonVariants, useNumberFormatting } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CategoryTrendChart } from "./category-trend-chart";
import { CompactAmount } from "./compact-amount";
import {
  CARD_LABEL,
  CATEGORY_CSS_COLORS,
  deriveChange,
  formatChangePercent,
  hadBalanceBefore,
  liabilityDetailPath,
  toneClass,
  toneColor,
  type ParsedHistoryPoint,
  type SelectedCategory,
} from "./utils";

/** Net-worth category color (CSS), with red for liabilities. */
function categoryColor(selected: SelectedCategory): string {
  if (selected.isLiability) return "var(--destructive)";
  return CATEGORY_CSS_COLORS[selected.key] ?? "var(--muted-foreground)";
}

/** Alternative-asset duotone icon matching the category kind. */
function CategoryIcon({ selected, className }: { selected: SelectedCategory; className?: string }) {
  if (selected.isLiability) return <Icons.LiabilityDuotone className={className} />;
  switch (selected.key) {
    case "properties":
      return <Icons.RealEstateDuotone className={className} />;
    case "vehicles":
      return <Icons.VehicleDuotone className={className} />;
    case "collectibles":
      return <Icons.CollectibleDuotone className={className} />;
    case "preciousMetals":
      return <Icons.PreciousDuotone className={className} />;
    case "cash":
      return <Icons.Wallet className={className} />;
    default:
      return <Icons.OtherAssetDuotone className={className} />;
  }
}

/** Rounded icon chip tinted with the category color. */
function CategoryAvatar({
  selected,
  className = "h-7 w-7",
  iconClassName = "h-4 w-4",
}: {
  selected: SelectedCategory;
  className?: string;
  iconClassName?: string;
}) {
  const color = categoryColor(selected);
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-md ${className}`}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <CategoryIcon selected={selected} className={iconClassName} />
    </div>
  );
}

interface CategoryDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: SelectedCategory | null;
  history: ParsedHistoryPoint[];
  currency: string;
  periodLabel: string;
}

/** Detail drawer for a breakdown row: trend chart + the items rolled into it. */
export function CategoryDetailSheet({
  open,
  onOpenChange,
  selected,
  history,
  currency,
  periodLabel,
}: CategoryDetailSheetProps) {
  const formatting = useNumberFormatting();
  const { t } = useTranslation();
  const trend = selected
    ? history.map((point) => ({ date: point.date, value: point.breakdown[selected.key] ?? 0 }))
    : [];
  const change = deriveChange(
    trend.map((t) => t.value),
    selected?.isLiability ?? false,
    hadBalanceBefore(history, selected?.firstValueDate),
  );
  const sign = Math.abs(change.amount) < 0.005 ? "" : change.amount > 0 ? "+" : "-";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden sm:max-w-md">
        {selected && (
          <>
            <SheetHeader className="mt-4">
              <SheetTitle className="flex items-center gap-2.5">
                <CategoryAvatar selected={selected} />
                {selected.name}
              </SheetTitle>
            </SheetHeader>

            <div className="flex-1 space-y-6 overflow-y-auto py-4">
              {/* Current value + change over range */}
              <div>
                <div className="text-2xl font-bold tabular-nums">
                  {selected.isLiability && selected.value !== 0 ? "-" : ""}
                  <CompactAmount value={selected.value} currency={currency} />
                </div>
                <div
                  className={`mt-0.5 flex items-baseline gap-1.5 text-sm tabular-nums ${toneClass(change.amount)}`}
                >
                  <span>
                    {sign}
                    <CompactAmount value={Math.abs(change.amount)} currency={currency} />
                  </span>
                  <span>
                    {change.percent !== null && sign}
                    {formatChangePercent(
                      change,
                      t("insights:networth.breakdown_table.new"),
                      formatting,
                    )}
                  </span>
                  <span className="text-muted-foreground font-normal">
                    {t("insights:networth.category_sheet.over_period", { period: periodLabel })}
                  </span>
                </div>
              </div>

              {/* Trend */}
              <div>
                <p className={`${CARD_LABEL} pb-2`}>
                  {t("insights:networth.category_sheet.trend_period", { period: periodLabel })}
                </p>
                <CategoryTrendChart data={trend} color={toneColor(change.amount)} />
              </div>

              {/* A liability is one item with a page of its own. */}
              {selected.isLiability && (
                <Link
                  to={liabilityDetailPath(selected.key)}
                  onClick={() => onOpenChange(false)}
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className: "w-full pointer-coarse:h-11",
                  })}
                >
                  {t("insights:networth.category_sheet.view_details")}
                  <Icons.ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
                </Link>
              )}

              {/* Items rolled into this category */}
              {selected.children.length > 0 && (
                <div>
                  <p className={`${CARD_LABEL} pb-1`}>
                    {t("insights:networth.category_sheet.items")}
                  </p>
                  <div className="divide-border/40 divide-y">
                    {selected.children.map((child, index) => {
                      const content = (
                        <>
                          <div className="flex min-w-0 items-center gap-2.5">
                            <CategoryAvatar selected={selected} />
                            <span className="text-foreground/90 min-w-0 truncate text-sm">
                              {child.name}
                            </span>
                          </div>
                          <div className="flex items-baseline gap-2.5">
                            {selected.value > 0 && (
                              <span className="text-muted-foreground/60 text-xs tabular-nums">
                                {formatting.formatPercent(child.value / selected.value, {
                                  digits: 1,
                                })}
                              </span>
                            )}
                            <span className="text-foreground/90 text-sm tabular-nums">
                              <CompactAmount value={child.value} currency={currency} />
                            </span>
                            {child.assetId && (
                              <Icons.ChevronRight
                                className="text-muted-foreground size-4 rtl:rotate-180"
                                aria-hidden
                              />
                            )}
                          </div>
                        </>
                      );
                      const rowClass = "flex items-center justify-between gap-3 py-2";
                      // Each item opens its own asset page.
                      return child.assetId ? (
                        <Link
                          key={child.assetId}
                          to={`/holdings/${encodeURIComponent(child.assetId)}`}
                          onClick={() => onOpenChange(false)}
                          className={`${rowClass} hover:bg-muted/50 -mx-2 rounded-md px-2 pointer-coarse:min-h-11`}
                        >
                          {content}
                        </Link>
                      ) : (
                        <div key={`${child.name}-${index}`} className={rowClass}>
                          {content}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
