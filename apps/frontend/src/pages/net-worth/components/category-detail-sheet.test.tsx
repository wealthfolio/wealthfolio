import { fireEvent, render, screen } from "@/test/render";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import copy from "@/i18n/locales/en/insights.json";
import { CategoryDetailSheet } from "./category-detail-sheet";
import { liabilityDetailPath, type ParsedHistoryPoint, type SelectedCategory } from "./utils";

vi.mock("./category-trend-chart", () => ({ CategoryTrendChart: () => null }));
vi.mock("@/components/financial/compact-amount", () => ({
  CompactAmount: ({ value }: { value: number }) => <span>{value}</span>,
}));

const viewDetails = copy.networth.category_sheet.view_details;

function renderSheet(
  selected: SelectedCategory,
  onOpenChange = vi.fn(),
  history: ParsedHistoryPoint[] = [],
) {
  render(
    <MemoryRouter>
      <CategoryDetailSheet
        open
        onOpenChange={onOpenChange}
        selected={selected}
        history={history}
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

const historyPoint = (value: number, date: string): ParsedHistoryPoint => ({
  date,
  netWorth: -value,
  totalAssets: 0,
  totalLiabilities: value,
  portfolioValue: 0,
  alternativeAssetsValue: 0,
  netContribution: 0,
  breakdown: { "mortgage-1": value },
});

it.each([{ history: [] }, { history: [historyPoint(100, "2026-11-01")] }])(
  "shows an unavailable category change without two comparison points ($history.length)",
  ({ history }) => {
    renderSheet(liability("mortgage-1"), vi.fn(), history);
    expect(screen.getByText("—")).toBeVisible();
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
    expect(screen.getByText("429000")).toBeVisible();
  },
);

it("retains zero category changes when a complete period is flat", () => {
  renderSheet(liability("mortgage-1"), vi.fn(), [
    historyPoint(100, "2026-11-01"),
    historyPoint(100, "2026-11-16"),
  ]);
  expect(screen.getByText("0.0%")).toBeVisible();
  expect(screen.getByText("0")).toBeVisible();
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

it.each([
  ["CASH:acct-1", "/accounts/acct-1"],
  ["CASH:acct-1:USD", "/accounts/acct-1"],
  ["CASH:account/with space:EUR", "/accounts/account%2Fwith%20space"],
])("routes net-worth cash key %s to its account and closes the sheet", (assetId, href) => {
  const onOpenChange = renderSheet({
    key: "cash",
    name: "Cash",
    value: 100,
    isLiability: false,
    isInvestment: false,
    children: [{ category: "cash", name: "Savings", value: 100, assetId }],
  });
  const link = screen.getByRole("link", { name: /Savings/ });
  expect(link).toHaveAttribute("href", href);
  fireEvent.click(link);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("keeps instrument IDs and cash-like IDs outside the cash category as asset links", () => {
  renderSheet({
    key: "otherAssets",
    name: "Other",
    value: 200,
    isLiability: false,
    isInvestment: false,
    children: [
      { category: "otherAssets", name: "Cash-like asset", value: 100, assetId: "CASH:asset" },
      { category: "otherAssets", name: "Currency instrument", value: 100, assetId: "cash:USD" },
    ],
  });
  expect(screen.getByRole("link", { name: /Cash-like asset/ })).toHaveAttribute(
    "href",
    "/holdings/CASH%3Aasset",
  );
  expect(screen.getByRole("link", { name: /Currency instrument/ })).toHaveAttribute(
    "href",
    "/holdings/cash%3AUSD",
  );
});

it("leaves net-worth cash items without usable account keys non-interactive", () => {
  renderSheet({
    key: "cash",
    name: "Cash",
    value: 200,
    isLiability: false,
    isInvestment: false,
    children: [
      { category: "cash", name: "Missing key", value: 100 },
      { category: "cash", name: "Empty account", value: 100, assetId: "CASH:" },
    ],
  });
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
