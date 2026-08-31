import { render } from "@/test/render";
import type { TaxonomyAllocation } from "@/lib/types";
import { DonutChart } from "@wealthfolio/ui";
import { describe, expect, it } from "vitest";
import { DrillableDonutChart } from "./drillable-donut-chart";

function regions(categories: TaxonomyAllocation["categories"]): TaxonomyAllocation {
  return {
    taxonomyId: "regions",
    taxonomyName: "Regions",
    color: "#8b7ec8",
    categories,
  } as TaxonomyAllocation;
}

const AMERICAS = {
  categoryId: "R20",
  categoryName: "Americas",
  color: "#8b7ec8",
  value: 638300,
  percentage: 100,
} as TaxonomyAllocation["categories"][number];

describe("DrillableDonutChart", () => {
  it("renders the center label for a single category", () => {
    const { container } = render(
      <DrillableDonutChart title="Regions" allocation={regions([AMERICAS])} baseCurrency="USD" />,
    );
    expect(container.textContent).toContain("Americas");
  });
});

describe("DonutChart center label", () => {
  const one = [{ name: "Americas", value: 638300, currency: "USD" }];
  const two = [...one, { name: "Europe", value: 425533, currency: "USD" }];

  it("labels the selected slice", () => {
    const { container } = render(<DonutChart data={two} activeIndex={1} />);
    expect(container.textContent).toContain("Europe");
  });

  // A selected slice can disappear while the chart stays mounted (asset re-classified,
  // account scope narrowed, background refetch). The label must survive that.
  it("falls back to a valid slice when the selection is past the end of the data", () => {
    const { container } = render(<DonutChart data={one} activeIndex={1} />);
    expect(container.textContent).toContain("Americas");
  });

  it("keeps a label after the data shrinks below the selected index", () => {
    const { container, rerender } = render(<DonutChart data={two} activeIndex={1} />);
    expect(container.textContent).toContain("Europe");

    rerender(<DonutChart data={one} activeIndex={1} />);
    expect(container.textContent).toContain("Americas");
  });

  it("renders no label when there is no data", () => {
    const { container } = render(<DonutChart data={[]} activeIndex={0} />);
    expect(container.textContent).toBe("");
  });
});
