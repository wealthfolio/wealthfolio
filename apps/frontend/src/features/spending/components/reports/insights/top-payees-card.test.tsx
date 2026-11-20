import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";
import { render, screen } from "@/test/render";

import type { ReportsRange } from "../../../lib/reports-period";
import type { CategoryBreakdownRow } from "../../../types/report";
import { TopPayeesCard } from "./top-payees-card";

const payee = (id: string, name: string) => ({ id, name }) as TaxonomyCategory;
const row = (categoryId: string, amount: number): CategoryBreakdownRow => ({
  taxonomyId: "payees",
  categoryId,
  amount,
  count: 1,
});
const range = {
  start: new Date(2026, 4, 1),
  end: new Date(2026, 4, 31),
  days: 31,
  months: 1,
} as ReportsRange;

function renderCard(rows: CategoryBreakdownRow[]) {
  return render(
    <MemoryRouter>
      <TopPayeesCard
        rows={rows}
        payees={[payee("p1", "Corner Bakery"), payee("p2", "City Water")]}
        currency="USD"
        range={range}
      />
    </MemoryRouter>,
  );
}

it("lists payees largest first and leaves out the spending with no payee", () => {
  renderCard([row("__uncategorized__", 900), row("p2", 70), row("p1", 80)]);

  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    expect.stringContaining("Corner Bakery"),
    expect.stringContaining("City Water"),
  ]);
});

it("links each payee to its transactions in the period", () => {
  renderCard([row("p1", 80)]);

  expect(screen.getByRole("link")).toHaveAttribute(
    "href",
    "/activities?tab=spending&payees=p1&from=2026-05-01&to=2026-05-31",
  );
});

it("renders nothing while no spending in the period has a payee", () => {
  const { container } = renderCard([row("__uncategorized__", 900)]);

  expect(container).toBeEmptyDOMElement();
});
