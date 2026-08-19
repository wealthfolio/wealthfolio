import {
  createFormatter,
  dateFnsLocaleFor,
  formatAmount,
  formatCompactAmount,
  formatCurrencySymbol,
  formatPercent,
  formatPrice,
  formatQuantity,
  parseDateTimeInTimezone,
  parseLocalizedDecimalString,
  parseLocalizedDate,
  parseLocalizedNumber,
  resolveFormattingLocale,
} from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";
import { formatOptionSubtitle } from "./occ-symbol";

describe("locale formatting", () => {
  it("fails clearly for missing or invalid required locale configuration", () => {
    expect(() => resolveFormattingLocale(undefined)).toThrow("A formatting locale is required");
    expect(() => resolveFormattingLocale("not_a_locale")).toThrow("Invalid formatting locale");
    expect(() => resolveFormattingLocale("ZZ")).toThrow("Invalid formatting locale");
  });

  it("resolves regions to authoritative formatting locales", () => {
    expect(resolveFormattingLocale("de-DE", "en")).toBe("de-DE");
    expect(resolveFormattingLocale("DE", "en")).toBe("de-DE");
    expect(resolveFormattingLocale("DE", "ja")).toBe("de-DE");
    expect(resolveFormattingLocale("en-US", "fr")).toBe("en-US");
  });

  it("preserves a language-only system locale", () => {
    const languages = vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en"]);

    try {
      const locale = resolveFormattingLocale("system");
      expect(locale).toBe("en");
      expect(resolveFormattingLocale(locale)).toBe("en");
    } finally {
      languages.mockRestore();
    }
  });

  it("formats an English UI using the resolved Germany locale", () => {
    const formatter = createFormatter(resolveFormattingLocale("DE", "en"));
    expect(formatter.formatDecimal(1234.56)).toBe("1.234,56");
  });

  it.each(["en", "ja", "ko", "zh"])(
    "keeps German conventions authoritative with a %s UI",
    (uiLocale) => {
      const locale = resolveFormattingLocale("DE", uiLocale);
      const formatter = createFormatter(locale, "UTC");
      expect(locale).toBe("de-DE");
      expect(formatter.formatDecimal(1234.56)).toBe("1.234,56");
      expect(formatter.formatAmount(1234.56, "EUR")).toMatch(/^1\.234,56\s*€/);
      expect(formatter.formatPercent(0.125, { digits: 1 })).toMatch(/^12,5\s*%$/);
    },
  );

  it("combines date-fns UI language with regional week conventions", () => {
    const locale = dateFnsLocaleFor("en-DE");
    expect(locale.localize.month(0)).toBe("January");
    expect(locale.options?.weekStartsOn).toBe(1);
    expect(dateFnsLocaleFor("zh-HK").options?.weekStartsOn).toBe(0);
    expect(dateFnsLocaleFor("es-MX").localize.month(0)).toBe("enero");
    expect(dateFnsLocaleFor("es-MX").options?.weekStartsOn).toBe(0);
    expect(() => dateFnsLocaleFor(undefined)).toThrow("A resolved formatting locale is required");
  });

  it.each(["it-IT", "pt-BR", "nl-NL", "ar-EG", "fa-IR"])(
    "supports the arbitrary system locale %s in date-fns calendars",
    (locale) => {
      const dateFnsLocale = dateFnsLocaleFor(locale);
      const expectedMonth = new Intl.DateTimeFormat(locale, {
        calendar: "gregory",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2020, 0, 1)));

      expect(dateFnsLocale.localize.month(0)).toBe(expectedMonth);
    },
  );

  it("parses locale-specific grouping and decimal separators", () => {
    expect(parseLocalizedNumber("$1,234.56", "en-US")).toBe(1234.56);
    expect(parseLocalizedNumber("$1,234.56", "fr-FR")).toBe(1234.56);
    expect(parseLocalizedNumber("1.234,56 €", "de-DE")).toBe(1234.56);
    expect(parseLocalizedNumber("1234.56", "de-DE")).toBe(1234.56);
    expect(parseLocalizedNumber("1,234.56", "de-DE")).toBe(1234.56);
    expect(parseLocalizedNumber("1.234", "de-DE")).toBe(1234);
    expect(parseLocalizedNumber("1\u202f234,56 $", "fr-CA")).toBe(1234.56);
    expect(parseLocalizedNumber("1,234", "en-US")).toBe(1234);
    expect(parseLocalizedNumber("1,234", "de-DE")).toBe(1.234);
    expect(parseLocalizedNumber("-$1,234.56", "en-US")).toBe(-1234.56);
    expect(parseLocalizedNumber(".5", "en-US")).toBe(0.5);
    expect(parseLocalizedNumber("1.", "en-US")).toBe(1);
    expect(parseLocalizedNumber("1\u202f234,56\u00a0$US", "fr-FR")).toBe(1234.56);
    expect(parseLocalizedNumber("元\u00a01,234.56", "ja-JP")).toBe(1234.56);
  });

  it("normalizes localized decimals as precision-preserving invariant strings", () => {
    expect(parseLocalizedDecimalString("123456789012345678,12345678", "de-DE")).toBe(
      "123456789012345678.12345678",
    );
    expect(parseLocalizedDecimalString("1234.56", "de-DE")).toBe("1234.56");
    expect(parseLocalizedDecimalString("١٬٢٣٤٫٥٦", "ar-EG")).toBe("1234.56");
    expect(parseLocalizedDecimalString("1,23", "en-US")).toBeUndefined();
  });

  it.each([
    ["fr-FR", "USD"],
    ["fr-FR", "CAD"],
    ["ja-JP", "CNY"],
    ["zh-CN", "JPY"],
    ["ko-KR", "CNY"],
    ["pl-PL", "PLN"],
    ["sv-SE", "SEK"],
    ["da-DK", "DKK"],
    ["nb-NO", "NOK"],
    ["ar-EG", "EGP"],
    ["en-GB", "GBp"],
  ])("parses its own %s %s currency output", (locale, currency) => {
    const formatter = createFormatter(locale);
    expect(formatter.parseNumber(formatter.formatAmount(1234, currency))).toBe(1234);
  });

  it("parses system locales with non-Western grouping and digits", () => {
    expect(parseLocalizedNumber("12,34,567.89", "en-IN")).toBe(1234567.89);
    expect(parseLocalizedNumber("١٬٢٣٤٬٥٦٧٫٨٩", "ar-EG")).toBe(1234567.89);
  });

  it.each(["ja-JP", "ko-KR", "zh-CN"])("normalizes full-width numeric input for %s", (locale) => {
    expect(parseLocalizedNumber("１，２３４．５６", locale)).toBe(1234.56);
    expect(createFormatter(locale).parseNumber("１，２３４．５６")).toBe(1234.56);
  });

  it("rejects malformed mixed separators", () => {
    expect(parseLocalizedNumber("1,234.5.6", "en-US")).toBeUndefined();
    expect(parseLocalizedNumber("1,23", "en-US")).toBeUndefined();
    expect(parseLocalizedNumber("1.234,56", "en-US")).toBeUndefined();
    expect(parseLocalizedNumber("abc123", "en-US")).toBeUndefined();
  });

  it("parses ISO before the selected locale date order", () => {
    expect(parseLocalizedDate("2026-07-10", "en-US")?.getDate()).toBe(10);
    expect(parseLocalizedDate("2026/08/18", "en-US")).toEqual(new Date(2026, 7, 18));
    expect(parseLocalizedDate("07/10/2026", "en-US")?.getMonth()).toBe(6);
    expect(parseLocalizedDate("10/07/2026", "en-GB")?.getMonth()).toBe(6);
    expect(parseLocalizedDate("2026-07-10T00:00:00.000Z", "en-US")?.toISOString()).toBe(
      "2026-07-10T00:00:00.000Z",
    );
  });

  it.each(["fa-IR", "th-TH"])(
    "keeps ISO date-only values Gregorian for the %s calendar",
    (locale) => {
      expect(parseLocalizedDate("2026-08-18", locale)).toEqual(new Date(2026, 7, 18));
    },
  );

  it("preserves month-name and RFC date paste formats", () => {
    expect(parseLocalizedDate("3-Jan-2023", "en-US")?.getDate()).toBe(3);
    expect(parseLocalizedDate("August 18, 2026", "en-US")?.getMonth()).toBe(7);
    expect(parseLocalizedDate("Tue, 18 Aug 2026 00:00:00 GMT", "en-US")?.toISOString()).toBe(
      "2026-08-18T00:00:00.000Z",
    );
  });

  it.each([
    ["Jul 3, 2026", new Date(2026, 6, 3)],
    ["Jan 5, 2026", new Date(2026, 0, 5)],
    ["Nov 9, 2026", new Date(2026, 10, 9)],
    ["Jul 15, 2026", new Date(2026, 6, 15)],
  ])("does not confuse the day with a Japanese month in %s", (value, expected) => {
    expect(parseLocalizedDate(value, "ja-JP")).toEqual(expected);
  });

  it("parses localized month names and CJK full-width calendar dates", () => {
    const spanish = createFormatter("es-ES");
    const rendered = spanish.formatDate(new Date(2023, 0, 3));
    expect(rendered).toBe("3 ene 2023");
    expect(spanish.parseDate(rendered)?.getMonth()).toBe(0);
    expect(spanish.parseDate(rendered)?.getDate()).toBe(3);
    expect(parseLocalizedDate("２０２６/８/１８", "ja-JP")?.getFullYear()).toBe(2026);
    expect(parseLocalizedDate("２０２６/８/１８", "ja-JP")?.getMonth()).toBe(7);
    expect(parseLocalizedDate("２０２６/８/１８", "ja-JP")?.getDate()).toBe(18);
  });

  it.each(["ar-EG", "fa-IR", "th-TH"])(
    "round-trips native digits and calendars for %s",
    (locale) => {
      const formatter = createFormatter(locale);
      const rendered = formatter.formatCalendarDate("2026-08-18", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
      const parsed = formatter.parseDate(rendered);

      expect(parsed?.getFullYear()).toBe(2026);
      expect(parsed?.getMonth()).toBe(7);
      expect(parsed?.getDate()).toBe(18);

      const mediumParsed = formatter.parseDate(formatter.formatCalendarDate("2026-08-18"));
      expect(mediumParsed?.getFullYear()).toBe(2026);
      expect(mediumParsed?.getMonth()).toBe(7);
      expect(mediumParsed?.getDate()).toBe(18);
    },
  );

  it("interprets wall-clock datetimes in the configured timezone", () => {
    expect(parseDateTimeInTimezone("2026-08-18 09:00", "Asia/Tokyo")?.toISOString()).toBe(
      "2026-08-18T00:00:00.000Z",
    );
    expect(parseDateTimeInTimezone("2026-08-18T09:00:00-04:00", "Asia/Tokyo")?.toISOString()).toBe(
      "2026-08-18T13:00:00.000Z",
    );
  });

  it("preserves the published standalone formatter exports", () => {
    expect(formatAmount(1234.56, "USD")).toBe("$1,234.56");
    expect(formatPrice(1.2345, "USD")).toBe("$1.2345");
    expect(formatCompactAmount(1_250_000, "USD")).toBe("$1.25M");
    expect(formatPercent(0.125)).toBe("12.50%");
    expect(formatQuantity(1234.5)).toBe("1,234.5");
    expect(formatCurrencySymbol("USD")).toBe("$");
    expect(formatCurrencySymbol("CAD")).toBe("$");
    expect(formatCurrencySymbol("CNY")).toBe("¥");
    expect(formatAmount(1234.4, "JPY")).toBe("¥1,234.40");
    expect(formatAmount(1234.4, "KWD")).toBe("KWD 1,234.40");
  });

  it("does not apply the configured timezone to calendar dates", () => {
    const formatter = createFormatter("en-CA", "Pacific/Honolulu");
    expect(
      formatter.formatCalendarDate("2026-07-10", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    ).toBe("2026-07-10");
  });

  it.each(["ja-JP", "ko-KR", "zh-CN"])(
    "uses the locale's native calendar range pattern for %s",
    (locale) => {
      const options: Intl.DateTimeFormatOptions = {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      };
      const expected = new Intl.DateTimeFormat(locale, options).formatRange(
        new Date(Date.UTC(2026, 6, 1)),
        new Date(Date.UTC(2026, 6, 3)),
      );
      expect(
        createFormatter(locale).formatCalendarDateRange("2026-07-01", "2026-07-03", options),
      ).toBe(expected);
    },
  );

  it("formats the same values according to locale", () => {
    const us = createFormatter("en-US");
    const de = createFormatter("de-DE");
    expect(us.formatDecimal(1234.56)).toBe("1,234.56");
    expect(de.formatDecimal(1234.56)).toBe("1.234,56");
    expect(us.formatDate(new Date(2026, 6, 10), { dateStyle: "short" })).not.toBe(
      de.formatDate(new Date(2026, 6, 10), { dateStyle: "short" }),
    );
  });

  it("preserves currency placement, grouping, signs, compact values, percentages, and quantities", () => {
    const us = createFormatter("en-US");
    const de = createFormatter("de-DE");
    const fr = createFormatter("fr-FR");

    expect(us.formatAmount(-1234.56, "USD")).toBe("-$1,234.56");
    expect(de.formatAmount(1234.56, "EUR")).toMatch(/^1\.234,56\s*€/);
    expect(fr.formatAmount(1234.56, "EUR")).toMatch(/^1[\u00a0\u202f ]234,56\s*€/);
    expect(us.formatCompactAmount(1_250_000, "USD")).toBe("$1.25M");
    expect(fr.formatCompactAmount(1_250_000, "EUR")).toMatch(/^1,25\s*M\s*€/);
    expect(us.formatPercent(-0.125)).toBe("-12.50%");
    expect(fr.formatPercent(0.125)).toMatch(/^12,50[\u00a0\u202f ]%$/);
    expect(us.formatQuantity(1234.56789)).toBe("1,234.56789");
    expect(fr.formatQuantity(1234.56789)).toMatch(/^1[\u00a0\u202f ]234,56789$/);
    expect(us.formatRoundedAmount(1234.56, "GBp")).toBe("1,235p");
    expect(us.formatPercent(0, { signDisplay: "exceptZero" })).toBe("0.00%");
  });

  it("uses each currency's standard minor units for amounts", () => {
    const ja = createFormatter("ja-JP");
    const ko = createFormatter("ko-KR");
    const en = createFormatter("en-US");

    expect(ja.formatAmount(1234.4, "JPY")).toBe(
      new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(1234.4),
    );
    expect(ko.formatAmount(1234.4, "KRW")).toBe(
      new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW" }).format(1234.4),
    );
    expect(en.formatAmount(1.2345, "KWD")).toBe(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "KWD" }).format(1.2345),
    );
    expect(ja.formatAmount(1234.4, "JPY", false)).toBe("1,234");
    expect(en.formatAmount(1.2345, "KWD", false)).toBe("1.235");
    expect(ja.formatAmount(-0.4, "JPY")).not.toContain("-");
  });

  it("keeps formatter instances isolated and converts timestamps by timezone", () => {
    const losAngeles = createFormatter("en-US", "America/Los_Angeles");
    const tokyo = createFormatter("en-US", "Asia/Tokyo");
    const instant = "2026-07-10T01:30:00.000Z";
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    };

    expect(losAngeles.formatDateTime(instant, options)).toBe("07/09/2026, 18:30");
    expect(tokyo.formatDateTime(instant, options)).toBe("07/10/2026, 10:30");
    expect(losAngeles.formatDecimal(1234.5)).toBe("1,234.5");
    expect(createFormatter("fr-FR").formatDecimal(1234.5)).toMatch(/^1[\u00a0\u202f ]234,5$/);
    expect(losAngeles.formatDecimal(1234.5)).toBe("1,234.5");
  });

  it("honors an explicit per-call timezone over the configured timezone", () => {
    const formatter = createFormatter("en-US", "America/Los_Angeles");
    expect(
      formatter.formatDate("2026-07-10T00:00:00.000Z", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    ).toBe("Jul 10, 2026");
  });

  it("injects one formatter into pure formatting helpers", () => {
    const formatting = createFormatter("de-DE");
    expect(formatting.formatAmount(1234.56, "EUR")).toMatch(/1\.234,56/);
    expect(formatting.formatPercent(0.125)).toBe("12,50 %");
    expect(
      formatOptionSubtitle(
        {
          underlying: "AAPL",
          expiration: "2026-07-23",
          strikePrice: 1234.5,
          optionType: "CALL",
        },
        formatting,
      ),
    ).toContain("$1.234,5");
  });
});
