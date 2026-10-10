import { describe, expect, it } from "vitest";

import type { CashActivity } from "../types/cash-activity";
import {
  flattenDayGroups,
  getTransactionDisplay,
  getTransferLinkStatus,
  groupRowsByDay,
  netSummary,
  isTransferCashActivity,
  toRowVM,
} from "./transactions-helpers";

function cashActivity(overrides: Partial<CashActivity>): CashActivity {
  return {
    id: "activity-1",
    activityType: "WITHDRAWAL",
    activityDate: "2026-01-01T00:00:00.000Z",
    accountId: "account-1",
    amount: "100",
    currency: "USD",
    cashFlowBucket: "neutral",
    assignments: [],
    splits: [],
    isUserModified: false,
    needsReview: false,
    netAmount: 0,
    status: "POSTED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as CashActivity;
}

describe("spending transaction helpers", () => {
  it("treats activity type overrides as transfer rows", () => {
    const activity = cashActivity({
      activityTypeOverride: "TRANSFER_OUT",
      transferLinkStatus: "unlinked",
    });

    expect(isTransferCashActivity(activity)).toBe(true);
    expect(getTransferLinkStatus(activity)).toBe("unlinked");
  });

  it("does not expose transfer link status for non-transfer effective types", () => {
    expect(getTransferLinkStatus(cashActivity({ sourceGroupId: "group-1" }))).toBeNull();
  });

  it("prefers split display state over a single category assignment", () => {
    const activity = cashActivity({
      cashFlowBucket: "spending",
      assignments: [
        {
          id: "assignment-1",
          activityId: "activity-1",
          taxonomyId: "spending_categories",
          categoryId: "groceries",
          weight: 10_000,
          source: "manual",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      splits: [
        {
          id: "split-1",
          activityId: "activity-1",
          taxonomyId: "spending_categories",
          categoryId: "groceries",
          amount: "80.00",
          note: null,
          sortOrder: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "split-2",
          activityId: "activity-1",
          taxonomyId: "spending_categories",
          categoryId: "household",
          amount: "40.00",
          note: null,
          sortOrder: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const row = toRowVM(
      activity,
      new Map([
        [
          "groceries",
          {
            id: "groceries",
            taxonomyId: "spending_categories",
            name: "Groceries",
            key: "groceries",
            color: "#4385be",
            sortOrder: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      ]),
    );

    expect(row.category).toBeNull();
    expect(row.splitCount).toBe(2);
  });
});

describe("groupRowsByDay", () => {
  function row(overrides: Partial<CashActivity>) {
    return toRowVM(cashActivity(overrides), new Map());
  }

  it("buckets rows by zoned day and keeps incoming order", () => {
    const groups = groupRowsByDay(
      [
        row({ id: "a", activityDate: "2026-06-07T02:00:00.000Z" }),
        row({ id: "b", activityDate: "2026-06-06T18:00:00.000Z" }),
        row({ id: "c", activityDate: "2026-06-06T12:00:00.000Z" }),
      ],
      "America/New_York",
    );

    // 2026-06-07T02:00Z is still Jun 6 in New York, so all three land together.
    expect(groups.map((g) => g.key)).toEqual(["2026-06-06"]);
    expect(groups[0].rows.map((r) => r.activity.id)).toEqual(["a", "b", "c"]);
  });

  it("nets outflows against income for a single-currency day", () => {
    const groups = groupRowsByDay(
      [
        row({ id: "a", cashFlowBucket: "spending", amount: "60", netAmount: -60 }),
        row({ id: "b", cashFlowBucket: "income", amount: "200", netAmount: 200 }),
      ],
      undefined,
    );

    expect(groups[0].net).toEqual({ amount: 140, currency: "USD" });
  });

  it("returns no net when a day mixes currencies", () => {
    const groups = groupRowsByDay(
      [
        row({ id: "a", cashFlowBucket: "spending", amount: "60", currency: "USD", netAmount: -60 }),
        row({ id: "b", cashFlowBucket: "spending", amount: "40", currency: "EUR", netAmount: -40 }),
      ],
      undefined,
    );

    expect(groups[0].net).toBeNull();
  });

  it("ignores neutral rows when deciding whether a day is single-currency", () => {
    const groups = groupRowsByDay(
      [
        row({ id: "a", cashFlowBucket: "spending", amount: "60", currency: "USD", netAmount: -60 }),
        // Moves no cash, so it neither contributes nor makes the day mixed.
        row({ id: "b", cashFlowBucket: "neutral", amount: "500", currency: "EUR", netAmount: 0 }),
      ],
      undefined,
    );

    expect(groups[0].net).toEqual({ amount: -60, currency: "USD" });
  });

  it("has no net for a day of only neutral rows", () => {
    const groups = groupRowsByDay([row({ id: "a", cashFlowBucket: "neutral" })], undefined);

    expect(groups[0].net).toBeNull();
  });
});

describe("flattenDayGroups", () => {
  function row(overrides: Partial<CashActivity>) {
    return toRowVM(cashActivity(overrides), new Map());
  }

  const groups = groupRowsByDay(
    [
      row({ id: "a", activityDate: "2026-06-07T12:00:00.000Z" }),
      row({ id: "b", activityDate: "2026-06-06T12:00:00.000Z" }),
      row({ id: "c", activityDate: "2026-06-06T09:00:00.000Z" }),
    ],
    "UTC",
  );

  it("puts each header immediately before its own rows", () => {
    const items = flattenDayGroups(groups);

    expect(
      items.map((item) => (item.kind === "header" ? item.group.key : item.row.activity.id)),
    ).toEqual(["2026-06-07", "a", "2026-06-06", "b", "c"]);
  });

  it("marks only the trailing group as last", () => {
    const items = flattenDayGroups(groups);

    // Rows fetched so far can stop mid-day, so only that day's header has to
    // describe itself as partial.
    expect(items.filter((item) => item.kind === "header" && item.isLastGroup)).toHaveLength(1);
    expect(items.at(-3)).toMatchObject({ kind: "header", isLastGroup: true });
  });

  it("keys headers apart from rows so an id collision cannot merge them", () => {
    const items = flattenDayGroups(groups);
    const keys = items.map((item) => item.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("day:2026-06-07");
    expect(keys[1]).toBe("a");
  });

  it("returns nothing for no groups", () => {
    expect(flattenDayGroups([])).toEqual([]);
  });
});

describe("netSummary", () => {
  function row(overrides: Partial<CashActivity>) {
    return toRowVM(cashActivity(overrides), new Map());
  }

  const exchange = () =>
    row({
      id: "exchange",
      activityType: "FX_EXCHANGE",
      cashFlowBucket: "neutral",
      amount: "100",
      currency: "USD",
      destinationAmount: "92",
      destinationCurrency: "EUR",
      netAmount: 0,
      cashMovements: [
        { currency: "USD", amount: -100, amountBase: -100 },
        { currency: "EUR", amount: 92, amountBase: 101.2 },
      ],
    });

  it("includes both exchange legs in selected totals without treating them as spending", () => {
    const fx = exchange();
    const deposit = row({
      id: "deposit",
      cashFlowBucket: "income",
      netAmount: 1000,
      netAmountBase: 1000,
    });
    expect(netSummary([deposit, fx], "USD")).toEqual({
      byCurrency: [
        { currency: "USD", amount: 900 },
        { currency: "EUR", amount: 92 },
      ],
      converted: { currency: "USD", amount: 1001.2 },
    });
    const selected = netSummary([fx], "USD");
    expect(selected.byCurrency).toEqual([
      { currency: "USD", amount: -100 },
      { currency: "EUR", amount: 92 },
    ]);
    expect(selected.converted?.amount).toBeCloseTo(1.2);
    expect(fx.activity.cashFlowBucket).toBe("neutral");
  });

  it("counts exchange legs when choosing a daily total rather than showing a source-only total", () => {
    const deposit = row({ id: "deposit", netAmount: 1000 });
    expect(groupRowsByDay([deposit, exchange()], "UTC")[0].net).toBeNull();
    const canceledSource = row({ id: "deposit", netAmount: 100 });
    expect(groupRowsByDay([canceledSource, exchange()], "UTC")[0].net).toEqual({
      currency: "EUR",
      amount: 92,
    });
  });

  it("keeps native exchange totals but withholds conversion if either leg has no rate", () => {
    const fx = exchange();
    fx.activity.cashMovements![1].amountBase = null;
    const totals = netSummary([fx], "USD");
    expect(totals.byCurrency).toHaveLength(2);
    expect(totals.converted).toBeNull();
  });

  it("does not let a canceled exchange currency veto the remaining converted total", () => {
    const fx = exchange();
    fx.activity.cashMovements![1].amountBase = null;
    const withdrawal = row({ currency: "EUR", netAmount: -92 });
    const deposit = row({ currency: "GBP", netAmount: 10, netAmountBase: 12 });
    expect(netSummary([fx, withdrawal, deposit], "USD")).toEqual({
      byCurrency: [
        { currency: "USD", amount: -100 },
        { currency: "GBP", amount: 10 },
      ],
      converted: { currency: "USD", amount: -88 },
    });
  });

  it("uses empty server movements for unposted exchanges without deriving cash from their amounts", () => {
    const fx = exchange();
    fx.activity.status = "DRAFT";
    fx.activity.cashMovements = [];
    expect(netSummary([fx], "USD")).toEqual({ byCurrency: [], converted: null });
  });

  it("nets outflows against income within one currency", () => {
    expect(
      netSummary([
        row({ id: "a", cashFlowBucket: "spending", amount: "60", netAmount: -60 }),
        row({ id: "b", cashFlowBucket: "spending", amount: "40", netAmount: -40 }),
        row({ id: "c", cashFlowBucket: "income", amount: "250", netAmount: 250 }),
      ]).byCurrency,
    ).toEqual([{ currency: "USD", amount: 150 }]);
  });

  it("reports one total per currency instead of converting", () => {
    const totals = netSummary([
      row({ id: "a", cashFlowBucket: "spending", amount: "60", currency: "USD", netAmount: -60 }),
      row({ id: "b", cashFlowBucket: "spending", amount: "40", currency: "EUR", netAmount: -40 }),
      row({ id: "c", cashFlowBucket: "income", amount: "100", currency: "EUR", netAmount: 100 }),
    ]);

    expect(totals.byCurrency).toEqual([
      { currency: "USD", amount: -60 },
      { currency: "EUR", amount: 60 },
    ]);
  });

  it("excludes neutral rows and the currencies they alone would add", () => {
    expect(
      netSummary([
        row({ id: "a", cashFlowBucket: "spending", amount: "60", currency: "USD", netAmount: -60 }),
        row({ id: "b", cashFlowBucket: "neutral", amount: "900", currency: "EUR", netAmount: 0 }),
      ]).byCurrency,
    ).toEqual([{ currency: "USD", amount: -60 }]);
  });

  /**
   * The reported case. A transfer between your own accounts is neither income
   * nor an expense, so it used to be classified neutral and contribute nothing
   * — which made a Transfer In filter total zero, correct by that rule and
   * useless in practice. The net now follows the money, not the bucket.
   */
  it("counts an internal transfer by the direction the money moved", () => {
    const transferIn = row({
      id: "a",
      activityType: "TRANSFER_IN",
      sourceGroupId: "pair-1",
      cashFlowBucket: "neutral",
      amount: "900",
      netAmount: 900,
    });

    expect(getTransactionDisplay(transferIn.activity, undefined).sign).toBe("+");
    expect(netSummary([transferIn]).byCurrency).toEqual([{ currency: "USD", amount: 900 }]);
  });

  it("leaves a row that moved no money unsigned", () => {
    const unposted = row({ id: "a", cashFlowBucket: "spending", amount: "500", netAmount: 0 });

    expect(getTransactionDisplay(unposted.activity, undefined).sign).toBe("");
    expect(netSummary([unposted]).byCurrency).toEqual([]);
  });

  it("drops a currency whose rows cancel out, as the server-side net does", () => {
    expect(
      netSummary([
        row({ id: "a", activityType: "TRANSFER_IN", amount: "900", netAmount: 900 }),
        row({ id: "b", activityType: "TRANSFER_OUT", amount: "900", netAmount: -900 }),
      ]).byCurrency,
    ).toEqual([]);
  });

  it("is empty when nothing contributes", () => {
    expect(netSummary([row({ id: "a", cashFlowBucket: "neutral" })]).byCurrency).toEqual([]);
    expect(netSummary([])).toEqual({ byCurrency: [], converted: null });
  });

  it("converts a mixed selection when every row carries a base amount", () => {
    const summary = netSummary(
      [
        row({
          id: "a",
          cashFlowBucket: "spending",
          amount: "60",
          currency: "USD",
          netAmount: -60,
          netAmountBase: -60,
        }),
        row({
          id: "b",
          cashFlowBucket: "spending",
          amount: "40",
          currency: "EUR",
          netAmount: -40,
          netAmountBase: -80,
        }),
      ],
      "USD",
    );

    expect(summary.converted).toEqual({ currency: "USD", amount: -140 });
  });

  /** Same rule the server applies, so the two readouts cannot disagree. */
  it("withholds the converted figure when a row has no base amount", () => {
    const summary = netSummary(
      [
        row({
          id: "a",
          cashFlowBucket: "spending",
          amount: "60",
          currency: "USD",
          netAmount: -60,
          netAmountBase: -60,
        }),
        row({ id: "b", cashFlowBucket: "spending", amount: "40", currency: "JPY", netAmount: -40 }),
      ],
      "USD",
    );

    expect(summary.converted).toBeNull();
    expect(summary.byCurrency).toHaveLength(2);
  });

  it("withholds the converted figure when a single currency already is the total", () => {
    const summary = netSummary(
      [
        row({
          id: "a",
          cashFlowBucket: "spending",
          amount: "60",
          currency: "EUR",
          netAmount: -60,
          netAmountBase: -66,
        }),
      ],
      "USD",
    );

    expect(summary.converted).toBeNull();
    expect(summary.byCurrency).toEqual([{ currency: "EUR", amount: -60 }]);
  });

  /** Guessing a base currency would label server-converted amounts wrongly. */
  it("withholds the converted figure when the base currency is unknown", () => {
    const summary = netSummary(
      [
        row({
          id: "a",
          cashFlowBucket: "spending",
          amount: "60",
          currency: "USD",
          netAmount: -60,
          netAmountBase: -60,
        }),
        row({
          id: "b",
          cashFlowBucket: "spending",
          amount: "40",
          currency: "EUR",
          netAmount: -40,
          netAmountBase: -80,
        }),
      ],
      undefined,
    );

    expect(summary.converted).toBeNull();
    expect(summary.byCurrency).toHaveLength(2);
  });

  /**
   * The server nets in decimal so its cancellations are exact; f64 leaves dust,
   * which would otherwise surface as a stray "+0.00" pill the server never
   * reports.
   */
  /** Dust scales with magnitude, so a fixed nano-unit bound misses large sums. */
  it("treats dust from large cancelled amounts as zero", () => {
    const summary = netSummary([
      row({ id: "a", cashFlowBucket: "income", amount: "20000000", netAmount: 20_000_000 }),
      row({ id: "b", cashFlowBucket: "income", amount: "0.1", netAmount: 0.1 }),
      row({ id: "c", cashFlowBucket: "spending", amount: "20000000", netAmount: -20_000_000 }),
      row({ id: "d", cashFlowBucket: "spending", amount: "0.1", netAmount: -0.1 }),
    ]);

    expect(summary.byCurrency).toEqual([]);
  });

  it("keeps a genuinely small amount that is not dust", () => {
    const summary = netSummary([
      row({ id: "a", cashFlowBucket: "spending", amount: "0.00000001", netAmount: -1e-8 }),
    ]);

    expect(summary.byCurrency).toEqual([{ currency: "USD", amount: -1e-8 }]);
  });

  /**
   * The same small amount, this time sharing a currency with two large rows
   * that cancel. Judging it against the gross summed rather than against the
   * error actually made would call it dust and drop a real balance.
   */
  it("keeps a small amount that shares a currency with large cancelling rows", () => {
    const summary = netSummary([
      row({ id: "a", cashFlowBucket: "income", amount: "20000000", netAmount: 20_000_000 }),
      row({ id: "b", cashFlowBucket: "spending", amount: "20000000", netAmount: -20_000_000 }),
      row({ id: "c", cashFlowBucket: "income", amount: "0.00000001", netAmount: 1e-8 }),
    ]);

    expect(summary.byCurrency).toEqual([{ currency: "USD", amount: 1e-8 }]);
  });

  /** Summation error grows with the row count; compensating removes it. */
  it("treats dust from thousands of cancelling rows as zero", () => {
    const rows = Array.from({ length: 2000 }, (_, index) =>
      index % 2 === 0
        ? row({ id: `p${index}`, cashFlowBucket: "income", amount: "1234.56", netAmount: 1234.56 })
        : row({
            id: `m${index}`,
            cashFlowBucket: "spending",
            amount: "1234.56",
            netAmount: -1234.56,
          }),
    );

    expect(netSummary(rows).byCurrency).toEqual([]);
  });

  it("treats floating-point dust from cancelled rows as zero", () => {
    const summary = netSummary([
      row({ id: "a", cashFlowBucket: "spending", amount: "0.1", netAmount: 0.1 }),
      row({ id: "b", cashFlowBucket: "spending", amount: "0.2", netAmount: 0.2 }),
      row({ id: "c", cashFlowBucket: "income", amount: "0.3", netAmount: -0.3 }),
    ]);

    expect(summary.byCurrency).toEqual([]);
  });

  it("keeps a cancelled currency out of the converted total, as the server does", () => {
    const summary = netSummary(
      [
        // CAD cancels natively but its per-date conversions do not.
        row({
          id: "a",
          currency: "CAD",
          cashFlowBucket: "income",
          amount: "900",
          netAmount: 900,
          netAmountBase: 700,
        }),
        row({
          id: "b",
          currency: "CAD",
          cashFlowBucket: "spending",
          amount: "900",
          netAmount: -900,
          netAmountBase: -650,
        }),
        row({
          id: "c",
          currency: "USD",
          cashFlowBucket: "spending",
          amount: "60",
          netAmount: -60,
          netAmountBase: -60,
        }),
        row({
          id: "d",
          currency: "EUR",
          cashFlowBucket: "spending",
          amount: "40",
          netAmount: -40,
          netAmountBase: -80,
        }),
      ],
      "USD",
    );

    expect(summary.byCurrency).toEqual([
      { currency: "USD", amount: -60 },
      { currency: "EUR", amount: -40 },
    ]);
    // The CAD residual of +50 must not leak into the headline.
    expect(summary.converted).toEqual({ currency: "USD", amount: -140 });
  });

  it("converts despite an unrated currency that cancels out", () => {
    const summary = netSummary(
      [
        row({ id: "a", currency: "JPY", cashFlowBucket: "income", amount: "900", netAmount: 900 }),
        row({
          id: "b",
          currency: "JPY",
          cashFlowBucket: "spending",
          amount: "900",
          netAmount: -900,
        }),
        row({
          id: "c",
          currency: "USD",
          cashFlowBucket: "spending",
          amount: "60",
          netAmount: -60,
          netAmountBase: -60,
        }),
        row({
          id: "d",
          currency: "EUR",
          cashFlowBucket: "spending",
          amount: "40",
          netAmount: -40,
          netAmountBase: -80,
        }),
      ],
      "USD",
    );

    expect(summary.converted).toEqual({ currency: "USD", amount: -140 });
  });
});
