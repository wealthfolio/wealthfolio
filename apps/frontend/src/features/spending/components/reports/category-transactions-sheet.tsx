import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import {
  Button,
  Icons,
  PrivacyAmount,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  formatCompactAmount,
} from "@wealthfolio/ui";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Account, TaxonomyCategory } from "@/lib/types";
import { cn, formatDate, formatDateISO } from "@/lib/utils";

import { CategoryIcon } from "../category-chips";
import { useCashActivitySearch } from "../../hooks/use-cash-activity-search";
import { getActivitySpendingAmount } from "../../lib/constants";

const SPENDING_TAXONOMY = "spending_categories";

interface CategoryTransactionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The category that was clicked. Null while the sheet is closed. */
  category: TaxonomyCategory | null;
  taxonomyCategories: TaxonomyCategory[];
  rangeStart: Date;
  rangeEnd: Date;
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
  currency,
}: CategoryTransactionsSheetProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const isTopLevel = !!category && !category.parentId;

  const ids = useMemo(() => {
    if (!category) return [] as string[];
    if (category.parentId) return [category.id];
    const out = [category.id];
    for (const c of taxonomyCategories) {
      if (c.parentId === category.id) out.push(c.id);
    }
    return out;
  }, [category, taxonomyCategories]);

  const startIso = rangeStart.toISOString();
  // Inclusive end-of-day so transactions on the final day are included.
  const endIso = useMemo(() => {
    const d = new Date(rangeEnd);
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }, [rangeEnd]);

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

  // Aggregate the loaded items into the four header stats.
  const stats = useMemo(() => {
    let outflow = 0;
    let outflowCount = 0;
    for (const it of items) {
      const account = accountById.get(it.accountId);
      const amt = getActivitySpendingAmount(it, account?.accountType);
      if (amt <= 0) continue;
      outflow += amt;
      outflowCount += 1;
    }
    const avg = outflowCount > 0 ? outflow / outflowCount : 0;
    const days = Math.max(
      1,
      Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000) + 1,
    );
    const dailyPace = outflow / days;
    return { outflow, outflowCount, avg, dailyPace, days };
  }, [items, accountById, rangeStart, rangeEnd]);

  // Subcategory composition for top-level categories only. Loaded items each
  // carry their assignments; group by the spending-taxonomy assignment id.
  const subBreakdown = useMemo(() => {
    if (!isTopLevel || !category) return [];
    const subMeta = new Map(
      taxonomyCategories.filter((c) => c.parentId === category.id).map((c) => [c.id, c] as const),
    );
    const byId = new Map<string, { id: string; name: string; color: string; amount: number }>();
    let directAmount = 0; // Items tagged directly to the parent (no sub).
    for (const it of items) {
      const account = accountById.get(it.accountId);
      const amt = getActivitySpendingAmount(it, account?.accountType);
      if (amt <= 0) continue;
      const assignment = it.assignments.find((a) => a.taxonomyId === SPENDING_TAXONOMY);
      const subId = assignment?.categoryId;
      if (subId && subMeta.has(subId)) {
        const m = subMeta.get(subId)!;
        const e = byId.get(subId) ?? {
          id: subId,
          name: m.name,
          color: m.color ?? "var(--muted-foreground)",
          amount: 0,
        };
        e.amount += amt;
        byId.set(subId, e);
      } else {
        directAmount += amt;
      }
    }
    const rows = Array.from(byId.values())
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    if (directAmount > 0) {
      rows.push({
        id: "__direct__",
        name: t("spending:categorySheet.direct"),
        color: category.color ?? "var(--muted-foreground)",
        amount: directAmount,
      });
    }
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return rows.map((r) => ({ ...r, share: total > 0 ? (r.amount / total) * 100 : 0 }));
  }, [accountById, category, isTopLevel, items, taxonomyCategories, t]);

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
                {formatRangeLabel(rangeStart, rangeEnd)} ·{" "}
                {t("spending:categorySheet.daysCount", { count: stats.days })}
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-4 gap-3">
            <Stat
              label={t("spending:categorySheet.spent")}
              value={
                isLoading ? (
                  <Skeleton className="h-5 w-16" />
                ) : isBalanceHidden ? (
                  "••••"
                ) : (
                  formatCompactAmount(stats.outflow, currency)
                )
              }
              hint={isTopLevel ? t("spending:categorySheet.allSubcategories") : null}
            />
            <Stat
              label={t("spending:categorySheet.tx")}
              value={isLoading ? <Skeleton className="h-5 w-10" /> : totalCount.toLocaleString()}
              hint={
                stats.outflowCount > 0 && stats.outflowCount < totalCount
                  ? t("spending:categorySheet.outflowsCount", { count: stats.outflowCount })
                  : null
              }
            />
            <Stat
              label={t("spending:categorySheet.avgPerTx")}
              value={
                isLoading ? (
                  <Skeleton className="h-5 w-14" />
                ) : isBalanceHidden ? (
                  "••••"
                ) : (
                  formatCompactAmount(stats.avg, currency)
                )
              }
              hint={t("spending:categorySheet.outflowsOnly")}
            />
            <Stat
              label={t("spending:categorySheet.dailyPace")}
              value={
                isLoading ? (
                  <Skeleton className="h-5 w-14" />
                ) : isBalanceHidden ? (
                  "••••"
                ) : (
                  formatCompactAmount(stats.dailyPace, currency)
                )
              }
              hint={t("spending:categorySheet.inThisPeriod")}
            />
          </div>
        </header>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Subcategory composition */}
          {isTopLevel && (subBreakdown.length > 0 || isLoading) && (
            <section className="mb-6">
              <h3 className="text-foreground text-sm font-semibold">
                {t("spending:categorySheet.subcategoryMix")}
              </h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("spending:categorySheet.subcategoryMixHint")}
              </p>
              <div className="mt-3 space-y-2">
                {isLoading ? (
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
                        {row.share.toFixed(0)}%
                      </span>
                      <span className="text-foreground/90 w-16 shrink-0 text-right text-xs font-semibold tabular-nums">
                        {isBalanceHidden ? "••••" : formatCompactAmount(row.amount, currency)}
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
                        <div className="text-foreground truncate text-[13px] font-medium leading-tight">
                          {it.notes ?? (
                            <span className="text-muted-foreground italic">
                              {it.activityType.toLowerCase()}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground/80 mt-0.5 flex items-center gap-1 text-[10px] leading-tight">
                          <span>{formatDate(it.activityDate)}</span>
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

function formatRangeLabel(start: Date, end: Date): string {
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const sameYear = start.getFullYear() === end.getFullYear();
  const yearFmt = new Intl.DateTimeFormat(undefined, { year: "numeric" });
  const startStr = fmt.format(start);
  const endStr = fmt.format(end);
  const yearStr = sameYear ? `, ${yearFmt.format(end)}` : "";
  return `${startStr} – ${endStr}${yearStr}`;
}
