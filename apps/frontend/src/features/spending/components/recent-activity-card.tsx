import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { DashboardCard } from "@/components/dashboard-card";
import { QueryKeys } from "@/lib/query-keys";
import type { Activity } from "@/lib/types";
import { cn, formatDateISO } from "@/lib/utils";
import { PrivacyAmount } from "@wealthfolio/ui";

import { getActivityAssignments } from "../adapters/cash-activities";
import {
  getActivitySpendingAmount,
  getEffectiveCashActivityType,
  isCashActivityIncome,
} from "../lib/constants";
import { CategoryBadge, ReviewPill, type CategoryMetaMap } from "./category-chips";

const SPENDING_TAXONOMY = "spending_categories";

export function RecentActivityCard({
  activities,
  accountTypeById,
  categoriesMeta,
  currency,
  uncategorizedCount = 0,
}: {
  activities: Activity[];
  accountTypeById?: Map<string, string>;
  categoriesMeta: CategoryMetaMap;
  currency: string;
  uncategorizedCount?: number;
}) {
  const { t } = useTranslation();
  const recent = useMemo(() => {
    return activities
      .slice()
      .filter((activity) => {
        const accountType = accountTypeById?.get(activity.accountId);
        const activityType = getEffectiveCashActivityType(activity);
        return (
          getActivitySpendingAmount(activity, accountType) !== 0 ||
          isCashActivityIncome(activityType, accountType, activity.subtype)
        );
      })
      .sort((a, b) => b.activityDate.localeCompare(a.activityDate))
      .slice(0, 10);
  }, [activities, accountTypeById]);

  const assignmentQueries = useQueries({
    queries: recent.map((a) => ({
      queryKey: [QueryKeys.SPENDING_TRANSACTIONS, "assignments", a.id],
      queryFn: () => getActivityAssignments(a.id),
      staleTime: 30_000,
    })),
  });

  const badgeByActivityId = useMemo(() => {
    const out = new Map<
      string,
      { name: string; color: string | null; icon: string | null } | null
    >();
    recent.forEach((a, i) => {
      const assignments = assignmentQueries[i]?.data ?? [];
      const spending = assignments.find((x) => x.taxonomyId === SPENDING_TAXONOMY);
      if (!spending) {
        out.set(a.id, null);
        return;
      }
      const meta = categoriesMeta.get(spending.categoryId);
      const topId = meta?.parentId ?? spending.categoryId;
      const top = categoriesMeta.get(topId) ?? meta;
      if (!top) {
        out.set(a.id, null);
        return;
      }
      out.set(a.id, {
        name: top.name,
        color: top.color,
        icon: meta?.icon ?? top.icon,
      });
    });
    return out;
  }, [recent, assignmentQueries, categoriesMeta]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof recent>();
    for (const a of recent) {
      const dateKey = a.activityDate.slice(0, 10);
      const arr = m.get(dateKey) ?? [];
      arr.push(a);
      m.set(dateKey, arr);
    }
    return Array.from(m.entries());
  }, [recent]);

  const dayLabel = (key: string): string => {
    const today = new Date();
    const todayKey = formatDateISO(today);
    const yest = new Date(today);
    yest.setDate(today.getDate() - 1);
    const yestKey = formatDateISO(yest);
    if (key === todayKey) return t("spending:dashboard.today");
    if (key === yestKey) return t("spending:dashboard.yesterday");
    return new Date(key + "T00:00:00").toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <DashboardCard
      title={t("spending:dashboard.recentActivity")}
      padded={false}
      className="overflow-hidden"
      action={
        <Link
          to={
            uncategorizedCount > 0
              ? "/activities?tab=spending&status=uncategorized"
              : "/activities?tab=spending"
          }
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
        >
          {uncategorizedCount > 0
            ? t("spending:dashboard.viewAllToTag", { count: uncategorizedCount })
            : t("spending:dashboard.viewAll")}
        </Link>
      }
    >
      {recent.length === 0 ? (
        <div className="text-muted-foreground px-4 py-6 text-center text-xs md:px-5">
          {t("spending:dashboard.noRecentActivity")}
        </div>
      ) : (
        grouped.map(([dateKey, items], gi) => (
          <div
            key={dateKey}
            className={cn("px-4 py-3 md:px-5", gi > 0 && "border-border/60 border-t")}
          >
            <div className="text-muted-foreground/70 text-[10px] font-semibold uppercase tracking-wide">
              {dayLabel(dateKey)}
            </div>
            {items.map((a) => {
              const payee = (a.notes ?? "").trim();
              const spendingAmount = getActivitySpendingAmount(
                a,
                accountTypeById?.get(a.accountId),
              );
              const isOutflow = spendingAmount > 0;
              const amount =
                spendingAmount === 0 ? parseFloat(a.amount ?? "0") || 0 : Math.abs(spendingAmount);
              const badge = badgeByActivityId.get(a.id);
              const needsReview = a.needsReview || (isOutflow && !badge);

              return (
                // Single transaction row → activities page filtered to this
                // payee (or status=uncategorized when there's no payee +
                // it's flagged for review). Matches the clickable behavior
                // of every neighboring spending widget (ranked bar rows,
                // treemap cells, budget rings) so this row no longer feels
                // like a dead row sandwiched between live ones.
                <Link
                  key={a.id}
                  to={
                    needsReview && !payee
                      ? "/activities?tab=spending&status=uncategorized"
                      : payee
                        ? `/activities?tab=spending&q=${encodeURIComponent(payee)}`
                        : "/activities?tab=spending"
                  }
                  className="hover:bg-muted/40 flex items-center gap-2.5 rounded-md py-1.5 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground/90 truncate text-xs font-medium">
                      {payee || (
                        <span className="text-muted-foreground italic">
                          {t("spending:dashboard.noPayee")}
                        </span>
                      )}
                    </div>
                  </div>
                  {badge ? (
                    <CategoryBadge name={badge.name} color={badge.color} icon={badge.icon} />
                  ) : needsReview ? (
                    <ReviewPill label={t("spending:dashboard.uncategorized")} />
                  ) : null}
                  <div
                    className={cn(
                      "shrink-0 text-xs font-semibold tabular-nums",
                      isOutflow ? "text-foreground" : "text-success",
                    )}
                  >
                    {isOutflow ? "−" : "+"}
                    <PrivacyAmount value={amount} currency={currency} />
                  </div>
                </Link>
              );
            })}
          </div>
        ))
      )}
    </DashboardCard>
  );
}
