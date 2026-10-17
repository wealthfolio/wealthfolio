import type { IncomeSummary } from "@/lib/types";
import { fireEvent, render, within } from "@testing-library/react";
import {
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IncomePage from "./income-page";

interface PieProps {
  data: Record<string, unknown>[];
  dataKey: string;
  nameKey: string;
}

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  pie: undefined as PieProps | undefined,
}));

vi.mock("@/adapters", () => ({ getIncomeSummary: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));
vi.mock("./income-history-chart", () => ({ IncomeHistoryChart: () => null }));
// jsdom has no layout: give the pie a fixed size and skip its entry animation
// so its slices exist right away. Record what the pie is given.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width: number; height: number }>, {
            width: 200,
            height: 200,
          })
        : null,
    Pie: (props: ComponentProps<typeof actual.Pie>) => {
      mocks.pie = props as unknown as PieProps;
      return <actual.Pie {...props} isAnimationActive={false} />;
    },
  };
});

// ₹1,234,567.89 is worth about $14,814.81, far more than the $2,500 of USD income.
const summary: IncomeSummary = {
  period: "ALL",
  byMonth: { "2026-01": 17314.81 },
  byType: { INTEREST: 17314.81 },
  byAsset: {},
  byCurrency: { INR: 1234567.89, USD: 2500 },
  byCurrencyBase: { INR: 14814.81, USD: 2500 },
  byAccount: {},
  totalIncome: 17314.81,
  currency: "USD",
  monthlyAverage: 17314.81,
  yoyGrowth: null,
  unconvertedCurrencies: [],
};

describe("IncomePage currency pie", () => {
  beforeEach(() => {
    mocks.pie = undefined;
    mocks.useQuery.mockReturnValue({ data: [summary], isLoading: false, error: null });
  });

  it("sizes each slice by its income converted to the base currency", () => {
    render(<IncomePage />);
    const { data, dataKey, nameKey } = mocks.pie!;

    expect(data.map((slice) => [slice[nameKey], slice[dataKey]])).toEqual([
      ["INR", 14814.81],
      ["USD", 2500],
    ]);
  });

  it("gives income without an exchange rate no slice", () => {
    mocks.useQuery.mockReturnValue({
      data: [
        {
          ...summary,
          byCurrencyBase: { USD: 2500 },
          totalIncome: 2500,
          unconvertedCurrencies: ["INR"],
        },
      ],
      isLoading: false,
      error: null,
    });
    render(<IncomePage />);
    const { data, dataKey, nameKey } = mocks.pie!;

    expect(data.map((slice) => [slice[nameKey], slice[dataKey]])).toEqual([["USD", 2500]]);
  });

  it("gives income that converts to zero no slice", () => {
    mocks.useQuery.mockReturnValue({
      data: [
        {
          ...summary,
          byCurrency: { IDR: 1, USD: 2500 },
          byCurrencyBase: { IDR: 0, USD: 2500 },
          totalIncome: 2500,
        },
      ],
      isLoading: false,
      error: null,
    });
    render(<IncomePage />);
    const { data, dataKey, nameKey } = mocks.pie!;

    expect(data.map((slice) => [slice[nameKey], slice[dataKey]])).toEqual([["USD", 2500]]);
  });

  it("shows each currency's own amount in the tooltip", () => {
    const { container } = render(<IncomePage />);
    const slice = container.querySelector('[name="INR"]')?.closest(".recharts-pie-sector");
    expect(slice).toBeInstanceOf(Element);
    fireEvent.mouseEnter(slice!);
    const pie = within(slice!.closest<HTMLElement>("[data-chart]")!);

    expect(pie.getByText("INR")).toBeInTheDocument();
    expect(pie.getByText("1,234,567.89")).toBeInTheDocument();
    expect(pie.queryByText("14,814.81")).not.toBeInTheDocument();
  });
});
