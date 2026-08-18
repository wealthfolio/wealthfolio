import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  compareCashFirst,
  DEFAULT_HOLDINGS_VISIBILITY,
  filterHoldingsByVisibility,
  getEffectiveHoldingsVisibility,
  hasNonDefaultHoldingsVisibility,
  isClosedPosition,
  mergeHoldingsVisibilitySelection,
} from "./holdings-visibility";

function holding(
  id: string,
  holdingType: Holding["holdingType"],
  quantity: number,
  isClosed?: boolean,
): Holding {
  return {
    id,
    holdingType,
    isClosed,
    accountId: "account-1",
    quantity,
    localCurrency: "USD",
    baseCurrency: "USD",
    marketValue: { local: quantity * 100, base: quantity * 100 },
    weight: quantity === 0 ? 0 : 1,
    asOfDate: "2026-08-17",
  };
}

const openPosition = holding("open", HoldingType.SECURITY, 1);
const closedPosition = holding("closed", HoldingType.SECURITY, 0);
const cashBalance = holding("cash", HoldingType.CASH, 100);
const allHoldings = [openPosition, closedPosition, cashBalance];

describe("holdings visibility filters", () => {
  it("shows open positions by default", () => {
    expect(
      filterHoldingsByVisibility(allHoldings, DEFAULT_HOLDINGS_VISIBILITY).map(({ id }) => id),
    ).toEqual(["open"]);
  });

  it("can focus on open, closed, or cash holdings independently", () => {
    expect(filterHoldingsByVisibility(allHoldings, ["open"]).map(({ id }) => id)).toEqual(["open"]);
    expect(filterHoldingsByVisibility(allHoldings, ["closed"]).map(({ id }) => id)).toEqual([
      "closed",
    ]);
    expect(filterHoldingsByVisibility(allHoldings, ["cash"]).map(({ id }) => id)).toEqual(["cash"]);
    expect(
      filterHoldingsByVisibility(allHoldings, ["open", "closed", "cash"]).map(({ id }) => id),
    ).toEqual(["open", "closed", "cash"]);
  });

  it("only marks non-default visibility selections as active", () => {
    expect(hasNonDefaultHoldingsVisibility(["open"])).toBe(false);
    expect(hasNonDefaultHoldingsVisibility(["closed"])).toBe(true);
    expect(hasNonDefaultHoldingsVisibility(["open", "cash"])).toBe(true);
  });

  it("removes unsupported closed visibility for snapshot accounts", () => {
    expect(getEffectiveHoldingsVisibility(["open", "closed", "cash"], false)).toEqual([
      "open",
      "cash",
    ]);
    expect(getEffectiveHoldingsVisibility(["closed"], false)).toEqual(["open"]);
    expect(getEffectiveHoldingsVisibility(["closed"], true)).toEqual(["closed"]);
  });

  it("preserves a hidden closed preference when supported filters change", () => {
    expect(mergeHoldingsVisibilitySelection(["open", "closed"], ["open", "cash"], false)).toEqual([
      "open",
      "cash",
      "closed",
    ]);
  });

  it("allows closed to be removed where the filter is supported", () => {
    expect(mergeHoldingsVisibilitySelection(["open", "closed"], ["open", "cash"], true)).toEqual([
      "open",
      "cash",
    ]);
  });

  it("does not classify a zero cash balance as a closed position", () => {
    expect(isClosedPosition(holding("zero-cash", HoldingType.CASH, 0))).toBe(false);
    expect(isClosedPosition(closedPosition)).toBe(true);
  });

  it("uses the explicit lifecycle state when an open aggregate nets to zero", () => {
    const openNetZero = holding("open-net-zero", HoldingType.SECURITY, 0, false);

    expect(isClosedPosition(openNetZero)).toBe(false);
    expect(filterHoldingsByVisibility([openNetZero], ["open"])).toEqual([openNetZero]);
    expect(filterHoldingsByVisibility([openNetZero], ["closed"])).toEqual([]);
  });

  it("orders cash before open and closed security positions", () => {
    const anotherCashBalance = holding("cash-eur", HoldingType.CASH, 50);
    const sorted = [openPosition, cashBalance, closedPosition, anotherCashBalance].sort(
      compareCashFirst,
    );

    expect(sorted.map(({ id }) => id)).toEqual(["cash", "cash-eur", "open", "closed"]);
  });
});
