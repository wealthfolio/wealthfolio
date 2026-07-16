import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { PrivacyAmount, Skeleton } from "@wealthfolio/ui";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import type { CategoryBreakdownRow, MonthlyReport } from "../../types/report";

interface NotableChangesCardProps {
  current: MonthlyReport | undefined;
  prior: MonthlyReport | undefined;
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
}

interface ChangeRow {
  id: string;
  name: string;
  color: string | null;
  current: number;
  prior: number;
  delta: number;
  pct: number | null;
}

const TOP_N = 3;
const SIGNIFICANCE_THRESHOLD = 0.05; // 5% — drop noise

/**
 * Notable changes — surfaces the categories that moved most vs the comparison
 * period. Two columns: biggest growers (red, "where it climbed"), biggest
 * shrinkers (green, "where you saved"). Picks where the action was without
 * forcing the user to scan the full hierarchy table.
 */
export function NotableChangesCard({
  current,
  prior,
  taxonomyCategories,
  currency,
  isLoading,
}: NotableChangesCardProps) {
  const { t } = useTranslation();
  const { climbed, saved } = useMemo(() => {
    if (!current || !prior) return { climbed: [] as ChangeRow[], saved: [] as ChangeRow[] };
    return computeChanges(current.spendingBreakdown, prior.spendingBreakdown, taxonomyCategories);
  }, [current, prior, taxonomyCategories]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
    );
  }

  if (!prior) {
    return (
      <div className="text-muted-foreground/70 py-6 text-center text-xs">
        {t("spending:notableChanges.comparisonDisabled")}
      </div>
    );
  }

  if (climbed.length === 0 && saved.length === 0) {
    return (
      <div className="text-muted-foreground/70 py-6 text-center text-xs">
        {t("spending:notableChanges.noChanges")}
      </div>
    );
  }

  return (
    <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
      <ChangeColumn
        heading={t("spending:notableChanges.whereItClimbed")}
        rows={climbed}
        tone="destructive"
        currency={currency}
      />
      <ChangeColumn
        heading={t("spending:notableChanges.whereYouSaved")}
        rows={saved}
        tone="success"
        currency={currency}
      />
    </div>
  );
}

function ChangeColumn({
  heading,
  rows,
  tone,
  currency,
}: {
  heading: string;
  rows: ChangeRow[];
  tone: "destructive" | "success";
  currency: string;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <div>
        <h3 className="text-muted-foreground/80 mb-2 text-[11px] font-semibold uppercase tracking-wide">
          {heading}
        </h3>
        <p className="text-muted-foreground/60 text-xs italic">
          {t("spending:notableChanges.noNotableChange")}
        </p>
      </div>
    );
  }

  const arrow = tone === "destructive" ? "↑" : "↓";
  const toneClass = tone === "destructive" ? "text-destructive" : "text-success";

  return (
    <div>
      <h3 className="text-muted-foreground/80 mb-2 text-[11px] font-semibold uppercase tracking-wide">
        {heading}
      </h3>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              to={`/activities?tab=spending&category=${encodeURIComponent(r.id)}`}
              className="hover:bg-muted/40 group flex items-center gap-2 rounded-md px-1 py-1 transition-colors"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: r.color ?? "var(--muted-foreground)" }}
              />
              <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs font-medium">
                {r.name}
              </span>
              <span className={cn("shrink-0 text-xs font-semibold tabular-nums", toneClass)}>
                {arrow} <PrivacyAmount value={Math.abs(r.delta)} currency={currency} />
                {r.pct != null && (
                  <span className="text-muted-foreground/60 ml-1 text-[10px] font-normal">
                    ({Math.round(Math.abs(r.pct) * 100)}%)
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function computeChanges(
  current: CategoryBreakdownRow[],
  prior: CategoryBreakdownRow[],
  taxonomyCategories: TaxonomyCategory[],
): { climbed: ChangeRow[]; saved: ChangeRow[] } {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));

  // Roll subcategory amounts up to top-level for cleaner change attribution.
  const rollup = (rows: CategoryBreakdownRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const c = meta.get(r.categoryId);
      const topId = c?.parentId ?? r.categoryId;
      m.set(topId, (m.get(topId) ?? 0) + r.amount);
    }
    return m;
  };

  const cMap = rollup(current);
  const pMap = rollup(prior);

  const ids = new Set<string>([...cMap.keys(), ...pMap.keys()]);
  const totalCurrent = Array.from(cMap.values()).reduce((s, x) => s + x, 0);

  const rows: ChangeRow[] = [];
  for (const id of ids) {
    const cur = cMap.get(id) ?? 0;
    const pri = pMap.get(id) ?? 0;
    if (cur === 0 && pri === 0) continue;
    const delta = cur - pri;
    if (delta === 0) continue;

    // Significance gate: drop changes that are negligible against the period total.
    if (totalCurrent > 0 && Math.abs(delta) / totalCurrent < SIGNIFICANCE_THRESHOLD) continue;

    const m = meta.get(id);
    rows.push({
      id,
      name: m?.name ?? id,
      color: m?.color ?? null,
      current: cur,
      prior: pri,
      delta,
      pct: pri > 0 ? delta / pri : null,
    });
  }

  return {
    climbed: rows
      .filter((r) => r.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, TOP_N),
    saved: rows
      .filter((r) => r.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, TOP_N),
  };
}
