import { describe, expect, it } from "vitest";
import { getActivityChargeLines } from "./activity-charges";

const lines = [
  { category: "fee", label: "Commission", amount: "8.00" },
  { category: "fee", label: "Exchange fee", amount: "1.99" },
  { category: "tax", label: "Stamp duty", amount: "1.50" },
];

describe("getActivityChargeLines", () => {
  it("splits lines that add up to the totals by category", () => {
    expect(
      getActivityChargeLines({
        fee: 9.99,
        tax: 1.5,
        metadata: { charges: lines },
      }),
    ).toEqual({
      fee: [lines[0], lines[1]],
      tax: [lines[2]],
    });
  });

  it("hides lines once a total no longer matches them", () => {
    expect(
      getActivityChargeLines({
        fee: 12,
        tax: 1.5,
        metadata: { charges: lines },
      }),
    ).toBeNull();
    expect(
      getActivityChargeLines({
        fee: 9.99,
        tax: null,
        metadata: { charges: lines },
      }),
    ).toBeNull();
  });

  it("compares decimals exactly without a tolerance or binary rounding", () => {
    const feeLines = (...amounts: (string | number)[]) => ({
      charges: amounts.map((amount) => ({ category: "fee", label: "Commission", amount })),
    });
    expect(getActivityChargeLines({ fee: 0.3, metadata: feeLines(0.1, 0.2) })).not.toBeNull();
    expect(
      getActivityChargeLines({ fee: "0.03", metadata: feeLines("1e-2", "2e-2") }),
    ).not.toBeNull();
    expect(
      getActivityChargeLines({ fee: "100000000.01", metadata: feeLines("100000000") }),
    ).toBeNull();
    expect(getActivityChargeLines({ fee: 0, metadata: feeLines("0.0000000001") })).toBeNull();
    expect(
      getActivityChargeLines({
        fee: "9007199254740993.01",
        metadata: feeLines("9007199254740993", "0.01"),
      }),
    ).not.toBeNull();
    expect(getActivityChargeLines({ fee: 0, metadata: feeLines(1, -1) })).not.toBeNull();
  });

  it("ignores missing or malformed lines", () => {
    expect(getActivityChargeLines({ fee: 1, tax: 0, metadata: null })).toBeNull();
    expect(getActivityChargeLines({ fee: 1, tax: 0, metadata: { charges: [] } })).toBeNull();
    expect(
      getActivityChargeLines({
        fee: 1,
        tax: 0,
        metadata: { charges: [{ category: "levy", label: "x", amount: 1 }] },
      }),
    ).toBeNull();
    for (const amount of ["", " ", "0x10", "NaN", "Infinity", "1e999999999", "1e-999999999"]) {
      expect(
        getActivityChargeLines({
          fee: 0,
          metadata: { charges: [{ category: "fee", label: "Commission", amount }] },
        }),
      ).toBeNull();
    }
    expect(
      getActivityChargeLines({
        fee: 0,
        metadata: { charges: [{ category: "fee", label: "  ", amount: "0" }] },
      }),
    ).toBeNull();
  });
});
