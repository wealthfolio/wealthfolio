import { describe, expect, it } from "vitest";

import { SAVINGS_ROW_ID } from "./category-rollup";
import { buildCashflowUrl, spendingActivityHref } from "./navigation";

describe("buildCashflowUrl", () => {
  it("builds a category + date-range url", () => {
    expect(
      buildCashflowUrl({
        categoryId: "cat_housing",
        startDate: "2026-01-01",
        endDate: "2026-08-28",
      }),
    ).toBe("/activities?tab=spending&category=cat_housing&from=2026-01-01&to=2026-08-28");
  });

  it("omits params that are not provided", () => {
    expect(buildCashflowUrl({ categoryId: "cat_housing" })).toBe(
      "/activities?tab=spending&category=cat_housing",
    );
    expect(buildCashflowUrl({})).toBe("/activities?tab=spending");
  });

  it("supports a status filter", () => {
    expect(
      buildCashflowUrl({ status: "uncategorized", startDate: "2026-01-01", endDate: "2026-08-28" }),
    ).toBe("/activities?tab=spending&status=uncategorized&from=2026-01-01&to=2026-08-28");
  });
});

describe("spendingActivityHref", () => {
  const dates = { startDate: "2026-01-01", endDate: "2026-08-28" };

  it("links a category with the selected period's date range", () => {
    expect(spendingActivityHref("cat_housing", dates)).toBe(
      "/activities?tab=spending&category=cat_housing&from=2026-01-01&to=2026-08-28",
    );
  });

  it("omits from/to when no date range is given", () => {
    expect(spendingActivityHref("cat_housing")).toBe(
      "/activities?tab=spending&category=cat_housing",
    );
  });

  it("routes the uncategorized bucket to the status filter with dates", () => {
    expect(spendingActivityHref("__uncategorized__", dates)).toBe(
      "/activities?tab=spending&status=uncategorized&from=2026-01-01&to=2026-08-28",
    );
  });

  it("returns the savings href verbatim without date params", () => {
    expect(
      spendingActivityHref(SAVINGS_ROW_ID, {
        ...dates,
        savingsHref: "/spending/insights?stage=where&period=YTD#cashflow",
      }),
    ).toBe("/spending/insights?stage=where&period=YTD#cashflow");
  });

  it("falls back to the bare spending tab for the savings row without a href", () => {
    expect(spendingActivityHref(SAVINGS_ROW_ID, dates)).toBe("/activities?tab=spending");
  });

  it("url-encodes category ids", () => {
    expect(spendingActivityHref("cat/a&b", dates)).toBe(
      "/activities?tab=spending&category=cat%2Fa%26b&from=2026-01-01&to=2026-08-28",
    );
  });
});
