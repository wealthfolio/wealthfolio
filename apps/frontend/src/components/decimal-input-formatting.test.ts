import {
  createNumberFormatting,
  localizeDecimalString,
  parseLocalizedNumber,
  parseLocalizedDecimalString,
} from "@wealthfolio/ui";
import { expect, it } from "vitest";

it.each(["en-US", "de-DE", "ar-EG", "fa-IR", "zh-CN-u-nu-hanidec"])(
  "%s preserves precision when localizing canonical decimals",
  (locale) => {
    const numbers = createNumberFormatting(locale);
    for (const value of [
      "123456789012345678.123456780000",
      "-1.125",
      "1e-7",
      String(Number.MIN_VALUE),
      String(Number.MAX_VALUE),
      "1.234567890123456789000e-7",
    ]) {
      const localized = localizeDecimalString(value, numbers);
      expect(parseLocalizedNumber(localized, locale)).toBe(Number(value));
      const canonical = parseLocalizedDecimalString(localized, locale);
      expect(canonical).toBeDefined();
      if (!value.includes("e")) expect(canonical).toBe(value);
      if (value === "1.234567890123456789000e-7")
        expect(canonical).toBe("0.0000001234567890123456789000");
    }
  },
);
