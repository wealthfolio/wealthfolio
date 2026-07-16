import type { Holding, RetirementOverview, RetirementTrajectoryPoint } from "@/lib/types";
import {
  AnimatedToggleGroup,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  formatCompactAmount,
  Skeleton,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CHART_COLORS,
  PROJECTED_CHART_COLORS,
  RetirementChart,
  type ChartPoint,
} from "../components/retirement-portfolio-chart";
import {
  COVERAGE_COLORS,
  RetirementCoverageChart,
  type CoverageProjectionPoint,
} from "../components/retirement-coverage-chart";
import { RetirementSnapshotTable } from "../components/retirement-snapshot-table";
import {
  ValueModeToggle,
  ValueModeTooltip,
  type ChartValueMode,
} from "../components/value-mode-toggle";
import { SidebarConfigurator } from "../components/sidebar-configurator";
import {
  boundedInflationFactor,
  coverageTimingLabel,
  deriveRetirementReadiness,
  incomeAgeRangeLabel,
  incomeStreamMonthlyAmount,
  isIncomeActiveAtAge,
  modeLabel,
  projectedAnnualExpenseNominalAtAge,
  projectedAnnualIncomeNominalAtAge,
  resolveCoverageAnnualNominalValues,
  resolveFundedProgress,
  resolvePortfolioDrawRate,
  type PlannerMode,
} from "../lib/dashboard-math";
import { expenseAgeRangeLabel, expenseItems, isExpenseActiveAtAge } from "../lib/expense-items";
import type { RetirementPlan } from "../types";

interface Props {
  plan: RetirementPlan;
  portfolioData: {
    holdings: Holding[];
    totalValue: number;
    isLoading: boolean;
    error: Error | null;
  };
  isLoading: boolean;
  plannerMode?: PlannerMode;
  onSavePlan?: (plan: RetirementPlan, plannerMode?: PlannerMode) => void;
  onNavigateToTab?: (tab: string) => void;
  retirementOverview?: RetirementOverview;
  retirementOverviewError?: Error | null;
  retirementOverviewIsFetching?: boolean;
  goalId?: string;
  dcLinkedAccountIds?: string[];
}

type CoverageView = "at-retirement" | "over-time";

// ─── Chart types & helpers ───────────────────────────────────────

// Warm olive palette for income streams (coverage bar + row dots).
// Values come from --fi-stream-N CSS variables which swap between light/dark themes.
const INCOME_STREAM_COLORS = [
  "var(--fi-stream-1)",
  "var(--fi-stream-2)",
  "var(--fi-stream-3)",
  "var(--fi-stream-4)",
  "var(--fi-stream-5)",
];

function RetirementAnalysisPendingColumn({ error }: { error: Error | null }) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="space-y-6 lg:col-span-2">
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="text-destructive flex gap-3 py-5 text-sm">
            <Icons.AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">{t("goals:dashboard.pending.failed_to_load")}</p>
              <p className="mt-1 text-xs">{error.message}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 lg:col-span-2">
      <Card className="overflow-hidden">
        <CardContent className="px-7 py-6">
          <div className="mb-5 flex items-start gap-3">
            <span className="bg-muted/60 flex size-8 shrink-0 items-center justify-center rounded-full">
              <Icons.Spinner className="text-muted-foreground size-4 animate-spin" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{t("goals:dashboard.pending.calculating")}</p>
              <p className="text-muted-foreground mt-1 max-w-xl text-sm leading-relaxed">
                {t("goals:dashboard.pending.calculating_help")}
              </p>
            </div>
          </div>
          <Skeleton className="mb-3 h-8 w-[82%] rounded-md" />
          <Skeleton className="mb-6 h-8 w-[58%] rounded-md" />
          <Skeleton className="mb-5 h-3 w-full rounded-full" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-3 w-16 rounded" />
                <Skeleton className="h-5 w-20 rounded" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-40 rounded" />
              <Skeleton className="h-4 w-32 rounded" />
            </div>
            <Skeleton className="h-8 w-40 rounded-md" />
          </div>
        </CardHeader>
        <CardContent className="px-2 sm:px-6">
          <Skeleton className="h-64 w-full rounded-md" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-32 rounded" />
            <Skeleton className="h-4 w-48 rounded" />
          </div>
        </CardHeader>
        <CardContent className="space-y-5 px-2 sm:px-6">
          <Skeleton className="h-48 w-full rounded-md" />
          <Skeleton className="h-3 w-full rounded-full" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-40 rounded" />
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="h-3 w-10 rounded" />
              <Skeleton className="h-3 flex-1 rounded" />
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-3 w-16 rounded" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

export default function DashboardPage({
  plan,
  portfolioData,
  plannerMode = "fire",
  onSavePlan,
  retirementOverview,
  retirementOverviewError,
  retirementOverviewIsFetching,
  goalId,
  dcLinkedAccountIds,
}: Props) {
  const { t } = useTranslation();
  const L = modeLabel(plannerMode);
  const isTraditionalMode = plannerMode === "traditional";
  const { totalValue, error } = portfolioData;
  const portfolioNow = retirementOverview?.portfolioNow ?? totalValue;
  const currency = plan.currency;
  const [chartValueMode, setChartValueMode] = useState<ChartValueMode>("real");
  const [coverageView, setCoverageView] = useState<CoverageView>("at-retirement");
  const sidebarKey = useMemo(() => `${plannerMode}:${JSON.stringify(plan)}`, [plan, plannerMode]);
  const valueModeLabel =
    chartValueMode === "real"
      ? t("goals:dashboard.value_mode.todays_value")
      : t("goals:dashboard.value_mode.nominal");
  const toTodayValueAtAge = useCallback(
    (value: number, age: number) => {
      const yearsFromNow = Math.max(0, age - plan.personal.currentAge);
      return value / boundedInflationFactor(plan.investment.inflationRate, yearsFromNow);
    },
    [plan.investment.inflationRate, plan.personal.currentAge],
  );
  const scaleForModeAtAge = useCallback(
    (value: number, age: number) => {
      if (chartValueMode === "nominal") return value;
      return toTodayValueAtAge(value, age);
    },
    [chartValueMode, toTodayValueAtAge],
  );

  // All numbers come from the backend DTO
  const retireTodayTarget = retirementOverview?.netFireTarget ?? 0;
  const targetReconciliation = retirementOverview?.targetReconciliation;
  const fallbackInflationFactorToGoal = boundedInflationFactor(
    plan.investment.inflationRate,
    Math.max(0, plan.personal.targetRetirementAge - plan.personal.currentAge),
  );
  const inflationFactorToGoal =
    targetReconciliation?.inflationFactorToTarget ?? fallbackInflationFactorToGoal;
  const targetNominalAtGoal =
    targetReconciliation?.requiredCapitalNominal ??
    retirementOverview?.requiredCapitalAtGoalAge ??
    0;
  const targetTodayAtGoal =
    targetReconciliation?.requiredCapitalTodayValue ?? targetNominalAtGoal / inflationFactorToGoal;
  const targetAtGoalDisplay =
    chartValueMode === "nominal" ? targetNominalAtGoal : targetTodayAtGoal;
  const coastAmount = retirementOverview?.coastAmountToday ?? 0;
  const coastAmountDisplay =
    chartValueMode === "nominal" ? coastAmount * inflationFactorToGoal : coastAmount;
  const fiAge = retirementOverview?.fiAge ?? null;
  const retirementStartAge = retirementOverview?.retirementStartAge ?? null;
  const suggestedAge = retirementOverview?.suggestedGoalAgeIfUnchanged ?? null;
  const requiredCapitalReachable = retirementOverview?.requiredCapitalReachable ?? true;
  // Effective FI age: genuine FI age, or the accumulation-only suggested age for display
  const effectiveFiAge = fiAge ?? suggestedAge;
  const progress = resolveFundedProgress(
    retirementOverview?.progress,
    portfolioNow,
    targetTodayAtGoal,
  );
  const milestonePortfolioDisplay =
    chartValueMode === "nominal" ? portfolioNow * inflationFactorToGoal : portfolioNow;

  const fireAgeForBudget = retirementStartAge ?? plan.personal.targetRetirementAge;
  const coverageExpenseItems = useMemo(() => expenseItems(plan.expenses), [plan.expenses]);
  const coverageIncomeStreams = plan.incomeStreams;

  // Budget from backend DTO
  const budget = retirementOverview?.budgetBreakdown;
  const totalBudget = budget?.totalMonthlyBudget ?? 0;
  const budgetStreams = budget?.incomeStreams ?? [];
  const effectiveTaxRate = budget?.effectiveTaxRate ?? 0;
  const fallbackMonthlyIncome = budgetStreams.reduce(
    (sum, stream) => sum + stream.monthlyAmount,
    0,
  );
  const coverageSnapshot = retirementOverview?.trajectory?.find(
    (pt) => pt.age === fireAgeForBudget,
  );
  const {
    annualSpendingNominal: coverageAnnualSpendingNominal,
    annualIncomeNominal: coverageAnnualIncomeNominal,
    annualPortfolioGapNominal: coverageAnnualPortfolioGapNominal,
    annualGrossWithdrawalNominal: coverageAnnualGrossWithdrawalNominal,
    annualEstimatedTaxesNominal: coverageAnnualEstimatedTaxesNominal,
  } = resolveCoverageAnnualNominalValues({
    snapshot: coverageSnapshot,
    totalMonthlyBudget: totalBudget,
    fallbackMonthlyIncome,
    effectiveTaxRate,
  });
  const coverageAnnualSpendingToday = toTodayValueAtAge(
    coverageAnnualSpendingNominal,
    fireAgeForBudget,
  );
  const coverageAnnualIncomeToday = toTodayValueAtAge(
    coverageAnnualIncomeNominal,
    fireAgeForBudget,
  );
  const coverageAnnualPortfolioGapToday = toTodayValueAtAge(
    coverageAnnualPortfolioGapNominal,
    fireAgeForBudget,
  );
  const coverageAnnualEstimatedTaxesToday = toTodayValueAtAge(
    coverageAnnualEstimatedTaxesNominal,
    fireAgeForBudget,
  );
  const coverageAnnualSpending =
    chartValueMode === "nominal" ? coverageAnnualSpendingNominal : coverageAnnualSpendingToday;
  const coverageAnnualIncome =
    chartValueMode === "nominal" ? coverageAnnualIncomeNominal : coverageAnnualIncomeToday;
  const coverageAnnualPortfolioGap =
    chartValueMode === "nominal"
      ? coverageAnnualPortfolioGapNominal
      : coverageAnnualPortfolioGapToday;
  const coverageAnnualEstimatedTaxes =
    chartValueMode === "nominal"
      ? coverageAnnualEstimatedTaxesNominal
      : coverageAnnualEstimatedTaxesToday;
  const coverageSpendingMonthly = coverageAnnualSpending / 12;
  const coverageEstimatedTaxesMonthly = coverageAnnualEstimatedTaxes / 12;
  const coverageIncomeAppliedAnnual = Math.min(coverageAnnualSpending, coverageAnnualIncome);
  const coveragePortfolioAppliedAnnual = Math.min(
    Math.max(0, coverageAnnualSpending - coverageIncomeAppliedAnnual),
    coverageAnnualPortfolioGap,
  );
  const coverageShortfallAnnual = Math.max(
    0,
    coverageAnnualSpending - coverageIncomeAppliedAnnual - coveragePortfolioAppliedAnnual,
  );
  const coveragePortfolioAppliedMonthly = coveragePortfolioAppliedAnnual / 12;
  const coverageShortfallMonthly = coverageShortfallAnnual / 12;
  const coverageIncomePct =
    coverageAnnualSpending > 0
      ? Math.min(100, Math.max(0, (coverageIncomeAppliedAnnual / coverageAnnualSpending) * 100))
      : 0;
  const coveragePortfolioPct =
    coverageAnnualSpending > 0
      ? Math.min(
          100 - coverageIncomePct,
          Math.max(0, (coveragePortfolioAppliedAnnual / coverageAnnualSpending) * 100),
        )
      : 0;
  const coverageShortfallPct =
    coverageAnnualSpending > 0
      ? Math.min(100, Math.max(0, (coverageShortfallAnnual / coverageAnnualSpending) * 100))
      : 0;
  const coveragePortfolioValueAtAge = coverageSnapshot?.portfolioStart ?? 0;
  const coveragePortfolioDrawRate = resolvePortfolioDrawRate({
    requiredCapitalReachable,
    portfolioValueAtAge: coveragePortfolioValueAtAge,
    grossWithdrawalAtAge: coverageAnnualGrossWithdrawalNominal,
    annualIncomeAtAge: coverageAnnualIncomeNominal,
    annualSpendingAtAge: coverageAnnualSpendingNominal,
    portfolioEndAtAge: coverageSnapshot?.portfolioEnd,
  });
  const nextIncomeStartAge =
    coverageIncomeStreams
      .filter((stream) => stream.startAge > fireAgeForBudget)
      .reduce<
        number | null
      >((earliest, stream) => (earliest === null ? stream.startAge : Math.min(earliest, stream.startAge)), null) ??
    null;

  const hasPensionFunds = plan.incomeStreams.some(
    (s) => (s.currentValue ?? 0) > 0 || (s.monthlyContribution ?? 0) > 0,
  );

  // Chart data from backend trajectory
  const chartData: ChartPoint[] = useMemo(() => {
    if (!retirementOverview?.trajectory?.length) return [];
    return retirementOverview.trajectory.map((pt) => ({
      label: t("goals:dashboard.age_label", { age: pt.age }),
      age: pt.age,
      portfolio: scaleForModeAtAge(Math.max(0, pt.portfolioStart), pt.age),
      portfolioStart: scaleForModeAtAge(Math.max(0, pt.portfolioStart), pt.age),
      portfolioEnd: scaleForModeAtAge(Math.max(0, pt.portfolioEnd), pt.age),
      target:
        pt.requiredCapital == null ? undefined : scaleForModeAtAge(pt.requiredCapital, pt.age),
      withdrawal: scaleForModeAtAge(pt.netWithdrawalFromPortfolio, pt.age),
      phase: pt.phase,
      annualContribution: scaleForModeAtAge(pt.annualContribution, pt.age),
      annualIncome: scaleForModeAtAge(pt.annualIncome, pt.age),
      annualExpenses: scaleForModeAtAge(pt.plannedExpenses ?? pt.annualExpenses, pt.age),
      netChange:
        scaleForModeAtAge(Math.max(0, pt.portfolioEnd), pt.age) -
        scaleForModeAtAge(Math.max(0, pt.portfolioStart), pt.age),
    }));
  }, [retirementOverview?.trajectory, scaleForModeAtAge, t]);

  const coverageProjectionData: CoverageProjectionPoint[] = useMemo(() => {
    if (!retirementOverview?.trajectory?.length) return [];
    const coverageStartAge = plan.personal.targetRetirementAge;
    return retirementOverview.trajectory
      .filter((pt) => pt.age >= coverageStartAge && pt.age <= plan.personal.planningHorizonAge)
      .map((pt) => {
        const plannedSpending = Math.max(
          0,
          pt.plannedExpenses ?? projectedAnnualExpenseNominalAtAge(plan, pt.age),
        );
        const retirementIncomeAvailable = Math.max(
          0,
          pt.phase === "fire"
            ? pt.annualIncome
            : projectedAnnualIncomeNominalAtAge(plan, pt.age, coverageStartAge),
        );
        const portfolioWithdrawalAvailable =
          pt.phase === "fire" ? Math.max(0, pt.netWithdrawalFromPortfolio) : 0;
        const retirementIncome = Math.min(plannedSpending, retirementIncomeAvailable);
        const remainingAfterIncome = Math.max(0, plannedSpending - retirementIncome);
        const portfolioWithdrawal = Math.min(remainingAfterIncome, portfolioWithdrawalAvailable);
        const shortfall = Math.max(
          0,
          pt.annualShortfall ?? plannedSpending - retirementIncome - portfolioWithdrawal,
        );
        return {
          label: t("goals:dashboard.age_label", { age: pt.age }),
          age: pt.age,
          plannedSpending: scaleForModeAtAge(plannedSpending, pt.age),
          retirementIncome: scaleForModeAtAge(retirementIncome, pt.age),
          portfolioWithdrawal: scaleForModeAtAge(portfolioWithdrawal, pt.age),
          shortfall: scaleForModeAtAge(shortfall, pt.age),
          taxes: scaleForModeAtAge(Math.max(0, pt.annualTaxes ?? 0), pt.age),
        };
      });
  }, [plan, retirementOverview?.trajectory, scaleForModeAtAge, t]);

  const coverageProjectionTicks = useMemo(() => {
    if (coverageProjectionData.length === 0) return [];

    const firstAge = coverageProjectionData[0].age;
    const lastAge = coverageProjectionData[coverageProjectionData.length - 1].age;
    const span = Math.max(1, lastAge - firstAge);
    const step = Math.max(1, Math.ceil(span / 5));
    const ticks = new Set<number>([firstAge, lastAge, fireAgeForBudget]);

    const firstSteppedAge = Math.ceil(firstAge / step) * step;
    for (let age = firstSteppedAge; age <= lastAge; age += step) {
      ticks.add(age);
    }

    return [...ticks].sort((a, b) => a - b);
  }, [coverageProjectionData, fireAgeForBudget]);

  // Year-by-year table: all years from backend trajectory
  const allSnapshots: RetirementTrajectoryPoint[] = useMemo(() => {
    return retirementOverview?.trajectory ?? [];
  }, [retirementOverview?.trajectory]);
  const incomeStartAges = useMemo(
    () => new Set(plan.incomeStreams.map((s) => s.startAge)),
    [plan.incomeStreams],
  );

  const isFinanciallyIndependent =
    !isTraditionalMode && portfolioNow >= retireTodayTarget && retireTodayTarget > 0;
  const yearsFromDesired =
    effectiveFiAge != null ? effectiveFiAge - plan.personal.targetRetirementAge : null;
  const traditionalStatus = retirementOverview?.successStatus;
  const spendingShortfallAge = retirementOverview?.spendingShortfallAge ?? null;
  const firstUnfundedAge = retirementOverview
    ? [retirementOverview.failureAge, spendingShortfallAge]
        .filter((age): age is number => typeof age === "number")
        .reduce<
          number | null
        >((earliest, age) => (earliest == null ? age : Math.min(earliest, age)), null)
    : null;
  const readiness = deriveRetirementReadiness({
    overview: retirementOverview,
    plannerMode,
    isFinanciallyIndependent,
    effectiveFiAge,
    desiredAge: plan.personal.targetRetirementAge,
    horizonAge: plan.personal.planningHorizonAge,
  });
  const heroHealth =
    readiness.tone === "good" ? "on_track" : readiness.tone === "watch" ? "at_risk" : "off_track";
  const heroGuidance = readiness.body;

  if (!retirementOverview) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <RetirementAnalysisPendingColumn error={retirementOverviewError ?? error} />
          <div className="space-y-4 lg:col-span-1 lg:self-start">
            <SidebarConfigurator
              key={sidebarKey}
              plan={plan}
              currency={currency}
              plannerMode={plannerMode}
              onSavePlan={onSavePlan}
              retirementOverview={retirementOverview}
              goalId={goalId}
              dcLinkedAccountIds={dcLinkedAccountIds}
            />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive p-4 text-sm">
        {t("goals:dashboard.failed_to_load_portfolio", { message: error.message })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {retirementOverviewIsFetching && (
        <div className="bg-muted/20 text-muted-foreground flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <Icons.Spinner className="size-3.5 animate-spin" />
          {t("goals:dashboard.recalculating")}
        </div>
      )}

      {/* Two-column layout: main + sidebar */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ── Main column ── */}
        <div className="space-y-6 lg:col-span-2">
          {/* Verdict — the hero. Sentence-style headline with inline status. */}
          {(() => {
            const statusAccent =
              heroHealth === "on_track"
                ? "text-green-600"
                : heroHealth === "at_risk"
                  ? "text-amber-600"
                  : "text-red-500";
            const goalShortfallNominal =
              targetReconciliation?.shortfallNominal ?? retirementOverview.shortfallAtGoalAge;
            const goalShortfallToday =
              targetReconciliation?.shortfallTodayValue ??
              retirementOverview.shortfallAtGoalAge / inflationFactorToGoal;
            const goalShortfall =
              chartValueMode === "nominal" ? goalShortfallNominal : goalShortfallToday;
            const goalSurplusNominal = retirementOverview.surplusAtGoalAge;
            const goalSurplusToday = goalSurplusNominal / inflationFactorToGoal;
            const goalSurplus =
              chartValueMode === "nominal" ? goalSurplusNominal : goalSurplusToday;
            const portfolioAtTargetToday =
              targetReconciliation?.portfolioAtTargetTodayValue ??
              retirementOverview.portfolioAtGoalAge / inflationFactorToGoal;
            const portfolioAtTargetNominal =
              targetReconciliation?.portfolioAtTargetNominal ??
              retirementOverview.portfolioAtGoalAge;
            const portfolioAtTarget =
              chartValueMode === "nominal" ? portfolioAtTargetNominal : portfolioAtTargetToday;
            const monthlyContribLabel = `${formatCompactAmount(plan.investment.monthlyContribution, currency)}/mo`;
            const annualBudgetToday =
              targetReconciliation?.plannedAnnualExpensesTodayValue ?? totalBudget * 12;
            const annualBudgetNominal =
              targetReconciliation?.plannedAnnualExpensesNominal ??
              totalBudget * 12 * inflationFactorToGoal;
            const annualBudget =
              chartValueMode === "nominal" ? annualBudgetNominal : annualBudgetToday;
            const annualBudgetLabel = formatCompactAmount(annualBudget, currency);
            const coastPct =
              targetAtGoalDisplay > 0
                ? Math.min(100, (coastAmountDisplay / targetAtGoalDisplay) * 100)
                : 0;
            const traditionalBadge =
              traditionalStatus === "depleted"
                ? t("goals:dashboard.badge.runs_short")
                : traditionalStatus === "shortfall"
                  ? t("goals:dashboard.badge.shortfall")
                  : traditionalStatus === "overfunded"
                    ? t("goals:dashboard.badge.surplus")
                    : t("goals:dashboard.badge.on_track");

            return (
              <Card className="overflow-hidden">
                <CardContent className="px-7 py-6">
                  <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      {heroHealth === "on_track" ? (
                        <Badge
                          variant="default"
                          className="gap-1.5 bg-green-600 text-[10px] hover:bg-green-600"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                          {isTraditionalMode
                            ? traditionalBadge
                            : isFinanciallyIndependent
                              ? t("goals:dashboard.badge.fi_reached")
                              : t("goals:dashboard.badge.on_track")}
                        </Badge>
                      ) : heroHealth === "at_risk" ? (
                        <Badge
                          variant="secondary"
                          className="gap-1.5 text-[10px] text-amber-700 dark:text-amber-400"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          {isTraditionalMode
                            ? traditionalBadge
                            : yearsFromDesired != null
                              ? t("goals:dashboard.badge.years_late", { count: yearsFromDesired })
                              : t("goals:dashboard.badge.at_risk")}
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="gap-1.5 text-[10px]">
                          <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                          {isTraditionalMode
                            ? traditionalBadge
                            : yearsFromDesired != null && yearsFromDesired > 0
                              ? t("goals:dashboard.badge.years_late", { count: yearsFromDesired })
                              : t("goals:dashboard.badge.never_reaches_fi")}
                        </Badge>
                      )}
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <ValueModeToggle value={chartValueMode} onChange={setChartValueMode} />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
                            aria-label={t("goals:dashboard.value_mode.explained_aria")}
                          >
                            <Icons.Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-xs">
                          <div className="font-semibold">
                            {t("goals:dashboard.value_mode.todays_value")}
                          </div>
                          <p className="text-muted-foreground mt-1">
                            {t("goals:dashboard.value_mode.todays_value_tip")}
                          </p>
                          <div className="mt-3 font-semibold">
                            {t("goals:dashboard.value_mode.nominal")}
                          </div>
                          <p className="text-muted-foreground mt-1">
                            {t("goals:dashboard.value_mode.nominal_tip")}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  {/* Sentence-style verdict */}
                  <h1 className="max-w-[95%] font-serif text-2xl font-normal leading-[1.15] tracking-tight">
                    {isTraditionalMode ? (
                      traditionalStatus === "shortfall" &&
                      spendingShortfallAge != null &&
                      goalShortfall <= 0 ? (
                        <>
                          {t("goals:dashboard.verdict.spending_gap_prefix")}{" "}
                          <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                            {t("goals:dashboard.verdict.age", { age: spendingShortfallAge })}
                          </span>
                          <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                            {" "}
                            {t("goals:dashboard.verdict.spending_gap_suffix", {
                              age: plan.personal.planningHorizonAge,
                            })}
                          </span>
                        </>
                      ) : traditionalStatus === "shortfall" ? (
                        <>
                          {t("goals:dashboard.verdict.short_prefix", {
                            age: plan.personal.targetRetirementAge,
                          })}{" "}
                          <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                            {formatCompactAmount(goalShortfall, currency)}
                          </span>
                          <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                            {" "}
                            {t("goals:dashboard.verdict.short_suffix", {
                              age: plan.personal.planningHorizonAge,
                            })}
                          </span>
                        </>
                      ) : traditionalStatus === "depleted" ? (
                        <>
                          {t("goals:dashboard.verdict.depleted_prefix")}{" "}
                          <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                            {t("goals:dashboard.verdict.age", {
                              age: retirementOverview.failureAge ?? firstUnfundedAge,
                            })}
                          </span>
                          <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                            {" "}
                            {t("goals:dashboard.verdict.depleted_suffix", {
                              age: plan.personal.targetRetirementAge,
                            })}
                          </span>
                        </>
                      ) : goalSurplus > 0 ? (
                        <>
                          {t("goals:dashboard.verdict.surplus_prefix", {
                            age: plan.personal.targetRetirementAge,
                          })}{" "}
                          <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                            {formatCompactAmount(goalSurplus, currency)}
                          </span>
                          <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                            {" "}
                            {t("goals:dashboard.verdict.surplus_suffix")}
                          </span>
                        </>
                      ) : (
                        <>
                          {t("goals:dashboard.verdict.on_track_prefix")}{" "}
                          <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                            {t("goals:dashboard.verdict.age", {
                              age: plan.personal.targetRetirementAge,
                            })}
                          </span>
                          <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                            {" "}
                            {t("goals:dashboard.verdict.on_track_suffix")}
                          </span>
                        </>
                      )
                    ) : isFinanciallyIndependent ? (
                      <>
                        {t("goals:dashboard.verdict.fi_reached_prefix")}{" "}
                        <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                          {t("goals:dashboard.verdict.financial_independence")}
                        </span>
                        <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                          {" "}
                          {t("goals:dashboard.verdict.fi_reached_suffix")}
                        </span>
                      </>
                    ) : effectiveFiAge != null ? (
                      <>
                        {t("goals:dashboard.verdict.fi_at_prefix")}{" "}
                        <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                          {t("goals:dashboard.verdict.age", { age: effectiveFiAge })}
                        </span>
                        {yearsFromDesired != null && yearsFromDesired !== 0 ? (
                          <>
                            {" — "}
                            <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                              {yearsFromDesired > 0
                                ? t("goals:dashboard.verdict.years_after", {
                                    count: yearsFromDesired,
                                  })
                                : t("goals:dashboard.verdict.years_before", {
                                    count: -yearsFromDesired,
                                  })}{" "}
                              {t("goals:dashboard.verdict.your_goal_of", {
                                age: plan.personal.targetRetirementAge,
                              })}
                            </span>
                          </>
                        ) : (
                          <>
                            {" — "}
                            <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                              {t("goals:dashboard.verdict.right_on_goal", {
                                age: plan.personal.targetRetirementAge,
                              })}
                            </span>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        {t("goals:dashboard.verdict.not_reachable_prefix")}{" "}
                        <span className={`font-medium ${statusAccent} whitespace-nowrap`}>
                          {t("goals:dashboard.verdict.age", {
                            age: plan.personal.planningHorizonAge,
                          })}
                        </span>
                        <span className="text-muted-foreground font-sans text-[0.6em] font-normal italic">
                          {" "}
                          {t("goals:dashboard.verdict.not_reachable_suffix")}
                        </span>
                      </>
                    )}
                  </h1>

                  <p className="text-muted-foreground mt-4 max-w-[620px] text-sm leading-relaxed">
                    {t("goals:dashboard.summary.at_your_current_prefix")}{" "}
                    <span className="text-foreground tabular-nums">{monthlyContribLabel}</span>{" "}
                    {t("goals:dashboard.summary.contribution")}{" "}
                    {!requiredCapitalReachable ? (
                      <>{t("goals:dashboard.summary.capital_not_available")}</>
                    ) : isTraditionalMode ? (
                      <>
                        {t("goals:dashboard.summary.projected_balance_is")}{" "}
                        <ValueModeTooltip
                          valueMode={chartValueMode}
                          currency={currency}
                          todayValue={portfolioAtTargetToday}
                          nominalValue={portfolioAtTargetNominal}
                        >
                          <span className="text-foreground tabular-nums">
                            {formatCompactAmount(portfolioAtTarget, currency)}
                          </span>
                        </ValueModeTooltip>{" "}
                        {t("goals:dashboard.summary.vs_required_capital_of")}{" "}
                        <ValueModeTooltip
                          valueMode={chartValueMode}
                          currency={currency}
                          todayValue={targetTodayAtGoal}
                          nominalValue={targetNominalAtGoal}
                        >
                          <span className="text-foreground tabular-nums">
                            {formatCompactAmount(targetAtGoalDisplay, currency)}
                          </span>
                        </ValueModeTooltip>{" "}
                        {t("goals:dashboard.summary.at_age", {
                          age: plan.personal.targetRetirementAge,
                        })}
                      </>
                    ) : (
                      <>
                        {t("goals:dashboard.summary.the_plan_funds")}{" "}
                        <ValueModeTooltip
                          valueMode={chartValueMode}
                          currency={currency}
                          todayValue={annualBudgetToday}
                          nominalValue={annualBudgetNominal}
                        >
                          <span className="text-foreground tabular-nums">{annualBudgetLabel}</span>
                        </ValueModeTooltip>
                        {t("goals:dashboard.summary.per_yr_expenses_to_age", {
                          age: plan.personal.planningHorizonAge,
                        })}
                      </>
                    )}
                    {requiredCapitalReachable &&
                      !isTraditionalMode &&
                      goalShortfall > 0 &&
                      yearsFromDesired != null &&
                      yearsFromDesired > 0 && (
                        <>
                          {" "}
                          {t("goals:dashboard.summary.youre_short")}{" "}
                          <ValueModeTooltip
                            valueMode={chartValueMode}
                            currency={currency}
                            todayValue={goalShortfallToday}
                            nominalValue={goalShortfallNominal}
                          >
                            <span className="font-medium tabular-nums text-amber-600">
                              {formatCompactAmount(goalShortfall, currency)}
                            </span>
                          </ValueModeTooltip>{" "}
                          {t("goals:dashboard.summary.at_age", {
                            age: plan.personal.targetRetirementAge,
                          })}
                        </>
                      )}
                  </p>

                  {/* Progress bar — portfolio vs. target with Coast FIRE marker */}
                  <div className="mt-6">
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
                          {t("goals:dashboard.progress.portfolio_today")}
                        </span>
                        <span className="text-sm font-semibold tabular-nums">
                          {formatCompactAmount(portfolioNow, currency)}
                        </span>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-muted-foreground cursor-help text-[10px] uppercase tracking-wider underline decoration-dotted underline-offset-2">
                              {isTraditionalMode
                                ? t("goals:dashboard.progress.required_at_age", {
                                    age: plan.personal.targetRetirementAge,
                                  })
                                : t("goals:dashboard.progress.target_at_age", {
                                    age: plan.personal.targetRetirementAge,
                                  })}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-xs">
                            {isTraditionalMode
                              ? t("goals:dashboard.progress.capital_needed_tip_traditional", {
                                  valueLabel: valueModeLabel,
                                })
                              : t("goals:dashboard.progress.capital_needed_tip_fire", {
                                  valueLabel: valueModeLabel,
                                })}
                          </TooltipContent>
                        </Tooltip>
                        {requiredCapitalReachable ? (
                          <ValueModeTooltip
                            valueMode={chartValueMode}
                            currency={currency}
                            todayValue={targetTodayAtGoal}
                            nominalValue={targetNominalAtGoal}
                          >
                            <span className="text-sm font-semibold tabular-nums">
                              {formatCompactAmount(targetAtGoalDisplay, currency)}
                            </span>
                          </ValueModeTooltip>
                        ) : (
                          <span className="text-muted-foreground text-sm font-semibold">
                            {t("goals:dashboard.progress.not_available")}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="bg-muted/60 relative h-2.5 overflow-hidden rounded-md border">
                      <div
                        className="bg-success absolute inset-y-0 left-0 transition-[width] duration-500"
                        style={{ width: `${Math.min(progress * 100, 100)}%` }}
                      />
                      {!isTraditionalMode &&
                        requiredCapitalReachable &&
                        targetAtGoalDisplay > 0 &&
                        coastAmountDisplay > 0 && (
                          <div
                            className="bg-foreground/55 absolute -bottom-0.5 -top-0.5 w-[2px]"
                            style={{ left: `${coastPct}%` }}
                            title={t("goals:dashboard.milestone.coast_fire")}
                          />
                        )}
                    </div>
                    <div className="text-muted-foreground mt-1 flex justify-between text-[10px]">
                      <span className="tabular-nums">
                        {t("goals:dashboard.progress.funded_pct", {
                          pct: (progress * 100).toFixed(1),
                        })}
                      </span>
                      {!isTraditionalMode && (
                        <span className="tabular-nums">
                          ▲ {L.coast} {formatCompactAmount(coastAmountDisplay, currency)}
                        </span>
                      )}
                    </div>
                  </div>

                  {!isTraditionalMode &&
                    heroGuidance &&
                    !isFinanciallyIndependent &&
                    yearsFromDesired == null && (
                      <p
                        className={`mt-4 border-t pt-4 text-xs ${
                          heroHealth === "on_track"
                            ? "text-green-700 dark:text-green-300"
                            : heroHealth === "at_risk"
                              ? "text-amber-700 dark:text-amber-300"
                              : "text-red-600 dark:text-red-300"
                        }`}
                      >
                        {heroGuidance}
                      </p>
                    )}
                </CardContent>
              </Card>
            );
          })()}

          {/* Retirement projection chart */}
          {chartData.length > 2 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
                  <div>
                    <div className="text-muted-foreground mb-0.5 text-[10px] font-semibold uppercase tracking-wider">
                      {t("goals:dashboard.chart.projection_age_range", {
                        start: plan.personal.currentAge,
                        end: plan.personal.planningHorizonAge,
                      })}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <CardTitle className="text-sm">
                        {t("goals:dashboard.chart.portfolio_trajectory")}
                      </CardTitle>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
                            aria-label={t("goals:dashboard.chart.portfolio_trajectory_aria")}
                          >
                            <Icons.Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm text-xs">
                          {isTraditionalMode
                            ? t("goals:dashboard.chart.trajectory_tip_traditional")
                            : t("goals:dashboard.chart.trajectory_tip_fire")}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="block h-0 w-4 border-b-[2px]"
                        style={{
                          borderColor:
                            readiness.tone === "good"
                              ? PROJECTED_CHART_COLORS.onTrack.stroke
                              : PROJECTED_CHART_COLORS.offTrack.stroke,
                        }}
                      />
                      {t("goals:dashboard.chart.projected")}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex cursor-help items-center gap-1.5 underline decoration-dotted underline-offset-2">
                          <svg viewBox="0 0 24 4" aria-hidden="true" className="h-1 w-6 shrink-0">
                            <line
                              x1="1"
                              y1="2"
                              x2="23"
                              y2="2"
                              stroke={CHART_COLORS.reference}
                              strokeWidth="1.5"
                              strokeDasharray="6 4"
                              strokeLinecap="round"
                            />
                          </svg>
                          {t("goals:dashboard.chart.required")}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs">
                        {isTraditionalMode
                          ? t("goals:dashboard.chart.required_tip_traditional")
                          : t("goals:dashboard.chart.required_tip_fire")}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-2 sm:px-6">
                <RetirementChart
                  data={chartData}
                  currency={currency}
                  retirementAge={plan.personal.targetRetirementAge}
                  projectedFireAge={effectiveFiAge}
                  valueMode={chartValueMode}
                  plannerMode={plannerMode}
                  projectedIsOnTrack={readiness.tone === "good"}
                />
              </CardContent>
            </Card>
          )}

          {/* Milestone strip — Coast FIRE / Lean FIRE / FI / Fat FIRE */}
          {plannerMode === "fire" && targetAtGoalDisplay > 0 && (
            <Card className="p-0">
              <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-4 sm:divide-y-0">
                {[
                  {
                    key: "coast",
                    label: L.coast,
                    value: coastAmountDisplay,
                    hint: t("goals:dashboard.milestone.coast_hint"),
                    tip:
                      chartValueMode === "nominal"
                        ? t("goals:dashboard.milestone.coast_tip_nominal")
                        : t("goals:dashboard.milestone.coast_tip_real"),
                  },
                  {
                    key: "lean",
                    label: t("goals:dashboard.milestone.lean_fire"),
                    value: targetAtGoalDisplay * 0.7,
                    hint: t("goals:dashboard.milestone.lean_hint"),
                    tip: t("goals:dashboard.milestone.lean_tip"),
                  },
                  {
                    key: "fi",
                    label: t("goals:dashboard.milestone.fi"),
                    value: targetAtGoalDisplay,
                    hint: t("goals:dashboard.milestone.fi_hint"),
                    tip: t("goals:dashboard.milestone.fi_tip"),
                  },
                  {
                    key: "fat",
                    label: t("goals:dashboard.milestone.fat_fire"),
                    value: targetAtGoalDisplay * 1.5,
                    hint: t("goals:dashboard.milestone.fat_hint"),
                    tip: t("goals:dashboard.milestone.fat_tip"),
                  },
                ].map((m) => {
                  const pct = m.value > 0 ? Math.min(1, milestonePortfolioDisplay / m.value) : 0;
                  const reached = milestonePortfolioDisplay >= m.value && m.value > 0;
                  return (
                    <div key={m.key} className="p-4">
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                          {m.label}
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="text-muted-foreground/70 hover:text-foreground inline-flex rounded-full transition-colors"
                              aria-label={t("goals:dashboard.milestone.more_info_about", {
                                label: m.label,
                              })}
                            >
                              <Icons.Info className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-xs">{m.tip}</TooltipContent>
                        </Tooltip>
                        {reached && (
                          <Badge
                            variant="default"
                            className="h-[14px] bg-green-600 px-1.5 text-[9px] font-semibold tracking-wider hover:bg-green-600"
                          >
                            {t("goals:dashboard.milestone.done")}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[17px] font-semibold tabular-nums tracking-tight">
                        {formatCompactAmount(m.value, currency)}
                      </div>
                      <div className="bg-muted/60 mt-2 h-[3px] overflow-hidden rounded-sm">
                        <div
                          className={`h-full transition-[width] duration-500 ${reached ? "bg-green-600" : "bg-success"}`}
                          style={{ width: `${pct * 100}%`, opacity: 0.85 }}
                        />
                      </div>
                      <div className="text-muted-foreground mt-1.5 text-[10.5px]">{m.hint}</div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Retirement spending coverage */}
          <Card>
            <CardHeader className="relative pb-4 sm:pr-56">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <Icons.CreditCard className="text-muted-foreground h-3.5 w-3.5" />
                  <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.15em]">
                    {t("goals:dashboard.coverage.kicker")}
                  </div>
                </div>
                <CardTitle className="text-[17px] font-semibold leading-none tracking-tight">
                  {L.budgetAt}
                </CardTitle>
                <div className="mt-2 flex items-start gap-1.5">
                  <p className="text-muted-foreground max-w-4xl text-sm leading-relaxed">
                    {coverageView === "at-retirement" ? (
                      <>
                        {t("goals:dashboard.coverage.snapshot_prefix", { age: fireAgeForBudget })}{" "}
                        <span className="text-foreground tabular-nums">
                          {t("goals:dashboard.coverage.amount_per_mo", {
                            amount: formatCompactAmount(coverageSpendingMonthly, currency),
                          })}
                        </span>{" "}
                        {t("goals:dashboard.coverage.snapshot_suffix")}
                      </>
                    ) : (
                      <>{t("goals:dashboard.coverage.over_time_desc")}</>
                    )}
                  </p>
                  {coverageView === "over-time" && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground mt-0.5 rounded-full transition-colors"
                          aria-label={t("goals:dashboard.coverage.chart_details_aria")}
                        >
                          <Icons.Info className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs">
                        {t("goals:dashboard.coverage.over_time_tip", {
                          valueLabel: valueModeLabel,
                        })}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
              <AnimatedToggleGroup<CoverageView>
                value={coverageView}
                onValueChange={setCoverageView}
                items={[
                  { value: "at-retirement", label: t("goals:dashboard.coverage.at_retirement") },
                  { value: "over-time", label: t("goals:dashboard.coverage.over_time") },
                ]}
                size="xs"
                rounded="md"
                className="bg-muted/30 mt-4 w-fit border sm:absolute sm:right-5 sm:top-5 sm:mt-0"
              />
            </CardHeader>
            <CardContent className="space-y-3.5">
              {coverageView === "at-retirement" ? (
                <>
                  <div className="text-foreground/90 text-[13px]">
                    {t("goals:dashboard.coverage.at_age_dash", { age: fireAgeForBudget })}{" "}
                    <span className="text-foreground font-semibold tabular-nums">
                      {t("goals:dashboard.coverage.amount_per_mo", {
                        amount: formatCompactAmount(coverageSpendingMonthly, currency),
                      })}
                    </span>{" "}
                    {t("goals:dashboard.coverage.planned_spending")}
                  </div>

                  {/* Split bar — income streams + portfolio + shortfall */}
                  <div className="bg-muted/60 relative flex h-2.5 w-full overflow-hidden rounded-full border">
                    {budgetStreams.map((s, i) => {
                      const pct = Math.min(100, Math.max(0, s.percentageOfBudget * 100));
                      if (pct <= 0) return null;
                      return (
                        <div
                          key={s.label}
                          className="h-full transition-[width] duration-500"
                          style={{
                            width: `${pct}%`,
                            background: INCOME_STREAM_COLORS[i % INCOME_STREAM_COLORS.length],
                          }}
                          title={t("goals:dashboard.coverage.stream_title", {
                            label: s.label,
                            pct: pct.toFixed(0),
                          })}
                        />
                      );
                    })}
                    {coveragePortfolioPct > 0 && (
                      <div
                        className="bg-success h-full transition-[width] duration-500"
                        style={{ width: `${coveragePortfolioPct}%` }}
                        title={t("goals:dashboard.coverage.portfolio_withdrawal_title", {
                          pct: coveragePortfolioPct.toFixed(0),
                        })}
                      />
                    )}
                    {coverageShortfallPct > 0 && (
                      <div
                        className="h-full bg-red-500/75 transition-[width] duration-500"
                        style={{ width: `${coverageShortfallPct}%` }}
                        title={t("goals:dashboard.coverage.unfunded_title", {
                          pct: coverageShortfallPct.toFixed(0),
                        })}
                      />
                    )}
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    {budgetStreams.length > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 rounded-sm"
                          style={{ background: COVERAGE_COLORS.income }}
                        />
                        {t("goals:dashboard.coverage.income_pct", {
                          pct: coverageIncomePct.toFixed(0),
                        })}
                      </span>
                    )}
                    {coveragePortfolioPct > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="bg-success inline-block h-2 w-2 rounded-sm" />
                        {t("goals:dashboard.coverage.portfolio_pct", {
                          pct: coveragePortfolioPct.toFixed(0),
                        })}
                      </span>
                    )}
                    {coverageShortfallPct > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-sm bg-red-500/75" />
                        {t("goals:dashboard.coverage.unfunded_pct", {
                          pct: coverageShortfallPct.toFixed(0),
                        })}
                      </span>
                    )}
                    {budgetStreams.length === 0 && nextIncomeStartAge !== null && (
                      <span>
                        {t("goals:dashboard.coverage.no_income_active", {
                          age: fireAgeForBudget,
                          nextAge: nextIncomeStartAge,
                        })}
                      </span>
                    )}
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    {/* Expense breakdown — no color dots */}
                    <div className="min-w-0">
                      <div className="text-muted-foreground mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]">
                        {t("goals:dashboard.coverage.spending_schedule")}
                      </div>
                      <div className="divide-border divide-y">
                        {coverageExpenseItems.map((r) => {
                          const isActive = isExpenseActiveAtAge(r, fireAgeForBudget);
                          const status = coverageTimingLabel(
                            isActive,
                            r.startAge,
                            r.endAge,
                            fireAgeForBudget,
                          );
                          return (
                            <div
                              key={r.id}
                              className="flex items-center justify-between gap-3 py-1.5 text-[13px]"
                            >
                              <span className="min-w-0">
                                <span className="text-foreground block truncate font-medium">
                                  {r.label}
                                </span>
                                <span className="text-muted-foreground block truncate text-[11px]">
                                  {expenseAgeRangeLabel(r, plan.personal.planningHorizonAge)}
                                  {status ? ` · ${status}` : ""}
                                </span>
                              </span>
                              <span className="text-foreground shrink-0 tabular-nums">
                                {t("goals:dashboard.coverage.amount_per_mo", {
                                  amount: formatCompactAmount(r.monthlyAmount, currency),
                                })}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Income schedule + current-age funding sources */}
                    <div className="min-w-0 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
                      <div className="text-muted-foreground mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em]">
                        {t("goals:dashboard.coverage.income_schedule")}
                      </div>
                      <div className="space-y-1.5">
                        {coverageIncomeStreams.length === 0 && (
                          <div className="text-muted-foreground py-1 text-[12px]">
                            {t("goals:dashboard.coverage.no_income_configured")}
                          </div>
                        )}
                        {coverageIncomeStreams.map((s, i) => {
                          const isActive = isIncomeActiveAtAge(s, fireAgeForBudget);
                          const matchedBudgetStream = budgetStreams.find(
                            (stream) => stream.label === s.label,
                          );
                          const monthlyAmount =
                            isActive && matchedBudgetStream
                              ? matchedBudgetStream.monthlyAmount
                              : incomeStreamMonthlyAmount(plan, s);
                          const status = coverageTimingLabel(
                            isActive,
                            s.startAge,
                            undefined,
                            fireAgeForBudget,
                          );

                          return (
                            <div
                              key={s.id}
                              className="flex items-center justify-between gap-3 text-[13px]"
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span
                                  className="inline-block h-2 w-2 shrink-0 rounded-sm"
                                  style={{
                                    background:
                                      INCOME_STREAM_COLORS[i % INCOME_STREAM_COLORS.length],
                                  }}
                                />
                                <span className="min-w-0">
                                  <span className="text-foreground block truncate font-medium">
                                    {s.label}
                                  </span>
                                  <span className="text-muted-foreground block truncate text-[11px]">
                                    {incomeAgeRangeLabel(s, plan.personal.planningHorizonAge)}
                                    {status ? ` · ${status}` : ""}
                                  </span>
                                </span>
                              </span>
                              <span className="text-foreground shrink-0 tabular-nums">
                                {t("goals:dashboard.coverage.amount_per_mo", {
                                  amount: formatCompactAmount(monthlyAmount, currency),
                                })}{" "}
                                {isActive && matchedBudgetStream ? (
                                  <span className="text-muted-foreground ml-1 text-[11px]">
                                    {(matchedBudgetStream.percentageOfBudget * 100).toFixed(0)}%
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          );
                        })}
                        {(coveragePortfolioAppliedMonthly > 0 ||
                          coverageShortfallMonthly > 0 ||
                          coverageEstimatedTaxesMonthly > 0) && (
                          <div className="border-border mt-2 flex items-center justify-between gap-3 border-t pt-2">
                            <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.14em]">
                              {t("goals:dashboard.coverage.funding_at_age", {
                                age: fireAgeForBudget,
                              })}
                            </div>
                            {coveragePortfolioDrawRate != null && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors"
                                  >
                                    {t("goals:dashboard.coverage.draw_on_portfolio")}{" "}
                                    <span className="text-foreground tabular-nums">
                                      {t("goals:dashboard.coverage.draw_rate_per_yr", {
                                        pct: (coveragePortfolioDrawRate * 100).toFixed(1),
                                      })}
                                    </span>
                                    <Icons.Info className="size-3" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-xs">
                                  {t("goals:dashboard.coverage.draw_rate_tip")}
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        )}
                        {coveragePortfolioAppliedMonthly > 0 && (
                          <div className="flex items-center justify-between gap-3 text-[13px]">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="bg-success inline-block h-2 w-2 shrink-0 rounded-sm" />
                              <span className="text-foreground truncate font-medium">
                                {t("goals:dashboard.coverage.portfolio_withdrawal")}
                              </span>
                            </span>
                            <span className="text-foreground shrink-0 tabular-nums">
                              {t("goals:dashboard.coverage.amount_per_mo", {
                                amount: formatCompactAmount(
                                  coveragePortfolioAppliedMonthly,
                                  currency,
                                ),
                              })}{" "}
                              <span className="text-muted-foreground ml-1 text-[11px]">
                                {coveragePortfolioPct.toFixed(0)}%
                              </span>
                            </span>
                          </div>
                        )}
                        {coverageShortfallMonthly > 0 && (
                          <div className="flex items-center justify-between gap-3 text-[13px]">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-sm bg-red-500/75" />
                              <span className="text-foreground truncate font-medium">
                                {t("goals:dashboard.coverage.unfunded_spending")}
                              </span>
                            </span>
                            <span className="text-foreground shrink-0 tabular-nums">
                              {t("goals:dashboard.coverage.amount_per_mo", {
                                amount: formatCompactAmount(coverageShortfallMonthly, currency),
                              })}{" "}
                              <span className="text-muted-foreground ml-1 text-[11px]">
                                {coverageShortfallPct.toFixed(0)}%
                              </span>
                            </span>
                          </div>
                        )}
                        {coverageEstimatedTaxesMonthly > 0 && (
                          <div className="text-muted-foreground flex items-center justify-between gap-3 pt-1 text-[11px] italic">
                            <span>{t("goals:dashboard.coverage.withdrawal_taxes")}</span>
                            <span className="tabular-nums">
                              +
                              {t("goals:dashboard.coverage.amount_per_mo", {
                                amount: formatCompactAmount(
                                  coverageEstimatedTaxesMonthly,
                                  currency,
                                ),
                              })}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ) : coverageProjectionData.length > 1 ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-sm"
                          style={{ background: COVERAGE_COLORS.income }}
                        />
                        {t("goals:dashboard.coverage.retirement_income")}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-sm"
                          style={{ background: COVERAGE_COLORS.portfolio }}
                        />
                        {t("goals:dashboard.coverage.portfolio_withdrawal")}
                      </span>
                      {coverageProjectionData.some((pt) => pt.shortfall > 0) && (
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-sm"
                            style={{ background: COVERAGE_COLORS.shortfall }}
                          />
                          {t("goals:dashboard.coverage.unfunded")}
                        </span>
                      )}
                      <span className="flex items-center gap-1.5">
                        <span
                          className="block h-0 w-4 border-b border-dashed"
                          style={{ borderColor: COVERAGE_COLORS.planned }}
                        />
                        {t("goals:dashboard.coverage.planned_spending_legend")}
                      </span>
                    </div>
                    <span className="bg-muted/60 text-muted-foreground rounded-full px-2.5 py-1 text-[11px] font-medium">
                      {t("goals:dashboard.coverage.showing", { valueLabel: valueModeLabel })}
                    </span>
                  </div>

                  <RetirementCoverageChart
                    data={coverageProjectionData}
                    ticks={coverageProjectionTicks}
                    currency={currency}
                    valueMode={chartValueMode}
                    fireAgeForBudget={fireAgeForBudget}
                    referenceLabelPrefix={L.prefix}
                  />
                </div>
              ) : (
                <div className="text-muted-foreground rounded-md border border-dashed py-8 text-center text-sm">
                  {t("goals:dashboard.coverage.projection_unavailable")}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Year-by-Year Snapshot — in main column with pagination */}
          <RetirementSnapshotTable
            snapshots={allSnapshots}
            hasPensionFunds={hasPensionFunds}
            incomeStartAges={incomeStartAges}
            fiAge={fiAge}
            phaseLabel={L.prefix}
            currency={currency}
            scaleForModeAtAge={scaleForModeAtAge}
          />

          <Card className="bg-muted/30 border-dashed">
            <CardContent className="text-muted-foreground flex gap-3 py-5 text-xs leading-relaxed">
              <Icons.Info className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-1.5">
                <p className="text-foreground font-medium">
                  {t("goals:dashboard.disclaimer.title")}
                </p>
                <p>{t("goals:dashboard.disclaimer.body")}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Sidebar ── */}
        <div className="space-y-4 lg:col-span-1 lg:self-start">
          <SidebarConfigurator
            key={sidebarKey}
            plan={plan}
            currency={currency}
            plannerMode={plannerMode}
            onSavePlan={onSavePlan}
            retirementOverview={retirementOverview}
            goalId={goalId}
            dcLinkedAccountIds={dcLinkedAccountIds}
          />
        </div>
      </div>

      {portfolioNow === 0 && (
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            {t("goals:dashboard.no_portfolio_data")}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
