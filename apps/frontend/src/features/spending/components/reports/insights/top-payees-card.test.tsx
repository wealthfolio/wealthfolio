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

function renderCard(
  rows: CategoryBreakdownRow[],
  period: { range: ReportsRange; timezone?: string } = { range },
) {
  return render(
    <MemoryRouter>
      <TopPayeesCard
        rows={rows}
        payees={[payee("p1", "Corner Bakery"), payee("p2", "City Water")]}
        currency="USD"
        range={period.range}
        timezone={period.timezone}
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

it("dates the link by the application's timezone, not the browser's", () => {
  // May 2026 in Auckland and in Honolulu: each starts or ends on another day in UTC.
  const auckland = {
    start: new Date("2026-04-30T12:00:00.000Z"),
    end: new Date("2026-05-31T11:59:59.999Z"),
    days: 31,
    months: 1,
  } as ReportsRange;
  const honolulu = {
    start: new Date("2026-05-01T10:00:00.000Z"),
    end: new Date("2026-06-01T09:59:59.999Z"),
    days: 31,
    months: 1,
  } as ReportsRange;
  const href = "/activities?tab=spending&payees=p1&from=2026-05-01&to=2026-05-31";

  const first = renderCard([row("p1", 80)], { range: auckland, timezone: "Pacific/Auckland" });
  expect(screen.getByRole("link")).toHaveAttribute("href", href);
  first.unmount();

  renderCard([row("p1", 80)], { range: honolulu, timezone: "Pacific/Honolulu" });
  expect(screen.getByRole("link")).toHaveAttribute("href", href);
});

it("renders nothing while no spending in the period has a payee", () => {
  const { container } = renderCard([row("__uncategorized__", 900)]);

  expect(container).toBeEmptyDOMElement();
});
