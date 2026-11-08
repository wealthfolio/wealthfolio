import { describe, expect, it } from "vitest";
import type { RetirementTrajectoryPoint } from "@/lib/types";
import { toCsv } from "@/pages/allocation-targets/components/allocation-worksheet-export";
import {
  goalProjectionFileName,
  retirementProjectionExportRows,
  saveUpProjectionExportRows,
  type GoalProjectionContextLabels,
} from "./goal-projection-export";

const shared: Omit<GoalProjectionContextLabels, "title" | "note"> = {
  goal: "Goal",
  exportedOn: "Exported on",
  currency: "Currency",
  noteLabel: "Note",
};

const retirementLabels = {
  ...shared,
  title: "Retirement projection",
  note: "Amounts are nominal.",
  age: "Age",
  year: "Year",
  phase: "Phase",
  phaseAccumulation: "Accumulation",
  phaseRetirement: "Retirement",
  portfolioStart: "Portfolio at start",
  annualContribution: "Contributions",
  annualIncome: "Retirement income",
  annualExpenses: "Expenses",
  plannedExpenses: "Planned spending",
  fundedExpenses: "Funded spending",
  annualShortfall: "Shortfall",
  netWithdrawal: "Net withdrawal",
  grossWithdrawal: "Gross withdrawal",
  annualTaxes: "Taxes",
  portfolioEnd: "Portfolio at end",
  requiredCapital: "Required capital",
  pensionAssets: "Pension assets",
};

const point = (
  age: number,
  overrides: Partial<RetirementTrajectoryPoint> = {},
): RetirementTrajectoryPoint => ({
  age,
  year: 2026 + age - 40,
  phase: "accumulation",
  portfolioStart: 100000,
  annualContribution: 12000,
  annualIncome: 0,
  annualExpenses: 0,
  netWithdrawalFromPortfolio: 0,
  portfolioEnd: 118000.456,
  requiredCapital: 900000,
  pensionAssets: 0,
  ...overrides,
});

const context = { goalName: "Early retirement", currency: "EUR", exportedOn: "2026-11-08" };

describe("retirementProjectionExportRows", () => {
  it("writes one row per year with every column and the export date after the table", () => {
    const rows = retirementProjectionExportRows(
      [
        point(40),
        point(41, {
          phase: "fire",
          annualContribution: 0,
          annualIncome: 5000,
          annualExpenses: 40000,
          plannedExpenses: 40000,
          fundedExpenses: 38000,
          annualShortfall: 2000,
          netWithdrawalFromPortfolio: 33000,
          grossWithdrawal: 36000,
          annualTaxes: 3000,
          requiredCapital: null,
        }),
      ],
      context,
      retirementLabels,
    );
    const lines = toCsv(rows).split("\n");
    expect(lines[0]).toBe(
      [
        "Age",
        "Year",
        "Phase",
        "Portfolio at start (EUR)",
        "Contributions (EUR)",
        "Retirement income (EUR)",
        "Expenses (EUR)",
        "Planned spending (EUR)",
        "Funded spending (EUR)",
        "Shortfall (EUR)",
        "Net withdrawal (EUR)",
        "Gross withdrawal (EUR)",
        "Taxes (EUR)",
        "Portfolio at end (EUR)",
        "Required capital (EUR)",
        "Pension assets (EUR)",
      ]
        .map((cell) => `"${cell}"`)
        .join(","),
    );
    // Columns the backend leaves out for a year stay empty rather than zero.
    expect(lines[1]).toBe(
      '"40","2026","Accumulation","100000.00","12000.00","0.00","0.00","","","","0.00","","","118000.46","900000.00","0.00"',
    );
    expect(lines[2]).toBe(
      '"41","2027","Retirement","100000.00","0.00","5000.00","40000.00","40000.00","38000.00","2000.00","33000.00","36000.00","3000.00","118000.46","","0.00"',
    );
    expect(lines.slice(3)).toEqual([
      "",
      '"Retirement projection"',
      '"Goal","Early retirement"',
      '"Exported on","2026-11-08"',
      '"Currency","EUR"',
      '"Note","Amounts are nominal."',
    ]);
  });

  it("writes numbers with the user's decimal mark and no group separators", () => {
    const rows = retirementProjectionExportRows([point(40)], context, retirementLabels);
    expect(toCsv(rows, ",").split("\n")[1]).toContain('"118000,46";"900000,00"');
  });
});

describe("saveUpProjectionExportRows", () => {
  it("writes one row per projected date", () => {
    const rows = saveUpProjectionExportRows(
      [
        {
          date: "2026-11-08",
          nominal: 1000,
          optimistic: 1000,
          pessimistic: 1000,
          target: 5000,
          needed: 900,
        },
        {
          date: "2026-11-30",
          nominal: 1204.1,
          optimistic: 1210,
          pessimistic: 1199.5,
          target: 5000,
          needed: 1100,
        },
      ],
      { ...context, goalName: 'Car, "new"' },
      {
        ...shared,
        title: "Savings projection",
        note: "Projected from the saved plan.",
        date: "Date",
        projected: "Projected balance",
        optimistic: "Optimistic",
        pessimistic: "Pessimistic",
        target: "Target",
        needed: "Needed to stay on track",
      },
    );
    expect(toCsv(rows).split("\n")).toEqual([
      '"Date","Projected balance (EUR)","Optimistic (EUR)","Pessimistic (EUR)","Target (EUR)","Needed to stay on track (EUR)"',
      '"2026-11-08","1000.00","1000.00","1000.00","5000.00","900.00"',
      '"2026-11-30","1204.10","1210.00","1199.50","5000.00","1100.00"',
      "",
      '"Savings projection"',
      '"Goal","Car, ""new"""',
      '"Exported on","2026-11-08"',
      '"Currency","EUR"',
      '"Note","Projected from the saved plan."',
    ]);
  });
});

describe("goalProjectionFileName", () => {
  it("names the goal and the export date", () => {
    expect(goalProjectionFileName("Early Retirement!", "2026-11-08")).toBe(
      "goal-projection_early-retirement_2026-11-08.csv",
    );
    expect(goalProjectionFileName("", "2026-11-08")).toBe("goal-projection_goal_2026-11-08.csv");
  });
});
