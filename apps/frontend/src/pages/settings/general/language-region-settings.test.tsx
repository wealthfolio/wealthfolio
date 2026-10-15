import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageRegionSettings } from "./language-region-settings";

async function renderSettings() {
  const view = render(<LanguageRegionSettings />);
  await userEvent.click(screen.getByRole("button", { name: /Customize currency formats/ }));
  return view;
}

const updateSettings = vi.fn();
let currencyFormattingRegions: Record<string, string> = {};

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: {
      language: "en",
      formattingRegion: "US",
      timezone: "UTC",
      currencyFormattingRegions,
    },
    updateSettings,
  }),
}));

vi.mock("@/components/language-selector", () => ({ LanguageSelector: () => null }));
vi.mock("./timezone-input", () => ({ TimezoneInput: () => null }));

vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  CurrencyInput: ({
    id,
    value,
    onChange,
    "aria-label": ariaLabel,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    "aria-label"?: string;
  }) => (
    <button type="button" id={id} aria-label={ariaLabel} onClick={() => onChange("USD")}>
      {value}
    </button>
  ),
}));

describe("LanguageRegionSettings currency formats", () => {
  beforeEach(() => {
    updateSettings.mockReset().mockResolvedValue(undefined);
    currencyFormattingRegions = { INR: "IN" };
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it("keeps currency formats collapsed and shows how many are set", async () => {
    currencyFormattingRegions = { INR: "IN", USD: "US" };
    render(<LanguageRegionSettings />);

    const toggle = screen.getByRole("button", { name: /Customize currency formats/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("2 custom formats");
    expect(screen.queryByTestId("currency-format-INR")).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("currency-format-INR")).toBeInTheDocument();
  });

  it("shows no count when no currency has its own format", () => {
    currencyFormattingRegions = {};
    render(<LanguageRegionSettings />);

    expect(screen.getByRole("button", { name: "Customize currency formats" })).toBeInTheDocument();
  });

  it("previews each currency in its own region", async () => {
    await renderSettings();

    expect(screen.getByTestId("currency-format-INR")).toHaveTextContent("₹12,34,567.89 · ₹12.35Cr");
  });

  it("removes a currency format", async () => {
    await renderSettings();

    await userEvent.click(screen.getByRole("button", { name: "Remove format for INR" }));

    expect(updateSettings).toHaveBeenCalledWith({ currencyFormattingRegions: {} });
  });

  it("adds a currency format", async () => {
    await renderSettings();

    await userEvent.click(screen.getByRole("button", { name: "Select currency" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Select region" }));
    await userEvent.click(await screen.findByRole("option", { name: "United States" }));
    await userEvent.click(screen.getByTestId("currency-format-add"));

    expect(updateSettings).toHaveBeenCalledWith({
      currencyFormattingRegions: { INR: "IN", USD: "US" },
    });
  });

  it("names each region control after its currency", async () => {
    currencyFormattingRegions = { INR: "IN", USD: "US" };
    await renderSettings();

    expect(screen.getByRole("combobox", { name: "Region for INR" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Region for USD" })).toBeInTheDocument();
  });

  it("waits for a save before the next edit so it cannot restore a removed currency", async () => {
    currencyFormattingRegions = { INR: "IN", USD: "US" };
    let finishSave = () => {};
    updateSettings.mockImplementationOnce(
      (updates: { currencyFormattingRegions: Record<string, string> }) =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            currencyFormattingRegions = updates.currencyFormattingRegions;
            resolve();
          };
        }),
    );
    const view = await renderSettings();

    await userEvent.click(screen.getByRole("button", { name: "Remove format for INR" }));
    expect(screen.getByRole("button", { name: "Remove format for USD" })).toBeDisabled();
    expect(screen.getByTestId("currency-format-add")).toBeDisabled();

    await act(async () => finishSave());
    view.rerender(<LanguageRegionSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Remove format for USD" }));

    expect(updateSettings).toHaveBeenLastCalledWith({ currencyFormattingRegions: {} });
  });

  it("keeps the edit available when a save fails", async () => {
    updateSettings.mockRejectedValue(new Error("save failed"));
    await renderSettings();

    await userEvent.click(screen.getByRole("button", { name: "Remove format for INR" }));
    expect(screen.getByRole("button", { name: "Remove format for INR" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Select currency" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Select region" }));
    await userEvent.click(await screen.findByRole("option", { name: "United States" }));
    await userEvent.click(screen.getByTestId("currency-format-add"));

    expect(screen.getByRole("button", { name: "Select currency" })).toHaveTextContent("USD");
    expect(screen.getByRole("combobox", { name: "Select region" })).toHaveTextContent(
      "United States",
    );
  });

  it.each(["succeeds", "fails"] as const)(
    "returns keyboard focus to the region control when the save %s",
    async (outcome) => {
      currencyFormattingRegions = { INR: "IN", USD: "US" };
      let finishSave = () => {};
      updateSettings.mockImplementationOnce(
        (updates: { currencyFormattingRegions: Record<string, string> }) =>
          new Promise<void>((resolve, reject) => {
            finishSave = () => {
              if (outcome === "fails") return reject(new Error("save failed"));
              currencyFormattingRegions = updates.currencyFormattingRegions;
              resolve();
            };
          }),
      );
      const view = await renderSettings();
      const region = screen.getByRole("combobox", { name: "Region for INR" });

      region.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("option", { name: "India" })).toHaveFocus());
      await userEvent.keyboard("{ArrowDown}{Enter}");
      expect(region).toBeDisabled();

      await act(async () => finishSave());
      view.rerender(<LanguageRegionSettings />);

      expect(region).toHaveTextContent(outcome === "succeeds" ? "France" : "India");
      expect(region).toHaveFocus();
    },
  );

  it("moves keyboard focus to the currency picker after removing a row", async () => {
    let finishSave = () => {};
    updateSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const view = await renderSettings();

    screen.getByRole("button", { name: "Remove format for INR" }).focus();
    await userEvent.keyboard("{Enter}");
    // The settings update lands before the save resolves, as in the mutation.
    await act(async () => {
      currencyFormattingRegions = {};
      view.rerender(<LanguageRegionSettings />);
      finishSave();
    });

    expect(screen.getByRole("button", { name: "Select currency" })).toHaveFocus();
  });
});
