import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import type { AllocationHoldings, TaxonomyAllocation } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Activity } from "react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AllocationDetailSheet } from "./allocation-detail-sheet";
import { queryTooltip } from "@/test/tooltip";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/adapters", () => ({
  getHoldingsByAllocation: vi.fn((_filter: unknown, taxonomyId: string, categoryId: string) =>
    Promise.resolve<AllocationHoldings>({
      taxonomyId,
      taxonomyName: "Regions",
      categoryId,
      categoryName: categoryId,
      color: "",
      holdings: [],
      totalValue: 0,
      currency: "USD",
    }),
  ),
}));

const allocation = {
  taxonomyId: "regions",
  taxonomyName: "Regions",
  categories: [{ categoryId: "R20", categoryName: "Americas", value: 100, percentage: 100 }],
} as TaxonomyAllocation;

// Each test waits for its holdings query to settle before it ends. Otherwise
// React Query's update timer can fire after Vitest has removed `window`.
const waitForHoldings = () => screen.findByText("No holdings found in this category.");

describe("AllocationDetailSheet focus", () => {
  it("opens on the title without a tooltip and retains keyboard access to segment tooltips", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <AllocationDetailSheet
            isOpen
            onOpenChange={vi.fn()}
            allocation={allocation}
            accountFilter={{ type: "all" }}
            baseCurrency="USD"
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "Regions" })).toHaveFocus());
    expect(queryTooltip()).not.toBeInTheDocument();
    const segment = screen.getAllByRole("button").find((button) => button.tagName === "DIV")!;
    act(() => segment.focus());
    await waitFor(() => expect(queryTooltip()).toHaveTextContent("Americas"));
    await waitForHoldings();
  });
});

describe("AllocationDetailSheet on a kept screen", () => {
  it("keeps the chosen category when its phone screen is shown again", async () => {
    // A phone screen kept under another one is a hidden <Activity>, whose
    // effects run again when it is shown.
    const regions = {
      ...allocation,
      categories: [
        { categoryId: "R20", categoryName: "Americas", value: 60, percentage: 60 },
        { categoryId: "R30", categoryName: "Europe", value: 40, percentage: 40 },
      ],
    } as TaxonomyAllocation;
    const client = new QueryClient();
    const view = (hidden: boolean) => (
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <Activity mode={hidden ? "hidden" : "visible"}>
            <AllocationDetailSheet
              isOpen
              onOpenChange={vi.fn()}
              allocation={regions}
              accountFilter={{ type: "all" }}
              baseCurrency="USD"
            />
          </Activity>
        </QueryClientProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view(false));
    expect(screen.getByRole("heading", { name: "Holdings in Americas" })).toBeInTheDocument();
    // The strip names it first, then the category list.
    fireEvent.click(screen.getAllByText("Europe").at(-1)!);
    expect(screen.getByRole("heading", { name: "Holdings in Europe" })).toBeInTheDocument();

    rerender(view(true));
    rerender(view(false));

    expect(screen.getByRole("heading", { name: "Holdings in Europe" })).toBeInTheDocument();
    await waitForHoldings();
  });
});

it("formats allocation percentages using the selected region", async () => {
  render(
    <FormattingProvider locale="ES">
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <AllocationDetailSheet
            isOpen
            onOpenChange={vi.fn()}
            allocation={{
              ...allocation,
              categories: [
                {
                  categoryId: "R20",
                  categoryName: "Americas",
                  value: 33.3,
                  percentage: 33.3,
                  color: "var(--chart-1)",
                },
              ],
            }}
            accountFilter={{ type: "all" }}
            baseCurrency="USD"
          />
        </QueryClientProvider>
      </MemoryRouter>
    </FormattingProvider>,
  );
  expect(screen.getByText("33,3 %")).toBeInTheDocument();
  await waitForHoldings();
});
