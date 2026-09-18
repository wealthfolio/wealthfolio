import { describe, expect, it } from "vitest";
import { QueryKeys } from "./query-keys";
import { shouldInvalidateAfterPortfolioUpdate } from "./query-invalidation";

describe("device sync settings refresh", () => {
  it("refetches settings after the portfolio update triggered by a device sync pull", () => {
    expect(shouldInvalidateAfterPortfolioUpdate([QueryKeys.SETTINGS])).toBe(true);
    expect(shouldInvalidateAfterPortfolioUpdate([QueryKeys.BROKER_CONNECTIONS])).toBe(false);
    expect(shouldInvalidateAfterPortfolioUpdate(["sync", "status"])).toBe(false);
  });
});
