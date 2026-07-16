import { memo, useMemo, useState, type FC, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

import { PrivacyAmount, Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { TaxonomyCategory } from "@/lib/types";
import { cn, formatAmount, resolveDisplayTimezone } from "@/lib/utils";

import { CategoryIcon } from "../../category-chips";
import { topCategoryId } from "../../../lib/category-rollup";
import type { ReportsRange } from "../../../lib/reports-period";
import type {
  CategoryBreakdownRow,
  DayCategoryBucket,
  MonthBucket,
  MonthlyReport,
} from "../../../types/report";
import {
  MIN_PRIOR_FOR_PCT,
  classifyPeriod,
  describeCategories,
  type ChangeDescriptor,
  type PeriodState,
} from "../../../lib/change-descriptor";
import { buildHeadline, type HeadlineFragment, type HeadlineModel } from "../../../lib/headline";
import { UNCATEGORIZED_CATEGORY_ID } from "../../../lib/insight-projection";
import { formatPercentValue } from "./format";

const CARD_CLASS = "border-border/60 bg-card/40 rounded-2xl border p-5 backdrop-blur-xl";
const LABEL_CLASS =
  "text-muted-foreground/70 text-[10px] font-semibold uppercase tracking-[0.12em]";

const SPARK_MARGIN = { top: 2, right: 0, left: 0, bottom: 0 };

export interface WhatChangedStageProps {
  range: ReportsRange;
  priorRange?: ReportsRange;
  timezone?: string | null;
  currentReport: MonthlyReport | undefined;
  priorReport: MonthlyReport | undefined;
  months: MonthBucket[];
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
  onCategoryClick?: (categoryId: string) => void;
}

interface MoverDescriptor extends ChangeDescriptor {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

export function WhatChangedStage({
  range,
  priorRange,
  timezone,
  currentReport,
  priorReport,
  months,
  taxonomyCategories,
  currency,
  isLoading,
  onCategoryClick,
}: WhatChangedStageProps) {
  const { t } = useTranslation();
  const labels = useMemo(
    () => buildPeriodLabels(range, priorRange, timezone, t),
    [range, priorRange, timezone, t],
  );

  const currentTotal = currentReport?.current.outflow ?? 0;
  const priorTotal = priorReport?.current.outflow ?? 0;
  const currentTxCount = currentReport?.current.count ?? 0;
  const priorTxCount = priorReport?.current.count ?? 0;

  const periodState = useMemo<PeriodState>(
    () =>
      classifyPeriod({
        currentTotal,
        priorTotal,
        currentTransactionCount: currentTxCount,
        priorTransactionCount: priorTxCount,
      }),
    [currentTotal, priorTotal, currentTxCount, priorTxCount],
  );

  const movers = useMemo<MoverDescriptor[]>(
    () =>
      computeMovers(
        currentReport?.spendingBreakdown ?? [],
        priorReport?.spendingBreakdown ?? [],
        taxonomyCategories,
        currentTotal,
        priorTotal,
        t,
      ),
    [currentReport, priorReport, taxonomyCategories, currentTotal, priorTotal, t],
  );

  const headline = useMemo<HeadlineModel>(
    () =>
      buildHeadline({
        periodState,
        movers,
        currentTotal,
        priorTotal,
        priorLabel: labels.prior,
        metaLabel: t("spending:whatChanged.headlineMeta", { label: labels.combined }),
      }),
    [periodState, movers, currentTotal, priorTotal, labels, t],
  );

  return (
    <div className="flex flex-col gap-6">
      <HeadlineCard headline={headline} currency={currency} isLoading={isLoading} />
      <CategoryTrendsSection
        months={months}
        currentReport={currentReport}
        taxonomyCategories={taxonomyCategories}
        movers={movers}
        periodState={periodState}
        currency={currency}
        useDaily={range.days <= 35}
        isLoading={isLoading}
        onCategoryClick={onCategoryClick}
      />
      {!isLoading && movers.length > 0 && (
        <div>
          <h3 className="text-foreground mb-4 text-base font-semibold tracking-tight">
            {t("spending:whatChanged.categoryDetails")}
          </h3>
          <ComparisonTable
            movers={movers}
            labels={labels}
            periodState={periodState}
            currency={currency}
            onCategoryClick={onCategoryClick}
          />
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// Headline card — narrative + compact comparison line
// ═════════════════════════════════════════════════════════════════════════

interface HeadlineCardProps {
  headline: HeadlineModel;
  currency: string;
  isLoading: boolean;
}

const HeadlineCard: FC<HeadlineCardProps> = ({ headline, currency, isLoading }) => {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  if (isLoading) {
    return (
      <div className={CARD_CLASS}>
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-3 h-16 w-full" />
        <Skeleton className="mt-4 h-4 w-2/3" />
      </div>
    );
  }

  return (
    <div className={CARD_CLASS}>
      {headline.metaLabel && <div className={LABEL_CLASS}>{headline.metaLabel}</div>}
      <p
        className={cn(
          "text-foreground max-w-[95%] text-base font-normal leading-snug tracking-tight md:text-lg",
          headline.metaLabel && "mt-3",
        )}
      >
        {renderHeadlineFragments(headline.fragments, currency, isBalanceHidden, t)}
      </p>
      {headline.summary && (
        <HeadlineSummaryLine
          summary={headline.summary}
          currency={currency}
          isBalanceHidden={isBalanceHidden}
        />
      )}
    </div>
  );
};

function renderHeadlineFragments(
  fragments: HeadlineFragment[],
  currency: string,
  isBalanceHidden: boolean,
  t: TFunction,
): ReactNode {
  return fragments.map((f, i) => {
    switch (f.type) {
      case "text":
        return <span key={i}>{f.text}</span>;
      case "amount":
        return (
          <span
            key={i}
            className={cn("whitespace-nowrap font-serif font-medium", toneClass(f.tone))}
          >
            <PrivacyAmount value={f.value} currency={currency} />
          </span>
        );
      case "mover": {
        const d = f.descriptor.descriptor;
        const phrase = describeMoverPhrase(d, currency, isBalanceHidden, t);
        return (
          <span
            key={i}
            className={cn("whitespace-nowrap font-serif font-medium", toneClass(f.tone))}
          >
            {f.descriptor.name} {phrase}
          </span>
        );
      }
    }
  });
}

function describeMoverPhrase(
  d: ChangeDescriptor,
  currency: string,
  isBalanceHidden: boolean,
  t: TFunction,
): string {
  const amt = (v: number) => (isBalanceHidden ? "••••" : formatAmount(v, currency));
  switch (d.kind) {
    case "no_activity":
      return "";
    case "new":
      return t("spending:whatChanged.phraseAppeared", { amount: amt(d.absDelta) });
    case "ended":
      return t("spending:whatChanged.phraseDroppedToZero", { amount: amt(d.prior) });
    case "valid": {
      const verb = d.delta >= 0 ? t("spending:whatChanged.up") : t("spending:whatChanged.down");
      if (d.showPct && d.pct != null) {
        return `${verb} ${formatPercentValue(Math.abs(d.pct), { digits: 0 })}`;
      }
      return `${verb} ${amt(d.absDelta)}`;
    }
  }
}

function toneClass(tone: "up" | "down" | "neutral"): string {
  if (tone === "up") return "text-destructive";
  if (tone === "down") return "text-success";
  return "text-foreground";
}

function HeadlineSummaryLine({
  summary,
  currency,
  isBalanceHidden,
}: {
  summary: NonNullable<HeadlineModel["summary"]>;
  currency: string;
  isBalanceHidden: boolean;
}) {
  const { t } = useTranslation();
  const renderAmt = (value: number) =>
    isBalanceHidden ? <>••••</> : <PrivacyAmount value={value} currency={currency} />;
  const parts: ReactNode[] = [
    <span key="cur" className="tabular-nums">
      <span className={LABEL_CLASS}>{t("spending:whatChanged.thisLabel")} </span>
      {renderAmt(summary.current)}
    </span>,
  ];
  if (summary.prior != null) {
    parts.push(
      <span key="prior" className="text-muted-foreground/80 tabular-nums">
        <span className={LABEL_CLASS}>{t("spending:whatChanged.priorLabel")} </span>
        {renderAmt(summary.prior)}
      </span>,
    );
  }
  if (summary.delta != null) {
    const sign = summary.delta >= 0 ? "+" : "−";
    const tone = summary.delta === 0 ? "neutral" : summary.delta > 0 ? "up" : "down";
    parts.push(
      <span key="delta" className={cn("font-medium tabular-nums", toneClass(tone))}>
        {sign}
        {renderAmt(Math.abs(summary.delta))}
      </span>,
    );
  }
  if (summary.showPct && summary.pct != null) {
    const tone = summary.pct === 0 ? "neutral" : summary.pct > 0 ? "up" : "down";
    parts.push(
      <span key="pct" className={cn("font-medium tabular-nums", toneClass(tone))}>
        {formatPercentValue(summary.pct, { digits: 0, signDisplay: "always" })}
      </span>,
    );
  }
  return (
    <div className="border-border/40 mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-sm">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-3">
          {i > 0 && <span className="text-muted-foreground/40">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// Movers — descriptor-backed comparison rows shared by every surface
// ═════════════════════════════════════════════════════════════════════════

function computeMovers(
  current: CategoryBreakdownRow[],
  prior: CategoryBreakdownRow[],
  taxonomyCategories: TaxonomyCategory[],
  currentTotal: number,
  priorTotal: number,
  t: TFunction,
): MoverDescriptor[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const roll = (rows: CategoryBreakdownRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const top = topCategoryId(r.categoryId, meta);
      m.set(top, (m.get(top) ?? 0) + r.amount);
    }
    return m;
  };
  const cur = roll(current);
  const pri = roll(prior);
  const ids = new Set<string>([...cur.keys(), ...pri.keys()]);
  const aggregates = Array.from(ids).map((id) => ({
    id,
    current: cur.get(id) ?? 0,
    prior: pri.get(id) ?? 0,
  }));
  const descriptors = describeCategories(aggregates, currentTotal, priorTotal);
  return descriptors.map((d) => {
    const m = meta.get(d.id);
    const isUncategorized = d.id === UNCATEGORIZED_CATEGORY_ID;
    return {
      ...d,
      name: isUncategorized ? t("spending:insightsPage.uncategorized") : (m?.name ?? d.id),
      color: m?.color ?? null,
      icon: m?.icon ?? null,
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Category trends — sparkline grid (no section chrome)
// ═════════════════════════════════════════════════════════════════════════

interface CategoryTrendsSectionProps {
  months: MonthBucket[];
  currentReport: MonthlyReport | undefined;
  taxonomyCategories: TaxonomyCategory[];
  movers: MoverDescriptor[];
  periodState: PeriodState;
  currency: string;
  useDaily: boolean;
  isLoading: boolean;
  onCategoryClick?: (categoryId: string) => void;
}

const COLLAPSED_ROWS = 6;

const CategoryTrendsSection: FC<CategoryTrendsSectionProps> = ({
  months,
  currentReport,
  taxonomyCategories,
  movers,
  periodState,
  currency,
  useDaily,
  isLoading,
  onCategoryClick,
}) => {
  const { t } = useTranslation();
  const showPills = periodState.kind === "valid_comparison";
  const [expanded, setExpanded] = useState(false);

  const sparkRows = useMemo(
    () =>
      buildSparklineRows({
        months,
        byDayByCategory:
          useDaily && currentReport?.byDayByCategory.length
            ? currentReport.byDayByCategory
            : undefined,
        taxonomyCategories,
        useDaily: useDaily && !!currentReport?.byDayByCategory.length,
        movers,
      }),
    [months, currentReport?.byDayByCategory, taxonomyCategories, useDaily, movers],
  );

  const visible = expanded ? sparkRows : sparkRows.slice(0, COLLAPSED_ROWS);
  const remaining = sparkRows.length - visible.length;

  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-4 w-32" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-4">
        <h3 className="text-foreground text-base font-semibold tracking-tight">
          {t("spending:whatChanged.categoryTrends")}
        </h3>
      </header>

      {sparkRows.length === 0 ? (
        <div className="text-muted-foreground py-6 text-center text-sm">
          {t("spending:sparkline.noHistory")}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((row) => (
              <SparklineRow
                key={row.id}
                row={row}
                currency={currency}
                showPill={showPills}
                onCategoryClick={onCategoryClick}
              />
            ))}
          </div>
          {remaining > 0 && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
              >
                {t("spending:whatChanged.showMore", { count: remaining })}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

interface SparkRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  series: { label: string; value: number }[];
  total: number;
  descriptor: ChangeDescriptor | null;
}

function buildSparklineRows({
  months,
  byDayByCategory,
  taxonomyCategories,
  useDaily,
  movers,
}: {
  months: MonthBucket[];
  byDayByCategory: DayCategoryBucket[] | undefined;
  taxonomyCategories: TaxonomyCategory[];
  useDaily: boolean;
  movers: MoverDescriptor[];
}): SparkRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const descriptorById = new Map(movers.map((m) => [m.id, m]));

  interface Bucket {
    name: string;
    color: string | null;
    icon: string | null;
    perBucket: number[];
  }
  const byCat = new Map<string, Bucket>();

  if (useDaily && byDayByCategory) {
    const days = Array.from(new Set(byDayByCategory.map((b) => b.date))).sort();
    const dayIndex = new Map(days.map((d, i) => [d, i] as const));
    for (const b of byDayByCategory) {
      if (b.taxonomyId !== "spending_categories") continue;
      const top = topCategoryId(b.categoryId, meta);
      const tcat = meta.get(top);
      if (!tcat) continue;
      const idx = dayIndex.get(b.date);
      if (idx == null) continue;
      const e = byCat.get(top) ?? {
        name: tcat.name,
        color: tcat.color ?? null,
        icon: tcat.icon ?? null,
        perBucket: new Array(days.length).fill(0),
      };
      e.perBucket[idx] += b.amount;
      byCat.set(top, e);
    }
  } else {
    months.forEach((m, idx) => {
      for (const r of m.report?.spendingBreakdown ?? []) {
        const top = topCategoryId(r.categoryId, meta);
        const tcat = meta.get(top);
        if (!tcat) continue;
        const e = byCat.get(top) ?? {
          name: tcat.name,
          color: tcat.color ?? null,
          icon: tcat.icon ?? null,
          perBucket: new Array(months.length).fill(0),
        };
        e.perBucket[idx] += r.amount;
        byCat.set(top, e);
      }
    });
  }

  const rows: SparkRow[] = [];
  for (const [id, e] of byCat) {
    const total = e.perBucket.reduce((s, x) => s + x, 0);
    if (total <= 0) continue;
    const series = e.perBucket.map((value, i) => ({ label: String(i), value }));
    const descriptor = descriptorById.get(id) ?? null;
    rows.push({ id, name: e.name, color: e.color, icon: e.icon, series, total, descriptor });
  }

  // Sort by descriptor rankValue (|delta|); categories without a descriptor
  // (no prior or current row in either period) fall to the bottom.
  return rows.sort((a, b) => {
    const ra = a.descriptor?.rankValue ?? -1;
    const rb = b.descriptor?.rankValue ?? -1;
    return rb - ra;
  });
}

interface PillModel {
  label: string;
  tone: "up" | "down" | "neutral";
}

function describePill(d: ChangeDescriptor, t: TFunction): PillModel | null {
  switch (d.kind) {
    case "no_activity":
      return null;
    case "new":
      return { label: t("spending:whatChanged.pillNew"), tone: "neutral" };
    case "ended":
      // Small-prior categories that ended read better as "No spend" than
      // dramatic "Ended" — the change isn't meaningful.
      return {
        label:
          d.prior < MIN_PRIOR_FOR_PCT
            ? t("spending:whatChanged.pillNoSpend")
            : t("spending:whatChanged.pillEnded"),
        tone: "neutral",
      };
    case "valid": {
      const tone: PillModel["tone"] = d.delta === 0 ? "neutral" : d.delta > 0 ? "up" : "down";
      const arrow = d.delta >= 0 ? "↑" : "↓";
      if (d.showPct && d.pct != null) {
        return {
          label: `${arrow} ${formatPercentValue(Math.abs(d.pct), { digits: 0 })}`,
          tone,
        };
      }
      // valid but pct suppressed → label with dollar delta
      if (d.absDelta > 0) {
        return { label: `${arrow} ${formatCompactDelta(d.absDelta)}`, tone };
      }
      return null;
    }
  }
}

/** Compact $-delta for pills (one decimal, K/M suffix), currency-agnostic. */
function formatCompactDelta(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(0);
}

const SparklineRow = memo(function SparklineRow({
  row,
  currency,
  showPill,
  onCategoryClick,
}: {
  row: SparkRow;
  currency: string;
  showPill: boolean;
  onCategoryClick?: (categoryId: string) => void;
}) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const color = row.color ?? "var(--muted-foreground)";
  const tintBg = row.color ? `${row.color}14` : "var(--muted)";
  const gradId = `wc-spark-${row.id.replace(/[^a-z0-9]/gi, "_")}`;
  const pill = showPill && row.descriptor ? describePill(row.descriptor, t) : null;
  const clickable = !!onCategoryClick;
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onCategoryClick?.(row.id) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onCategoryClick?.(row.id);
              }
            }
          : undefined
      }
      className={cn(
        "border-border/60 bg-card/50 flex flex-col gap-1.5 rounded-xl border px-4 pb-4 pt-3",
        clickable && "hover:border-border/90 hover:bg-card/70 cursor-pointer transition-colors",
      )}
      style={{ backgroundImage: `linear-gradient(to bottom, ${tintBg}, transparent 70%)` }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
          <CategoryIcon
            icon={row.icon}
            fallback={row.name}
            className="text-foreground/70 h-3.5 w-3.5"
          />
          <span className="text-foreground truncate text-sm font-medium">{row.name}</span>
        </div>
        {pill && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
              pill.tone === "up" && "bg-destructive/10 text-destructive",
              pill.tone === "down" && "bg-success/15 text-success",
              pill.tone === "neutral" && "text-muted-foreground/80 bg-muted/40",
            )}
          >
            {pill.label}
          </span>
        )}
      </div>
      <div className="-mx-1 mt-1 h-9">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={row.series} margin={SPARK_MARGIN}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.45} />
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
      <div className="text-muted-foreground/80 text-xs tabular-nums">
        {isBalanceHidden ? "••••" : formatCompactAmount(row.total, currency)}
      </div>
    </div>
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Comparison table
// ═════════════════════════════════════════════════════════════════════════

interface ComparisonTableProps {
  movers: MoverDescriptor[];
  labels: PeriodLabels;
  periodState: PeriodState;
  currency: string;
  onCategoryClick?: (categoryId: string) => void;
}

function ComparisonTable({
  movers,
  labels,
  periodState,
  currency,
  onCategoryClick,
}: ComparisonTableProps) {
  const { t } = useTranslation();
  const hidePct = periodState.kind === "no_prior_period";

  return (
    <div className="border-border/60 bg-card/40 overflow-x-auto rounded-2xl border backdrop-blur-xl">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border/40 text-muted-foreground/70 border-b text-[10px] font-semibold uppercase tracking-[0.12em]">
            <th className="px-3 py-3 text-left md:px-4">{t("spending:filters.category")}</th>
            <th className="px-2 py-3 text-right md:px-3">{labels.current}</th>
            <th className="px-2 py-3 text-right md:px-3">{labels.prior}</th>
            <th className="px-2 py-3 text-right md:px-3">
              {t("spending:whatChanged.deltaDollar")}
            </th>
            <th className="hidden px-3 py-3 text-right md:table-cell">
              {t("spending:whatChanged.impact")}
            </th>
            {!hidePct && (
              <th className="hidden px-4 py-3 text-right md:table-cell">
                {t("spending:whatChanged.deltaPct")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {movers.map((row) => (
            <ComparisonRow
              key={row.id}
              row={row}
              currency={currency}
              hidePct={hidePct}
              onCategoryClick={onCategoryClick}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ComparisonRow = memo(function ComparisonRow({
  row,
  currency,
  hidePct,
  onCategoryClick,
}: {
  row: MoverDescriptor;
  currency: string;
  hidePct: boolean;
  onCategoryClick?: (categoryId: string) => void;
}) {
  const color = row.color ?? "var(--muted-foreground)";
  const isUp = row.delta > 0;
  const clickable = !!onCategoryClick;
  const impactPct = row.shareOfMovement != null ? Math.round(row.shareOfMovement * 100) : null;
  return (
    <tr
      className={cn(
        "border-border/30 hover:bg-muted/20 border-b last:border-b-0",
        clickable && "cursor-pointer",
      )}
      onClick={clickable ? () => onCategoryClick?.(row.id) : undefined}
    >
      <td className="px-3 py-2.5 md:px-4">
        <div className="flex items-center gap-2">
          <span
            className="block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="text-foreground text-xs md:text-sm">{row.name}</span>
        </div>
      </td>
      <td className="text-foreground/90 px-2 py-2.5 text-right text-[11px] tabular-nums md:px-3 md:text-xs">
        {row.current === 0 ? (
          <span className="text-muted-foreground/60">—</span>
        ) : (
          <PrivacyAmount value={row.current} currency={currency} />
        )}
      </td>
      <td className="text-muted-foreground/80 px-2 py-2.5 text-right text-[11px] tabular-nums md:px-3 md:text-xs">
        {row.prior === 0 ? (
          <span className="text-muted-foreground/60">—</span>
        ) : (
          <PrivacyAmount value={row.prior} currency={currency} />
        )}
      </td>
      <td
        className={cn(
          "px-2 py-2.5 text-right text-[11px] font-medium tabular-nums md:px-3 md:text-xs",
          row.delta === 0 ? "text-muted-foreground/70" : isUp ? "text-destructive" : "text-success",
        )}
      >
        {row.delta === 0 ? (
          "—"
        ) : (
          <>
            {isUp ? "+" : "−"}
            <PrivacyAmount value={Math.abs(row.delta)} currency={currency} />
          </>
        )}
      </td>
      <td className="text-muted-foreground/90 hidden px-3 py-2.5 text-right text-xs tabular-nums md:table-cell">
        {impactPct == null || impactPct === 0 ? "—" : `${impactPct}%`}
      </td>
      {!hidePct && (
        <td
          className={cn(
            "hidden px-4 py-2.5 text-right text-xs font-medium tabular-nums md:table-cell",
            !row.showPct || row.pct == null
              ? "text-muted-foreground/70"
              : row.pct >= 0
                ? "text-destructive"
                : "text-success",
          )}
        >
          {!row.showPct || row.pct == null
            ? "—"
            : formatPercentValue(row.pct, { digits: 0, signDisplay: "always" })}
        </td>
      )}
    </tr>
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Period labels
// ═════════════════════════════════════════════════════════════════════════

interface PeriodLabels {
  current: string;
  prior: string;
  combined: string;
}

function buildPeriodLabels(
  range: ReportsRange,
  priorRange: ReportsRange | undefined,
  timezone: string | null | undefined,
  t: TFunction,
): PeriodLabels {
  if (priorRange) {
    const current = formatDateSpan(range.start, range.end, timezone);
    const prior = formatDateSpan(priorRange.start, priorRange.end, timezone);
    return {
      current,
      prior,
      combined: t("spending:whatChanged.combinedVs", {
        current: current.toUpperCase(),
        prior: prior.toUpperCase(),
      }),
    };
  }

  const priorEnd = new Date(range.start.getTime() - 1);

  if (range.months <= 1) {
    const current = formatMonthNameInZone(range.end, timezone);
    const prior = formatMonthNameInZone(priorEnd, timezone);
    return {
      current,
      prior,
      combined: t("spending:whatChanged.combinedVs", {
        current: current.toUpperCase(),
        prior: prior.toUpperCase(),
      }),
    };
  }
  const priorStart = new Date(priorEnd.getTime() - (range.end.getTime() - range.start.getTime()));
  const current = `${formatMonthYearInZone(range.start, timezone)} – ${formatMonthYearInZone(
    range.end,
    timezone,
  )}`;
  const prior = `${formatMonthYearInZone(priorStart, timezone)} – ${formatMonthYearInZone(
    priorEnd,
    timezone,
  )}`;
  return {
    current,
    prior,
    combined: t("spending:whatChanged.combinedMonths", { months: range.months }),
  };
}

function formatDateSpan(start: Date, end: Date, timezone?: string | null): string {
  const timeZone = resolveDisplayTimezone(timezone);
  const dateKey = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const monthDay = new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
  });
  if (dateKey.format(start) === dateKey.format(end)) {
    return monthDay.format(start);
  }
  return `${monthDay.format(start)}-${monthDay.format(end)}`;
}

function formatMonthNameInZone(date: Date, timezone?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: resolveDisplayTimezone(timezone),
    month: "long",
  }).format(date);
}

function formatMonthYearInZone(date: Date, timezone?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: resolveDisplayTimezone(timezone),
    month: "short",
    year: "numeric",
  }).format(date);
}
