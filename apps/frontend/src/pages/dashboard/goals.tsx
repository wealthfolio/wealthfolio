import { getGoals } from "@/adapters";
import { DashboardCard } from "@/components/dashboard-card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { QueryKeys } from "@/lib/query-keys";
import type { Goal } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { cn, formatCompactAmount } from "@wealthfolio/ui";
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
  if (status === "at_risk") return "bg-amber-500";
  if (status === "on_track") return "bg-success";
  return "bg-muted-foreground/35";
}

function formatTimeRemaining(t: (key: string) => string, targetDate?: string): string {
  if (!targetDate) return t("dashboard:goals.time_no_deadline");
  const target = new Date(targetDate);
  const now = new Date();
  if (!Number.isFinite(target.getTime())) return t("dashboard:goals.time_no_deadline");
  if (target.getTime() <= now.getTime()) return t("dashboard:goals.time_due");
  let months =
    (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  if (target.getDate() < now.getDate()) months -= 1;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  // Compact, language-neutral units (Y/M).
  if (years === 0) return `${Math.max(1, remMonths)}M`;
  if (remMonths === 0) return `${years}Y`;
  return `${years}Y ${remMonths}M`;
}

function ViewAllLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/goals"
      className="text-muted-foreground hover:bg-success/10 inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors"
    >
      {t("dashboard:view_all")}
      <Icons.ChevronRight className="ml-1 h-3 w-3" />
    </Link>
  );
}

export function SavingGoals() {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();

  const { data: goals, isLoading } = useQuery<Goal[], Error>({
    queryKey: [QueryKeys.GOALS],
    queryFn: getGoals,
  });

  if (isLoading) {
    return (
      <DashboardCard title={t("common:goals")} elevated>
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
      <DashboardCard title={t("common:goals")} elevated action={<ViewAllLink />}>
        <div className="py-2 text-center">
          <p className="text-sm">{t("dashboard:goals.no_goals_set")}</p>
          <Link
            to="/goals/new"
            className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
          >
            {t("dashboard:goals.create_first_goal")}
            <Icons.ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </DashboardCard>
    );
  }

  return (
    <DashboardCard title={t("common:goals")} elevated action={<ViewAllLink />}>
      {visibleGoals.map((goal) => {
        const progress = goal.summaryProgress ?? 0;
        const pct = Math.max(0, Math.min(1, progress));
        const currentValue = goal.summaryCurrentValue ?? 0;
        const target = goal.summaryTargetAmount ?? goal.targetAmount ?? 0;
        const currency = goal.currency ?? "USD";
        const deadline = goal.targetDate ?? goal.projectedCompletionDate;
        const timeStr = formatTimeRemaining(t, deadline);
        const pctDisplay = Math.round(pct * 100);

        const currentDisplay = isBalanceHidden
          ? "••••"
          : formatCompactAmount(currentValue, currency);
        const targetDisplay = isBalanceHidden
          ? "••••"
          : target > 0
            ? formatCompactAmount(target, currency)
            : "—";

        return (
          <Link
            key={goal.id}
            to={`/goals/${goal.id}`}
            className="border-border hover:bg-muted/30 group block border-b py-3 transition-colors last:border-0"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                {/* Title row with status dot */}
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold leading-tight">{goal.title}</h3>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      statusDotClass(goal.statusHealth),
                    )}
                  />
                  {progress >= 1 ? (
                    <Icons.CheckCircle className="text-success h-3.5 w-3.5 shrink-0" />
                  ) : null}
                </div>

                {/* Amounts directly under title */}
                <div className="text-muted-foreground mt-0.5 text-[11px] tabular-nums">
                  {currentDisplay} / {targetDisplay}
                </div>
              </div>

              {/* Right: big % + time */}
              <div className="shrink-0 text-right">
                <div className="text-base font-semibold tabular-nums leading-none">
                  {pctDisplay}
                  <span className="text-[9px] font-medium">%</span>
                </div>
                <div className="text-muted-foreground mt-1 text-[10px] tracking-[0.1em]">
                  {timeStr}
                </div>
              </div>
            </div>

            {/* Full-width progress bar at row bottom */}
            <div className="bg-muted/60 relative mt-2.5 h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-success h-full rounded-full transition-all"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
          </Link>
        );
      })}
      {hiddenGoalsCount > 0 && (
        <Link
          to="/goals"
          className="text-muted-foreground hover:text-foreground flex items-center justify-between pt-3 text-xs transition-colors"
        >
          <span>{t("dashboard:goals.more_goals", { count: hiddenGoalsCount })}</span>
          <Icons.ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </DashboardCard>
  );
}

export default SavingGoals;
