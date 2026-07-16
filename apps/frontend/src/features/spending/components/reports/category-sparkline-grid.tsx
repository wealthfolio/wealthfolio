import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

import { Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CategoryIcon } from "../category-chips";
import type { CategoryBreakdownRow, DayCategoryBucket, MonthBucket } from "../../types/report";

export type SparklineGranularity = "day" | "month";

interface CategorySparklineGridProps {
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
  /** Prior-period breakdown — drives the % chip (matches the Breakdown table). */
  priorBreakdown?: CategoryBreakdownRow[];
  /** Granularity of the sparkline series. Defaults to "month". */
  granularity?: SparklineGranularity;
  /** Required when granularity = "month". */
  months?: MonthBucket[];
  /** Required when granularity = "day". */
  byDayByCategory?: DayCategoryBucket[];
  /** Limit visible cards. */
  topN?: number;
}

interface CategorySparklineRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  series: { label: string; value: number }[];
  total: number;
  /** % delta — current period vs prior period (same source as the Breakdown table). */
  deltaPct: number | null;
}

/**
 * Per-category sparkline grid — one card per top-level category.
 *
 * Shows the spending trajectory across the months in scope. Designed for the
 * Categories tab where the user wants to spot which categories are accelerating
 * or decelerating without drilling into a chart per row.
 */
export function CategorySparklineGrid({
  taxonomyCategories,
  currency,
  isLoading,
  priorBreakdown,
  granularity = "month",
  months,
  byDayByCategory,
  topN = 8,
}: CategorySparklineGridProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    if (granularity === "day") {
      return buildRowsFromDays(
        byDayByCategory ?? [],
        taxonomyCategories,
        priorBreakdown ?? [],
        topN,
      );
    }
    return buildRowsFromMonths(months ?? [], taxonomyCategories, priorBreakdown ?? [], topN);
  }, [granularity, months, byDayByCategory, taxonomyCategories, priorBreakdown, topN]);

  if (isLoading && rows.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        {t("spending:sparkline.noHistory")}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map((r) => (
        <SparklineCard key={r.id} row={r} currency={currency} />
      ))}
    </div>
  );
}

function SparklineCard({ row, currency }: { row: CategorySparklineRow; currency: string }) {
  const { isBalanceHidden } = useBalancePrivacy();
  const color = row.color ?? "var(--muted-foreground)";
  const tintBg = row.color ? `${row.color}1F` : "var(--muted)";
  const gradId = `spark-${row.id.replace(/[^a-z0-9]/gi, "_")}`;

  return (
    <Link
      to={`/activities?tab=spending&category=${encodeURIComponent(row.id)}`}
      className="border-border/60 bg-card/40 hover:bg-card/60 group flex flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: tintBg, color }}
          >
            <CategoryIcon icon={row.icon} fallback={row.name} className="h-3 w-3" />
          </span>
          <span className="text-foreground truncate text-xs font-medium">{row.name}</span>
        </div>
        {row.deltaPct != null && Math.abs(row.deltaPct) >= 1 && (
          <span
            className={cn(
              "shrink-0 text-[10px] font-semibold tabular-nums",
              row.deltaPct >= 0 ? "text-destructive" : "text-success",
            )}
          >
            {row.deltaPct >= 0 ? "↑" : "↓"} {Math.abs(row.deltaPct).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="text-foreground text-sm font-semibold tabular-nums">
        {isBalanceHidden ? "••••" : formatCompactAmount(row.total, currency)}
      </div>
      <div className="-mx-1 h-10">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={row.series} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#${gradId})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Link>
  );
}

/** Build prior-period totals rolled up to top-level categories. */
function buildPriorByTop(
  priorBreakdown: CategoryBreakdownRow[],
  meta: Map<string, TaxonomyCategory>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of priorBreakdown) {
    const c = meta.get(r.categoryId);
    const topId = c?.parentId ?? r.categoryId;
    m.set(topId, (m.get(topId) ?? 0) + r.amount);
  }
  return m;
}

function buildRowsFromMonths(
  months: MonthBucket[],
  taxonomyCategories: TaxonomyCategory[],
  priorBreakdown: CategoryBreakdownRow[],
  topN: number,
): CategorySparklineRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const priorByTop = buildPriorByTop(priorBreakdown, meta);

  const byCat = new Map<
    string,
    { name: string; color: string | null; icon: string | null; perBucket: number[] }
  >();
  months.forEach((m, idx) => {
    for (const r of m.report?.spendingBreakdown ?? []) {
      const c = meta.get(r.categoryId);
      const topId = c?.parentId ?? r.categoryId;
      const top = meta.get(topId) ?? c;
      if (!top) continue;
      const e = byCat.get(topId) ?? {
        name: top.name,
        color: top.color ?? null,
        icon: top.icon ?? null,
        perBucket: new Array(months.length).fill(0),
      };
      e.perBucket[idx] += r.amount;
      byCat.set(topId, e);
    }
  });

  return finalizeRows(
    byCat,
    months.map((m) => m.label),
    priorByTop,
    topN,
  );
}

function buildRowsFromDays(
  byDayByCategory: DayCategoryBucket[],
  taxonomyCategories: TaxonomyCategory[],
  priorBreakdown: CategoryBreakdownRow[],
  topN: number,
): CategorySparklineRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const priorByTop = buildPriorByTop(priorBreakdown, meta);

  // Determine the unique sorted day-axis from all buckets.
  const days = Array.from(new Set(byDayByCategory.map((b) => b.date))).sort();
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const byCat = new Map<
    string,
    { name: string; color: string | null; icon: string | null; perBucket: number[] }
  >();
  for (const b of byDayByCategory) {
    if (b.taxonomyId !== "spending_categories") continue;
    const c = meta.get(b.categoryId);
    const topId = c?.parentId ?? b.categoryId;
    const top = meta.get(topId) ?? c;
    if (!top) continue;
    const idx = dayIndex.get(b.date);
    if (idx == null) continue;
    const e = byCat.get(topId) ?? {
      name: top.name,
      color: top.color ?? null,
      icon: top.icon ?? null,
      perBucket: new Array(days.length).fill(0),
    };
    e.perBucket[idx] += b.amount;
    byCat.set(topId, e);
  }

  // Day labels: just the day-of-month number; charts don't render the label
  // anyway, but it's there for tooltips later.
  const labels = days.map((d) => d.slice(8));
  return finalizeRows(byCat, labels, priorByTop, topN);
}

function finalizeRows(
  byCat: Map<
    string,
    { name: string; color: string | null; icon: string | null; perBucket: number[] }
  >,
  labels: string[],
  priorByTop: Map<string, number>,
  topN: number,
): CategorySparklineRow[] {
  const rows: CategorySparklineRow[] = [];
  for (const [id, e] of byCat) {
    const total = e.perBucket.reduce((s, x) => s + x, 0);
    if (total <= 0) continue;
    const series = e.perBucket.map((value, i) => ({ label: labels[i] ?? "", value }));
    const prior = priorByTop.get(id) ?? 0;
    const deltaPct = prior > 0 ? ((total - prior) / prior) * 100 : null;
    rows.push({ id, name: e.name, color: e.color, icon: e.icon, series, total, deltaPct });
  }
  return rows.sort((a, b) => b.total - a.total).slice(0, topN);
}
