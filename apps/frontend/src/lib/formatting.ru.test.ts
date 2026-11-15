import { createFormatter, dateFnsLocaleFor, parseLocalizedDate } from "@wealthfolio/ui";
import { format, formatDistance } from "date-fns";
import { describe, expect, it, vi } from "vitest";

describe("Russian locale formatting", () => {
  it("gives ru-RU Russian calendar text", () => {
    const locale = dateFnsLocaleFor("ru-RU");
    expect(format(new Date(2026, 0, 15), "d MMMM", { locale })).toBe("15 января");
    expect(formatDistance(new Date(2026, 0, 1), new Date(2026, 0, 3), { locale })).toMatch(/[а-я]/);
  });

  it("takes the Russian region's Monday week from date-fns when Intl has no week info", () => {
    const prototype = Intl.Locale.prototype as Intl.Locale & {
      getWeekInfo: () => unknown;
      weekInfo: unknown;
    };
    // Stub only what the runtime has: a spy on a missing method or accessor throws.
    const spies = [];
    if (typeof prototype.getWeekInfo === "function") {
      spies.push(vi.spyOn(prototype, "getWeekInfo").mockReturnValue(undefined));
    }
    if (Object.getOwnPropertyDescriptor(prototype, "weekInfo")?.get) {
      spies.push(vi.spyOn(prototype, "weekInfo", "get").mockReturnValue(undefined));
    }
    try {
      // An English UI with the Russian region: the week comes from the region, not the language.
      expect(dateFnsLocaleFor("en-RU").options?.weekStartsOn).toBe(1);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it.each([
    ["15 января 2026 г.", new Date(2026, 0, 15)],
    ["15 мая 2026 г.", new Date(2026, 4, 15)],
  ])("parses the Russian in-date month form in %s", (value, expected) => {
    expect(parseLocalizedDate(value, "ru-RU")).toEqual(expected);
  });

  it.each(["medium", "long"] as const)(
    "round-trips all twelve Russian months with dateStyle %s",
    (dateStyle) => {
      const russian = createFormatter("ru-RU");
      for (let month = 0; month < 12; month++) {
        const iso = `2026-${String(month + 1).padStart(2, "0")}-15`;
        const rendered = russian.formatCalendarDate(iso, { dateStyle });
        expect(russian.parseDate(rendered), rendered).toEqual(new Date(2026, month, 15));
      }
    },
  );

  describe("month-name parsing guards", () => {
    // These guard the shared monthTokens change that was made for the Russian month forms.
    it("does not let a word shared by most Catalan months hide the real month", () => {
      expect(parseLocalizedDate("15 de març de 2026", "ca-ES")).toEqual(new Date(2026, 2, 15));
    });

    it.each([
      ["1 ก.ย. 2567", new Date(2024, 8, 1)],
      ["1 พ.ย. 2567", new Date(2024, 10, 1)],
    ])(
      "keeps parsing the Thai standalone month names whose fragments repeat in %s",
      (value, expected) => {
        expect(parseLocalizedDate(value, "th-TH")).toEqual(expected);
      },
    );
  });
});
