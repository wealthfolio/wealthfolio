import { describe, expect, it } from "vitest";
import type { Quote } from "@/lib/types";
import { format } from "date-fns";
import { buildLoanChartData, getRemainingLoanProjection } from "./loan-projection";
import { serializeLoanProjectionMetadata } from "./loan-events";

const quote = (day: string, close: number): Quote => ({
  id: `loan_${day}_MANUAL`,
  createdAt: `${day}T00:00:00Z`,
  dataSource: "MANUAL",
  timestamp: `${day}T00:00:00Z`,
  assetId: "loan",
  open: close,
  high: close,
  low: close,
  close,
  adjclose: close,
  volume: 0,
  currency: "EUR",
});

const projectionMetadata = serializeLoanProjectionMetadata({
  version: 1,
  annualRate: 0,
  paymentAmount: 100,
  frequency: "monthly",
  firstPaymentDate: "2026-01-01",
  paymentCount: 12,
  termEndDate: "2026-12-01",
});

describe("remaining loan projection", () => {
  it("projects only installments remaining after the latest confirmed balance", () => {
    const result = getRemainingLoanProjection({ loan_projection: projectionMetadata }, [
      quote("2026-04-01", 800),
    ]);

    expect(result?.projection.rows).toHaveLength(8);
    expect(result?.projection.rows[0].paymentDate).toEqual(new Date(2026, 4, 1));
    expect(result?.projection.endDate).toEqual(new Date(2026, 11, 1));
  });

  it("keeps terms from an already-effective renewal without replaying its balance effects", () => {
    const result = getRemainingLoanProjection(
      {
        loan_projection: projectionMetadata,
        loan_events: JSON.stringify([
          {
            type: "renewal",
            effectiveDate: "2026-03-01",
            annualRate: 6,
            paymentAmount: 120,
            termEndDate: "2027-02-01",
          },
        ]),
      },
      [quote("2026-04-01", 2_000)],
    );

    expect(result).toMatchObject({ annualRate: 6, paymentAmount: 120 });
    expect(result?.projection.rows[0].interest).toBeCloseTo(10, 6);
    expect(result?.projection.endDate).toEqual(new Date(2027, 1, 1));
  });

  it("builds chart projections from engine rows and lets confirmed dates win", () => {
    const remaining = getRemainingLoanProjection({ loan_projection: projectionMetadata }, [
      quote("2026-04-01", 800),
    ])!;
    const chart = buildLoanChartData(
      [{ timestamp: "2026-04-01T00:00:00Z", totalValue: 800 }],
      remaining.projection.rows,
      new Date("2026-06-15T00:00:00Z"),
    );

    expect(chart.data.map((point) => point.totalValue)).toEqual([
      800, 700, 600, 500, 400, 300, 200, 100, 0,
    ]);
    expect(format(new Date(chart.todayTimestamp!), "yyyy-MM-dd")).toBe("2026-06-01");
    expect(chart.splitPercent).toBe(25);
  });
});
