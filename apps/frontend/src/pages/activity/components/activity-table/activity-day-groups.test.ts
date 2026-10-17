import { describe, expect, it } from "vitest";

import { ActivityType } from "@/lib/constants";
import type { ActivityDetails, CashBalanceScope } from "@/lib/types";
import { flattenActivityDayGroups, groupActivitiesByDay } from "./activity-day-groups";

function activity(
  id: string,
  shownDate: string,
  balance?: { amount: string; scope: CashBalanceScope | null },
): ActivityDetails {
  return {
    id,
    activityType: ActivityType.BUY,
    // The grouping reads the displayed date through the caller; this field
    // carries it so the tests can say which day each row shows.
    date: shownDate as unknown as Date,
    quantity: "1",
    unitPrice: "10",
    amount: null,
    fee: "0",
    currency: "USD",
    needsReview: false,
    createdAt: new Date("2026-04-02T15:00:00Z"),
    updatedAt: new Date("2026-04-02T15:00:00Z"),
    assetId: "AAPL",
    assetSymbol: "AAPL",
    accountId: "account-1",
    accountName: "Brokerage",
    accountCurrency: "USD",
    cashBalance: balance?.amount ?? null,
    cashBalanceCurrency: balance ? "USD" : null,
    cashBalanceScope: balance?.scope ?? null,
  };
}

const group = (activities: ActivityDetails[]) =>
  groupActivitiesByDay(
    activities,
    (item) => item,
    (item) => String(item.date),
  );

describe("groupActivitiesByDay", () => {
  it("groups runs of rows showing the same date, in the order given", () => {
    const groups = group([
      activity("a", "Oct 14, 2026"),
      activity("b", "Oct 14, 2026"),
      activity("c", "Oct 9, 2026"),
    ]);

    expect(groups.map((g) => [g.key, g.items.map((item) => item.id)])).toEqual([
      ["Oct 14, 2026", ["a", "b"]],
      ["Oct 9, 2026", ["c"]],
    ]);
  });

  it("never reorders rows: a date that recurs later starts its own run", () => {
    const groups = group([
      activity("a", "Oct 14, 2026"),
      activity("b", "Oct 9, 2026"),
      activity("c", "Oct 14, 2026"),
    ]);

    expect(groups.map((g) => g.items.map((item) => item.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("takes the day's cash from a row carrying the end-of-day balance", () => {
    const [day] = group([
      activity("draft", "Oct 14, 2026"),
      activity("buy", "Oct 14, 2026", { amount: "15480.19", scope: "DAY" }),
      activity("sell", "Oct 14, 2026", { amount: "15480.19", scope: "DAY" }),
    ]);

    expect(day.cashBalance).toEqual({ amount: 15480.19, currency: "USD" });
  });

  it.each<[string, CashBalanceScope | null]>([
    ["after-row balance", "ROW"],
    ["unscoped balance", null],
  ])("gives the day no cash from an %s", (_, scope) => {
    const [day] = group([activity("rent", "Oct 14, 2026", { amount: "954.90", scope })]);

    expect(day.cashBalance).toBeNull();
  });

  it("gives the day no cash when none of its rows has one", () => {
    const [day] = group([activity("a", "Oct 14, 2026"), activity("b", "Oct 14, 2026")]);

    expect(day.cashBalance).toBeNull();
  });
});

describe("flattenActivityDayGroups", () => {
  it("puts each header before its own rows and marks only the last day", () => {
    const items = flattenActivityDayGroups(
      group([
        activity("a", "Oct 14, 2026"),
        activity("b", "Oct 14, 2026"),
        activity("c", "Oct 9, 2026"),
      ]),
      (item) => item.id,
    );

    expect(
      items.map((item) =>
        item.kind === "header" ? `${item.key}${item.isLastGroup ? " (last)" : ""}` : item.key,
      ),
    ).toEqual(["day:Oct 14, 2026", "a", "b", "day:Oct 9, 2026 (last)", "c"]);
  });

  it("keeps header keys unique when a date recurs", () => {
    const items = flattenActivityDayGroups(
      group([
        activity("a", "Oct 14, 2026"),
        activity("b", "Oct 9, 2026"),
        activity("c", "Oct 14, 2026"),
      ]),
      (item) => item.id,
    );
    const keys = items.map((item) => item.key);

    expect(new Set(keys).size).toBe(keys.length);
  });
});
