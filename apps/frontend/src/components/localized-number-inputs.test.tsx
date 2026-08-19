import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFormatter, FormattingProvider, MoneyInput, QuantityInput } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";

function paste(text: string) {
  return fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { getData: () => text },
  });
}

describe("localized financial input typing", () => {
  it.each([
    ["money", "de-DE", "1.5", "1,5", 1.5],
    ["quantity", "de-DE", "1.5", "1,5", 1.5],
    ["money", "en-US", "1,5", "1.5", 1.5],
    ["quantity", "en-US", "1,5", "1.5", 1.5],
  ] as const)(
    "accepts an alternate decimal separator in the %s input for %s",
    async (inputKind, locale, typedValue, displayedValue, expected) => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <FormattingProvider locale={locale}>
          {inputKind === "money" ? (
            <MoneyInput onValueChange={onValueChange} />
          ) : (
            <QuantityInput onValueChange={onValueChange} />
          )}
        </FormattingProvider>,
      );

      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.type(input, typedValue);

      expect(input).toHaveValue(displayedValue);
      expect(onValueChange).toHaveBeenLastCalledWith(expected);
    },
  );

  it.each([
    ["money", 2, "12.345", "12.34", 12.34],
    ["quantity", 4, "12.34567", "12.3456", 12.3456],
  ] as const)(
    "enforces the configured precision in the %s input",
    async (inputKind, maxDecimalPlaces, typedValue, displayedValue, expected) => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <FormattingProvider locale="en-US">
          {inputKind === "money" ? (
            <MoneyInput maxDecimalPlaces={maxDecimalPlaces} onValueChange={onValueChange} />
          ) : (
            <QuantityInput maxDecimalPlaces={maxDecimalPlaces} onValueChange={onValueChange} />
          )}
        </FormattingProvider>,
      );

      const input = screen.getByRole<HTMLInputElement>("textbox");
      await user.type(input, typedValue);

      expect(input).toHaveValue(displayedValue);
      expect(onValueChange).toHaveBeenLastCalledWith(expected);
    },
  );

  it("allows negative quantities only when configured", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale="en-US">
        <QuantityInput allowNegative onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    const input = screen.getByRole<HTMLInputElement>("textbox");
    await user.type(input, "-12.5");

    expect(input).toHaveValue("-12.5");
    expect(onValueChange).toHaveBeenLastCalledWith(-12.5);
  });

  it("rejects negative keyboard values by default", async () => {
    const user = userEvent.setup();
    const onMoneyChange = vi.fn();
    const onQuantityChange = vi.fn();
    render(
      <FormattingProvider locale="en-US">
        <MoneyInput aria-label="Amount" onValueChange={onMoneyChange} />
        <QuantityInput aria-label="Quantity" onValueChange={onQuantityChange} />
      </FormattingProvider>,
    );

    await user.type(screen.getByRole("textbox", { name: "Amount" }), "-12.5");
    await user.type(screen.getByRole("textbox", { name: "Quantity" }), "-12.5");

    expect(onMoneyChange).toHaveBeenLastCalledWith(12.5);
    expect(onQuantityChange).toHaveBeenLastCalledWith(12.5);
    expect(onMoneyChange.mock.calls.every(([value]) => value === undefined || value >= 0)).toBe(
      true,
    );
    expect(onQuantityChange.mock.calls.every(([value]) => value === undefined || value >= 0)).toBe(
      true,
    );
  });

  it("renders configured grouping and fixed decimal scale", () => {
    render(
      <FormattingProvider locale="en-US">
        <MoneyInput
          aria-label="Amount"
          value={1234.5}
          maxDecimalPlaces={2}
          fixedDecimalScale
          thousandSeparator
        />
        <QuantityInput aria-label="Quantity" value={1234.5} />
      </FormattingProvider>,
    );

    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("1,234.50");
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveValue("1,234.5");
  });

  it("keeps the legacy change contract when the preferred handler is absent", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FormattingProvider locale="en-US">
        <MoneyInput name="amount" onChange={onChange} />
      </FormattingProvider>,
    );

    await user.type(screen.getByRole("textbox"), "12.5");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { name: "amount", value: 12.5 } }),
    );
  });

  it("prefers the numeric change handler over the legacy handler", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const onChange = vi.fn();
    render(
      <FormattingProvider locale="en-US">
        <QuantityInput onValueChange={onValueChange} onChange={onChange} />
      </FormattingProvider>,
    );

    await user.type(screen.getByRole("textbox"), "12.5");

    expect(onValueChange).toHaveBeenLastCalledWith(12.5);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("localized financial input paste", () => {
  it.each([
    ["1234.56", 1234.56],
    ["1,234.56", 1234.56],
    ["$1,234.56", 1234.56],
    ["USD 1,234.56", 1234.56],
  ])("pastes %s using US formats", (clipboardValue, expected) => {
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale="en-US">
        <MoneyInput onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    paste(clipboardValue);

    expect(onValueChange).toHaveBeenLastCalledWith(expected);
  });

  it.each([
    ["1234,56", 1234.56],
    ["1.234,56", 1234.56],
    ["1.234,56 €", 1234.56],
    ["1234.56", 1234.56],
    ["1,234.56", 1234.56],
  ])("pastes %s using German formats", (clipboardValue, expected) => {
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale="de-DE">
        <MoneyInput onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    paste(clipboardValue);

    expect(onValueChange).toHaveBeenLastCalledWith(expected);
  });

  it.each([
    ["1.234,56", "money"],
    ["-100", "money"],
    ["1.234,56", "quantity"],
    ["-100", "quantity"],
  ] as const)(
    "blocks rejected %s full-value pastes in %s inputs",
    async (clipboardValue, inputKind) => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(
        <FormattingProvider locale="en-US">
          {inputKind === "money" ? (
            <MoneyInput onValueChange={onValueChange} />
          ) : (
            <QuantityInput onValueChange={onValueChange} />
          )}
        </FormattingProvider>,
      );
      const input = screen.getByRole<HTMLInputElement>("textbox");

      await user.click(input);
      await user.paste(clipboardValue);

      expect(input).toHaveValue("");
      expect(onValueChange).not.toHaveBeenCalled();
    },
  );

  it("uses the same locale-aware paste behavior for quantities", () => {
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale="de-DE">
        <QuantityInput onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    paste("1.234,56");

    expect(onValueChange).toHaveBeenLastCalledWith(1234.56);
  });

  it("pastes invariant decimals into German quantities", () => {
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale="de-DE">
        <QuantityInput onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    paste("1234.56");

    expect(onValueChange).toHaveBeenLastCalledWith(1234.56);
  });

  it("normalizes full-width CJK numeric input", () => {
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale="ja-JP">
        <MoneyInput onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    paste("￥１，２３４．５６");

    expect(onValueChange).toHaveBeenLastCalledWith(1234.56);
  });

  it.each([
    ["fr-FR", "1\u202f234,56\u00a0$US"],
    ["ja-JP", "元\u00a01,234.56"],
  ])("pastes localized currency output for %s", (locale, clipboardValue) => {
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale={locale}>
        <MoneyInput onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    paste(clipboardValue);

    expect(onValueChange).toHaveBeenLastCalledWith(1234.56);
  });

  it.each([
    ["pl-PL", "PLN"],
    ["sv-SE", "SEK"],
    ["da-DK", "DKK"],
    ["nb-NO", "NOK"],
    ["ar-EG", "EGP"],
  ])("pastes the formatter's own %s %s currency output", (locale, currency) => {
    const onValueChange = vi.fn();
    const formatted = createFormatter(locale).formatAmount(1234.56, currency);
    render(
      <FormattingProvider locale={locale}>
        <MoneyInput onValueChange={onValueChange} />
      </FormattingProvider>,
    );

    paste(formatted);

    expect(onValueChange).toHaveBeenLastCalledWith(1234.56);
  });

  it("leaves partial plain-number pastes to the input", () => {
    const onValueChange = vi.fn();
    render(
      <FormattingProvider locale="en-US">
        <MoneyInput value={100} onValueChange={onValueChange} />
      </FormattingProvider>,
    );
    const input = screen.getByRole<HTMLInputElement>("textbox");
    input.setSelectionRange(1, 2);

    const allowed = fireEvent.paste(input, {
      clipboardData: { getData: () => "5" },
    });

    expect(allowed).toBe(true);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
