import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseCurrencyForm } from "./currency-settings";

const updateBaseCurrency = vi.fn();
let pickedCurrency = "";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" }, updateBaseCurrency }),
}));

vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  CurrencyInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange(pickedCurrency)}>
      {value}
    </button>
  ),
}));

async function pickAndSave(currency: string) {
  pickedCurrency = currency;
  render(<BaseCurrencyForm />);
  await userEvent.click(screen.getByRole("button", { name: "USD" }));
  await userEvent.click(screen.getByRole("button", { name: "Save currency" }));
}

describe("BaseCurrencyForm", () => {
  beforeEach(() => {
    updateBaseCurrency.mockReset().mockResolvedValue(undefined);
  });

  it.each(["usd", "USDT", "GBX", "GBp"])("rejects %s as the base currency", async (currency) => {
    await pickAndSave(currency);

    expect(
      await screen.findByText("Enter a valid 3-letter currency code, such as USD."),
    ).toBeInTheDocument();
    expect(updateBaseCurrency).not.toHaveBeenCalled();
  });

  it("saves a custom 3-letter code", async () => {
    await pickAndSave("BTC");

    expect(updateBaseCurrency).toHaveBeenCalledWith("BTC");
  });
});
