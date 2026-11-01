import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import { useSettingsContext } from "@/lib/settings-provider";
import { parseLocalDate } from "@/lib/utils";
import { getGoals } from "@/adapters";
import { DashboardCard } from "@/components/dashboard-card";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { QueryKeys } from "@/lib/query-keys";
import type { Goal } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { cn, useAmountFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemSeparator,
  ItemTitle,
} from "@wealthfolio/ui/components/ui/item";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import type { TFunction } from "i18next";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

const MAX_DISPLAYED_GOALS = 5;

function goalTime(goal: Goal) {
  const date = goal.targetDate ?? goal.projectedCompletionDate;
  if (!date) return Infinity;
  const time = new Date(date).getTime();
  return Number.isFinite(time) ? time : Infinity;
}

function goalTarget(goal: Goal) {
  return goal.summaryTargetAmount ?? goal.targetAmount ?? 0;
}

function sortDashboardGoals(a: Goal, b: Goal) {
  const aRetirement = a.goalType === "retirement" ? 0 : 1;
  const bRetirement = b.goalType === "retirement" ? 0 : 1;
  if (aRetirement !== bRetirement) return aRetirement - bRetirement;

  const dateDiff = goalTime(a) - goalTime(b);
  if (dateDiff !== 0) return dateDiff;

  const targetDiff = goalTarget(b) - goalTarget(a);
  if (targetDiff !== 0) return targetDiff;

  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function statusDotClass(status: Goal["statusHealth"]) {
  if (status === "off_track") return "bg-destructive";
  if (status === "at_risk") return "bg-warning";
  if (status === "on_track") return "bg-success";
  return "bg-muted-foreground/35";
}

function formatTimeRemaining(t: TFunction, targetDate?: string, timezone?: string): string {
  if (!targetDate) return t("dashboard:goals.time_no_deadline");
  const target = parseLocalDate(targetDate);
  const now = parseLocalDate(formatZonedDateKey(new Date(), timezone));
  if (!Number.isFinite(target.getTime())) return t("dashboard:goals.time_no_deadline");
  if (target.getTime() <= now.getTime()) return t("dashboard:goals.time_due");
  let months =
    (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  if (target.getDate() < now.getDate()) months -= 1;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (years === 0) {
    return t("goals:card.months_left", { count: Math.max(1, remMonths) });
  }
  if (remMonths === 0) return t("goals:card.years_left", { count: years });
  return t("goals:card.years_months_left", { years, months: remMonths });
}

function ViewAllLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/goals"
      className="text-muted-foreground hover:bg-success-subtle inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors"
    >
      {t("dashboard:view_all")}
      <Icons.ChevronRight className="ms-1 h-3 w-3 rtl:rotate-180" />
    </Link>
  );
}

export function SavingGoals() {
  const { settings } = useSettingsContext();
  const amountFormatting = useAmountFormatting();
  const numberFormatting = useNumberFormatting();
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();

  const { data: goals, isLoading } = useQuery<Goal[], Error>({
    queryKey: [QueryKeys.GOALS],
    queryFn: getGoals,
  });

  if (isLoading) {
    return (
      <DashboardCard title={t("common:goals")}>
        <div className="space-y-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-[2px] w-2/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          ))}
        </div>
      </DashboardCard>
    );
  }

  const activeGoals = (goals ?? [])
    .filter((g) => g.statusLifecycle === "active")
    .sort(sortDashboardGoals);
  const visibleGoals = activeGoals.slice(0, MAX_DISPLAYED_GOALS);
  const hiddenGoalsCount = Math.max(0, activeGoals.length - visibleGoals.length);

  if (activeGoals.length === 0) {
    return (
      <DashboardCard title={t("common:goals")} action={<ViewAllLink />}>
        <div className="py-2 text-center">
          <p className="text-sm">{t("dashboard:goals.no_goals_set")}</p>
          <Link
            to="/goals/new"
            className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
          >
            {t("dashboard:goals.create_first_goal")}
            <Icons.ChevronRight className="h-3 w-3 rtl:rotate-180" />
          </Link>
        </div>
      </DashboardCard>
    );
  }

  return (
    <DashboardCard title={t("common:goals")} action={<ViewAllLink />}>
      {visibleGoals.map((goal, index) => {
        const progress = goal.summaryProgress ?? 0;
        const pct = Math.max(0, Math.min(1, progress));
        const currentValue = goal.summaryCurrentValue ?? 0;
        const target = goal.summaryTargetAmount ?? goal.targetAmount ?? 0;
        const currency = goal.currency ?? "USD";
        const deadline = goal.targetDate ?? goal.projectedCompletionDate;
        const timeStr = formatTimeRemaining(t, deadline, settings?.timezone);
        const pctDisplay = numberFormatting.formatPercent(pct, { digits: 0 });

        const currentDisplay = isBalanceHidden
          ? "••••"
          : amountFormatting.formatCompactAmount(currentValue, currency);
        const targetDisplay = isBalanceHidden
          ? "••••"
          : target > 0
            ? amountFormatting.formatCompactAmount(target, currency)
            : "—";

        // An Item link: its padding and rounded corners carry the hover, and the negative
        // margin keeps the content on the card's padding.
        return (
          <Fragment key={goal.id}>
            {index > 0 && <ItemSeparator />}
            <Item
              size="sm"
              render={<Link to={`/goals/${goal.id}`} />}
              className="-mx-2 items-start gap-x-4 gap-y-2.5 border-0 px-2"
            >
              <ItemContent className="min-w-0 gap-0.5">
                {/* Title row with status dot */}
                <ItemTitle className="w-full min-w-0 gap-2">
                  <h3 className="truncate text-sm leading-tight font-semibold md:text-base">
                    {goal.title}
                  </h3>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      statusDotClass(goal.statusHealth),
                    )}
                  />
                  {progress >= 1 ? (
                    <Icons.CheckCircle className="text-success h-3.5 w-3.5 shrink-0" />
                  ) : null}
                </ItemTitle>

                {/* Amounts directly under title */}
                <ItemDescription className="line-clamp-none text-xs tabular-nums md:text-sm">
                  {currentDisplay} / {targetDisplay}
                </ItemDescription>
              </ItemContent>

              {/* Right: big % + time */}
              <ItemActions className="shrink-0 flex-col items-end gap-1 text-end">
                <div className="text-base leading-none font-semibold tabular-nums">
                  {pctDisplay}
                </div>
                <div className="text-muted-foreground text-xs md:text-sm">{timeStr}</div>
              </ItemActions>

              {/* Full-width progress bar at row bottom */}
              <ItemFooter>
                <div className="bg-muted/60 relative h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-success h-full rounded-full transition-all"
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
              </ItemFooter>
            </Item>
          </Fragment>
        );
      })}
      {hiddenGoalsCount > 0 && (
        <Link
          to="/goals"
          className="text-muted-foreground hover:text-foreground flex items-center justify-between pt-3 text-xs transition-colors"
        >
          <span>{t("dashboard:goals.more_goals", { count: hiddenGoalsCount })}</span>
          <Icons.ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </Link>
      )}
    </DashboardCard>
  );
}

export default SavingGoals;
