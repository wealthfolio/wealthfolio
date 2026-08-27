import { DEFAULT_DC_PAYOUT_ESTIMATE_RATE } from "./constants";
import { activeExpenseItems } from "./expense-items";
import type { RetirementIncomeStream, RetirementPlan } from "../types";

export type PlannerMode = "fire" | "traditional";

export function modeLabel(mode: PlannerMode) {
  return {
    target: mode === "fire" ? "FIRE Target" : "Retirement Target",
    targetNet: mode === "fire" ? "FIRE Target (net)" : "Retirement Target (net)",
    estAge: mode === "fire" ? "Projected FI Age" : "Target Retirement Age",
    progress: mode === "fire" ? "FIRE Progress" : "Retirement Progress",
    coast: "Coast FIRE",
    budgetAt: "Retirement spending coverage",
    prefix: mode === "fire" ? "FIRE" : "Retirement",
    targetAge: mode === "fire" ? "Desired retirement age" : "Retirement age",
    horizonAge: mode === "fire" ? "Plan through age" : "Life expectancy",
  };
}

export function boundedInflationFactor(rate: number, years: number) {
  return Math.max(0.01, Math.pow(1 + rate, Math.max(0, years)));
}

/** Mirror of the engine's `net_annual_return`: the fee comes off the assumption. */
export function netAnnualReturn(grossReturn: number, annualFeeRate: number) {
  return Math.max(-0.99, grossReturn - annualFeeRate);
}

/**
 * Mirror of the engine's `plan_accumulation_return`, and the rate a fund with no
 * `accumulationReturn` of its own grows at. The plan's stated return is gross of
 * the investment fee everywhere the engine consumes it.
 */
export function planAccumulationReturn(plan: RetirementPlan) {
  return netAnnualReturn(
    plan.investment.preRetirementAnnualReturn,
    plan.investment.annualInvestmentFeeRate,
  );
}

/** Mirror of the engine's `plan_retirement_return`. */
export function planRetirementReturn(plan: RetirementPlan) {
  return netAnnualReturn(
    plan.investment.retirementAnnualReturn,
    plan.investment.annualInvestmentFeeRate,
  );
}

/**
 * The return a drawdown fund's remaining balance earns during its payout phase, and
 * the rate a fund with no `postPayoutReturn` of its own draws against. Showing the
 * gross assumption instead would make touching the control save a higher number than
 * the projection had been using.
 */
export function payoutPhaseReturn(
  stream: Pick<RetirementIncomeStream, "postPayoutReturn">,
  plan: RetirementPlan,
) {
  return stream.postPayoutReturn ?? planRetirementReturn(plan);
}

export function projectedAnnualExpenseNominalAtAge(plan: RetirementPlan, age: number) {
  const yearsFromNow = Math.max(0, age - plan.personal.currentAge);
  return activeExpenseItems(plan.expenses, age).reduce((sum, item) => {
    const rate = item.inflationRate ?? plan.investment.inflationRate;
    return sum + item.monthlyAmount * 12 * Math.pow(1 + rate, yearsFromNow);
  }, 0);
}

function projectedDcMonthlyPayout(
  stream: RetirementIncomeStream,
  currentAge: number,
  retirementAge: number,
  defaultAccumulationReturn: number,
) {
  const payoutRate = Math.max(0, stream.payoutRate ?? DEFAULT_DC_PAYOUT_ESTIMATE_RATE);
  if (stream.startAge <= currentAge) {
    const fallback = (Math.max(0, stream.currentValue ?? 0) * payoutRate) / 12;
    return Math.max(0, stream.monthlyAmount ?? fallback);
  }
  const totalYears = Math.max(0, stream.startAge - currentAge);
  const contribYears = Math.max(0, Math.min(stream.startAge, retirementAge) - currentAge);
  const growthOnlyYears = totalYears - contribYears;
  const r = stream.accumulationReturn ?? defaultAccumulationReturn;
  const initial = stream.currentValue ?? 0;
  const monthly = stream.monthlyContribution ?? 0;
  const fvLump = initial * Math.pow(1 + r, totalYears);
  const monthlyGrowth = Math.pow(Math.max(0.01, 1 + r), 1 / 12);
  const monthlyReturn = monthlyGrowth - 1;
  const annualContributionEndValue =
    Math.abs(monthlyReturn) <= 1e-9
      ? monthly * 12
      : (monthly * (Math.pow(monthlyGrowth, 12) - 1)) / monthlyReturn;
  const fvAnnuityAtStop =
    Math.abs(r) > 1e-9
      ? (annualContributionEndValue * (Math.pow(1 + r, contribYears) - 1)) / r
      : monthly * 12 * contribYears;
  const fvAnnuity = fvAnnuityAtStop * Math.pow(1 + r, growthOnlyYears);
  return ((fvLump + fvAnnuity) * payoutRate) / 12;
}

export function projectedAnnualIncomeNominalAtAge(
  plan: RetirementPlan,
  age: number,
  retirementAge: number,
) {
  const yearsFromNow = Math.max(0, age - plan.personal.currentAge);

  return plan.incomeStreams.reduce((sum, stream) => {
    if (age < stream.startAge) return sum;

    const growthYears =
      stream.streamType === "dc" && stream.payoutMode === "drawdown"
        ? Math.max(0, age - Math.max(stream.startAge, plan.personal.currentAge))
        : yearsFromNow;

    const baseMonthly =
      stream.streamType === "dc"
        ? projectedDcMonthlyPayout(
            stream,
            plan.personal.currentAge,
            retirementAge,
            planAccumulationReturn(plan),
          )
        : (stream.monthlyAmount ?? 0);
    const annual = baseMonthly * 12;

    if (stream.annualGrowthRate !== undefined) {
      return sum + annual * Math.pow(1 + stream.annualGrowthRate, growthYears);
    }
    if (stream.adjustForInflation) {
      return sum + annual * Math.pow(1 + plan.investment.inflationRate, growthYears);
    }
    return sum + annual;
  }, 0);
}

export function incomeStreamMonthlyAmount(plan: RetirementPlan, stream: RetirementIncomeStream) {
  if (stream.streamType === "dc") {
    return projectedDcMonthlyPayout(
      stream,
      plan.personal.currentAge,
      plan.personal.targetRetirementAge,
      planAccumulationReturn(plan),
    );
  }
  return stream.monthlyAmount ?? 0;
}

export function incomeAgeRangeLabel(stream: RetirementIncomeStream, horizonAge: number) {
  return `Age ${stream.startAge} → ${horizonAge}`;
}

export function isIncomeActiveAtAge(stream: RetirementIncomeStream, age: number) {
  return age >= stream.startAge;
}

export function coverageTimingLabel(
  isActive: boolean,
  startAge: number | undefined,
  endAge: number | undefined,
  age: number,
) {
  if (isActive) return null;
  if (startAge !== undefined && age < startAge) return `Starts at ${startAge}`;
  if (endAge !== undefined && age >= endAge) return `Ended at ${endAge}`;
  return "Not active";
}

interface CoverageSnapshotLike {
  phase?: string;
  plannedExpenses?: number;
  annualExpenses?: number;
  annualIncome?: number;
  netWithdrawalFromPortfolio?: number;
  grossWithdrawal?: number;
  annualTaxes?: number;
}

interface CoverageAnnualNominalValuesInput {
  snapshot?: CoverageSnapshotLike;
  totalMonthlyBudget: number;
  fallbackMonthlyIncome: number;
  effectiveTaxRate: number;
}

export interface CoverageAnnualNominalValues {
  annualSpendingNominal: number;
  annualIncomeNominal: number;
  annualPortfolioGapNominal: number;
  annualGrossWithdrawalNominal: number;
  annualEstimatedTaxesNominal: number;
}

export function resolveCoverageAnnualNominalValues({
  snapshot,
  totalMonthlyBudget,
  fallbackMonthlyIncome,
  effectiveTaxRate,
}: CoverageAnnualNominalValuesInput): CoverageAnnualNominalValues {
  const snapshotSpending =
    snapshot?.plannedExpenses ?? (snapshot?.phase === "fire" ? snapshot.annualExpenses : undefined);
  const snapshotIncome = snapshot?.phase === "fire" ? snapshot.annualIncome : undefined;
  const snapshotPortfolioGap =
    snapshot?.phase === "fire" ? snapshot.netWithdrawalFromPortfolio : undefined;
  const snapshotGrossWithdrawal = snapshot?.phase === "fire" ? snapshot.grossWithdrawal : undefined;
  const snapshotTaxes = snapshot?.phase === "fire" ? snapshot.annualTaxes : undefined;

  const annualSpendingNominal = snapshotSpending ?? totalMonthlyBudget * 12;
  const annualIncomeNominal = snapshotIncome ?? fallbackMonthlyIncome * 12;
  const annualPortfolioGapNominal =
    snapshotPortfolioGap ?? Math.max(0, annualSpendingNominal - annualIncomeNominal);
  const annualGrossWithdrawalNominal =
    snapshotGrossWithdrawal ??
    (effectiveTaxRate > 0
      ? annualPortfolioGapNominal / Math.max(0.01, 1 - effectiveTaxRate)
      : annualPortfolioGapNominal);
  const annualEstimatedTaxesNominal =
    snapshotTaxes ?? Math.max(0, annualGrossWithdrawalNominal - annualPortfolioGapNominal);

  return {
    annualSpendingNominal,
    annualIncomeNominal,
    annualPortfolioGapNominal,
    annualGrossWithdrawalNominal,
    annualEstimatedTaxesNominal,
  };
}

export function resolveFundedProgress(
  backendProgress: number | null | undefined,
  portfolioNow: number,
  targetTodayAtGoal: number,
) {
  const progress =
    backendProgress ?? (targetTodayAtGoal > 0 ? portfolioNow / targetTodayAtGoal : 0);
  return Math.min(Math.max(progress, 0), 1);
}

interface PortfolioDrawRateInput {
  requiredCapitalReachable: boolean;
  portfolioValueAtAge: number | null | undefined;
  grossWithdrawalAtAge: number | null | undefined;
  annualIncomeAtAge: number;
  annualSpendingAtAge: number;
  portfolioEndAtAge: number | null | undefined;
}

export function resolvePortfolioDrawRate({
  requiredCapitalReachable,
  portfolioValueAtAge,
  grossWithdrawalAtAge,
  annualIncomeAtAge,
  annualSpendingAtAge,
  portfolioEndAtAge,
}: PortfolioDrawRateInput) {
  const portfolioValue = portfolioValueAtAge ?? 0;
  const grossWithdrawal = grossWithdrawalAtAge ?? 0;
  const portfolioEnd = portfolioEndAtAge ?? portfolioValue;

  if (!requiredCapitalReachable) return null;
  if (portfolioValue <= 0 || grossWithdrawal <= 0) return null;
  if (annualSpendingAtAge > 0 && annualIncomeAtAge >= annualSpendingAtAge * 0.95) return null;
  if (portfolioEnd <= 0) return null;

  return grossWithdrawal / portfolioValue;
}

export type ReadinessTone = "good" | "watch" | "bad";

interface RetirementOverviewLike {
  requiredCapitalReachable?: boolean;
  successStatus?: string;
  failureAge?: number | null;
  spendingShortfallAge?: number | null;
  incomeStreamExhaustion?: { label: string; exhaustedAge: number }[] | null;
}

interface DeriveRetirementReadinessInput {
  overview?: RetirementOverviewLike | null;
  plannerMode: "fire" | "traditional";
  isFinanciallyIndependent: boolean;
  effectiveFiAge: number | null;
  desiredAge: number;
  horizonAge: number;
}

export interface RetirementReadiness {
  tone: ReadinessTone;
  problem:
    | "loading"
    | "unreachable-target"
    | "spending-gap"
    | "portfolio-depletion"
    | "fund-exhaustion"
    | "on-track"
    | "late"
    | "not-reachable";
  body: string | null;
}

/** The first drawdown fund to run out, which is the one worth naming. */
function earliestFundExhaustion(overview: RetirementOverviewLike) {
  return (overview.incomeStreamExhaustion ?? []).reduce<{
    label: string;
    exhaustedAge: number;
  } | null>(
    (earliest, entry) =>
      earliest && earliest.exhaustedAge <= entry.exhaustedAge ? earliest : entry,
    null,
  );
}

export function deriveRetirementReadiness({
  overview,
  plannerMode,
  isFinanciallyIndependent,
  effectiveFiAge,
  desiredAge,
  horizonAge,
}: DeriveRetirementReadinessInput): RetirementReadiness {
  if (!overview) {
    return { tone: "watch", problem: "loading", body: null };
  }

  if (overview.requiredCapitalReachable === false) {
    return {
      tone: "bad",
      problem: "unreachable-target",
      body: "Target cannot be sized with the current assumptions. Check spending, inflation, returns, and retirement horizon.",
    };
  }

  if (overview.failureAge != null || overview.successStatus === "depleted") {
    return {
      tone: "bad",
      problem: "portfolio-depletion",
      body: `Projected portfolio runs short during age ${overview.failureAge ?? horizonAge}. Reduce spending, retire later, or add retirement income.`,
    };
  }

  if (overview.spendingShortfallAge != null) {
    return {
      tone: "watch",
      problem: "spending-gap",
      body: `Projected spending gap starts at age ${overview.spendingShortfallAge}. Increase contributions, retire later, reduce retirement spending, or add retirement income.`,
    };
  }

  const exhaustion = earliestFundExhaustion(overview);
  if (exhaustion) {
    return {
      tone: "watch",
      problem: "fund-exhaustion",
      body: `${exhaustion.label} runs out at age ${exhaustion.exhaustedAge} and pays nothing after that. Lower its payout rate, switch it to an annuity, or plan for the portfolio to cover the gap.`,
    };
  }

  if (plannerMode === "traditional") {
    if (overview.successStatus === "shortfall") {
      return {
        tone: "watch",
        problem: "spending-gap",
        body: "Short at retirement. Increase contributions, retire later, reduce retirement spending, or add retirement income.",
      };
    }
    return { tone: "good", problem: "on-track", body: null };
  }

  if (isFinanciallyIndependent) {
    return {
      tone: "good",
      problem: "on-track",
      body: "You have reached financial independence with the current assumptions.",
    };
  }

  if (effectiveFiAge == null) {
    return {
      tone: "bad",
      problem: "not-reachable",
      body: `Not reachable by age ${horizonAge} with current assumptions. Consider increasing contributions, extending the desired retirement age, reducing retirement spending, or adding retirement income.`,
    };
  }

  if (effectiveFiAge <= desiredAge) {
    return { tone: "good", problem: "on-track", body: null };
  }

  const yearsLate = effectiveFiAge - desiredAge;
  return {
    tone: yearsLate <= 3 ? "watch" : "bad",
    problem: "late",
    body: `${yearsLate} year${yearsLate !== 1 ? "s" : ""} after your desired age. Consider increasing contributions, extending the desired retirement age, or reducing retirement spending.`,
  };
}
