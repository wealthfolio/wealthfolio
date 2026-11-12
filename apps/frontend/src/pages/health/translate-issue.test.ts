import { createFormatter } from "@wealthfolio/ui";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";

import enHealth from "@/i18n/locales/en/health.json";
import frHealth from "@/i18n/locales/fr/health.json";
import type { EngineActivityIssue } from "@/lib/types";
import { translateActivityReason } from "./translate-issue";

const activity = (code: string, params?: Record<string, string>): EngineActivityIssue => ({
  activityId: "buy-1",
  kind: "REJECTED",
  message: "raw fallback message",
  reason: { code, params },
});

async function translator(language = "en") {
  const instance = createInstance();
  await instance.init({
    lng: language,
    resources: { en: { health: enHealth }, fr: { health: frHealth } },
  });
  return instance.getFixedT(language);
}

describe("activity reason translations", () => {
  it.each([
    ["MISSING_FX_RATE", { from: "USD", to: "GBp", date: "2025-01-06" }],
    ["CLOSE_BUY_WITHOUT_SHORT_POSITION", { asset: "aapl" }],
    ["SELL_SHORT_INTENT_REQUIRED", { asset: "aapl" }],
    ["CONVERSION_INSUFFICIENT_HOLDINGS", { asset: "aapl", requested: "15", held: "10" }],
    [
      "CONVERSION_CURRENCY_MISMATCH",
      { fromAsset: "a", fromCurrency: "USD", toAsset: "b", toCurrency: "EUR" },
    ],
    ["RETURN_OF_CAPITAL_AMOUNT_REQUIRED", undefined],
    ["SELL_WITHOUT_POSITION", { asset: "aapl" }],
    ["INSUFFICIENT_QUANTITY", { asset: "aapl", requested: "15", held: "10", excess: "5" }],
    ["MISSING_FINAL_CASH", undefined],
  ] as const)("translates %s", async (code, params) => {
    const result = translateActivityReason(
      await translator(),
      activity(code, params),
      createFormatter("en-US", "UTC"),
    );
    expect(result).not.toBe("raw fallback message");
    expect(result).not.toContain("{{");
    expect(result).not.toContain("activityReasons");
  });

  it("uses the selected language and locale for dates and quantities", async () => {
    const t = await translator("fr");
    const formatting = createFormatter("fr-FR", "America/Toronto");
    const fx = translateActivityReason(
      t,
      activity("MISSING_FX_RATE", { from: "USD", to: "EUR", date: "2025-01-06" }),
      formatting,
    );
    expect(fx).toContain("Aucun taux de change");
    expect(fx).toContain("6 janv. 2025");
    const quantity = translateActivityReason(
      t,
      activity("CONVERSION_INSUFFICIENT_HOLDINGS", {
        asset: "aapl",
        requested: "1000.5",
        held: "500",
      }),
      formatting,
    );
    expect(quantity).toContain(formatting.formatQuantity("1000.5"));
    expect(quantity).not.toContain("1000.5");
  });

  it.each([undefined, "FUTURE_REASON", "__proto__"])(
    "keeps the fallback for legacy or unknown reasons (%s)",
    async (code) => {
      const issue = activity(code ?? "");
      if (code === undefined) delete issue.reason;
      expect(translateActivityReason(await translator(), issue, createFormatter("en-US"))).toBe(
        issue.message,
      );
    },
  );
});
