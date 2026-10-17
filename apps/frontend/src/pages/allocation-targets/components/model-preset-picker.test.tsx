import { describe, expect, it, vi } from "vitest";

import type { CategoryAllocation } from "@/lib/types";
import { render, screen } from "@/test/render";

import { ModelPresetPicker } from "./model-preset-picker";

function category(
  categoryId: string,
  categoryName: string,
  percentage: number,
): CategoryAllocation {
  return { categoryId, categoryName, color: "", value: percentage * 100, percentage };
}

function renderPicker() {
  render(
    <ModelPresetPicker
      taxonomyId="asset_classes"
      selected={null}
      onSelect={vi.fn()}
      currentCategories={[
        category("EQUITY", "Equity", 70),
        category("FIXED_INCOME", "Fixed Income", 30),
      ]}
    />,
  );
  return screen.getAllByRole("button").map((button) => button.textContent ?? "");
}

describe("ModelPresetPicker", () => {
  it("names each example by its weights alone, in alphabetical order, under the disclosure", () => {
    const buttons = renderPicker();

    expect(
      screen.getByText(
        "Example weights only. They are not recommendations, and Wealthfolio has not assessed whether they fit you.",
      ),
    ).toBeInTheDocument();
    expect(buttons).toEqual([
      expect.stringContaining("20% Equity / 80% Fixed Income"),
      expect.stringContaining("25% Equity / 25% Fixed Income / 25% Cash / +1"),
      expect.stringContaining("30% Equity / 55% Fixed Income / 15% Commodities"),
      expect.stringContaining("70% Equity / 30% Fixed Income"),
      "40% Equity / 60% Fixed Income",
      "60% Equity / 40% Fixed Income",
      "80% Equity / 20% Fixed Income",
      "90% Equity / 10% Fixed Income",
      "Build from scratch",
    ]);
    expect(screen.getAllByText("Example weights")).toHaveLength(3);
    expect(buttons[3]).toContain("Current allocation");
  });

  it("carries no risk label and no name tied to anything outside the app", () => {
    const text = renderPicker().join("\n");

    // The former names and risk badges; "Fixed Income" is a category, not a name.
    expect(text).not.toMatch(
      /conservative|moderate|aggressive|balanced|growth|income 20|weather|permanent/i,
    );
  });
});
