import type { PriceAlert, PriceAlertCondition } from "@/lib/types";

export const PRICE_PRESETS = [-10, -5, 5, 10] as const;

export type PriceAlertTargetError = "REQUIRED" | "INVALID" | "ALREADY_SATISFIED" | "DUPLICATE";

export function targetFromPercent(currentPrice: number, percent: number) {
  const target = currentPrice * (1 + percent / 100);
  const precision = target < 1 ? 6 : 2;
  return target.toFixed(precision).replace(/\.?0+$/, "");
}

export function conditionForPercent(percent: number): PriceAlertCondition {
  return percent < 0 ? "BELOW" : "ABOVE";
}

export function sanitizeTargetInput(value: string) {
  const sanitized = value.replace(/[^0-9.]/g, "");
  const [whole, ...fractionParts] = sanitized.split(".");
  return fractionParts.length > 0 ? `${whole}.${fractionParts.join("")}` : whole;
}

interface ValidateTargetInput {
  assetId: string;
  condition: PriceAlertCondition;
  targetPrice: string;
  currentPrice?: number;
  existingAlerts: PriceAlert[];
}

export function validatePriceAlertTarget({
  assetId,
  condition,
  targetPrice,
  currentPrice,
  existingAlerts,
}: ValidateTargetInput): { parsedTarget: number; error?: PriceAlertTargetError } {
  if (targetPrice.trim().length === 0) {
    return { parsedTarget: Number.NaN, error: "REQUIRED" };
  }

  const parsedTarget = Number(targetPrice);
  if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
    return { parsedTarget, error: "INVALID" };
  }

  if (
    currentPrice != null &&
    (condition === "ABOVE" ? parsedTarget <= currentPrice : parsedTarget >= currentPrice)
  ) {
    return { parsedTarget, error: "ALREADY_SATISFIED" };
  }

  const duplicate = existingAlerts.some(
    (alert) =>
      alert.assetId === assetId &&
      alert.condition === condition &&
      Number(alert.targetPrice) === parsedTarget,
  );
  return duplicate ? { parsedTarget, error: "DUPLICATE" } : { parsedTarget };
}
