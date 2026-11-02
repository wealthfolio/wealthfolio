import { render, screen } from "@testing-library/react";
import { FormattingProvider, GainAmount, GainPercent } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";

vi.mock("@number-flow/react", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef<
      HTMLSpanElement,
      { value: number; locales?: string; format?: Intl.NumberFormatOptions }
    >(({ value, locales, format }, ref) => (
      <span ref={ref} data-testid="animated-financial-value">
        {new Intl.NumberFormat(locales, format).format(value)}
      </span>
    )),
  };
});

describe("localized financial components", () => {
  it("preserves Wealthfolio quote-unit symbols in gain amounts", () => {
    render(
      <FormattingProvider locale="US" uiLocale="en">
        <GainAmount value={12.34} currency="GBp" />
      </FormattingProvider>,
    );
    expect(screen.getByText("+12.34p")).toBeInTheDocument();
  });

  it("formats gain amounts in the currency's own region", () => {
    render(
      <FormattingProvider locale="US" uiLocale="en" currencyFormattingRegions={{ INR: "IN" }}>
        <GainAmount value={1234567.89} currency="INR" />
        <GainAmount value={1234567.89} currency="USD" />
      </FormattingProvider>,
    );
    expect(screen.getByText("+₹12,34,567.89")).toBeInTheDocument();
    expect(screen.getByText("+$1,234,567.89")).toBeInTheDocument();
  });

  it("shows gain amounts with each currency's minor units", () => {
    render(
      <FormattingProvider locale="US" uiLocale="en">
        <GainAmount value={1234} currency="JPY" />
        <GainAmount value={1.2345} currency="KWD" />
        <GainAmount value={0.004} currency="KWD" />
        <GainAmount value={0.4} currency="JPY" displayCurrency={false} />
      </FormattingProvider>,
    );
    expect(screen.getByText("+¥1,234")).toBeInTheDocument();
    expect(screen.getByText("+KWD 1.235")).toBeInTheDocument();
    expect(screen.getByText("+KWD 0.004")).toBeInTheDocument();
    expect(screen.getByText("0").parentElement).toHaveClass("text-foreground");
  });

  it.each([
    { currency: "JPY", value: 0.4, expected: "¥0" },
    { currency: "JPY", value: -0.4, expected: "¥0" },
    { currency: "USD", value: 0.004, expected: "$0.00" },
    { currency: "USD", value: -0.004, expected: "$0.00" },
    { currency: "KWD", value: 0.0004, expected: "KWD 0.000" },
    { currency: "KWD", value: -0.0004, expected: "KWD 0.000" },
    { currency: "GBp", value: 0.004, expected: "0.00p" },
    { currency: "GBp", value: -0.004, expected: "0.00p" },
    { currency: "USD", value: 3 * 10.1 - 30.3, expected: "$0.00" },
    { currency: "USD", value: 3 * 0.1 - 0.3, expected: "$0.00" },
    { currency: "USD", value: 0, expected: "$0.00" },
    { currency: "USD", value: -0, expected: "$0.00" },
  ])("shows $value $currency as neutral rounded zero", async ({ currency, value, expected }) => {
    const { container } = render(
      <FormattingProvider locale="US">
        <GainAmount value={value} currency={currency} />
      </FormattingProvider>,
    );
    const gain = container.firstElementChild?.firstElementChild;
    expect(gain?.textContent?.replace(/[\u00a0\u202f]/g, " ")).toBe(expected);
    expect(gain).toHaveClass("text-foreground");

    await screen.findByTestId("animated-financial-value");
    expect(gain?.textContent?.replace(/[\u00a0\u202f]/g, " ")).toBe(expected);
    expect(gain).toHaveClass("text-foreground");
  });

  it.each([
    { currency: "JPY", value: 0.5, expected: "+¥1" },
    { currency: "JPY", value: -0.5, expected: "-¥1" },
    { currency: "USD", value: 0.005, expected: "+$0.01" },
    { currency: "USD", value: -0.005, expected: "-$0.01" },
    { currency: "KWD", value: 0.0005, expected: "+KWD 0.001" },
    { currency: "KWD", value: -0.0005, expected: "-KWD 0.001" },
  ])(
    "keeps $value $currency signed at the rounding boundary",
    async ({ currency, value, expected }) => {
      const { container } = render(
        <FormattingProvider locale="US">
          <GainAmount value={value} currency={currency} />
        </FormattingProvider>,
      );
      const gain = container.firstElementChild?.firstElementChild;
      expect(gain?.textContent?.replace(/[\u00a0\u202f]/g, " ")).toBe(expected);
      expect(gain).toHaveClass(value > 0 ? "text-gain" : "text-loss");

      await screen.findByTestId("animated-financial-value");
      expect(gain?.textContent?.replace(/[\u00a0\u202f]/g, " ")).toBe(expected);
      expect(gain).toHaveClass(value > 0 ? "text-gain" : "text-loss");
    },
  );

  it.each([0, -0, 0.4, -0.4])(
    "keeps whole-number gains neutral when decimals are disabled (%s)",
    async (value) => {
      const { container } = render(
        <FormattingProvider locale="US">
          <GainAmount value={value} currency="JPY" displayDecimal={false} />
        </FormattingProvider>,
      );
      const gain = container.firstElementChild?.firstElementChild;
      expect(gain).toHaveTextContent(/^¥0$/);
      expect(gain).toHaveClass("text-foreground");

      await screen.findByTestId("animated-financial-value");
      expect(gain).toHaveTextContent(/^¥0$/);
      expect(gain).toHaveClass("text-foreground");
    },
  );

  it("keeps rounded zero neutral with region, sign, symbol and inverted color options", async () => {
    const { container } = render(
      <FormattingProvider locale="US" currencyFormattingRegions={{ USD: "FR" }}>
        <GainAmount
          value={-0.004}
          currency="USD"
          displayCurrency={false}
          showSign={false}
          invertColor
        />
      </FormattingProvider>,
    );
    const gain = container.firstElementChild?.firstElementChild;
    expect(gain).toHaveTextContent(/^0,00$/);
    expect(gain).toHaveClass("text-foreground");

    await screen.findByTestId("animated-financial-value");
    expect(gain).toHaveTextContent(/^0,00$/);
    expect(gain).toHaveClass("text-foreground");
  });

  it("preserves locale percent spacing in the animated fallback", () => {
    const { container } = render(
      <FormattingProvider locale="FR" uiLocale="fr">
        <GainPercent value={0.125} animated />
      </FormattingProvider>,
    );
    expect(container.textContent).toMatch(/^\+12,50[\u00a0\u202f ]%$/);
  });
});
