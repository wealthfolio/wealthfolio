import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { PrivacyAmount, Skeleton } from "@wealthfolio/ui";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import type { BudgetCategoryRow } from "../../types/budget";
import type { CategoryBreakdownRow } from "../../types/report";

interface BudgetVsActualBarsProps {
  breakdown: CategoryBreakdownRow[];
  budgetRows: BudgetCategoryRow[];
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
}

type Status = "over" | "approaching" | "comfortable" | "underused";

interface BudgetRow {
  id: string;
  name: string;
  color: string | null;
  budgeted: number;
  spent: number;
  pct: number;
  status: Status;
}

const APPROACH_THRESHOLD = 0.85;
const UNDERUSE_THRESHOLD = 0.4;

const STATUS_LABEL_KEYS: Record<Status, string> = {
  over: "spending:budgetBars.statusOver",
  approaching: "spending:budgetBars.statusClose",
  comfortable: "spending:budgetBars.statusOnTrack",
  underused: "spending:budgetBars.statusUnder",
};

const STATUS_TONE: Record<Status, string> = {
  over: "text-destructive",
  approaching: "text-foreground",
  comfortable: "text-success",
  underused: "text-muted-foreground/80",
};

const STATUS_FILL: Record<Status, string> = {
  over: "var(--destructive)",
  approaching: "var(--status-warn)",
  comfortable: "var(--success)",
  underused: "var(--muted-foreground)",
};

/**
 * Visual budget tracker — one row per budgeted category with a richer layout
 * than a simple progress bar:
 *
 *   [color dot] Category name          $spent / $budgeted        [status pill]
 *               $left or $over  +%                        ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱
 *
 * Header summarizes status counts so the user has a one-glance read on
 * portfolio health before scanning rows. Sorted by % consumed desc.
 */
export function BudgetVsActualBars({
  breakdown,
  budgetRows,
  taxonomyCategories,
  currency,
  isLoading,
}: BudgetVsActualBarsProps) {
  const { t } = useTranslation();
  const rows = useMemo(
    () => buildRows(breakdown, budgetRows, taxonomyCategories),
    [breakdown, budgetRows, taxonomyCategories],
  );

  const summary = useMemo(() => {
    const counts: Record<Status, number> = {
      over: 0,
      approaching: 0,
      comfortable: 0,
      underused: 0,
    };
    let totalBudget = 0;
    let totalSpent = 0;
    for (const r of rows) {
      counts[r.status] += 1;
      totalBudget += r.budgeted;
      totalSpent += r.spent;
    }
    return { counts, totalBudget, totalSpent };
  }, [rows]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        {t("spending:budgetBars.noBudgets")}{" "}
        <Link
          to="/settings/spending/setup"
          className="hover:text-foreground underline-offset-4 hover:underline"
        >
          {t("spending:budgetBars.setOne")}
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Aggregate status header */}
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <SummaryStat
          count={summary.counts.over}
          label={t("spending:budgetBars.over")}
          tone="destructive"
        />
        <SummaryStat
          count={summary.counts.approaching}
          label={t("spending:budgetBars.close")}
          tone="warning"
        />
        <SummaryStat
          count={summary.counts.comfortable}
          label={t("spending:budgetBars.onTrack")}
          tone="success"
        />
        {summary.counts.underused > 0 && (
          <SummaryStat
            count={summary.counts.underused}
            label={t("spending:budgetBars.underUsed")}
            tone="muted"
          />
        )}
        <span className="text-muted-foreground/60 ml-auto text-[11px] tabular-nums">
          <PrivacyAmount value={summary.totalSpent} currency={currency} />{" "}
          {t("spending:budgetBars.of")}{" "}
          <PrivacyAmount value={summary.totalBudget} currency={currency} />
        </span>
      </div>

      {/* Rows */}
      <div className="divide-border/40 divide-y">
        {rows.map((r) => (
          <BudgetRow key={r.id} row={r} currency={currency} />
        ))}
      </div>
    </div>
  );
}

function BudgetRow({ row, currency }: { row: BudgetRow; currency: string }) {
  const { t } = useTranslation();
  const fillPct = Math.min(100, row.pct * 100);
  const overflowPct = row.pct > 1 ? Math.min(100, (row.pct - 1) * 100) : 0;
  const remaining = Math.max(0, row.budgeted - row.spent);
  const overage = Math.max(0, row.spent - row.budgeted);

  return (
    <Link
      to={`/activities?tab=spending&category=${encodeURIComponent(row.id)}`}
      className="hover:bg-muted/30 group block px-2 py-2.5 transition-colors"
    >
      {/* Row header */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: row.color ?? "var(--muted-foreground)" }}
        />
        <span className="text-foreground truncate text-sm font-medium">{row.name}</span>
        <span
          className={cn(
            "ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            statusPillBg(row.status),
            STATUS_TONE[row.status],
          )}
        >
          {t(STATUS_LABEL_KEYS[row.status])}
        </span>
      </div>

      {/* Progress + amount strip */}
      <div className="flex items-center gap-3">
        <div className="bg-muted/40 relative h-2 flex-1 overflow-hidden rounded-full">
          {/* Filled portion (clamped to 100%) */}
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${fillPct}%`,
              backgroundColor: STATUS_FILL[row.status],
              opacity: 0.95,
            }}
          />
          {/* Subtle overflow stripe layered over the filled bar */}
          {overflowPct > 0 && (
            <div
              className="absolute inset-y-0 right-0 rounded-r-full"
              style={{
                width: `${overflowPct}%`,
                backgroundColor: "var(--destructive)",
                opacity: 0.5,
                backgroundImage:
                  "repeating-linear-gradient(135deg, var(--bar-stripe) 0 4px, transparent 4px 8px)",
              }}
            />
          )}
        </div>
        <div className="text-foreground/90 shrink-0 tabular-nums" style={{ minWidth: "5.5rem" }}>
          <span className="text-xs font-semibold">
            <PrivacyAmount value={row.spent} currency={currency} />
          </span>
          <span className="text-muted-foreground/70 text-[11px]">
            {" / "}
            <PrivacyAmount value={row.budgeted} currency={currency} />
          </span>
        </div>
      </div>

      {/* Subline: remaining or overage */}
      <div className="text-muted-foreground/70 mt-1 flex items-center gap-1.5 pl-4 text-[11px] tabular-nums">
        <span className={cn(STATUS_TONE[row.status])}>{Math.round(row.pct * 100)}%</span>
        <span className="text-muted-foreground/40">·</span>
        {row.status === "over" ? (
          <span className="text-destructive font-medium">
            <PrivacyAmount value={overage} currency={currency} />{" "}
            {t("spending:budgetBars.overSuffix")}
          </span>
        ) : (
          <span>
            <PrivacyAmount value={remaining} currency={currency} />{" "}
            {t("spending:budgetBars.leftSuffix")}
          </span>
        )}
      </div>
    </Link>
  );
}

function SummaryStat({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "destructive" | "warning" | "success" | "muted";
}) {
  const dot =
    tone === "destructive"
      ? "bg-destructive"
      : tone === "warning"
        ? "bg-[var(--status-warn)]"
        : tone === "success"
          ? "bg-success"
          : "bg-muted-foreground/60";
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dot)} />
      <span className="text-foreground font-semibold tabular-nums">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function statusPillBg(status: Status): string {
  switch (status) {
    case "over":
      return "bg-destructive/10";
    case "approaching":
      return "bg-[var(--status-warn)]/15";
    case "comfortable":
      return "bg-success/10";
    case "underused":
      return "bg-muted/60";
  }
}

function statusOf(pct: number): Status {
  if (pct > 1) return "over";
  if (pct >= APPROACH_THRESHOLD) return "approaching";
  if (pct < UNDERUSE_THRESHOLD) return "underused";
  return "comfortable";
}

function buildRows(
  breakdown: CategoryBreakdownRow[],
  budgetRows: BudgetCategoryRow[],
  taxonomyCategories: TaxonomyCategory[],
): BudgetRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));

  // Roll spending up to the top-level category for matching against allocations.
  const spentByTop = new Map<string, number>();
  for (const r of breakdown) {
    const m = meta.get(r.categoryId);
    const topId = m?.parentId ?? r.categoryId;
    spentByTop.set(topId, (spentByTop.get(topId) ?? 0) + r.amount);
  }

  return budgetRows
    .map<BudgetRow | null>((a) => {
      const budgeted = a.target || 0;
      if (budgeted <= 0) return null;
      const m = meta.get(a.categoryId);
      const spent = spentByTop.get(a.categoryId) ?? 0;
      const pct = spent / budgeted;
      return {
        id: a.categoryId,
        name: m?.name ?? a.categoryId,
        color: m?.color ?? null,
        budgeted,
        spent,
        pct,
        status: statusOf(pct),
      };
    })
    .filter((r): r is BudgetRow => r !== null)
    .sort((a, b) => b.pct - a.pct);
}
