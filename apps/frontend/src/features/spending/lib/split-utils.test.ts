import { describe, expect, it } from "vitest";

import {
  canDistributeSplitUnits,
  distributeEvenlyUnits,
  distributeRemainingUnits,
  significantDecimals,
  splitUnitsToAmount,
  toSplitUnits,
} from "./split-utils";

describe("split utils", () => {
  it("counts the decimals an amount needs, without trailing zeros", () => {
    expect(significantDecimals("12.345")).toBe(3);
    expect(significantDecimals("-1.235")).toBe(3);
    expect(significantDecimals("12.3400")).toBe(2);
    expect(significantDecimals("1000")).toBe(0);
    expect(significantDecimals(12.5)).toBe(1);
    expect(significantDecimals(1e-7)).toBe(7);
    expect(significantDecimals("1.5e2")).toBe(0);
    expect(significantDecimals("0.123456789")).toBe(8);
    expect(significantDecimals(undefined)).toBe(0);
    expect(significantDecimals("abc")).toBe(0);
  });

  it("counts amounts in units of the given decimals", () => {
    expect(toSplitUnits("12.34", 2)).toBe(1234);
    expect(toSplitUnits(1.235, 3)).toBe(1235);
    expect(toSplitUnits("-1.235", 3)).toBe(-1235);
    expect(toSplitUnits(undefined, 3)).toBe(0);
    expect(splitUnitsToAmount(1235, 3)).toBe(1.235);
    expect(splitUnitsToAmount(1234, 2)).toBe(12.34);
  });

  it.each([1, -1])("keeps eight-decimal amounts exact with sign %s", (sign) => {
    const amount = sign * 33554432.12345678;
    const units = toSplitUnits(amount, 8);

    expect(units).toBe(sign * 3355443212345678);
    expect(splitUnitsToAmount(units, 8).toFixed(8)).toBe(amount.toFixed(8));
  });

  it("distributes remaining units evenly and keeps the exact total", () => {
    expect(distributeRemainingUnits(12000, 0, 3)).toEqual([4000, 4000, 4000]);
  });

  it("places rounding units on the earliest empty lines", () => {
    expect(distributeRemainingUnits(10000, 0, 3)).toEqual([3334, 3333, 3333]);
  });

  it("only distributes the unassigned remainder", () => {
    expect(distributeRemainingUnits(12000, 8000, 2)).toEqual([2000, 2000]);
  });

  it("returns zeroes when there is no positive remainder", () => {
    expect(distributeRemainingUnits(10000, 10001, 2)).toEqual([0, 0]);
  });

  it("distributes a full amount evenly across all lines", () => {
    expect(distributeEvenlyUnits(7727, 2)).toEqual([3864, 3863]);
  });

  it("allows rebalancing after adding an empty line to a fully assigned split", () => {
    expect(canDistributeSplitUnits(7727, 7727, 1, 2)).toBe(true);
  });

  it("allows distribution when every split line is empty", () => {
    expect(canDistributeSplitUnits(7727, 0, 2, 2)).toBe(true);
  });
});
