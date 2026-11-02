import { fireEvent, render, screen } from "@testing-library/react";
import { createNumberFormatting, FormattingProvider } from "@wealthfolio/ui";
import type { TaxonomyCategory } from "@/lib/types";
import { describe, expect, it, vi } from "vitest";
import { formatPp, formatTolerance } from "./drift-copy";
import { TargetWeightEditor } from "./target-weight-editor";

const categories: TaxonomyCategory[] = ["Equity", "Bonds"].map((name, index) => ({
  id: name,
  key: name,
  name,
  taxonomyId: "custom",
  color: "#123456",
  sortOrder: index,
  createdAt: "",
  updatedAt: "",
}));

describe("allocation regional formatting", () => {
  it("formats signed drift and tolerance with the selected decimal mark and percent spacing", () => {
    const es = createNumberFormatting("ES");
    expect(formatPp(125, es)).toBe("+1,3 %");
    expect(formatPp(-125, es)).toBe("-1,3 %");
    expect(formatTolerance(150, es)).toBe("±1,5 %");
  });

  it("displays and edits target weights without truncating decimal commas", () => {
    const onChange = vi.fn();
    render(
      <FormattingProvider locale="ES">
        <TargetWeightEditor
          categories={categories}
          weights={[
            { categoryId: "Equity", targetBps: 3330, isLocked: false },
            { categoryId: "Bonds", targetBps: 6670, isLocked: false },
          ]}
          currentAllocation={{ Equity: 33.3, Bonds: 66.7 }}
          colorByCategory={new Map()}
          bandType="absolute"
          driftBandBps={100}
          relativeFactorBps={2000}
          onChange={onChange}
        />
      </FormattingProvider>,
    );
    expect(screen.getByText("33,3 %")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "33,3" }));
    const input = screen.getByRole("textbox", { name: "Equity Target" });
    expect(input).toHaveValue("33,3");
    fireEvent.change(input, { target: { value: "34,5" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ categoryId: "Equity", targetBps: 3450 }),
      expect.objectContaining({ categoryId: "Bonds", targetBps: 6550 }),
    ]);
  });
});
