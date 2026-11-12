import { render, screen } from "@/test/render";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import copy from "@/i18n/locales/en/insights.json";
import { CategoryDetailSheet } from "./category-detail-sheet";
import { liabilityDetailPath, type SelectedCategory } from "./utils";

vi.mock("./category-trend-chart", () => ({ CategoryTrendChart: () => null }));
vi.mock("./compact-amount", () => ({
  CompactAmount: ({ value }: { value: number }) => <span>{value}</span>,
}));

const viewDetails = copy.networth.category_sheet.view_details;

function renderSheet(selected: SelectedCategory, onOpenChange = vi.fn()) {
  render(
    <MemoryRouter>
      <CategoryDetailSheet
        open
        onOpenChange={onOpenChange}
        selected={selected}
        history={[]}
        currency="USD"
        periodLabel="1M"
      />
    </MemoryRouter>,
  );
  return onOpenChange;
}

const liability = (key: string): SelectedCategory => ({
  key,
  name: "Home Mortgage",
  value: 429_000,
  isLiability: true,
  isInvestment: false,
  children: [],
});

it("links a liability to its asset page and a credit card to its account", () => {
  expect(liabilityDetailPath("loan 1")).toBe("/holdings/loan%201");
  expect(liabilityDetailPath("CREDIT_CARD:acct-1")).toBe("/accounts/acct-1");

  renderSheet(liability("mortgage-1"));
  expect(screen.getByRole("link", { name: viewDetails })).toHaveAttribute(
    "href",
    "/holdings/mortgage-1",
  );
});

it("lets each item of a category open its own asset page", () => {
  renderSheet({
    key: "properties",
    name: "Properties",
    value: 750_000,
    isLiability: false,
    isInvestment: false,
    children: [
      { category: "properties", name: "Main home", value: 600_000, assetId: "home-1" },
      { category: "properties", name: "Unlinked", value: 150_000 },
    ],
  });

  expect(screen.queryByRole("link", { name: viewDetails })).toBeNull();
  expect(screen.getByRole("link", { name: /Main home/ })).toHaveAttribute(
    "href",
    "/holdings/home-1",
  );
  expect(screen.queryByRole("link", { name: /Unlinked/ })).toBeNull();
});
