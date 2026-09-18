import { act, render, screen, waitFor } from "@/test/render";
import type { TaxonomyAllocation } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AllocationDetailSheet } from "./allocation-detail-sheet";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/adapters", () => ({ getHoldingsByAllocation: vi.fn() }));

const allocation = {
  taxonomyId: "regions",
  taxonomyName: "Regions",
  categories: [{ categoryId: "R20", categoryName: "Americas", value: 100, percentage: 100 }],
} as TaxonomyAllocation;

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
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    const segment = screen.getAllByRole("button").find((button) => button.tagName === "DIV")!;
    act(() => segment.focus());
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Americas"));
  });
});
