import type { RetirementPlan } from "../types";
import { defaultExpenseItems, normalizeExpenseBudget } from "./expense-items";

function formatYearMonth(year: number, monthIndex: number) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

export function inferBirthYearMonthFromAge(age: number, asOf = new Date()) {
  return formatYearMonth(asOf.getFullYear() - Math.max(0, Math.round(age)), asOf.getMonth());
}

export function ageFromBirthYearMonth(birthYearMonth: string, asOf = new Date()) {
  const [yearRaw, monthRaw] = birthYearMonth.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return undefined;
  }
  let age = asOf.getFullYear() - year;
  if (asOf.getMonth() + 1 < month) age -= 1;
  return age >= 0 ? age : undefined;
}

export function normalizePersonalProfile(
  personal: Partial<RetirementPlan["personal"]> | undefined,
): RetirementPlan["personal"] {
  const fallback = DEFAULT_RETIREMENT_PLAN.personal;
  const currentAge = Math.round(personal?.currentAge ?? fallback.currentAge);
  const birthYearMonth =
    personal?.birthYearMonth ?? fallback.birthYearMonth ?? inferBirthYearMonthFromAge(currentAge);
  const derivedAge = ageFromBirthYearMonth(birthYearMonth) ?? currentAge;
  const targetRetirementAge = Math.max(
    derivedAge + 1,
    Math.round(personal?.targetRetirementAge ?? fallback.targetRetirementAge),
  );
  const planningHorizonAge = Math.max(
    targetRetirementAge + 1,
    Math.round(personal?.planningHorizonAge ?? fallback.planningHorizonAge),
  );

  return {
    ...fallback,
    ...personal,
    birthYearMonth,
    currentAge: derivedAge,
    targetRetirementAge,
    planningHorizonAge,
  };
}

export function normalizeRetirementPlan(plan: RetirementPlan): RetirementPlan {
  return {
    ...plan,
    personal: normalizePersonalProfile(plan.personal),
    expenses: normalizeExpenseBudget(plan.expenses),
    incomeStreams: plan.incomeStreams ?? [],
  };
}

export function normalizeDashboardRetirementPlan(plan: RetirementPlan): RetirementPlan {
  return normalizeRetirementPlan(plan);
}

export const DEFAULT_RETIREMENT_PLAN: RetirementPlan = {
  version: "v3",
  personal: {
    birthYearMonth: inferBirthYearMonthFromAge(30),
    currentAge: 30,
    targetRetirementAge: 50,
    planningHorizonAge: 90,
  },
  expenses: {
    items: defaultExpenseItems(),
  },
  incomeStreams: [],
  investment: {
    preRetirementAnnualReturn: 0.0577,
    retirementAnnualReturn: 0.0337,
    annualInvestmentFeeRate: 0.006,
    annualVolatility: 0.12,
    inflationRate: 0.02,
    monthlyContribution: 1000,
    contributionGrowthRate: 0.02,
  },
  tax: {
    taxableWithdrawalRate: 0.15,
    taxDeferredWithdrawalRate: 0.25,
    taxFreeWithdrawalRate: 0,
    earlyWithdrawalPenaltyRate: 0,
    earlyWithdrawalPenaltyAge: 65,
  },
  currency: "USD",
};

/** DEFAULT_RETIREMENT_PLAN with its currency placeholder set to the account's base currency. */
export function createDefaultRetirementPlan(baseCurrency: string): RetirementPlan {
  return { ...DEFAULT_RETIREMENT_PLAN, currency: baseCurrency };
}

export function parseSettingsJson(json: string): RetirementPlan {
  try {
    const raw = JSON.parse(json);
    const { withdrawal: _legacyWithdrawal, ...rawWithoutWithdrawal } = raw ?? {};
    const rawInvestment = raw.investment ?? {};
    const {
      expectedAnnualReturn,
      expectedReturnStdDev,
      targetAllocations,
      ...investmentWithoutLegacy
    } = rawInvestment;
    void targetAllocations;
    return {
      ...DEFAULT_RETIREMENT_PLAN,
      ...rawWithoutWithdrawal,
      version: "v3",
      personal: normalizePersonalProfile(raw.personal),
      expenses: normalizeExpenseBudget(raw.expenses ?? DEFAULT_RETIREMENT_PLAN.expenses),
      incomeStreams: raw.incomeStreams ?? DEFAULT_RETIREMENT_PLAN.incomeStreams,
      investment: {
        ...DEFAULT_RETIREMENT_PLAN.investment,
        ...investmentWithoutLegacy,
        preRetirementAnnualReturn:
          rawInvestment.preRetirementAnnualReturn ??
          expectedAnnualReturn ??
          DEFAULT_RETIREMENT_PLAN.investment.preRetirementAnnualReturn,
        retirementAnnualReturn:
          rawInvestment.retirementAnnualReturn ??
          DEFAULT_RETIREMENT_PLAN.investment.retirementAnnualReturn,
        annualInvestmentFeeRate:
          rawInvestment.annualInvestmentFeeRate ??
          DEFAULT_RETIREMENT_PLAN.investment.annualInvestmentFeeRate,
        annualVolatility:
          rawInvestment.annualVolatility ??
          expectedReturnStdDev ??
          DEFAULT_RETIREMENT_PLAN.investment.annualVolatility,
      },
      tax: raw.tax ?? DEFAULT_RETIREMENT_PLAN.tax,
    };
  } catch {
    return { ...DEFAULT_RETIREMENT_PLAN };
  }
}
