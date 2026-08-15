import { describe, expect, it } from "vitest";
import { buildMonthlyComparison, calculateMonthlyReturns } from "./monthly-performance-utils";
import type { ReturnData } from "@/lib/types";

describe("monthly-performance-utils", () => {
  it("calculates monthly returns accurately from cumulative series", () => {
    // Cumulative returns starting at 0% at beginning of Jan 2025
    // Jan 31: 5% (cumulative = 0.05) -> Jan return = +5%
    // Feb 28: 2% (cumulative = 0.02) -> Feb return = (1 + 0.02)/(1 + 0.05) - 1 = -2.857%
    // Mar 31: 10% (cumulative = 0.10) -> Mar return = (1 + 0.10)/(1 + 0.02) - 1 = +7.843%
    const series: ReturnData[] = [
      { date: "2025-01-01", value: 0 },
      { date: "2025-01-15", value: 0.02 },
      { date: "2025-01-31", value: 0.05 },
      { date: "2025-02-14", value: 0.03 },
      { date: "2025-02-28", value: 0.02 },
      { date: "2025-03-15", value: 0.06 },
      { date: "2025-03-31", value: 0.1 },
    ];

    const result = calculateMonthlyReturns(series);
    expect(result).toHaveLength(1);
    expect(result[0].year).toBe(2025);

    // Jan
    expect(result[0].months[0]).toBeCloseTo(0.05, 4);
    // Feb: (1.02 / 1.05) - 1 = -0.02857
    expect(result[0].months[1]).toBeCloseTo(1.02 / 1.05 - 1, 4);
    // Mar: (1.10 / 1.02) - 1 = 0.07843
    expect(result[0].months[2]).toBeCloseTo(1.1 / 1.02 - 1, 4);
    // Apr .. Dec should be null
    expect(result[0].months[3]).toBeNull();

    // Year total compounded should be exactly 10% (0.10)
    expect(result[0].yearTotal).toBeCloseTo(0.1, 4);
  });

  it("handles multi-year series and sorts years descending", () => {
    const series: ReturnData[] = [
      { date: "2024-11-01", value: 0 },
      { date: "2024-11-30", value: 0.02 },
      { date: "2024-12-31", value: 0.04 },
      { date: "2025-01-31", value: 0.08 },
    ];

    const result = calculateMonthlyReturns(series);
    expect(result).toHaveLength(2);
    expect(result[0].year).toBe(2025);
    expect(result[1].year).toBe(2024);

    // 2024: Nov = 2%, Dec = (1.04/1.02) - 1
    expect(result[1].months[10]).toBeCloseTo(0.02, 4);
    expect(result[1].months[11]).toBeCloseTo(1.04 / 1.02 - 1, 4);
    expect(result[1].yearTotal).toBeCloseTo(0.04, 4);

    // 2025: Jan = (1.08/1.04) - 1
    expect(result[0].months[0]).toBeCloseTo(1.08 / 1.04 - 1, 4);
    expect(result[0].yearTotal).toBeCloseTo(1.08 / 1.04 - 1, 4);
  });

  it("builds monthly comparison with benchmark and computes relative returns", () => {
    const portfolio = [
      {
        year: 2025,
        months: [0.03, -0.01, 0.05, ...Array(9).fill(null)],
        yearTotal: 1.03 * 0.99 * 1.05 - 1,
      },
    ];

    const benchmark = [
      {
        year: 2025,
        months: [0.01, 0.02, 0.03, ...Array(9).fill(null)],
        yearTotal: 1.01 * 1.02 * 1.03 - 1,
      },
    ];

    const comparison = buildMonthlyComparison(portfolio, benchmark);
    expect(comparison).toHaveLength(1);
    expect(comparison[0].year).toBe(2025);

    // Jan: portfolio 3%, benchmark 1% => relative +2%
    expect(comparison[0].months[0]?.portfolioReturn).toBe(0.03);
    expect(comparison[0].months[0]?.benchmarkReturn).toBe(0.01);
    expect(comparison[0].months[0]?.relativeReturn).toBeCloseTo(0.02, 4);

    // Feb: portfolio -1%, benchmark 2% => relative -3%
    expect(comparison[0].months[1]?.relativeReturn).toBeCloseTo(-0.03, 4);

    // Mar: portfolio 5%, benchmark 3% => relative +2%
    expect(comparison[0].months[2]?.relativeReturn).toBeCloseTo(0.02, 4);
  });
});
