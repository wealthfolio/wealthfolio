import type { CategoryAllocation, TaxonomyAllocation } from "@/lib/types";
import { fireEvent, render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { DrillableDonutChart } from "./drillable-donut-chart";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Recharts draws no sectors in jsdom; expose each slice as a button instead.
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  DonutChart: ({
    data,
    onSectionClick,
  }: {
    data: { name: string; value: number; currency: string }[];
    onSectionClick?: (item: { name: string; value: number; currency: string }, i: number) => void;
  }) => (
    <div>
      {data.map((item, i) => (
        <button key={item.name} onClick={() => onSectionClick?.(item, i)}>
          {item.name}
        </button>
      ))}
    </div>
  ),
}));

function category(
  categoryId: string,
  categoryName: string,
  value: number,
  children?: CategoryAllocation[],
): CategoryAllocation {
  return { categoryId, categoryName, color: "#8b7ec8", value, percentage: 0, children };
}

function regions(categories: CategoryAllocation[]): TaxonomyAllocation {
  return { taxonomyId: "regions", taxonomyName: "Regions", color: "#8b7ec8", categories };
}

const AMERICAS = category("R20", "Americas", 300, [
  category("R21", "United States", 200),
  category("R22", "Canada", 100),
]);
const EUROPE = category("R10", "Europe", 150);

describe("DrillableDonutChart drill-down", () => {
  // Changing the account scope keeps the chart mounted; the new scope may hold nothing in
  // the drilled category.
  it("returns to the categories when the drilled category leaves the data", () => {
    const { rerender } = render(
      <DrillableDonutChart title="Regions" allocation={regions([AMERICAS, EUROPE])} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Americas" }));
    expect(screen.getByRole("button", { name: "United States" })).toBeTruthy();

    rerender(<DrillableDonutChart title="Regions" allocation={regions([EUROPE])} />);

    expect(screen.queryByText("holdings:no_typed_data_available")).toBeNull();
    expect(screen.getByRole("button", { name: "Europe" })).toBeTruthy();
  });

  it("returns to the categories when the drilled category's children have no value", () => {
    const { rerender } = render(
      <DrillableDonutChart title="Regions" allocation={regions([AMERICAS, EUROPE])} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Americas" }));

    const emptied = category("R20", "Americas", 0, [
      category("R21", "United States", 0),
      category("R22", "Canada", 0),
    ]);
    rerender(<DrillableDonutChart title="Regions" allocation={regions([emptied, EUROPE])} />);

    expect(screen.queryByText("holdings:no_typed_data_available")).toBeNull();
    expect(screen.getByRole("button", { name: "Europe" })).toBeTruthy();
  });

  it("stays drilled when the category still has children with value", () => {
    const { rerender } = render(
      <DrillableDonutChart title="Regions" allocation={regions([AMERICAS, EUROPE])} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Americas" }));

    const narrowed = category("R20", "Americas", 200, [category("R21", "United States", 200)]);
    rerender(<DrillableDonutChart title="Regions" allocation={regions([narrowed])} />);

    expect(screen.getByRole("button", { name: "United States" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Canada" })).toBeNull();
  });
});
