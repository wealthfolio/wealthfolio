import { CategoryAvatar } from "@/components/financial/category-avatar";
import { CompactAmount } from "@/components/financial/compact-amount";
import { CARD_LABEL } from "@/components/financial/styles";
import { buttonVariants, useNumberFormatting } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { CategoryTrendChart } from "./category-trend-chart";
import {
  categoryItemDetailPath,
  deriveChange,
  formatChangePercent,
  hadBalanceBefore,
  liabilityDetailPath,
  toneClass,
  toneColor,
  type ParsedHistoryPoint,
  type SelectedCategory,
} from "./utils";

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
  const change =
    trend.length >= 2
      ? deriveChange(
          trend.map((t) => t.value),
          selected?.isLiability ?? false,
          hadBalanceBefore(history, selected?.firstValueDate),
        )
      : null;
  const sign = !change || Math.abs(change.amount) < 0.005 ? "" : change.amount > 0 ? "+" : "-";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden sm:max-w-md">
        {selected && (
          <>
            <SheetHeader className="mt-4">
              <SheetTitle className="flex items-center gap-2.5">
                <CategoryAvatar category={selected.key} isLiability={selected.isLiability} />
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
                  className={`mt-0.5 flex items-baseline gap-1.5 text-sm tabular-nums ${toneClass(change?.amount ?? 0)}`}
                >
                  {change ? (
                    <>
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
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
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
                <CategoryTrendChart data={trend} color={toneColor(change?.amount ?? 0)} />
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
                      const detailPath = categoryItemDetailPath(selected.key, child.assetId);
                      const content = (
                        <>
                          <div className="flex min-w-0 items-center gap-2.5">
                            <CategoryAvatar
                              category={selected.key}
                              isLiability={selected.isLiability}
                            />
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
                            {detailPath && (
                              <Icons.ChevronRight
                                className="text-muted-foreground size-4 rtl:rotate-180"
                                aria-hidden
                              />
                            )}
                          </div>
                        </>
                      );
                      const rowClass = "flex items-center justify-between gap-3 py-2";
                      // Cash items identify accounts; other items identify assets.
                      return detailPath ? (
                        <Link
                          key={child.assetId}
                          to={detailPath}
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
