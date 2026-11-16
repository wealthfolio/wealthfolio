import { render, screen } from "@/test/render";
import { expect, it, vi } from "vitest";
import { BreakdownTable } from "./breakdown-table";
import type { ParsedHistoryPoint, ParsedNetWorth } from "./utils";

vi.mock("./composition-bar", () => ({ CompositionBar: () => null }));
vi.mock("@/components/financial/compact-amount", () => ({
  CompactAmount: ({ value }: { value: number }) => <span>amount:{value}</span>,
}));

const data: ParsedNetWorth = {
  netWorth: 300,
  assets: { total: 400, breakdown: [{ category: "cash", name: "Cash", value: 400 }] },
  liabilities: {
    total: 100,
    breakdown: [{ category: "liabilities", name: "Mortgage", value: 100, assetId: "loan" }],
  },
};
const point = (cash: number, loan: number, date: string): ParsedHistoryPoint => ({
  date,
  netWorth: cash - loan,
  totalAssets: cash,
  totalLiabilities: loan,
  portfolioValue: cash,
  alternativeAssetsValue: 0,
  netContribution: 0,
  breakdown: { cash, loan },
});
function table(history: ParsedHistoryPoint[], isIncomplete = false, values = data) {
  return render(
    <BreakdownTable
      data={values}
      history={history}
      currency="USD"
      periodLabel="1M"
      isIncomplete={isIncomplete}
      onSelect={vi.fn()}
    />,
  );
}

it.each([{ history: [] }, { history: [point(400, 100, "2026-11-01")] }])(
  "shows unavailable changes for fewer than two comparison points ($history.length)",
  ({ history }) => {
    table(history);
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
    expect(screen.queryByText("amount:0")).not.toBeInTheDocument();
    expect(screen.getByText("amount:300")).toBeVisible();
  },
);

it("labels an incomplete total as a known subtotal while retaining known amounts", () => {
  table([], true);
  expect(screen.getByText("Known subtotal")).toBeVisible();
  expect(screen.queryByText("Net Worth")).not.toBeInTheDocument();
  expect(screen.getByText("amount:300")).toBeVisible();
});

it("keeps a legitimate zero known subtotal visible", () => {
  table([], true, {
    netWorth: 0,
    assets: { total: 0, breakdown: [] },
    liabilities: { total: 0, breakdown: [] },
  });
  expect(screen.getByText("Known subtotal")).toBeVisible();
  expect(screen.getAllByText("amount:0")).toHaveLength(2);
  expect(screen.getByText("—")).toBeVisible();
});

it("preserves true zero changes for a complete flat period", () => {
  table([point(400, 100, "2026-11-01"), point(400, 100, "2026-11-16")]);
  expect(screen.getAllByText("0.0%")).toHaveLength(3);
  expect(screen.getAllByText("amount:0")).toHaveLength(3);
  expect(screen.getByText("Net Worth")).toBeVisible();
});

it("leaves a legacy liability change unavailable when the row has no history key", () => {
  table([point(400, 100, "2026-11-01"), point(400, 100, "2026-11-16")], false, {
    ...data,
    liabilities: {
      total: 100,
      breakdown: [{ category: "liabilities", name: "Legacy loan", value: 100 }],
    },
  });
  expect(screen.getByText("—")).toBeVisible();
  expect(screen.getAllByText("0.0%")).toHaveLength(2);
});

it("preserves New for values first added during a comparable period", () => {
  table([point(0, 0, "2026-11-01"), point(400, 100, "2026-11-16")]);
  expect(screen.getAllByText("New")).toHaveLength(3);
});
