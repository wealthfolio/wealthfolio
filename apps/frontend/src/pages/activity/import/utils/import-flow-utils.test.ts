import { describe, expect, it } from "vitest";
import { createDefaultParseConfig } from "./default-activity-template";
import { mergeDetectedParseConfig, shouldUseSavedHoldingsMapping } from "./import-flow-utils";

describe("import-flow-utils", () => {
  it("keeps the final detected parse config after a template re-parse", () => {
    expect(
      mergeDetectedParseConfig(
        {
          hasHeaderRow: true,
          headerRowIndex: 0,
          delimiter: ",",
          skipTopRows: 2,
          skipBottomRows: 0,
          skipEmptyRows: true,
          dateFormat: "DD/MM/YYYY",
          decimalSeparator: ",",
          thousandsSeparator: ".",
          defaultCurrency: "CAD",
        },
        {
          dateFormat: "YYYY-MM-DD",
        },
      ),
    ).toMatchObject({
      dateFormat: "YYYY-MM-DD",
      skipTopRows: 2,
      decimalSeparator: ",",
      defaultCurrency: "CAD",
    });
  });

  it.each([
    { requested: "auto", detected: ";" },
    { requested: "\\t", detected: "\t" },
  ])(
    "keeps the requested delimiter $requested over the detected one",
    ({ requested, detected }) => {
      expect(
        mergeDetectedParseConfig(
          { ...createDefaultParseConfig("CAD"), delimiter: requested },
          { ...createDefaultParseConfig("CAD"), delimiter: detected },
        ).delimiter,
      ).toBe(requested);
    },
  );

  it("restores saved holdings mappings unless the user explicitly cleared templates", () => {
    expect(shouldUseSavedHoldingsMapping(false)).toBe(true);
    expect(shouldUseSavedHoldingsMapping(true)).toBe(false);
  });
});
