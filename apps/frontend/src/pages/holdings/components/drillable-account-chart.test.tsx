import type { Account, AccountValueSource } from "@/lib/types";
import { fireEvent, render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DrillableAccountChart } from "./drillable-account-chart";

const ACCOUNTS = [
  { id: "a1", name: "Brokerage", group: "Taxable" },
  { id: "a2", name: "Joint", group: "Taxable" },
  { id: "b1", name: "Roth IRA", group: "Retirement" },
] as Account[];

vi.mock("@/adapters", () => ({ getAccounts: () => Promise.resolve(ACCOUNTS) }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/hooks/use-accounts-simple-performance", () => ({
  useAccountsSimplePerformance: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Recharts draws no sectors in jsdom; expose each slice as a button instead.
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  DonutChart: ({
    data,
    onSectionClick,
  }: {
    data: { name: string; value: number; currency: string }[];
    onSectionClick?: (item: { name: string; value: number; currency: string }, i: number) => void;
  }) => (
    <div>
      {data.map((item, i) => (
        <button key={item.name} onClick={() => onSectionClick?.(item, i)}>
          {item.name}
        </button>
      ))}
    </div>
  ),
}));

const VALUATIONS: AccountValueSource[] = [
  { accountId: "a1", totalValueBase: 100 },
  { accountId: "a2", totalValueBase: 50 },
  { accountId: "b1", totalValueBase: 80 },
];

function renderChart() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <DrillableAccountChart accountIds={["a1", "a2", "b1"]} accountValuations={VALUATIONS} />,
    { wrapper },
  );
}

describe("DrillableAccountChart", () => {
  it("drills into a group with several accounts", async () => {
    renderChart();
    fireEvent.click(await screen.findByRole("button", { name: "Taxable" }));

    expect(screen.getByRole("button", { name: "Brokerage" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Joint" })).toBeTruthy();
  });

  // Changing the account scope keeps the chart mounted; the drilled group may not be in
  // the new scope at all.
  it("returns to the groups when the drilled group leaves the account scope", async () => {
    const { rerender } = renderChart();
    fireEvent.click(await screen.findByRole("button", { name: "Taxable" }));

    rerender(<DrillableAccountChart accountIds={["b1"]} accountValuations={VALUATIONS} />);

    expect(screen.queryByText("holdings:no_account_data")).toBeNull();
    expect(screen.getByRole("button", { name: "Retirement" })).toBeTruthy();
  });

  it("stays drilled when the new scope still has the group", async () => {
    const { rerender } = renderChart();
    fireEvent.click(await screen.findByRole("button", { name: "Taxable" }));

    rerender(<DrillableAccountChart accountIds={["a1", "b1"]} accountValuations={VALUATIONS} />);

    expect(screen.getByRole("button", { name: "Brokerage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retirement" })).toBeNull();
  });
});
