import type { PriceAlert } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  conditionForPercent,
  sanitizeTargetInput,
  targetFromPercent,
  validatePriceAlertTarget,
} from "./price-alert-form";

function alert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: "alert-1",
    assetId: "asset-1",
    condition: "ABOVE",
    targetPrice: "105",
    currency: "USD",
    status: "ACTIVE",
    armedAt: "2026-08-16T12:00:00Z",
    armedMarketDate: "2026-08-16",
    createdAt: "2026-08-16T12:00:00Z",
    updatedAt: "2026-08-16T12:00:00Z",
    ...overrides,
  };
}

describe("price alert form rules", () => {
  it("calculates percentage presets and their directions", () => {
    expect(targetFromPercent(84.33, -10)).toBe("75.9");
    expect(targetFromPercent(84.33, 5)).toBe("88.55");
    expect(conditionForPercent(-5)).toBe("BELOW");
    expect(conditionForPercent(10)).toBe("ABOVE");
  });

  it("preserves one decimal separator while sanitizing input", () => {
    expect(sanitizeTargetInput("$1,234.5.6abc")).toBe("1234.56");
  });

  it("rejects empty, non-positive, and already-satisfied targets", () => {
    const validate = (condition: "ABOVE" | "BELOW", targetPrice: string) =>
      validatePriceAlertTarget({
        assetId: "asset-1",
        condition,
        targetPrice,
        currentPrice: 100,
        existingAlerts: [],
      }).error;

    expect(validate("ABOVE", "")).toBe("REQUIRED");
    expect(validate("ABOVE", "0")).toBe("INVALID");
    expect(validate("ABOVE", "90")).toBe("ALREADY_SATISFIED");
    expect(validate("BELOW", "110")).toBe("ALREADY_SATISFIED");
  });

  it("blocks only an identical asset, direction, and target", () => {
    const existingAlerts = [alert()];
    const validate = (targetPrice: string) =>
      validatePriceAlertTarget({
        assetId: "asset-1",
        condition: "ABOVE",
        targetPrice,
        currentPrice: 100,
        existingAlerts,
      }).error;

    expect(validate("105.00")).toBe("DUPLICATE");
    expect(validate("110")).toBeUndefined();
  });
});
