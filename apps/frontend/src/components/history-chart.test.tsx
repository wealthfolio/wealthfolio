import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HistoryChart } from "./history-chart";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/hooks/use-chart-scrub-haptic", () => ({
  useChartScrubHaptic: () => ({ tick: vi.fn(), reset: vi.fn() }),
}));
vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => false,
  useViewportBelow: () => false,
}));
vi.mock("@wealthfolio/ui/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("recharts", () => ({
  AreaChart: ({ data, children }: { data: unknown; children: ReactNode }) => (
    <div>
      <output data-testid="points">{JSON.stringify(data)}</output>
      {children}
    </div>
  ),
  Area: ({ connectNulls, dataKey }: { connectNulls: boolean; dataKey: string }) => (
    <output data-testid={dataKey}>{String(connectNulls)}</output>
  ),
  YAxis: ({ domain }: { domain: number[] }) => (
    <output data-testid="domain">{JSON.stringify(domain)}</output>
  ),
  XAxis: () => null,
  ReferenceDot: () => null,
  Tooltip: () => null,
}));

describe("HistoryChart incomplete values", () => {
  it("keeps known segments, gaps unknown dates and excludes unknown subtotals from scaling", () => {
    render(
      <HistoryChart
        data={[
          { date: "2026-01-01", totalValue: 100, netContribution: 50, currency: "AED" },
          {
            date: "2026-01-02",
            totalValue: 999999999,
            netContribution: 999999999,
            currency: "AED",
            isUnavailable: true,
          },
          { date: "2026-01-03", totalValue: 150, netContribution: 75, currency: "AED" },
        ]}
      />,
    );
    const points = JSON.parse(screen.getByTestId("points").textContent ?? "[]");
    expect(points).toEqual([
      expect.objectContaining({ date: "2026-01-01", totalValue: 100 }),
      expect.objectContaining({ date: "2026-01-02", totalValue: null, netContribution: null }),
      expect.objectContaining({ date: "2026-01-03", totalValue: 150 }),
    ]);
    expect(screen.getByTestId("totalValue")).toHaveTextContent("false");
    const domain: number[] = JSON.parse(screen.getByTestId("domain").textContent ?? "[]");
    expect(Math.max(...domain)).toBeLessThan(1000);
  });
});
