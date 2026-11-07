import { FormattingProvider } from "@wealthfolio/ui";
import { renderHook } from "@/test/render";
import i18n from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import arAsset from "@/i18n/locales/ar/asset.json";
import { useLoanFormat } from "./use-loan-format";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

const durationOf = (months: number) => {
  const { result } = renderHook(() => useLoanFormat("USD"));
  return result.current.duration(months);
};

describe("useLoanFormat duration", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it.each([
    [0, "0 months"],
    [5, "5 months"],
    [12, "1 year"],
    [27, "2 years 3 months"],
  ])("formats %s months in English", (months, expected) => {
    expect(durationOf(months)).toBe(expected);
  });

  it.each([
    [24, "سنتان"],
    [27, "سنتان و3 أشهر"],
    [13, "سنة واحدة وشهر واحد"],
    [134, "11 سنةً وشهران"],
  ])("joins years and months with و in Arabic for %s months", async (months, expected) => {
    i18n.addResourceBundle("ar", "asset", arAsset);
    await i18n.changeLanguage("ar");
    expect(durationOf(months)).toBe(expected);
  });
});

it("formats loan rates using the region independently of the interface language", () => {
  const { result } = renderHook(() => useLoanFormat("USD"), {
    wrapper: ({ children }) => <FormattingProvider locale="ES">{children}</FormattingProvider>,
  });
  expect(result.current.rate(5.25)).toMatch(/5,25\s%/);
  expect(result.current.rate(5)).toMatch(/5\s%/);
});
