import {
  runRetirementDecisionSensitivityMap,
  runRetirementMonteCarlo,
  runRetirementSorr,
  runRetirementStressTests,
} from "@/adapters";
import type { RetirementOverview } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  formatAmount,
  formatCompactAmount,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { RiskLabSkeleton, StressCardSkeleton } from "../components/risk-lab-skeleton";
import {
  TooltipContent,
  TooltipTrigger,
  Tooltip as UiTooltip,
} from "@wealthfolio/ui/components/ui/tooltip";
import type { CSSProperties } from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  DecisionSensitivityCell,
  DecisionSensitivityMatrix,
  MonteCarloResult,
  RetirementPlan,
  SorrScenario,
  StressSeverity,
  StressTestResult,
} from "../types";

type PlannerMode = "fire" | "traditional";

interface Props {
  plan: RetirementPlan;
  totalValue: number;
  isLoading: boolean;
  retirementOverview?: RetirementOverview;
  plannerMode?: PlannerMode;
  goalId?: string;
}

const CHART = {
  portfolio: "hsl(38, 75%, 50%)",
  portfolioSoft: "hsla(38, 75%, 50%, 0.16)",
  income: "var(--fi-stream-1)",
  risk: "hsl(8, 67%, 48%)",
  muted: "var(--muted-foreground)",
  grid: "var(--border)",
  success: "var(--success)",
  fan: "color-mix(in srgb, var(--success) 22%, transparent)",
  reference: "color-mix(in srgb, var(--muted-foreground) 70%, transparent)",
};

function fmt(value: number, currency: string) {
  return formatAmount(value, currency);
}

function pct(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function moneyLastsDefinition(t: TFunction, plannerMode: PlannerMode, horizonAge: number) {
  if (plannerMode === "traditional") {
    return t("goals:risk_lab.results.money_lasts_definition_traditional", { horizonAge });
  }

  return t("goals:risk_lab.results.money_lasts_definition_fire", { horizonAge });
}

function moneyLastsSummary(t: TFunction, plannerMode: PlannerMode, horizonAge: number) {
  if (plannerMode === "traditional") {
    return t("goals:risk_lab.results.money_lasts_summary_traditional", { horizonAge });
  }

  return t("goals:risk_lab.results.money_lasts_summary_fire", { horizonAge });
}

function moneyLastsPrompt(t: TFunction, plannerMode: PlannerMode, horizonAge: number) {
  if (plannerMode === "traditional") {
    return t("goals:risk_lab.results.money_lasts_prompt_traditional", { horizonAge });
  }

  return t("goals:risk_lab.results.money_lasts_prompt_fire", { horizonAge });
}

function severityRank(severity: StressSeverity) {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function stableSeed(parts: unknown[]) {
  const input = JSON.stringify(parts);
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function errorMessage(t: TFunction, error: unknown) {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  return t("goals:risk_lab.errors.unknown");
}

function topStress(stresses?: StressTestResult[]) {
  return [...(stresses ?? [])].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      b.delta.shortfallAtGoalAge - a.delta.shortfallAtGoalAge ||
      Math.abs(b.delta.portfolioAtHorizon) - Math.abs(a.delta.portfolioAtHorizon),
  )[0];
}

function InlineAmountTooltip({
  value,
  currency,
  label,
  baseline,
  stressed,
  delta,
  tone = "default",
}: {
  value: number;
  currency: string;
  label: string;
  baseline: number;
  stressed: number;
  delta: number;
  tone?: "default" | "shortfall";
}) {
  const { t } = useTranslation();
  return (
    <UiTooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "cursor-help font-medium tabular-nums underline decoration-dotted underline-offset-4",
            tone === "shortfall" ? "text-amber-600" : "text-foreground",
          )}
        >
          {formatCompactAmount(value, currency)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        <div className="text-[10px] font-semibold uppercase tracking-wider">{label}</div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
          <span className="text-muted-foreground">{t("goals:risk_lab.results.base_plan")}</span>
          <span className="text-right">{fmt(baseline, currency)}</span>
          <span className="text-muted-foreground">{t("goals:risk_lab.results.stress_test")}</span>
          <span className="text-right">{fmt(stressed, currency)}</span>
          <span className="text-muted-foreground">{t("goals:risk_lab.results.change")}</span>
          <span className={cn("text-right", delta < 0 ? "text-destructive" : "text-amber-600")}>
            {delta > 0 ? "+" : delta < 0 ? "-" : ""}
            {fmt(Math.abs(delta), currency)}
          </span>
        </div>
      </TooltipContent>
    </UiTooltip>
  );
}

function deterministicRiskContent(
  t: TFunction,
  stress: StressTestResult | undefined,
  currency: string,
  plannerMode: PlannerMode,
) {
  if (!stress) return t("goals:risk_lab.stress.loading_short");
  if (stress.severity === "low") {
    return t("goals:risk_lab.results.no_material_stress");
  }

  const horizonDrop = Math.max(0, -stress.delta.portfolioAtHorizon);
  const shortfallIncrease = Math.max(0, stress.delta.shortfallAtGoalAge);
  const fragments: React.ReactNode[] = [];
  if (horizonDrop > 0) {
    fragments.push(
      <>
        {t("goals:risk_lab.results.money_left_drops_by")}{" "}
        <InlineAmountTooltip
          value={horizonDrop}
          currency={currency}
          label={t("goals:risk_lab.results.money_left_at_end")}
          baseline={stress.baseline.portfolioAtHorizon}
          stressed={stress.stressed.portfolioAtHorizon}
          delta={stress.delta.portfolioAtHorizon}
        />
      </>,
    );
  }
  if (shortfallIncrease > 0) {
    fragments.push(
      <>
        {t("goals:risk_lab.results.retirement_gap_increases_by")}{" "}
        <InlineAmountTooltip
          value={shortfallIncrease}
          currency={currency}
          label={t("goals:risk_lab.results.retirement_gap")}
          baseline={stress.baseline.shortfallAtGoalAge}
          stressed={stress.stressed.shortfallAtGoalAge}
          delta={stress.delta.shortfallAtGoalAge}
          tone="shortfall"
        />
      </>,
    );
  }
  if (plannerMode === "fire" && stress.delta.fiAgeYears && stress.delta.fiAgeYears > 0) {
    fragments.push(
      <>
        {t("goals:risk_lab.results.fi_moves_prefix")}{" "}
        <span className="text-foreground font-medium tabular-nums">{stress.delta.fiAgeYears}</span>{" "}
        {t("goals:risk_lab.results.fi_moves_suffix")}
      </>,
    );
  }

  return (
    <>
      {t("goals:risk_lab.results.largest_risk", { label: stress.label })}
      {fragments.length ? ": " : "."}
      {fragments.map((fragment, index) => (
        <Fragment key={index}>
          {index > 0 ? ` ${t("goals:risk_lab.results.and")} ` : ""}
          {fragment}
        </Fragment>
      ))}
      {fragments.length ? "." : null}
    </>
  );
}

function baselineStatusCopy(
  t: TFunction,
  isFunded: boolean,
  fiAge: number | null,
  desiredAge: number,
) {
  if (isFunded) return t("goals:risk_lab.status.on_track");
  if (!fiAge) return t("goals:risk_lab.status.not_reachable");
  const years = fiAge - desiredAge;
  if (years <= 0) return t("goals:risk_lab.status.on_track");
  return t("goals:risk_lab.status.years_late", { count: years });
}

function retirementStatusCopy(t: TFunction, status?: string) {
  if (status === "depleted") return t("goals:risk_lab.status.projected_run_short");
  if (status === "shortfall") return t("goals:risk_lab.status.short_at_retirement");
  if (status === "overfunded") return t("goals:risk_lab.status.ahead_of_target");
  return t("goals:risk_lab.status.on_track");
}

function HeroMetric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  tone?: "default" | "good" | "bad";
}) {
  return (
    <div className="border-border/70 px-3 py-3 first:rounded-l-lg last:rounded-r-lg md:border-l md:first:border-l-0">
      <p className="text-muted-foreground text-[9px] font-semibold uppercase tracking-[0.18em]">
        {label}
      </p>
      <div
        className={cn(
          "mt-1.5 text-xl font-semibold leading-none tracking-tight",
          tone === "good" && "text-[hsl(102,32%,39%)]",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </div>
      <div className="text-muted-foreground mt-1.5 text-xs">{detail}</div>
    </div>
  );
}

function RefreshActionButton({
  onClick,
  disabled,
  loading,
  children,
  loadingText,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  children?: React.ReactNode;
  loadingText?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={disabled} className="gap-1.5">
      <Icons.RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
      {loading
        ? (loadingText ?? t("goals:risk_lab.actions.updating"))
        : (children ?? t("goals:risk_lab.actions.refresh"))}
    </Button>
  );
}

function PlanResilienceHero({
  plan,
  overview,
  stresses,
  stressLoading,
  mc,
  plannerMode = "fire",
}: {
  plan: RetirementPlan;
  overview?: RetirementOverview;
  stresses?: StressTestResult[];
  stressLoading: boolean;
  mc?: MonteCarloResult;
  plannerMode?: PlannerMode;
}) {
  const { t } = useTranslation();
  const currency = plan.currency;
  const isTraditional = plannerMode === "traditional";
  const desiredAge = overview?.desiredFireAge ?? plan.personal.targetRetirementAge;
  const fiAge = overview?.fiAge ?? null;
  const isFunded = overview?.fundedAtGoalAge ?? false;
  const status = isTraditional
    ? retirementStatusCopy(t, overview?.successStatus)
    : baselineStatusCopy(t, isFunded, fiAge, desiredAge);
  const topRisk = topStress(stresses);
  const risk = stressLoading
    ? t("goals:risk_lab.stress.loading_short")
    : deterministicRiskContent(t, topRisk, currency, plannerMode);
  const hasGap = (overview?.shortfallAtGoalAge ?? 0) > 0;
  const surplus = overview?.surplusAtGoalAge ?? 0;
  const gapLabel =
    !overview || !hasGap
      ? isTraditional && surplus > 0
        ? formatCompactAmount(surplus, currency)
        : t("goals:risk_lab.results.none")
      : formatCompactAmount(overview.shortfallAtGoalAge, currency);
  const gapDetail =
    !overview || !hasGap
      ? isTraditional && surplus > 0
        ? t("goals:risk_lab.results.surplus")
        : t("goals:risk_lab.results.funded")
      : t("goals:risk_lab.results.amount_gap", {
          amount: formatCompactAmount(overview.shortfallAtGoalAge, currency),
        });
  const fiDetail = fiAge
    ? fiAge <= desiredAge
      ? t("goals:risk_lab.results.on_target")
      : t("goals:risk_lab.status.years_late", { count: fiAge - desiredAge })
    : t("goals:risk_lab.results.not_reached");
  const isBaselineHealthy = isTraditional
    ? overview?.successStatus === "on_track" || overview?.successStatus === "overfunded"
    : isFunded;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardContent className="space-y-4 p-5 md:p-6">
        <div className="flex gap-4">
          <div
            className={cn(
              "mt-2 h-14 w-1.5 shrink-0 rounded-full",
              isBaselineHealthy ? "bg-[hsl(111,25%,48%)]" : "bg-destructive",
            )}
          />
          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-muted-foreground text-[9px] font-semibold uppercase tracking-[0.22em]">
                {t("goals:risk_lab.hero.base_case")}
              </p>
              <h2 className="mt-2 max-w-[95%] font-serif text-2xl font-normal leading-[1.15] tracking-tight">
                {t("goals:risk_lab.hero.your_base_plan_is")}{" "}
                <span
                  className={cn(
                    "whitespace-nowrap font-medium",
                    isBaselineHealthy ? "text-[hsl(111,25%,43%)]" : "text-destructive",
                  )}
                >
                  {status}
                </span>
                .
              </h2>
              <p className="text-muted-foreground mt-4 max-w-[620px] text-sm leading-relaxed">
                {risk}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-muted/25 grid overflow-hidden rounded-lg border md:grid-cols-4">
          <HeroMetric
            label={
              isTraditional
                ? t("goals:risk_lab.hero.retirement_age")
                : t("goals:risk_lab.hero.desired_age")
            }
            value={desiredAge}
            detail={t("goals:risk_lab.hero.your_goal")}
          />
          {isTraditional ? (
            <HeroMetric
              label={t("goals:risk_lab.hero.projected_balance")}
              value={overview ? formatCompactAmount(overview.portfolioAtGoalAge, currency) : "—"}
              detail={t("goals:risk_lab.hero.at_age", { age: desiredAge })}
              tone={isBaselineHealthy ? "good" : "bad"}
            />
          ) : (
            <HeroMetric
              label={t("goals:risk_lab.hero.base_fi_age")}
              value={fiAge ?? "—"}
              detail={fiDetail}
              tone={fiAge && fiAge <= desiredAge ? "good" : fiAge ? "bad" : "default"}
            />
          )}
          <HeroMetric
            label={
              isTraditional
                ? t("goals:risk_lab.hero.gap_surplus")
                : t("goals:risk_lab.hero.gap_at_target_age")
            }
            value={gapLabel}
            detail={gapDetail}
            tone={overview && !hasGap ? "good" : "bad"}
          />
          <HeroMetric
            label={t("goals:risk_lab.hero.money_lasts")}
            value={mc ? pct(mc.successRate) : "—"}
            detail={
              mc
                ? t("goals:risk_lab.hero.paths_count", { count: mc.nSimulations.toLocaleString() })
                : t("goals:risk_lab.hero.not_run")
            }
            tone={mc ? (mc.successRate >= 0.9 ? "good" : "bad") : "default"}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function compactDelta(value: number, currency: string) {
  if (Math.abs(value) < 1) return "—";
  const direction = value > 0 ? "↑" : "↓";
  const sign = value > 0 ? "+" : "-";
  return `${direction}${sign}${formatCompactAmount(Math.abs(value), currency)}`;
}

function fiAgeDeltaLabel(t: TFunction, stress: StressTestResult) {
  const delta = stress.delta.fiAgeYears;
  if (delta === null) return "—";
  if (delta === 0) return t("goals:risk_lab.results.unchanged");
  return delta > 0
    ? `↑+${t("goals:risk_lab.results.years_short", { count: delta })}`
    : `↓${t("goals:risk_lab.results.years_short", { count: Math.abs(delta) })}`;
}

function retirementOutcomeLabel(t: TFunction, outcome: StressTestResult["baseline"]) {
  if (outcome.failureAge)
    return t("goals:risk_lab.results.runs_short_at", { age: outcome.failureAge });
  if (outcome.spendingShortfallAge)
    return t("goals:risk_lab.results.gap_starts_at", { age: outcome.spendingShortfallAge });
  if (outcome.fundedAtGoalAge) return t("goals:risk_lab.results.funded");
  if (outcome.shortfallAtGoalAge > 0) return t("goals:risk_lab.results.gap");
  return t("goals:risk_lab.results.funded");
}

function severityBadgeClass(severity: StressSeverity) {
  if (severity === "high") return "bg-destructive/10 text-destructive";
  if (severity === "medium") return "bg-amber-500/15 text-amber-700";
  return "bg-muted text-muted-foreground";
}

function severityRailClass(severity: StressSeverity) {
  if (severity === "high") return "bg-destructive";
  if (severity === "medium") return "bg-amber-500";
  return "bg-border";
}

function impactTextClass(value: number, badWhenPositive = true) {
  if (Math.abs(value) < 1) return "text-foreground";
  const isBad = badWhenPositive ? value > 0 : value < 0;
  return isBad ? "text-destructive" : "text-[hsl(102,32%,39%)]";
}

function StressIcon({ id }: { id: StressTestResult["id"] }) {
  const className = "mt-0.5 size-3.5 shrink-0 text-muted-foreground";
  switch (id) {
    case "return-drag":
      return <Icons.TrendingDown className={className} />;
    case "inflation-shock":
      return <Icons.Percent className={className} />;
    case "spending-shock":
      return <Icons.Wallet className={className} />;
    case "retire-earlier":
      return <Icons.Calendar className={className} />;
    case "save-less":
      return <Icons.BadgeDollarSign className={className} />;
    case "early-crash":
      return <Icons.AlertTriangle className={className} />;
  }
}

function StressMetric({
  label,
  value,
  from,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  from: React.ReactNode;
  tone?: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.18em]">
        {label}
      </p>
      <p className={cn("mt-2 text-sm font-semibold tabular-nums", tone)}>{value}</p>
      <p className="text-muted-foreground mt-2 text-xs tabular-nums">
        {t("goals:risk_lab.results.from")} {from}
      </p>
    </div>
  );
}

function SimulationMetric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  tone?: "default" | "good" | "bad";
}) {
  return (
    <div className="border-border/70 px-4 py-4 first:border-l-0 md:border-l">
      <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.18em]">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 text-xl font-semibold tabular-nums leading-none",
          tone === "good" && "text-[hsl(102,32%,39%)]",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </p>
      <p className="text-muted-foreground mt-2 text-xs">{detail}</p>
    </div>
  );
}

function StressTestsSection({
  stresses,
  loading,
  refreshing,
  error,
  currency,
  onRun,
  plannerMode = "fire",
}: {
  stresses?: StressTestResult[];
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  currency: string;
  onRun: () => void;
  plannerMode?: PlannerMode;
}) {
  const { t } = useTranslation();
  const isTraditional = plannerMode === "traditional";
  const sorted = useMemo(
    () =>
      [...(stresses ?? [])].sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.delta.shortfallAtGoalAge - a.delta.shortfallAtGoalAge,
      ),
    [stresses],
  );
  const message = errorMessage(t, error);

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-muted-foreground/55 text-[10px] font-normal uppercase leading-none tracking-[0.24em]">
            {t("goals:risk_lab.stress.eyebrow_with_count", { count: sorted.length || 6 })}
          </p>
          <h2 className="mt-2 font-serif text-[23px] font-normal leading-[1.05] tracking-[-0.02em]">
            {t("goals:risk_lab.stress.heading")}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {sorted.length > 0 && (
            <RefreshActionButton onClick={onRun} disabled={refreshing} loading={refreshing} />
          )}
        </div>
      </div>

      {message && <p className="text-destructive py-2 text-sm">{message}</p>}

      {loading && (
        <div className="space-y-3">
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Icons.Spinner className="size-3 animate-spin" />
            {t("goals:risk_lab.stress.running")}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <StressCardSkeleton key={index} />
            ))}
          </div>
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {sorted.map((stress) => (
            <div
              key={stress.id}
              className="bg-card relative overflow-hidden rounded-xl border shadow-sm"
            >
              <div
                className={cn(
                  "absolute inset-y-5 left-0 w-0.5 rounded-r-full",
                  severityRailClass(stress.severity),
                )}
              />
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StressIcon id={stress.id} />
                      <h3 className="text-base font-semibold leading-none">{stress.label}</h3>
                    </div>
                    <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">
                      {stress.description}
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "rounded-full px-3 text-[10px] font-semibold uppercase tracking-[0.14em]",
                      severityBadgeClass(stress.severity),
                    )}
                  >
                    {t(`goals:risk_lab.severity.${stress.severity}`)}
                  </Badge>
                </div>

                <div className="mt-5 border-t pt-4">
                  <div className="grid grid-cols-3 gap-4">
                    <StressMetric
                      label={
                        isTraditional
                          ? t("goals:risk_lab.stress.outcome")
                          : t("goals:risk_lab.stress.fi_age")
                      }
                      value={
                        isTraditional
                          ? retirementOutcomeLabel(t, stress.stressed)
                          : fiAgeDeltaLabel(t, stress)
                      }
                      from={
                        isTraditional
                          ? retirementOutcomeLabel(t, stress.baseline)
                          : (stress.baseline.fiAge ?? "—")
                      }
                      tone={
                        (
                          isTraditional
                            ? stress.stressed.shortfallAtGoalAge >
                                stress.baseline.shortfallAtGoalAge ||
                              Boolean(stress.stressed.failureAge) ||
                              Boolean(stress.stressed.spendingShortfallAge)
                            : stress.delta.fiAgeYears && stress.delta.fiAgeYears > 0
                        )
                          ? "text-destructive"
                          : undefined
                      }
                    />
                    <StressMetric
                      label={t("goals:risk_lab.stress.extra_gap")}
                      value={compactDelta(stress.delta.shortfallAtGoalAge, currency)}
                      from={formatCompactAmount(stress.baseline.shortfallAtGoalAge, currency)}
                      tone={impactTextClass(stress.delta.shortfallAtGoalAge)}
                    />
                    <StressMetric
                      label={t("goals:risk_lab.stress.money_left")}
                      value={compactDelta(stress.delta.portfolioAtHorizon, currency)}
                      from={formatCompactAmount(stress.baseline.portfolioAtHorizon, currency)}
                      tone={impactTextClass(stress.delta.portfolioAtHorizon, false)}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MonteCarloTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: { payload?: MonteCarloChartPoint }[];
  label?: string | number;
  currency: string;
}) {
  const { t } = useTranslation();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="bg-popover rounded-lg border p-3 text-xs shadow-sm">
      <p className="font-semibold">{t("goals:risk_lab.chart.age_label", { age: label })}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">P90</span>
        <span className="text-right tabular-nums">{fmt(point.p90, currency)}</span>
        <span className="text-muted-foreground">P75</span>
        <span className="text-right tabular-nums">{fmt(point.p75, currency)}</span>
        <span className="text-muted-foreground">P50</span>
        <span className="text-right tabular-nums">{fmt(point.p50, currency)}</span>
        <span className="text-muted-foreground">P25</span>
        <span className="text-right tabular-nums">{fmt(point.p25, currency)}</span>
        <span className="text-muted-foreground">P10</span>
        <span className="text-right tabular-nums">{fmt(point.p10, currency)}</span>
      </div>
    </div>
  );
}

interface MonteCarloChartPoint {
  age: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p10Base: number;
  p10ToP90: number;
}

interface ReferenceCaptionProps {
  viewBox?: {
    x?: number;
    y?: number;
  };
  value: string;
  fill: string;
  side: "left" | "right";
}

function ReferenceCaption({ viewBox, value, fill, side }: ReferenceCaptionProps) {
  const x = typeof viewBox?.x === "number" ? viewBox.x : 0;
  const y = typeof viewBox?.y === "number" ? viewBox.y : 0;
  const gap = side === "left" ? -12 : 12;

  return (
    <text
      x={x + gap}
      y={y + 12}
      textAnchor={side === "left" ? "end" : "start"}
      fill={fill}
      fontSize={11}
      fontWeight={600}
    >
      {value}
    </text>
  );
}

function MonteCarloFanChart({
  result,
  currency,
  desiredAge,
  showMedianFiLine = true,
  goalLabel = "goal",
}: {
  result: MonteCarloResult;
  currency: string;
  desiredAge: number;
  showMedianFiLine?: boolean;
  goalLabel?: string;
}) {
  const { t } = useTranslation();
  const chartData = useMemo(
    () =>
      result.ageAxis.map((age, index) => {
        const p10 = result.percentiles.p10[index] ?? 0;
        const p25 = result.percentiles.p25[index] ?? p10;
        const p50 = result.percentiles.p50[index] ?? p10;
        const p75 = result.percentiles.p75[index] ?? p50;
        const p90 = result.percentiles.p90[index] ?? p50;
        return {
          age,
          p10,
          p25,
          p50,
          p75,
          p90,
          p10Base: p10,
          p10ToP90: Math.max(0, p90 - p10),
        };
      }),
    [result.ageAxis, result.percentiles],
  );

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={chartData} margin={{ top: 18, right: 28, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
        <XAxis
          dataKey="age"
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART.muted, fontSize: 12 }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART.muted, fontSize: 12 }}
          tickFormatter={(value) => formatCompactAmount(Number(value), currency)}
        />
        <Tooltip content={<MonteCarloTooltip currency={currency} />} />
        <Area
          dataKey="p10Base"
          stackId="fan"
          stroke="none"
          fill="transparent"
          isAnimationActive={false}
        />
        <Area dataKey="p10ToP90" stackId="fan" stroke="none" fill={CHART.fan} />
        <Line dataKey="p50" stroke={CHART.success} strokeWidth={2.25} dot={false} />
        <ReferenceLine
          x={desiredAge}
          stroke={CHART.reference}
          strokeDasharray="3 3"
          strokeWidth={1.4}
          label={(props) => (
            <ReferenceCaption
              {...props}
              value={t("goals:risk_lab.chart.goal_at_age", { label: goalLabel, age: desiredAge })}
              fill={CHART.reference}
              side="left"
            />
          )}
        />
        {showMedianFiLine && result.medianFireAge && result.medianFireAge !== desiredAge && (
          <ReferenceLine
            x={result.medianFireAge}
            stroke={CHART.success}
            strokeDasharray="3 3"
            strokeWidth={1.4}
            label={(props) => (
              <ReferenceCaption
                {...props}
                value={t("goals:risk_lab.chart.median_fi_at_age", { age: result.medianFireAge })}
                fill={CHART.success}
                side="right"
              />
            )}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function MonteCarloDistributionSection({
  plan,
  result,
  running,
  error,
  onRun,
  activeSims,
  plannerMode = "fire",
}: {
  plan: RetirementPlan;
  result?: MonteCarloResult;
  running: boolean;
  error: unknown;
  onRun: (nSims: number) => void;
  activeSims: number;
  plannerMode?: PlannerMode;
}) {
  const { t } = useTranslation();
  const message = errorMessage(t, error);
  const desiredAge = plan.personal.targetRetirementAge;
  const isTraditional = plannerMode === "traditional";
  const moneyLastsCopy = moneyLastsDefinition(t, plannerMode, plan.personal.planningHorizonAge);
  const moneyLastsDetail = moneyLastsSummary(t, plannerMode, plan.personal.planningHorizonAge);
  const moneyLastsCta = moneyLastsPrompt(t, plannerMode, plan.personal.planningHorizonAge);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b p-0">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-start md:justify-between md:p-6">
          <div className="min-w-0 flex-1">
            <p className="text-muted-foreground/60 text-[10px] font-normal uppercase leading-none tracking-[0.24em]">
              {t("goals:risk_lab.montecarlo.eyebrow")}
            </p>
            <CardTitle className="mt-2 font-serif text-[23px] font-normal leading-[1.05] tracking-[-0.02em]">
              {t("goals:risk_lab.montecarlo.heading")}
            </CardTitle>
            <p className="text-muted-foreground mt-4 max-w-[900px] text-sm leading-relaxed">
              {t("goals:risk_lab.montecarlo.intro")} {moneyLastsCopy}
            </p>
          </div>
          {result && (
            <div className="flex shrink-0 gap-2">
              <RefreshActionButton
                onClick={() => onRun(10_000)}
                disabled={running}
                loading={running && activeSims === 10_000}
                loadingText={t("goals:risk_lab.montecarlo.running_short")}
              >
                {t("goals:risk_lab.montecarlo.run_10k")}
              </RefreshActionButton>
              <RefreshActionButton
                onClick={() => onRun(100_000)}
                disabled={running}
                loading={running && activeSims === 100_000}
                loadingText={t("goals:risk_lab.montecarlo.running_short")}
              >
                {t("goals:risk_lab.montecarlo.run_100k")}
              </RefreshActionButton>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-0 p-0">
        {message && <p className="text-destructive text-sm">{message}</p>}
        {running && (
          <div className="bg-muted/20 m-5 rounded-xl border md:m-6">
            <div className="flex min-h-44 flex-col items-center justify-center px-5 py-8 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-[hsl(91,34%,29%)]/10 text-[hsl(91,34%,29%)]">
                <Icons.Spinner className="size-5 animate-spin" />
              </span>
              <p className="mt-4 text-sm font-semibold">
                {t("goals:risk_lab.montecarlo.running_title")}
              </p>
              <p className="text-muted-foreground mt-1 max-w-md text-sm leading-relaxed">
                {t("goals:risk_lab.montecarlo.running_detail")}
              </p>
            </div>
          </div>
        )}
        {!running && !result && (
          <div className="m-5 rounded-xl bg-[hsl(88,45%,84%)] px-4 py-4 text-[hsl(91,31%,24%)] md:m-6 md:px-5">
            <div className="flex flex-col gap-4 text-center md:flex-row md:items-center md:justify-between md:text-left">
              <div>
                <p className="text-sm font-semibold">{t("goals:risk_lab.montecarlo.no_run_yet")}</p>
                <p className="mt-1 max-w-4xl text-sm leading-relaxed text-[hsl(91,22%,32%)]">
                  {moneyLastsCta}
                </p>
              </div>
              <div className="flex shrink-0 justify-center gap-2">
                <Button
                  size="sm"
                  onClick={() => onRun(10_000)}
                  disabled={running}
                  className="bg-[hsl(91,34%,29%)] text-white hover:bg-[hsl(91,34%,24%)]"
                >
                  <Icons.Sparkles className="mr-2 size-3.5" />
                  {running && activeSims === 10_000
                    ? t("goals:risk_lab.montecarlo.running_short")
                    : t("goals:risk_lab.montecarlo.run_10k")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRun(100_000)}
                  disabled={running}
                  className="text-[hsl(91,31%,24%)] hover:bg-[hsl(91,34%,29%)]/10"
                >
                  {running && activeSims === 100_000
                    ? t("goals:risk_lab.montecarlo.running_short")
                    : t("goals:risk_lab.montecarlo.run_100k")}
                </Button>
              </div>
            </div>
          </div>
        )}
        {result && (
          <>
            <div className="bg-muted/10 grid border-b md:grid-cols-5">
              <SimulationMetric
                label={t("goals:risk_lab.montecarlo.money_lasts")}
                value={pct(result.successRate)}
                detail={moneyLastsDetail}
                tone={result.successRate >= 0.9 ? "good" : "bad"}
              />
              <SimulationMetric
                label={
                  isTraditional
                    ? t("goals:risk_lab.montecarlo.withdrawals_start")
                    : t("goals:risk_lab.montecarlo.median_fi_age")
                }
                value={isTraditional ? desiredAge : (result.medianFireAge ?? "—")}
                detail={
                  isTraditional
                    ? t("goals:risk_lab.montecarlo.withdrawals_start_detail")
                    : t("goals:risk_lab.montecarlo.vs_goal", { age: desiredAge })
                }
              />
              <SimulationMetric
                label={t("goals:risk_lab.montecarlo.bad_path")}
                value={formatCompactAmount(result.finalPortfolioAtHorizon.p10, plan.currency)}
                detail={t("goals:risk_lab.chart.age_detail", {
                  age: plan.personal.planningHorizonAge,
                })}
                tone={result.finalPortfolioAtHorizon.p10 > 0 ? "default" : "bad"}
              />
              <SimulationMetric
                label={t("goals:risk_lab.montecarlo.middle_path")}
                value={formatCompactAmount(result.finalPortfolioAtHorizon.p50, plan.currency)}
                detail={t("goals:risk_lab.chart.age_detail", {
                  age: plan.personal.planningHorizonAge,
                })}
              />
              <SimulationMetric
                label={t("goals:risk_lab.montecarlo.good_path")}
                value={formatCompactAmount(result.finalPortfolioAtHorizon.p90, plan.currency)}
                detail={t("goals:risk_lab.chart.age_detail", {
                  age: plan.personal.planningHorizonAge,
                })}
                tone="good"
              />
            </div>
            <div className="p-5 pt-3 md:p-6 md:pt-4">
              <MonteCarloFanChart
                result={result}
                currency={plan.currency}
                desiredAge={desiredAge}
                showMedianFiLine={!isTraditional}
                goalLabel={
                  isTraditional ? t("goals:risk_lab.chart.retire") : t("goals:risk_lab.chart.goal")
                }
              />
              <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-5 text-sm">
                <span className="flex items-center gap-2">
                  <span className="size-3 rounded-sm" style={{ backgroundColor: CHART.fan }} />
                  {t("goals:risk_lab.chart.bad_good_range")}
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-0.5 w-6" style={{ backgroundColor: CHART.success }} />
                  {t("goals:risk_lab.chart.median_path")}
                </span>
                <span className="flex items-center gap-2">
                  <span className="border-muted-foreground h-0 w-6 border-t border-dashed" />
                  {isTraditional
                    ? t("goals:risk_lab.chart.retirement_age")
                    : t("goals:risk_lab.chart.goal_age")}
                </span>
                {!isTraditional && result.medianFireAge && result.medianFireAge !== desiredAge && (
                  <span className="flex items-center gap-2">
                    <span
                      className="h-0 w-6 border-t border-dashed"
                      style={{ borderColor: CHART.success }}
                    />
                    {t("goals:risk_lab.chart.median_fi_age")}
                  </span>
                )}
                <span className="ml-auto italic">
                  {t("goals:risk_lab.chart.market_paths_count", {
                    count: result.nSimulations.toLocaleString(),
                  })}
                </span>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function axisMoney(value: number, currency: string) {
  return formatCompactAmount(value, currency).replace(".0", "");
}

function SensitivityMatrixCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-[15px] leading-tight sm:text-base">{title}</CardTitle>
          <p className="text-muted-foreground max-w-[34rem] text-xs leading-snug sm:text-sm">
            {subtitle}
          </p>
        </div>
      </CardHeader>
      {children}
    </Card>
  );
}

function matrixBaselineCell(matrix: DecisionSensitivityMatrix) {
  if (matrix.baselineRow == null || matrix.baselineColumn == null) return null;
  return matrix.cells[matrix.baselineRow]?.[matrix.baselineColumn] ?? null;
}

function matrixDeltaRange(matrix: DecisionSensitivityMatrix) {
  const baseline = matrixBaselineCell(matrix);
  const baselinePortfolio = displayMetricBucket(baseline?.portfolioAtHorizon ?? 0);
  const deltas = matrix.cells
    .flat()
    .map((cell) => displayMetricBucket(cell.portfolioAtHorizon) - baselinePortfolio)
    .filter(Number.isFinite);
  return {
    baselinePortfolio,
    maxGain: Math.max(...deltas, 1),
    maxLoss: Math.max(...deltas.map((value) => Math.abs(Math.min(value, 0))), 1),
  };
}

function displayMetricBucket(value: number) {
  const abs = Math.abs(value);
  const scale = abs >= 1_000_000 ? 10_000 : abs >= 100_000 ? 1_000 : abs >= 1_000 ? 100 : 1;
  return Math.round(value / scale) * scale;
}

function logStrength(value: number, max: number) {
  if (value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(Math.max(1, max)));
}

function tint(color: "success" | "warning" | "destructive", strength: number) {
  const token =
    color === "success" ? "--success" : color === "warning" ? "--warning" : "--destructive";
  const mix = 5 + Math.max(0, Math.min(1, strength)) * 11;
  return `color-mix(in srgb, var(${token}) ${mix}%, var(--card))`;
}

function neutralRamp(lightStart: number, lightEnd: number, strength: number) {
  const lightness = lightStart - (lightStart - lightEnd) * Math.max(0, Math.min(1, strength));
  return `hsl(70 8% ${lightness}%)`;
}

function isFlatColumn(matrix: DecisionSensitivityMatrix, column: number) {
  if (matrix.baselineColumn == null || column === matrix.baselineColumn) return false;
  return matrix.cells.every((row, rowIndex) => {
    const cell = row[column];
    const baseline = matrix.cells[rowIndex]?.[matrix.baselineColumn!];
    if (!cell || !baseline) return false;
    return (
      Math.abs(cell.portfolioAtHorizon - baseline.portfolioAtHorizon) < 1 &&
      Math.abs(cell.shortfallAtGoalAge - baseline.shortfallAtGoalAge) < 1 &&
      cell.fiAge === baseline.fiAge
    );
  });
}

function sensitivityCellStyle({
  cell,
  baseline,
  range,
  active,
}: {
  cell: DecisionSensitivityCell;
  baseline: DecisionSensitivityCell | null;
  range: ReturnType<typeof matrixDeltaRange>;
  active: boolean;
}): CSSProperties {
  if (active) {
    return {
      backgroundColor: "var(--card)",
      color: "var(--foreground)",
    };
  }

  if (cell.shortfallAtGoalAge > 1 || cell.portfolioAtHorizon <= 0) {
    return {
      backgroundColor: tint("destructive", 0.55),
      color: "var(--foreground)",
    };
  }

  const baselinePortfolio = displayMetricBucket(
    baseline?.portfolioAtHorizon ?? range.baselinePortfolio,
  );
  const delta = displayMetricBucket(cell.portfolioAtHorizon) - baselinePortfolio;

  if (delta === 0) {
    return {
      backgroundColor: neutralRamp(93, 89, 0.25),
      color: "var(--foreground)",
    };
  }

  if (delta > 0) {
    const strength = logStrength(delta, range.maxGain);
    return {
      backgroundColor: tint("success", strength),
      color: "var(--foreground)",
    };
  }

  const strength = logStrength(Math.abs(delta), range.maxLoss);
  return {
    backgroundColor: tint("warning", strength),
    color: "var(--foreground)",
  };
}

function decisionCellLabel(t: TFunction, cell: DecisionSensitivityCell, currency: string) {
  if (cell.shortfallAtGoalAge > 1) {
    return `-${formatCompactAmount(cell.shortfallAtGoalAge, currency)}`;
  }
  if (cell.portfolioAtHorizon <= 0) {
    return t("goals:risk_lab.results.runs_short");
  }
  return formatCompactAmount(cell.portfolioAtHorizon, currency);
}

function DecisionHeatmap({
  matrix,
  currency,
  formatRow,
  formatColumn,
  flatColumnHint,
  ageMetricLabel,
}: {
  matrix: DecisionSensitivityMatrix;
  currency: string;
  formatRow: (value: number, label: string) => string;
  formatColumn: (value: number, label: string) => string;
  flatColumnHint?: string;
  ageMetricLabel: string;
}) {
  const { t } = useTranslation();
  const range = useMemo(() => matrixDeltaRange(matrix), [matrix]);
  const baseline = useMemo(() => matrixBaselineCell(matrix), [matrix]);

  return (
    <div className="overflow-x-auto px-3 pb-4 pt-4 sm:px-5 sm:pb-5 sm:pt-5">
      <table className="w-full min-w-[480px] table-fixed border-separate border-spacing-[2px] text-xs sm:min-w-[540px] sm:border-spacing-[3px] sm:text-sm">
        <thead>
          <tr>
            <th className="w-14 sm:w-16" />
            {matrix.columnValues.map((value, column) => (
              <th
                key={`${value}-${column}`}
                className={cn(
                  "text-muted-foreground px-1 pb-2 text-center text-[11px] font-semibold tabular-nums sm:px-2 sm:pb-2.5 sm:text-[13px]",
                  column === matrix.baselineColumn && "text-foreground",
                )}
              >
                {flatColumnHint && isFlatColumn(matrix, column) ? (
                  <UiTooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dotted underline-offset-4">
                        {formatColumn(value, matrix.columnLabels[column] ?? "")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs">{flatColumnHint}</TooltipContent>
                  </UiTooltip>
                ) : (
                  formatColumn(value, matrix.columnLabels[column] ?? "")
                )}
              </th>
            ))}
            <th className="w-3 sm:w-4" />
          </tr>
        </thead>
        <tbody>
          {matrix.rowValues.map((rowValue, row) => (
            <tr key={`${rowValue}-${row}`}>
              <td
                className={cn(
                  "text-muted-foreground pr-2 text-right text-[11px] font-semibold tabular-nums sm:pr-3 sm:text-[13px]",
                  row === matrix.baselineRow && "text-foreground",
                )}
              >
                {formatRow(rowValue, matrix.rowLabels[row] ?? "")}
              </td>
              {matrix.columnValues.map((columnValue, column) => {
                const cell = matrix.cells[row]?.[column];
                if (!cell) return <td key={`${columnValue}-${column}`} />;
                const active = row === matrix.baselineRow && column === matrix.baselineColumn;
                return (
                  <td key={`${columnValue}-${column}`}>
                    <UiTooltip>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            "flex h-12 items-center justify-center rounded-[6px] px-2 text-center text-xs font-semibold tabular-nums leading-none transition-shadow sm:h-[52px] sm:px-3 sm:text-[13px]",
                            active && "ring-2 ring-[hsl(91,34%,29%)] ring-offset-0",
                          )}
                          style={sensitivityCellStyle({ cell, baseline, range, active })}
                        >
                          {decisionCellLabel(t, cell, currency)}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-xs">
                        <div className="text-[10px] font-semibold uppercase tracking-wider">
                          {matrix.rowLabel} × {matrix.columnLabel}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
                          <span className="text-muted-foreground">{matrix.rowLabel}</span>
                          <span className="text-right">
                            {formatRow(rowValue, matrix.rowLabels[row] ?? "")}
                          </span>
                          <span className="text-muted-foreground">{matrix.columnLabel}</span>
                          <span className="text-right">
                            {formatColumn(columnValue, matrix.columnLabels[column] ?? "")}
                          </span>
                          <span className="text-muted-foreground">
                            {t("goals:risk_lab.results.money_left_at_end")}
                          </span>
                          <span className="text-right">
                            {fmt(cell.portfolioAtHorizon, currency)}
                          </span>
                          <span className="text-muted-foreground">
                            {t("goals:risk_lab.results.change_vs_base_plan")}
                          </span>
                          <span
                            className={cn(
                              "text-right",
                              cell.portfolioAtHorizon > range.baselinePortfolio
                                ? "text-success"
                                : cell.portfolioAtHorizon < range.baselinePortfolio
                                  ? "text-muted-foreground"
                                  : "",
                            )}
                          >
                            {cell.portfolioAtHorizon >= range.baselinePortfolio ? "+" : "-"}
                            {fmt(
                              Math.abs(cell.portfolioAtHorizon - range.baselinePortfolio),
                              currency,
                            )}
                          </span>
                          <span className="text-muted-foreground">{ageMetricLabel}</span>
                          <span className="text-right">
                            {cell.fiAge ?? t("goals:risk_lab.results.not_reached")}
                          </span>
                          <span className="text-muted-foreground">
                            {t("goals:risk_lab.results.shortfall_at_retirement")}
                          </span>
                          <span className="text-right">
                            {fmt(cell.shortfallAtGoalAge, currency)}
                          </span>
                        </div>
                      </TooltipContent>
                    </UiTooltip>
                  </td>
                );
              })}
              {row === 0 && (
                <td rowSpan={matrix.rowValues.length} className="w-3 p-0 align-middle sm:w-4">
                  <span
                    className="text-muted-foreground/80 mx-auto block whitespace-nowrap text-center text-[11px] font-normal leading-none sm:text-xs"
                    style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                  >
                    {matrix.rowLabel}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th className="w-14 sm:w-16" />
            <th
              colSpan={matrix.columnValues.length}
              className="text-muted-foreground/80 px-1 pt-1.5 text-center text-[11px] font-normal leading-none sm:text-xs"
            >
              {matrix.columnLabel}
            </th>
            <th className="w-3 sm:w-4" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function WhatMovesThePlanSection({
  contributionReturn,
  retirementAgeSpending,
  contributionLoading,
  spendingLoading,
  error,
  onRun,
  plan,
  plannerMode = "fire",
}: {
  contributionReturn?: DecisionSensitivityMatrix;
  retirementAgeSpending?: DecisionSensitivityMatrix;
  contributionLoading: boolean;
  spendingLoading: boolean;
  error: unknown;
  onRun: () => void;
  plan: RetirementPlan;
  plannerMode?: PlannerMode;
}) {
  const { t } = useTranslation();
  const message = errorMessage(t, error);
  const isFireMode = plannerMode !== "traditional";
  const loading = contributionLoading || spendingLoading;
  const hasAnyMap = Boolean(contributionReturn || retirementAgeSpending);
  const showMaps = hasAnyMap || loading;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-muted-foreground/55 text-[10px] font-normal uppercase leading-none tracking-[0.24em]">
            {t("goals:risk_lab.moves.eyebrow")}
          </p>
          <h2 className="mt-2 font-serif text-[23px] font-normal leading-[1.05] tracking-[-0.02em]">
            {t("goals:risk_lab.moves.heading")}
          </h2>
          <p className="text-muted-foreground mt-2 max-w-4xl text-sm leading-relaxed xl:whitespace-nowrap">
            {t("goals:risk_lab.moves.description")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {showMaps && <RefreshActionButton onClick={onRun} disabled={loading} loading={loading} />}
        </div>
      </div>

      {message && <p className="text-destructive text-sm">{message}</p>}
      {!showMaps && (
        <div className="bg-muted/10 rounded-xl border border-dashed p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold">{t("goals:risk_lab.moves.empty_title")}</p>
              <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
                {t("goals:risk_lab.moves.empty_description")}
              </p>
            </div>
            <Button size="sm" onClick={onRun} disabled={loading}>
              <Icons.Sparkles className="mr-2 size-3.5" />
              {loading ? t("goals:risk_lab.moves.building") : t("goals:risk_lab.moves.build_maps")}
            </Button>
          </div>
        </div>
      )}
      {showMaps && (
        <div className="grid gap-3 lg:grid-cols-2">
          {contributionReturn ? (
            <SensitivityMatrixCard
              title={t("goals:risk_lab.moves.contribution_return")}
              subtitle={t("goals:risk_lab.moves.money_left_subtitle")}
            >
              <DecisionHeatmap
                matrix={contributionReturn}
                currency={plan.currency}
                formatRow={(value, label) => label || `${(value * 100).toFixed(1)}%`}
                formatColumn={(value) => axisMoney(value, plan.currency)}
                ageMetricLabel={
                  isFireMode
                    ? t("goals:risk_lab.moves.fi_age")
                    : t("goals:risk_lab.moves.readiness_age")
                }
              />
            </SensitivityMatrixCard>
          ) : (
            <SensitivityLoadingCard
              title={t("goals:risk_lab.moves.contribution_return")}
              description={t("goals:risk_lab.moves.contribution_return_loading")}
            />
          )}

          {retirementAgeSpending ? (
            <SensitivityMatrixCard
              title={
                isFireMode
                  ? t("goals:risk_lab.moves.desired_age_spending")
                  : t("goals:risk_lab.moves.retirement_age_spending")
              }
              subtitle={t("goals:risk_lab.moves.money_left_subtitle")}
            >
              <DecisionHeatmap
                matrix={retirementAgeSpending}
                currency={plan.currency}
                formatRow={(value) => axisMoney(value, plan.currency)}
                formatColumn={(value, label) => label || String(Math.round(value))}
                ageMetricLabel={
                  isFireMode
                    ? t("goals:risk_lab.moves.fi_age")
                    : t("goals:risk_lab.moves.readiness_age")
                }
                flatColumnHint={isFireMode ? t("goals:risk_lab.moves.flat_column_hint") : undefined}
              />
            </SensitivityMatrixCard>
          ) : (
            <SensitivityLoadingCard
              title={
                isFireMode
                  ? t("goals:risk_lab.moves.desired_age_spending")
                  : t("goals:risk_lab.moves.retirement_age_spending")
              }
              description={t("goals:risk_lab.moves.retirement_age_spending_loading")}
            />
          )}
        </div>
      )}
    </section>
  );
}

function SensitivityLoadingCard({ title, description }: { title: string; description: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          </div>
          <Icons.Spinner className="text-muted-foreground mt-1 size-4 animate-spin" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-5">
        <div className="grid grid-cols-5 gap-1.5">
          {Array.from({ length: 25 }).map((_, index) => (
            <div
              key={index}
              className="bg-muted/50 h-10 animate-pulse rounded-md"
              style={{ animationDelay: `${(index % 5) * 45}ms` }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
function SorrTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: {
    name?: string | number;
    value?: number | string;
    color?: string;
  }[];
  label?: string | number;
  currency: string;
}) {
  const { t } = useTranslation();
  const visiblePayload = payload?.filter((entry) => entry.value != null) ?? [];
  if (!active || visiblePayload.length === 0) return null;

  return (
    <div className="bg-popover min-w-56 rounded-lg border p-3 text-xs shadow-sm">
      <p className="font-semibold">{t("goals:risk_lab.chart.age_label", { age: label })}</p>
      <div className="mt-2 space-y-1.5">
        {visiblePayload.map((entry) => (
          <div
            key={String(entry.name)}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-2 tabular-nums"
          >
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: entry.color ?? CHART.muted }}
            />
            <span className="text-muted-foreground truncate">{entry.name}</span>
            <span className="font-medium">{fmt(Number(entry.value ?? 0), currency)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SorrChart({
  scenarios,
  currency,
  retirementStartAge,
}: {
  scenarios: SorrScenario[];
  currency: string;
  retirementStartAge: number;
}) {
  const maxLen = Math.max(...scenarios.map((scenario) => scenario.portfolioPath.length));
  const data = Array.from({ length: maxLen }, (_, index) => {
    const entry: Record<string, number> = { age: retirementStartAge + index };
    scenarios.forEach((scenario) => {
      entry[scenario.label] = scenario.portfolioPath[index] ?? 0;
    });
    return entry;
  });

  return (
    <ResponsiveContainer width="100%" height={210}>
      <LineChart data={data} margin={{ top: 12, right: 18, left: 18, bottom: 10 }}>
        <CartesianGrid
          vertical={false}
          stroke="hsl(var(--border))"
          strokeDasharray="3 3"
          opacity={0.55}
        />
        <XAxis
          dataKey="age"
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART.muted, fontSize: 12 }}
        />
        <YAxis
          width={54}
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHART.muted, fontSize: 12 }}
          tickFormatter={(value) => formatCompactAmount(Number(value), currency)}
        />
        <Tooltip
          content={<SorrTooltip currency={currency} />}
          cursor={{ stroke: "hsl(var(--border))", strokeDasharray: "3 3" }}
        />
        {scenarios.map((scenario, index) => (
          <Line
            key={scenario.label}
            dataKey={scenario.label}
            stroke={SORR_COLORS[index % SORR_COLORS.length]}
            dot={false}
            activeDot={{ r: 4, stroke: "hsl(var(--card))", strokeWidth: 2 }}
            strokeWidth={index === 0 ? 2.2 : 1.5}
            strokeDasharray={index === 0 ? undefined : "4 4"}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

const SORR_COLORS = [
  "hsl(91,34%,29%)",
  "hsl(8,55%,45%)",
  "hsl(38,65%,43%)",
  "hsl(191,24%,42%)",
  "hsl(50,4%,45%)",
];

function sorrRiskAge(scenario: SorrScenario) {
  return scenario.failureAge ?? scenario.spendingShortfallAge ?? null;
}

function sorrOutcomeText(t: TFunction, scenario: SorrScenario, currency: string) {
  if (scenario.survived) {
    return formatCompactAmount(scenario.finalValue, currency);
  }

  const riskAge = sorrRiskAge(scenario);
  return riskAge
    ? t("goals:risk_lab.advanced.runs_short_age", { age: riskAge })
    : t("goals:risk_lab.results.runs_short");
}

function worstSorrScenario(scenarios: SorrScenario[]) {
  return [...scenarios].sort((a, b) => {
    const aRiskAge = sorrRiskAge(a) ?? Number.POSITIVE_INFINITY;
    const bRiskAge = sorrRiskAge(b) ?? Number.POSITIVE_INFINITY;
    return aRiskAge - bRiskAge || a.finalValue - b.finalValue;
  })[0];
}

function AdvancedSection({
  plan,
  overview,
  sorrResult,
  sorrRunning,
  sorrError,
  onRunSorr,
}: {
  plan: RetirementPlan;
  overview?: RetirementOverview;
  sorrResult?: SorrScenario[];
  sorrRunning: boolean;
  sorrError: unknown;
  onRunSorr: () => void;
}) {
  const { t } = useTranslation();
  const retirementStartAge = overview?.retirementStartAge ?? plan.personal.targetRetirementAge;
  const canRunSorr = (overview?.portfolioAtRetirementStart ?? 0) > 0;
  const baseCase = sorrResult?.find((scenario) => scenario.label === "Base case");
  const hardestPath = sorrResult ? worstSorrScenario(sorrResult) : undefined;
  const hardestPathRiskAge = hardestPath ? sorrRiskAge(hardestPath) : null;
  const survivingPaths = sorrResult?.filter((scenario) => scenario.survived).length ?? 0;

  return (
    <details className="bg-card group overflow-hidden rounded-xl border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icons.ChevronDown className="text-muted-foreground mt-3 size-3.5 transition-transform group-open:rotate-180" />
          <div className="min-w-0">
            <p className="text-muted-foreground/60 text-[10px] font-normal uppercase leading-none tracking-[0.24em]">
              {t("goals:risk_lab.advanced.eyebrow")}
            </p>
            <h2 className="mt-1.5 text-lg font-semibold tracking-[-0.01em]">
              {t("goals:risk_lab.advanced.heading")}
            </h2>
          </div>
        </div>
        {canRunSorr && (
          <div
            className="shrink-0"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <RefreshActionButton
              onClick={onRunSorr}
              disabled={sorrRunning}
              loading={sorrRunning}
              loadingText={t("goals:risk_lab.advanced.running_short")}
            >
              {sorrResult
                ? t("goals:risk_lab.actions.refresh")
                : t("goals:risk_lab.advanced.run_paths")}
            </RefreshActionButton>
          </div>
        )}
      </summary>
      <div className="border-t p-5">
        {errorMessage(t, sorrError) && (
          <p className="text-destructive mb-4 text-sm">{errorMessage(t, sorrError)}</p>
        )}
        {sorrResult ? (
          <>
            <p className="text-muted-foreground mb-3 text-sm">
              {t("goals:risk_lab.advanced.intro")}
            </p>
            <div className="bg-muted/10 grid gap-3 border-y px-4 py-3 text-sm sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.16em]">
                  {t("goals:risk_lab.advanced.earliest_shortfall")}
                </p>
                <p className="mt-1 font-semibold tabular-nums">
                  {hardestPath && hardestPathRiskAge
                    ? `${hardestPath.label} @ ${hardestPathRiskAge}`
                    : t("goals:risk_lab.results.none")}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.16em]">
                  {t("goals:risk_lab.advanced.paths_survive")}
                </p>
                <p className="mt-1 font-semibold tabular-nums">
                  {survivingPaths}/{sorrResult.length}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.16em]">
                  {t("goals:risk_lab.advanced.base_case")}
                </p>
                <p className="mt-1 font-semibold tabular-nums">
                  {baseCase ? sorrOutcomeText(t, baseCase, plan.currency) : "—"}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <SorrChart
                scenarios={sorrResult}
                currency={plan.currency}
                retirementStartAge={retirementStartAge}
              />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
              {sorrResult.map((scenario, index) => (
                <div
                  key={scenario.label}
                  className="bg-background/70 flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs tabular-nums"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: SORR_COLORS[index % SORR_COLORS.length] }}
                    />
                    <span className="text-muted-foreground truncate">{scenario.label}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-semibold",
                      scenario.survived ? "text-[hsl(102,32%,39%)]" : "text-destructive",
                    )}
                  >
                    {sorrOutcomeText(t, scenario, plan.currency)}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="bg-muted/10 rounded-xl border border-dashed px-5 py-6">
            <div className="flex flex-col gap-4 text-center md:flex-row md:items-center md:justify-between md:text-left">
              <div>
                <p className="text-sm font-semibold">
                  {canRunSorr
                    ? t("goals:risk_lab.advanced.empty_title")
                    : t("goals:risk_lab.advanced.unavailable_title")}
                </p>
                <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
                  {canRunSorr
                    ? t("goals:risk_lab.advanced.empty_description")
                    : t("goals:risk_lab.advanced.unavailable_description")}
                </p>
              </div>
              {canRunSorr && (
                <Button size="sm" onClick={onRunSorr} disabled={sorrRunning} className="shrink-0">
                  {sorrRunning ? (
                    <Icons.Spinner className="mr-2 size-3.5 animate-spin" />
                  ) : (
                    <Icons.RefreshCw className="mr-2 size-3.5" />
                  )}
                  {sorrRunning
                    ? t("goals:risk_lab.advanced.running_short")
                    : t("goals:risk_lab.advanced.run_paths")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function useRiskLabQueries({
  plan,
  totalValue,
  isLoading,
  retirementOverview,
  plannerMode,
  goalId,
}: Props) {
  const portfolioNow = retirementOverview?.portfolioNow ?? totalValue;
  const portfolioAtRetirementStart = retirementOverview?.portfolioAtRetirementStart ?? portfolioNow;
  const retirementStartAge =
    retirementOverview?.retirementStartAge ?? plan.personal.targetRetirementAge;
  const planKey = useMemo(() => JSON.stringify(plan), [plan]);
  const canRunRiskLab = !isLoading && (!goalId || Boolean(retirementOverview));
  const [monteCarloSims, setMonteCarloSims] = useState(5_000);
  const autoMapsKeyRef = useRef<string | null>(null);

  const stressQuery = useQuery({
    queryKey: ["retirement-risk-lab-stress", goalId, plannerMode, planKey, portfolioNow],
    queryFn: () => runRetirementStressTests(plan, portfolioNow, plannerMode, goalId),
    enabled: canRunRiskLab,
    staleTime: 5 * 60 * 1000,
  });

  const contributionSensitivityQuery = useQuery({
    queryKey: [
      "retirement-risk-lab-decision-sensitivity-map",
      "contribution-return",
      goalId,
      plannerMode,
      planKey,
      portfolioNow,
    ],
    queryFn: () =>
      runRetirementDecisionSensitivityMap(
        plan,
        portfolioNow,
        "contribution-return",
        plannerMode,
        goalId,
      ),
    enabled: false,
    staleTime: 5 * 60 * 1000,
  });

  const spendingSensitivityQuery = useQuery({
    queryKey: [
      "retirement-risk-lab-decision-sensitivity-map",
      "retirement-age-spending",
      goalId,
      plannerMode,
      planKey,
      portfolioNow,
    ],
    queryFn: () =>
      runRetirementDecisionSensitivityMap(
        plan,
        portfolioNow,
        "retirement-age-spending",
        plannerMode,
        goalId,
      ),
    enabled: false,
    staleTime: 5 * 60 * 1000,
  });

  const monteCarlo = useQuery({
    queryKey: [
      "retirement-risk-lab-market-paths",
      goalId,
      plannerMode,
      planKey,
      portfolioNow,
      monteCarloSims,
    ],
    queryFn: () =>
      runRetirementMonteCarlo(
        plan,
        portfolioNow,
        monteCarloSims,
        plannerMode,
        goalId,
        stableSeed([planKey, portfolioNow, plannerMode, goalId, monteCarloSims]),
      ),
    enabled: canRunRiskLab,
    staleTime: 5 * 60 * 1000,
  });

  const sorr = useQuery({
    queryKey: [
      "retirement-risk-lab-early-crash-paths",
      goalId,
      planKey,
      portfolioAtRetirementStart,
      retirementStartAge,
    ],
    queryFn: () => runRetirementSorr(plan, portfolioAtRetirementStart, retirementStartAge, goalId),
    enabled: false,
    staleTime: 5 * 60 * 1000,
  });
  const refetchMonteCarlo = monteCarlo.refetch;
  const refetchContributionSensitivity = contributionSensitivityQuery.refetch;
  const refetchSpendingSensitivity = spendingSensitivityQuery.refetch;
  const refetchSorr = sorr.refetch;

  const runMonteCarlo = useCallback(
    (nSims: number) => {
      if (!canRunRiskLab) return;
      if (nSims === monteCarloSims) {
        void refetchMonteCarlo();
        return;
      }
      setMonteCarloSims(nSims);
    },
    [canRunRiskLab, monteCarloSims, refetchMonteCarlo],
  );

  const runSensitivityMaps = useCallback(() => {
    if (!canRunRiskLab) return;
    void refetchContributionSensitivity();
    void refetchSpendingSensitivity();
  }, [canRunRiskLab, refetchContributionSensitivity, refetchSpendingSensitivity]);

  const runSorr = useCallback(() => {
    if (!canRunRiskLab || portfolioAtRetirementStart <= 0) return;
    void refetchSorr();
  }, [canRunRiskLab, portfolioAtRetirementStart, refetchSorr]);

  const autoMapsKey = useMemo(
    () => JSON.stringify([goalId, plannerMode, planKey, portfolioNow]),
    [goalId, plannerMode, planKey, portfolioNow],
  );
  const mapsAlreadyStarted =
    Boolean(contributionSensitivityQuery.data) ||
    Boolean(spendingSensitivityQuery.data) ||
    contributionSensitivityQuery.isFetching ||
    spendingSensitivityQuery.isFetching ||
    Boolean(contributionSensitivityQuery.error) ||
    Boolean(spendingSensitivityQuery.error);
  const readyToBuildMaps =
    canRunRiskLab &&
    stressQuery.isSuccess &&
    monteCarlo.isSuccess &&
    !stressQuery.isFetching &&
    !monteCarlo.isFetching &&
    !mapsAlreadyStarted;

  useEffect(() => {
    if (!readyToBuildMaps || autoMapsKeyRef.current === autoMapsKey) return;

    const timeout = setTimeout(() => {
      autoMapsKeyRef.current = autoMapsKey;
      runSensitivityMaps();
    }, 600);

    return () => clearTimeout(timeout);
  }, [autoMapsKey, readyToBuildMaps, runSensitivityMaps]);

  return {
    canRunRiskLab,
    stressQuery,
    contributionSensitivityQuery,
    spendingSensitivityQuery,
    monteCarlo,
    sorr,
    monteCarloSims,
    runMonteCarlo,
    runSensitivityMaps,
    runSorr,
  };
}

export default function RiskLabPage({
  plan,
  totalValue,
  isLoading,
  retirementOverview,
  plannerMode,
  goalId,
}: Props) {
  const {
    canRunRiskLab,
    stressQuery,
    contributionSensitivityQuery,
    spendingSensitivityQuery,
    monteCarlo,
    sorr,
    monteCarloSims,
    runMonteCarlo,
    runSensitivityMaps,
    runSorr,
  } = useRiskLabQueries({
    plan,
    totalValue,
    isLoading,
    retirementOverview,
    plannerMode,
    goalId,
  });

  if (!canRunRiskLab) {
    return <RiskLabSkeleton />;
  }

  return (
    <div className="space-y-12">
      <PlanResilienceHero
        plan={plan}
        overview={retirementOverview}
        stresses={stressQuery.data}
        stressLoading={stressQuery.isFetching}
        mc={monteCarlo.data}
        plannerMode={plannerMode}
      />

      <MonteCarloDistributionSection
        plan={plan}
        result={monteCarlo.data}
        running={monteCarlo.isFetching}
        error={monteCarlo.error}
        onRun={runMonteCarlo}
        activeSims={monteCarloSims}
        plannerMode={plannerMode}
      />

      <StressTestsSection
        stresses={stressQuery.data}
        loading={stressQuery.isLoading}
        refreshing={stressQuery.isFetching}
        error={stressQuery.error}
        currency={plan.currency}
        onRun={() => {
          void stressQuery.refetch();
        }}
        plannerMode={plannerMode}
      />

      <WhatMovesThePlanSection
        contributionReturn={contributionSensitivityQuery.data}
        retirementAgeSpending={spendingSensitivityQuery.data}
        contributionLoading={contributionSensitivityQuery.isFetching}
        spendingLoading={spendingSensitivityQuery.isFetching}
        error={contributionSensitivityQuery.error ?? spendingSensitivityQuery.error}
        onRun={runSensitivityMaps}
        plan={plan}
        plannerMode={plannerMode}
      />

      <AdvancedSection
        plan={plan}
        overview={retirementOverview}
        sorrResult={sorr.data}
        sorrRunning={sorr.isFetching}
        sorrError={sorr.error}
        onRunSorr={runSorr}
      />
    </div>
  );
}
