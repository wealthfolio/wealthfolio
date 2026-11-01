import { describe, expect, it } from "vitest";

import enAllocation from "@/i18n/locales/en/allocation.json";
import enInsights from "@/i18n/locales/en/insights.json";

import { BUILT_IN_PRESETS, modelPresetTitle } from "./model-preset-data";

interface Catalog {
  [key: string]: string | Catalog;
}

function strings(catalog: Catalog, prefix = ""): [string, string][] {
  return Object.entries(catalog).flatMap(([key, value]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [[path, value]] : strings(value, path);
  });
}

const allocationStrings = strings(enAllocation);
const worksheetStrings = allocationStrings.filter(([key]) => key.startsWith("worksheet."));
/** The Insights card that compares the portfolio with its target. */
const targetCardStrings = strings(enInsights.insights.rails, "insights.rails");
const targetCopy = [...allocationStrings, ...targetCardStrings];

/** Stating what the app does not do may name it. */
const DISCLOSURES = new Set(["worksheet.firstUseDisclosure"]);

// English is the source every locale translates, so the contract is checked
// there. Key parity across locales is checked by scripts/check-translations.mjs.
describe("allocation copy contract (spec §7 and §10)", () => {
  it("keeps no string from the removed planner", () => {
    for (const block of ["planner", "trades", "rebalance", "csv", "copyText"]) {
      expect(enAllocation).not.toHaveProperty(block);
    }
    expect(Object.keys(enAllocation.mode)).toEqual(["enableSellsTip"]);
    expect(enAllocation.worksheet).not.toHaveProperty("acknowledgeWarnings");
    expect(enAllocation.worksheet).not.toHaveProperty("acknowledgeExport");
    for (const key of ["suggested_moves", "add", "trim"]) {
      expect(enInsights.insights.rails).not.toHaveProperty(key);
    }
  });

  it("avoids the words §7 rules out", () => {
    const avoided = [
      /\b(proposed|suggested|generated) (trades?|moves?|orders?)\b/i,
      /\brecommended\b/i,
      /\b(optimal|best|ideal|should)\b/i,
      /\ballocation strategy\b/i,
      /\bmissing trades?\b/i,
      /\b(cash-flow only|sell to rebalance)\b/i,
      /\bno (action|rebalancing) (required|needed)\b/i,
      /\bplan\b/i,
    ];

    const offending = targetCopy.filter(([, text]) =>
      avoided.some((pattern) => pattern.test(text)),
    );

    expect(offending).toEqual([]);
  });

  it("words target copy as increases and reductions, never as orders", () => {
    const orderWords = /\b(buys?|sells?|selling|sold|trades?|orders?)\b/i;

    const offending = targetCopy.filter(
      ([key, text]) => !DISCLOSURES.has(key) && orderWords.test(text),
    );

    expect(offending).toEqual([]);
  });

  it("names the two modes and the two actions that regenerate", () => {
    expect(enAllocation.worksheet.modeInvestCash).toBe("Invest cash");
    expect(enAllocation.worksheet.modeRebalance).toBe("Rebalance");
    expect(enAllocation.worksheet.recalculateFromTarget).toBe("Recalculate from target");
    expect(enAllocation.worksheet.resetToCalculated).toBe("Reset to calculated adjustments");
  });

  it("says the adjustments were calculated, not entered into an empty worksheet", () => {
    expect(enAllocation.worksheet.reviewDisclaimer).toBe(
      "Wealthfolio calculated these adjustments from your target, eligible securities, and allocation rule. Review and edit them before using the result. Nothing is submitted or executed.",
    );

    // The reference branch's wording, from before the worksheet was prefilled.
    const startsEmpty =
      /\bchanges you entered\b|\bentered by the user\b|\bchanges you want to model\b|\b(starts?|begins?) (empty|blank)\b/i;

    expect(worksheetStrings.filter(([, text]) => startsEmpty.test(text))).toEqual([]);
  });

  it("titles every example by its weights, under the §10 disclosure", () => {
    for (const preset of BUILT_IN_PRESETS) {
      for (const field of ["name", "description", "risk", "featured", "sourceLabel"]) {
        expect(preset).not.toHaveProperty(field);
      }
      expect(modelPresetTitle(preset, [])).toMatch(/^\d+(\.\d)?% \S/);
    }
    expect(enAllocation.presets.disclosure).toBe(
      "Example weights only. They are not recommendations, and Wealthfolio has not assessed whether they fit you.",
    );
  });
});
