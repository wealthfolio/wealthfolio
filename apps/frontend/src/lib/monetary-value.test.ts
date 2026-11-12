import { describe, expect, it } from "vitest";
import { subtractAmounts, sumAmounts } from "./monetary-value";

describe("accounting availability", () => {
  it("does not publish a subtotal as a complete amount", () => {
    expect(sumAmounts([100, null, 20])).toBeNull();
    expect(sumAmounts([undefined, 0])).toBeNull();
    expect(sumAmounts([100, NaN])).toBeNull();
    expect(subtractAmounts(100, null)).toBeNull();
  });
  it("retains zero, including offsetting positive and negative amounts", () => {
    expect(sumAmounts([100, -100, 0])).toBe(0);
    expect(sumAmounts([])).toBe(0);
    expect(subtractAmounts(0, 0)).toBe(0);
  });
});
