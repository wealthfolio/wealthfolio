import { describe, expect, it } from "vitest";

import type { Asset, Holding } from "@/lib/types";

import {
  buildSecurityTargetRows,
  equalWeightBps,
  securityCurrentAllocation,
  securityTargetCategories,
} from "./security-target-rows";

function holding(overrides: Partial<Holding> & { assetId: string; symbol: string; base: number }) {
  const { assetId, symbol, base, ...rest } = overrides;
  return {
    id: `${assetId}-holding`,
    holdingType: "security",
    accountId: "acc-1",
    assetKind: "INVESTMENT",
    instrument: { id: assetId, symbol, name: `${symbol} name`, currency: "USD" },
    quantity: 1,
    marketValue: { local: base, base },
    ...rest,
  } as Holding;
}

describe("buildSecurityTargetRows", () => {
  it("leaves out cash, alternative assets and closed positions", () => {
    const rows = buildSecurityTargetRows(
      [
        holding({ assetId: "vti", symbol: "VTI", base: 600 }),
        holding({ assetId: "usd", symbol: "USD", base: 900, holdingType: "cash" }),
        holding({ assetId: "house", symbol: "HOUSE", base: 5000, assetKind: "PROPERTY" }),
        holding({ assetId: "old", symbol: "OLD", base: 0, isClosed: true }),
      ],
      [],
      [],
    );
    expect(rows.map((row) => row.assetId)).toEqual(["vti"]);
  });

  it("counts crypto and other investments as securities", () => {
    const rows = buildSecurityTargetRows(
      [
        holding({ assetId: "btc", symbol: "BTC", base: 100, assetKind: "INVESTMENT" }),
        holding({ assetId: "opt", symbol: "OPT", base: 50, assetKind: undefined }),
      ],
      [],
      [],
    );
    expect(rows.map((row) => row.assetId)).toEqual(["btc", "opt"]);
  });

  it("merges a security held in several accounts and orders by value", () => {
    const rows = buildSecurityTargetRows(
      [
        holding({ assetId: "aapl", symbol: "AAPL", base: 100 }),
        holding({ assetId: "vti", symbol: "VTI", base: 300, accountId: "acc-1" }),
        holding({ assetId: "vti", symbol: "VTI", base: 200, accountId: "acc-2" }),
      ],
      [],
      [],
    );
    expect(rows).toEqual([
      { assetId: "vti", name: "VTI", value: 500 },
      { assetId: "aapl", name: "AAPL", value: 100 },
    ]);
  });

  it("keeps a saved security that is no longer held, named from its asset", () => {
    const rows = buildSecurityTargetRows(
      [holding({ assetId: "vti", symbol: "VTI", base: 300 })],
      ["vti", "gone", "unknown"],
      [{ id: "gone", kind: "INVESTMENT", displayCode: "GONE" } as Asset],
    );
    expect(rows).toEqual([
      { assetId: "vti", name: "VTI", value: 300 },
      { assetId: "gone", name: "GONE", value: 0 },
      { assetId: "unknown", name: "unknown", value: 0 },
    ]);
  });
});

describe("securityTargetCategories", () => {
  it("uses the asset id as the category id, under the sentinel taxonomy", () => {
    const [category] = securityTargetCategories([{ assetId: "vti", name: "VTI", value: 1 }]);
    expect(category).toMatchObject({
      id: "vti",
      name: "VTI",
      taxonomyId: "__individual_securities__",
      parentId: null,
    });
  });
});

describe("securityCurrentAllocation", () => {
  it("is each security's share of the securities held", () => {
    expect(
      securityCurrentAllocation([
        { assetId: "a", name: "A", value: 750 },
        { assetId: "b", name: "B", value: 250 },
        { assetId: "c", name: "C", value: 0 },
      ]),
    ).toEqual({ a: 75, b: 25, c: 0 });
  });

  it("is zero everywhere when nothing is held", () => {
    expect(securityCurrentAllocation([{ assetId: "a", name: "A", value: 0 }])).toEqual({ a: 0 });
  });
});

describe("equalWeightBps", () => {
  it("gives the remainder to the last security", () => {
    expect(equalWeightBps(3)).toEqual([3333, 3333, 3334]);
    expect(equalWeightBps(2)).toEqual([5000, 5000]);
  });

  it("always adds up to 10000", () => {
    for (const count of [1, 4, 7, 13, 50]) {
      expect(equalWeightBps(count).reduce((sum, bps) => sum + bps, 0)).toBe(10000);
    }
    expect(equalWeightBps(0)).toEqual([]);
  });
});
