import { describe, expect, it } from "vitest";

import type { PrivateSnapshot } from "@/lib/types";
import {
  buildSnapshotFormValues,
  getDefaultStatementCashFlows,
  getLastMonthEnd,
  getLastQuarterEnd,
} from "./private-snapshot-edit-modal";

const BASE_DATE = new Date("2026-04-20T00:00:00Z");

function makeSnapshot(overrides: Partial<PrivateSnapshot> = {}): PrivateSnapshot {
  return {
    id: "snapshot-1",
    privateAssetId: "asset-1",
    contributedAmount: 1000000,
    distributedAmount: 400000,
    cashFlowType: "TOTAL_TO_DATE",
    currentValue: 1200000,
    asOfDate: "2026-04-20",
    valueSourceType: "STATEMENT",
    notes: "Latest statement",
    createdAt: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

describe("buildSnapshotFormValues", () => {
  it("prefills add-statement defaults from the latest total-to-date statement", () => {
    const values = buildSnapshotFormValues(undefined, makeSnapshot(), makeSnapshot(), BASE_DATE);

    expect(values).toMatchObject({
      contributedAmount: 1000000,
      distributedAmount: 400000,
      cashFlowType: "TOTAL_TO_DATE",
      currentValue: 1200000,
      valueSourceType: "STATEMENT",
      notes: "",
    });
    expect(values.asOfDate).toEqual(new Date(2026, 2, 31));
  });

  it("does not blindly copy period-only cash flow amounts into a new statement", () => {
    const values = buildSnapshotFormValues(
      undefined,
      makeSnapshot({
        cashFlowType: "PERIOD_ONLY",
        contributedAmount: 25000,
        distributedAmount: 5000,
      }),
      undefined,
      BASE_DATE,
    );

    expect(values).toMatchObject({
      contributedAmount: 0,
      distributedAmount: 0,
      cashFlowType: "TOTAL_TO_DATE",
      currentValue: 1200000,
      valueSourceType: "STATEMENT",
      notes: "",
    });
    expect(values.asOfDate).toEqual(new Date(2026, 2, 31));
  });

  it("uses the latest total-to-date statement for ITD prefills even when the newest statement is period-only", () => {
    const values = buildSnapshotFormValues(
      undefined,
      makeSnapshot({
        id: "snapshot-period",
        cashFlowType: "PERIOD_ONLY",
        contributedAmount: 1,
        distributedAmount: 1,
        currentValue: 1500000,
      }),
      makeSnapshot({
        id: "snapshot-itd",
        asOfDate: "2026-01-31",
        contributedAmount: 131716,
        distributedAmount: 2671,
        currentValue: 1200000,
      }),
      BASE_DATE,
    );

    expect(values).toMatchObject({
      contributedAmount: 131716,
      distributedAmount: 2671,
      cashFlowType: "TOTAL_TO_DATE",
      currentValue: 1500000,
      valueSourceType: "STATEMENT",
      notes: "",
    });
    expect(values.asOfDate).toEqual(new Date(2026, 2, 31));
  });

  it("starts a new statement at zero cash flows when no latest statement exists", () => {
    const values = buildSnapshotFormValues(undefined, undefined, undefined, BASE_DATE);

    expect(values).toMatchObject({
      contributedAmount: 0,
      distributedAmount: 0,
      cashFlowType: "TOTAL_TO_DATE",
      currentValue: undefined,
      valueSourceType: "STATEMENT",
      notes: "",
    });
    expect(values.asOfDate).toEqual(new Date(2026, 2, 31));
  });

  it("keeps edit mode bound to the selected statement values", () => {
    const values = buildSnapshotFormValues(
      makeSnapshot(),
      makeSnapshot({ currentValue: 999 }),
      makeSnapshot({ currentValue: 999 }),
      BASE_DATE,
    );

    expect(values).toMatchObject({
      contributedAmount: 1000000,
      distributedAmount: 400000,
      cashFlowType: "TOTAL_TO_DATE",
      currentValue: 1200000,
      valueSourceType: "STATEMENT",
      notes: "Latest statement",
    });
    expect(values.asOfDate).toEqual(new Date("2026-04-20T00:00:00"));
  });
});

describe("date shortcuts", () => {
  it("defaults to the prior month-end", () => {
    expect(getLastMonthEnd(BASE_DATE)).toEqual(new Date(2026, 2, 31));
  });

  it("computes the prior quarter-end", () => {
    expect(getLastQuarterEnd(BASE_DATE)).toEqual(new Date(2026, 2, 31));
    expect(getLastQuarterEnd(new Date("2026-02-10T00:00:00Z"))).toEqual(new Date(2025, 11, 31));
  });
});

describe("getDefaultStatementCashFlows", () => {
  it("carries forward total-to-date cash flows when the new statement stays total-to-date", () => {
    expect(getDefaultStatementCashFlows("TOTAL_TO_DATE", makeSnapshot())).toEqual({
      contributedAmount: 1000000,
      distributedAmount: 400000,
    });
  });

  it("starts a period-only statement at zero even when the latest statement is total-to-date", () => {
    expect(getDefaultStatementCashFlows("PERIOD_ONLY", makeSnapshot())).toEqual({
      contributedAmount: 0,
      distributedAmount: 0,
    });
  });
});
