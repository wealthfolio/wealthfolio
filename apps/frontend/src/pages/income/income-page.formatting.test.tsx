import type { IncomeSummary } from "@/lib/types";
import { findTooltip } from "@/test/tooltip";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  FormattingProvider,
  TooltipProvider,
  type CurrencyFormattingRegions,
} from "@wealthfolio/ui";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import IncomePage from "./income-page";

const { summary } = vi.hoisted(() => ({
  summary: {
    period: "ALL",
    totalIncome: 1237067.89,
    currency: "USD",
    monthlyAverage: 100,
    yoyGrowth: null,
    unconvertedCurrencies: [],
    byMonth: {},
    byType: { DIVIDEND: 412355.9633, INTEREST: 824711.9267 },
    byAsset: {
      example: {
        assetId: "example",
        kind: "INVESTMENT",
        symbol: "EXAMPLE",
        name: "Example company",
        income: 137451.9878,
        dividendIncome: 137451.9878,
      },
    },
    byAccount: {},
    byCurrency: { INR: 1234567.8912, USD: 2500, JPY: 1234.5 },
    byCurrencyBase: { INR: 14814.81, USD: 2500, JPY: 8.27 },
  } satisfies IncomeSummary,
}));

vi.mock("@/adapters", () => ({ getIncomeSummary: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [summary], isLoading: false, error: null }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));
vi.mock("./income-history-chart", () => ({ IncomeHistoryChart: () => null }));

// Supply a hover payload without depending on SVG measurements in jsdom.
// Keep ChartTooltipContent and the page's formatter real.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pie: () => null,
  Tooltip: ({ content }: { content: ReactElement }) => (
    <div data-testid="currency-tooltip">
      {cloneElement(content as ReactElement<{ active: boolean; payload: unknown[] }>, {
        active: true,
        // As Recharts does: the slice's size as the value, and its row as the payload.
        payload: Object.entries(summary.byCurrency).map(([currency, amount]) => ({
          name: currency,
          value: summary.byCurrencyBase[currency as keyof typeof summary.byCurrencyBase],
          payload: { currency, amount, fill: "red" },
        })),
      })}
    </div>
  ),
}));

describe("IncomePage currency tooltip", () => {
  it("uses each slice's currency and preserves default decimal precision", () => {
    const page = (regions?: CurrencyFormattingRegions) => (
      <FormattingProvider locale="US" currencyFormattingRegions={regions}>
        <IncomePage />
      </FormattingProvider>
    );
    const { rerender } = render(page({ INR: "IN", JPY: "JP" }));
    const tooltip = within(screen.getByTestId("currency-tooltip"));

    expect(tooltip.getByText("INR")).toBeInTheDocument();
    expect(tooltip.getByText("12,34,567.891")).toBeInTheDocument();
    expect(tooltip.getByText("2,500")).toBeInTheDocument();
    expect(tooltip.getByText("1,234.5")).toBeInTheDocument();

    rerender(page());
    expect(tooltip.getByText("1,234,567.891")).toBeInTheDocument();
    expect(tooltip.getByText("2,500")).toBeInTheDocument();
  });
});

it("uses the selected region for income source percentages and updates immediately", async () => {
  const page = (locale: string) => (
    <FormattingProvider locale={locale}>
      <TooltipProvider delay={0}>
        <IncomePage />
      </TooltipProvider>
    </FormattingProvider>
  );
  const { rerender } = render(page("ES"));
  expect(screen.getByText("33,3 %")).toBeInTheDocument();
  expect(screen.getByText("66,7 %")).toBeInTheDocument();
  const bar = document.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
  await userEvent.hover(bar!);
  expect(await findTooltip()).toHaveTextContent("33,3 % of total");
  rerender(page("US"));
  expect(screen.getByText("33.3%")).toBeInTheDocument();
  expect(screen.getByText("66.7%")).toBeInTheDocument();
});
