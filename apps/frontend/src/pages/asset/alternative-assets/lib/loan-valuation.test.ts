import { describe, expect, it } from "vitest";
import { getLoanValuationSnapshot } from "./loan-valuation";

describe("loan valuation", () => {
  it("uses the latest current quote and derives principal progress consistently", () => {
    const snapshot = getLoanValuationSnapshot("90", { original_amount: "100" }, [
      { timestamp: "2026-01-01T00:00:00Z", close: 95, notes: undefined } as never,
      { timestamp: "2026-02-01T00:00:00Z", close: 80, notes: undefined } as never,
    ]);
    expect(snapshot).toEqual({
      currentBalance: 80,
      originalAmount: 100,
      principalPaid: 20,
      principalProgress: 0.2,
    });
  });
});
