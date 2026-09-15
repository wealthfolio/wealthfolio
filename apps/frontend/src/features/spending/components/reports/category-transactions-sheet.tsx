import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { TruncatedText } from "@/components/truncated-text";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Account, TaxonomyCategory } from "@/lib/types";
import { cn, formatDate, formatDateISO } from "@/lib/utils";
import {
  Button,
  Icons,
  PrivacyAmount,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  calendarDateFromLocalDate,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
  type FormattingApi,
} from "@wealthfolio/ui";

import { useCashActivitySearch } from "../../hooks/use-cash-activity-search";
import { useSpendingSettings } from "../../hooks/use-spending-settings";
import {
  computeCategoryDrilldown,
  DIRECT_ROW_ID,
  type DrilldownBucket,
} from "../../lib/category-drilldown";
import { descendantCategoryIds } from "../../lib/category-rollup";
import { getActivitySpendingAmount } from "../../lib/constants";
import { CategoryIcon } from "../category-chips";

interface CategoryTransactionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The category that was clicked. Null while the sheet is closed. */
  category: TaxonomyCategory | null;
  taxonomyCategories: TaxonomyCategory[];
  rangeStart: Date;
  rangeEnd: Date;
  /**
   * `insight.byDayByCategory` for the same window as `rangeStart`/`rangeEnd`.
   * The header stats and subcategory mix come from here rather than from the
   * paginated list below, which only ever holds the pages loaded so far.
   */
  buckets: DrilldownBucket[];
  /** Calendar length of the window, from `ReportsRange.days`. Deriving it
   *  from the two boundary instants overcounts by a day. */
  rangeDays: number;
  /** `insight.headline.pace.daysElapsed` — days of the window that have
   *  actually happened, resolved in the app timezone. The pace card on the
   *  page behind the drawer divides by the same figure. */
  daysElapsed: number;
  /** Loading state of the insight query that produced `buckets` — separate
   *  from the transaction list's own. */
  isStatsLoading: boolean;
  currency: string;
}

/**
 * Drill-down drawer listing cash activities for a category in the active
 * insight range. Header shows aggregate stats; top-level categories also get a
 * subcategory composition strip.
 *
 * When to use this vs. navigating to `/activities?tab=spending&category=…`:
 *
 *   • In-context analysis surfaces (Insights stages, category breakdown
 *     tables, sparkline grids on the insights page) → **use this sheet**.
 *     The user is mid-narrative; staying in context preserves the period,
 *     comparison, and other settings they're examining.
 *
 *   • Cross-page summary widgets (the dashboard Spending tab's treemap,
 *     ranked bar, group blocks; the budget chart's category rings) →
 *     **navigate to /activities**. The user clicked a summary number to
 *     drill *out* for bulk edits, deletions, or full-transaction filters.
 *
 * If you find a third pattern emerging, decide which bucket above it falls
 * into rather than introducing a third primitive.
 */
export function CategoryTransactionsSheet({
  open,
  onOpenChange,
  category,
  taxonomyCategories,
  rangeStart,
  rangeEnd,
  buckets,
  rangeDays,
  daysElapsed,
  isStatsLoading,
  currency,
}: CategoryTransactionsSheetProps) {
  const amountFormatting = useAmountFormatting();
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const isTopLevel = !!category && !category.parentId;
  const { excludedCategoryIds } = useSpendingSettings();

  const categoryMeta = useMemo(
    () => new Map(taxonomyCategories.map((c) => [c.id, c] as const)),
    [taxonomyCategories],
  );

  // Whole subtree, so the list covers exactly what the stats roll up — minus
  // excluded branches (an excluded category and everything beneath it), which
  // the server aggregates behind those stats already leave out.
  const ids = useMemo(() => {
    if (!category) return [] as string[];
    const excluded = new Set(
      excludedCategoryIds.flatMap((id) => descendantCategoryIds(id, taxonomyCategories)),
    );
    return descendantCategoryIds(category.id, taxonomyCategories).filter((id) => !excluded.has(id));
  }, [category, excludedCategoryIds, taxonomyCategories]);

  // Both bounds are already resolved against the configured app timezone —
  // `rangeEnd` is that day's inclusive end-of-day instant. Re-flooring it to
  // the *browser's* 23:59:59 would shift the window whenever the two
  // timezones differ, pulling in rows the insight never counted.
  const startIso = rangeStart.toISOString();
  const endIso = rangeEnd.toISOString();

  const searchRequest = useMemo(
    () => ({
      categoryIds: ids,
      startDate: startIso,
      endDate: endIso,
      sortBy: "date" as const,
      sortDir: "desc" as const,
    }),
    [ids, startIso, endIso],
  );

  const {
    items,
    totalCount,
    isLoading,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useCashActivitySearch(searchRequest, { enabled: open && ids.length > 0 });

  const { accounts = [] } = useAccounts({ filterActive: false });
  const accountById = useMemo(() => {
    const m = new Map<string, Account>();
    accounts.forEach((a) => m.set(a.id, a));
    return m;
  }, [accounts]);

  // Header stats come from the server aggregate, never from `items` — the
  // list holds only the pages fetched so far.
  const drilldown = useMemo(
    () =>
      category
        ? computeCategoryDrilldown({ categoryId: category.id, buckets, meta: categoryMeta })
        : { spent: 0, mix: [] },
    [buckets, category, categoryMeta],
  );

  // Divided by the same count shown in the TX tile, so the three figures
  // multiply out on screen.
  const avg = totalCount > 0 ? drilldown.spent / totalCount : 0;
  // Elapsed days, not the calendar length: a live month-to-date window has
  // most of its days still ahead of it.
  const dailyPace = drilldown.spent / Math.max(1, daysElapsed);

  // Subcategory composition for top-level categories only. Names and colors
  // are resolved here; the arithmetic lives in `computeCategoryDrilldown`.
  const subBreakdown = useMemo(() => {
    if (!isTopLevel || !category) return [];
    return drilldown.mix.map((row) => {
      const meta = row.id === DIRECT_ROW_ID ? category : categoryMeta.get(row.id);
      return {
        ...row,
        name:
          row.id === DIRECT_ROW_ID ? t("spending:categorySheet.direct") : (meta?.name ?? row.id),
        color: meta?.color ?? "var(--muted-foreground)",
      };
    });
  }, [category, categoryMeta, drilldown.mix, isTopLevel, t]);

  const transactionsLink = useMemo(() => {
    if (!category) return "/activities?tab=spending";
    const params = new URLSearchParams();
    params.set("tab", "spending");
    if (category.parentId) {
      params.set("subcategory", category.id);
    } else {
      params.set("category", category.id);
    }
    params.set("from", formatDateISO(rangeStart));
    params.set("to", formatDateISO(rangeEnd));
    return `/activities?${params.toString()}`;
  }, [category, rangeStart, rangeEnd]);

  const accent = category?.color ?? "var(--muted-foreground)";
  const tintBg = category?.color ? `${category.color}24` : "var(--muted)";
  // Strong-at-top, fade-to-transparent — gives the header the warm "drill-down"
  // panel feel from the inspiration. Falls back to a neutral muted wash so the
  // anatomy is visible even when a category has no color set.
  const headerFill = category?.color ? `${category.color}40` : "rgba(120,120,120,0.18)";
  const headerFillMid = category?.color ? `${category.color}1A` : "rgba(120,120,120,0.06)";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-full flex-col gap-0 p-0 sm:max-w-lg"
        // SheetContent injects an inline paddingTop (safe-area + 1.5rem) that a
        // className can't override. Zero it here and reapply safe-area inside
        // the header so the gradient runs edge-to-edge from the very top.
        style={{ paddingTop: 0 }}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header
          className="border-border/60 relative border-b px-6 pb-5"
          style={{
            paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.5rem)",
            backgroundImage: `linear-gradient(to bottom, ${headerFill} 0%, ${headerFillMid} 55%, transparent 100%)`,
          }}
        >
          <div className="text-muted-foreground/80 text-[10px] font-semibold uppercase tracking-[0.14em]">
            {t("spending:categorySheet.eyebrow")}
          </div>
          <div className="mt-2 flex items-start gap-3">
            <span
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: tintBg, color: accent }}
            >
              <CategoryIcon
                icon={category?.icon ?? null}
                fallback={category?.name ?? "?"}
                className="h-5 w-5"
              />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-foreground truncate text-2xl font-semibold tracking-tight">
                {category?.name ?? t("spending:categorySheet.categoryFallback")}
              </SheetTitle>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {formatRangeLabel(rangeStart, rangeEnd, dateFormatting)} ·{" "}
                {t("spending:categorySheet.daysCount", { count: rangeDays })}
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-4 gap-3">
            <Stat
              label={t("spending:categorySheet.spent")}
              value={
                isStatsLoading ? (
                  <Skeleton className="h-5 w-16" />
                ) : isBalanceHidden ? (
                  "••••"
                ) : (
                  amountFormatting.formatCompactAmount(drilldown.spent, currency)
                )
              }
              hint={isTopLevel ? t("spending:categorySheet.allSubcategories") : null}
            />
            <Stat
              label={t("spending:categorySheet.tx")}
              value={
                isLoading ? (
                  <Skeleton className="h-5 w-10" />
                ) : (
                  numberFormatting.formatDecimal(totalCount)
                )
              }
              hint={null}
            />
            <Stat
              label={t("spending:categorySheet.avgPerTx")}
              value={
                isStatsLoading || isLoading ? (
                  <Skeleton className="h-5 w-14" />
                ) : isBalanceHidden ? (
                  "••••"
                ) : (
                  amountFormatting.formatCompactAmount(avg, currency)
                )
              }
              hint={t("spending:categorySheet.acrossAllTx")}
            />
            <Stat
              label={t("spending:categorySheet.dailyPace")}
              value={
                isStatsLoading ? (
                  <Skeleton className="h-5 w-14" />
                ) : isBalanceHidden ? (
                  "••••"
                ) : (
                  amountFormatting.formatCompactAmount(dailyPace, currency)
                )
              }
              hint={t("spending:categorySheet.inThisPeriod")}
            />
          </div>
        </header>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Subcategory composition */}
          {isTopLevel && (subBreakdown.length > 0 || isStatsLoading) && (
            <section className="mb-6">
              <h3 className="text-foreground text-sm font-semibold">
                {t("spending:categorySheet.subcategoryMix")}
              </h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("spending:categorySheet.subcategoryMixHint")}
              </p>
              <div className="mt-3 space-y-2">
                {isStatsLoading ? (
                  <>
                    <Skeleton className="h-5 w-full" />
                    <Skeleton className="h-5 w-full" />
                    <Skeleton className="h-5 w-3/4" />
                  </>
                ) : (
                  subBreakdown.map((row) => (
                    <div key={row.id} className="flex items-center gap-3 text-[12px]">
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className="block h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: row.color }}
                        />
                        <span className="text-foreground/90 truncate font-medium">{row.name}</span>
                      </span>
                      <div className="bg-foreground/5 h-1.5 w-32 overflow-hidden rounded-full sm:w-44">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, row.share)}%`,
                            backgroundColor: row.color,
                            opacity: 0.8,
                          }}
                        />
                      </div>
                      <span className="text-muted-foreground/80 w-10 shrink-0 text-right text-[11px] tabular-nums">
                        {numberFormatting.formatPercent(row.share / 100, { digits: 0 })}
                      </span>
                      <span className="text-foreground/90 w-16 shrink-0 text-right text-xs font-semibold tabular-nums">
                        {isBalanceHidden
                          ? "••••"
                          : amountFormatting.formatCompactAmount(row.amount, currency)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          {/* Transactions list */}
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-foreground text-sm font-semibold">
                {t("spending:categorySheet.transactions")}
              </h3>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {isLoading
                  ? t("spending:categorySheet.loading")
                  : t("spending:categorySheet.totalCount", { count: totalCount })}
              </span>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-xl" />
                ))}
              </div>
            ) : isError ? (
              <div className="text-destructive border-border/60 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center text-sm">
                <Icons.AlertTriangle className="h-6 w-6 opacity-70" aria-hidden />
                <div>{error?.message ?? t("spending:categorySheet.loadError")}</div>
              </div>
            ) : items.length === 0 ? (
              <div className="text-muted-foreground border-border/60 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center text-sm">
                <Icons.Activity className="h-6 w-6 opacity-50" aria-hidden />
                <div>{t("spending:categorySheet.noTransactions")}</div>
              </div>
            ) : (
              <ul className="divide-border/40 divide-y">
                {items.map((it) => {
                  const account = accountById.get(it.accountId);
                  const amt = parseFloat(it.amount ?? "0");
                  const safeAmt = Number.isFinite(amt) ? amt : 0;
                  const spendingAmount = getActivitySpendingAmount(it, account?.accountType);
                  const isOutflow = spendingAmount > 0;
                  const displayAmount =
                    spendingAmount !== 0 ? Math.abs(spendingAmount) : Math.abs(safeAmt);
                  return (
                    <li
                      key={it.id}
                      className="hover:bg-muted/30 flex items-center gap-2.5 px-1 py-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-foreground text-[13px] font-medium leading-tight">
                          {it.notes != null ? (
                            <TruncatedText text={it.notes} />
                          ) : (
                            <span className="text-muted-foreground italic">
                              {it.activityType.toLowerCase()}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground/80 mt-0.5 flex items-center gap-1 text-[10px] leading-tight">
                          <span>{formatDate(it.activityDate, dateFormatting)}</span>
                          <span aria-hidden>·</span>
                          <span className="truncate">{account?.name ?? it.accountId}</span>
                        </div>
                      </div>
                      <div
                        className={cn(
                          "shrink-0 text-right text-[13px] font-semibold tabular-nums leading-tight",
                          isOutflow ? "text-foreground" : "text-success",
                        )}
                      >
                        {isOutflow ? "−" : "+"}
                        <PrivacyAmount value={displayAmount} currency={it.currency} />
                        {it.currency !== currency && (
                          <span className="text-muted-foreground/70 ml-1 text-[9px] uppercase tracking-wide">
                            {it.currency}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {hasNextPage && (
              <div className="mt-3 flex items-center justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? (
                    <>
                      <Icons.Spinner className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden />
                      {t("spending:categorySheet.loading")}
                    </>
                  ) : (
                    t("spending:categorySheet.loadMore", {
                      count: Math.min(50, totalCount - items.length),
                    })
                  )}
                </Button>
              </div>
            )}
          </section>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <div className="border-border/60 bg-background/70 border-t px-6 py-3 backdrop-blur">
          <Button asChild size="sm" className="w-full">
            <Link to={transactionsLink} onClick={() => onOpenChange(false)}>
              {t("spending:categorySheet.openInTransactions")}
              <Icons.ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden />
            </Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint: string | null;
}) {
  return (
    <div>
      <div className="text-muted-foreground/70 text-[10px] font-semibold uppercase tracking-[0.12em]">
        {label}
      </div>
      <div className="text-foreground mt-1 text-base font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      {hint && <div className="text-muted-foreground/70 mt-0.5 truncate text-[10px]">{hint}</div>}
    </div>
  );
}

function formatRangeLabel(
  start: Date,
  end: Date,
  formatting: Pick<FormattingApi, "formatCalendarDate">,
): string {
  const sameYear = start.getFullYear() === end.getFullYear();
  const options = { month: "short", day: "numeric" } as const;
  const startStr = formatting.formatCalendarDate(calendarDateFromLocalDate(start), options);
  const endStr = formatting.formatCalendarDate(calendarDateFromLocalDate(end), options);
  const yearStr = sameYear
    ? `, ${formatting.formatCalendarDate(calendarDateFromLocalDate(end), { year: "numeric" })}`
    : "";
  return `${startStr} – ${endStr}${yearStr}`;
}
