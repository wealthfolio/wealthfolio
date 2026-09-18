import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETIREMENT_PLAN,
  createDefaultRetirementPlan,
  normalizeDashboardRetirementPlan,
  parseSettingsJson,
} from "./plan-adapter";

describe("retirement plan adapter", () => {
  it("default plans do not include legacy withdrawal-rule fields", () => {
    const plan = parseSettingsJson("{}");

    expect(plan).not.toHaveProperty("withdrawal");
  });

  it("parses old withdrawal-rule JSON and strips it from the normalized plan", () => {
    const plan = parseSettingsJson(
      JSON.stringify({
        withdrawal: {
          safeWithdrawalRate: 0.04,
          strategy: "guardrails",
          guardrails: {
            ceilingRate: 0.06,
          },
        },
      }),
    );

    expect(plan).not.toHaveProperty("withdrawal");
  });

  it("saving a plan strips any legacy withdrawal-rule fields", () => {
    const plan = parseSettingsJson(
      JSON.stringify({
        withdrawal: {
          safeWithdrawalRate: 0.041,
          strategy: "constant-percentage",
        },
      }),
    );

    const normalized = normalizeDashboardRetirementPlan(plan);

    expect(normalized).not.toHaveProperty("withdrawal");
  });
});

describe("createDefaultRetirementPlan", () => {
  it("sets the currency to the given base currency without altering amounts", () => {
    const plan = createDefaultRetirementPlan("IDR");

    expect(plan.currency).toBe("IDR");
    expect(plan.investment.monthlyContribution).toBe(
      DEFAULT_RETIREMENT_PLAN.investment.monthlyContribution,
    );
    expect(plan.expenses.items).toEqual(DEFAULT_RETIREMENT_PLAN.expenses.items);
  });
});

describe("retirement calendar date", () => {
  it("uses the supplied month for age and newly inferred birth dates", () => {
    const json = JSON.stringify({ personal: { birthYearMonth: "1990-01", currentAge: 35 } });
    expect(parseSettingsJson(json, new Date(2025, 11, 31)).personal.currentAge).toBe(35);
    expect(parseSettingsJson(json, new Date(2026, 0, 1)).personal.currentAge).toBe(36);
    expect(createDefaultRetirementPlan("USD", new Date(2026, 0, 1)).personal.birthYearMonth).toBe(
      "1996-01",
    );
    expect(createDefaultRetirementPlan("USD", new Date(2025, 11, 31)).personal.birthYearMonth).toBe(
      "1995-12",
    );
  });
});
