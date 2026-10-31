import { describe, expect, it } from "vitest";
import { mayUseRedForGains } from "@/themes/gain-colors";

describe("mayUseRedForGains", () => {
  it("asks for the languages of markets where red means up", () => {
    for (const language of ["zh", "zh-Hant", "ja", "ko"]) {
      expect(mayUseRedForGains({ language })).toBe(true);
    }
  });

  it("asks for those markets' formatting regions and currencies", () => {
    for (const formattingRegion of ["CN", "TW", "JP", "KR"]) {
      expect(mayUseRedForGains({ language: "en", formattingRegion })).toBe(true);
    }
    for (const baseCurrency of ["CNY", "TWD", "JPY", "KRW"]) {
      expect(mayUseRedForGains({ language: "en", baseCurrency })).toBe(true);
    }
  });

  it("asks again once other colours are picked", () => {
    expect(mayUseRedForGains({ language: "en", gainColors: "red-up" })).toBe(true);
  });

  it("doesn't ask elsewhere, including Hong Kong, which is green up", () => {
    expect(mayUseRedForGains(undefined)).toBe(false);
    expect(
      mayUseRedForGains({
        language: "en",
        formattingRegion: "system",
        baseCurrency: "HKD",
        gainColors: "green-up",
      }),
    ).toBe(false);
    expect(mayUseRedForGains({ language: "fr", formattingRegion: "FR", baseCurrency: "EUR" })).toBe(
      false,
    );
  });
});
