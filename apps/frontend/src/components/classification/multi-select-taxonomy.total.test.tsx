import { fireEvent, render, screen, within } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { beforeEach, expect, it, vi } from "vitest";
import { MultiSelectTaxonomy } from "./multi-select-taxonomy";

const { save, rows } = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue({}),
  rows: { equityWeight: 7304 },
}));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: () => ({
    data: {
      categories: [
        { id: "equity", name: "Equity", color: "red", sortOrder: 0 },
        { id: "bonds", name: "Bonds", color: "blue", sortOrder: 1 },
      ],
    },
    isLoading: false,
  }),
  useAssetTaxonomyAssignments: () => ({
    data: [
      { id: "a1", taxonomyId: "custom", categoryId: "equity", weight: rows.equityWeight },
      { id: "a2", taxonomyId: "custom", categoryId: "bonds", weight: 2695 },
    ],
    isLoading: false,
  }),
  useAssignAssetToCategory: () => ({ mutateAsync: save, isPending: false }),
  useRemoveAssetTaxonomyAssignment: () => ({ isPending: false }),
}));

beforeEach(() => save.mockClear());

function renderTaxonomy() {
  render(
    <FormattingProvider locale="US">
      <MultiSelectTaxonomy taxonomyId="custom" assetId="asset" label="Regions" />
    </FormattingProvider>,
  );
}

it.each([
  [7304, "73.04%", "99.99%", "text-warning"],
  [7305, "73.05%", "100%", "text-success"],
])(
  "shows weights at basis-point precision (equity %i)",
  (equityWeight, equityLabel, total, color) => {
    rows.equityWeight = equityWeight;
    renderTaxonomy();
    expect(screen.getByRole("button", { name: equityLabel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "26.95%" })).toBeInTheDocument();
    expect(screen.getByText(total)).toHaveClass(color);
  },
);

it("opens the weight editor on the stored basis-point value", () => {
  rows.equityWeight = 7304;
  renderTaxonomy();
  const equityRow = screen.getByText("Equity").parentElement!;
  fireEvent.click(within(equityRow).getByRole("button", { name: /%/ }));
  const input = screen.getByRole("textbox", { name: "Weight" });
  expect(input).toHaveValue("73.04");
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
});
