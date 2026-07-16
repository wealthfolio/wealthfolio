import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import type { Goal } from "@/lib/types";
import {
  Button,
  Page,
  PageContent,
  PageHeader,
  Skeleton,
  formatCompactAmount,
  formatPercent,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { GoalCard } from "../components/goal-card";
import { useGoals } from "../hooks/use-goals";

function StatBlock({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-muted-foreground text-[10px] tracking-[0.15em]">{label}</span>
      <span className="text-foreground font-serif text-[15px] font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}

function SummaryStats({ goals }: { goals: Goal[] }) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();
  const currency = settings?.baseCurrency ?? goals[0]?.currency ?? "USD";

  const saved = goals.reduce((s, g) => s + (g.summaryCurrentValue ?? 0), 0);
  const target = goals.reduce((s, g) => s + (g.summaryTargetAmount ?? g.targetAmount ?? 0), 0);
  const overall = target > 0 ? saved / target : 0;
  const onTrackCount = goals.filter(
    (g) => g.statusHealth === "on_track" || g.statusLifecycle === "achieved",
  ).length;

  const savedDisplay = isBalanceHidden ? "••••" : formatCompactAmount(saved, currency);
  const targetDisplay = isBalanceHidden ? "••••" : formatCompactAmount(target, currency);

  return (
    <div className="mb-6 flex flex-wrap items-baseline gap-x-8 gap-y-2">
      <StatBlock label={t("goals:dashboard.stat_saved")} value={savedDisplay} />
      <StatBlock label={t("goals:dashboard.stat_target")} value={targetDisplay} />
      <StatBlock label={t("goals:dashboard.stat_overall")} value={formatPercent(overall)} />
      <StatBlock
        label={t("goals:dashboard.stat_on_track")}
        value={`${onTrackCount}/${goals.length}`}
      />
    </div>
  );
}

function GoalGrid({ goals }: { goals: Goal[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {goals.map((goal) => (
        <GoalCard key={goal.id} goal={goal} />
      ))}
    </div>
  );
}

export default function GoalsDashboardPage() {
  const { t } = useTranslation();
  const { active, atRisk, achieved, archived, isLoading } = useGoals();
  const [archivedOpen, setArchivedOpen] = useState(false);

  if (isLoading) {
    return (
      <Page>
        <PageHeader heading={t("goals:goals")} text={t("goals:dashboard.subtitle")} />
        <PageContent>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-64 w-full rounded-xl" />
            ))}
          </div>
        </PageContent>
      </Page>
    );
  }

  // Merge all non-archived goals into one flat list, sorted by target amount DESC.
  const allActive = [...atRisk, ...active, ...achieved].sort((a, b) => {
    const aTarget = a.summaryTargetAmount ?? a.targetAmount ?? 0;
    const bTarget = b.summaryTargetAmount ?? b.targetAmount ?? 0;
    if (aTarget !== bTarget) return bTarget - aTarget;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  const hasGoals = allActive.length > 0 || archived.length > 0;

  return (
    <Page>
      <PageHeader
        heading={t("goals:goals")}
        text={t("goals:dashboard.subtitle")}
        actions={
          <Link to="/goals/new">
            <Button size="sm">
              <Icons.Plus className="mr-1 h-4 w-4" />
              {t("goals:dashboard.new_goal")}
            </Button>
          </Link>
        }
      />
      <PageContent>
        {!hasGoals ? (
          <div className="flex flex-col items-center justify-center gap-5 py-28 text-center">
            <div className="bg-muted/60 flex h-16 w-16 items-center justify-center rounded-2xl">
              <Icons.Target className="text-muted-foreground h-8 w-8" />
            </div>
            <div className="space-y-2">
              <p className="text-lg font-semibold">{t("goals:dashboard.empty_title")}</p>
              <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
                {t("goals:dashboard.empty_description")}
              </p>
            </div>
            <Link to="/goals/new">
              <Button size="lg" className="mt-2">
                <Icons.Plus className="mr-2 h-4 w-4" />
                {t("goals:dashboard.create_first_goal")}
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-8">
            {allActive.length > 0 && (
              <div>
                <SummaryStats goals={allActive} />
                <GoalGrid goals={allActive} />
              </div>
            )}

            {archived.length > 0 && (
              <section>
                <button
                  onClick={() => setArchivedOpen((o) => !o)}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-xs font-medium transition-colors"
                >
                  <Icons.ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${archivedOpen ? "rotate-90" : ""}`}
                  />
                  {t("goals:dashboard.archived_count", { count: archived.length })}
                </button>
                {archivedOpen && (
                  <div className="mt-3">
                    <GoalGrid goals={archived} />
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </PageContent>
    </Page>
  );
}
