import { describe, expect, it } from "vitest";
import i18nextConfig from "../../i18next.config";
import { SUPPORTED_LOCALE_CODES, normalizeLocaleCode } from "./locales";

const catalogDirectories = Object.keys(
  import.meta.glob("./locales/*/common.json", { eager: true }),
).map((path) => path.replace("./locales/", "").replace("/common.json", ""));

describe("supported locales", () => {
  // The locale list is duplicated across three places (see README "Adding a
  // language"). Two of them are TypeScript and can be checked here; the Rust
  // SUPPORTED_UI_LANGUAGES cannot be reached from this side and still has to be
  // updated by hand.
  it("keeps i18next-cli in sync with SUPPORTED_LOCALES", () => {
    expect([...i18nextConfig.locales].sort()).toEqual([...SUPPORTED_LOCALE_CODES].sort());
  });

  it("ships a catalog directory for every supported locale", () => {
    expect(catalogDirectories.sort()).toEqual([...SUPPORTED_LOCALE_CODES].sort());
  });

  it("names Chinese variants by script, not region", () => {
    // `zh` means Simplified (CLDR expands it to zh-Hans-CN) and `zh-Hant` means
    // Traditional, so one catalog serves Taiwan, Hong Kong and Macau. A
    // region-named `zh-TW` would claim a region it does not have and would leave
    // no room for a later `zh-Hant-HK` to fall back to.
    const chinese = SUPPORTED_LOCALE_CODES.filter((code) => code.startsWith("zh"));
    expect(chinese).toEqual(["zh", "zh-Hant"]);
  });

  // Add-on authors write these codes by hand, so the mapping has to be
  // forgiving about script/region spelling without ever crossing the
  // Simplified/Traditional boundary. Mirrors the Rust tests in
  // crates/core/src/settings/settings_service.rs.
  describe("normalizeLocaleCode", () => {
    it.each(["zh-TW", "zh_TW", "ZH-tw", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh-MO", "zh-Hant-HK"])(
      "maps the Traditional alias %s to zh-Hant",
      (tag) => {
        expect(normalizeLocaleCode(tag)).toBe("zh-Hant");
      },
    );

    it.each(["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-TW", "zh-Hans-HK"])(
      "keeps Simplified %s on zh",
      (tag) => {
        expect(normalizeLocaleCode(tag)).toBe("zh");
      },
    );

    it("falls back to the base language for unknown regional variants", () => {
      expect(normalizeLocaleCode("fr-CA")).toBe("fr");
      expect(normalizeLocaleCode("en_US")).toBe("en");
      expect(normalizeLocaleCode("pt-PT")).toBe("pt");
      expect(normalizeLocaleCode("vi-VN")).toBe("vi");
      expect(normalizeLocaleCode("vi_VN")).toBe("vi");
    });

    it("does not treat a Traditional region as Chinese on another language", () => {
      expect(normalizeLocaleCode("en-HK")).toBe("en");
      expect(normalizeLocaleCode("pt-MO")).toBe("pt");
    });

    it("returns every supported code unchanged", () => {
      for (const code of SUPPORTED_LOCALE_CODES) {
        expect(normalizeLocaleCode(code)).toBe(code);
      }
    });
  });
});
