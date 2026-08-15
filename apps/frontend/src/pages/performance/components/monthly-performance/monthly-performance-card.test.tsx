import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MonthlyPerformanceCard } from "./monthly-performance-card";
import type { ReturnData } from "@/lib/types";

// Mock i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "performance:monthly.title": "Monthly Performance",
        "performance:monthly.info": "Monthly breakdown of investment returns",
        "performance:monthly.view_portfolio": "Portfolio",
        "performance:monthly.view_benchmark": "Benchmark",
        "performance:monthly.view_relative": "Relative (Alpha)",
        "performance:monthly.alpha": "Alpha",
        "performance:monthly.year_total": "Total",
      };
      return translations[key] ?? key;
    },
  }),
}));

describe("MonthlyPerformanceCard", () => {
  it("renders monthly performance chart and table when portfolio series is provided", () => {
    const portfolioSeries: ReturnData[] = [
      { date: "2025-01-01", value: 0 },
      { date: "2025-01-31", value: 0.05 },
      { date: "2025-02-28", value: 0.03 },
      { date: "2025-03-31", value: 0.08 },
    ];

    render(
      <MonthlyPerformanceCard portfolioSeries={portfolioSeries} portfolioName="My Portfolio" />,
    );

    expect(screen.getByText("Monthly Performance")).toBeInTheDocument();
    expect(screen.getByText("2025")).toBeInTheDocument();
  });

  it("renders benchmark toggle when benchmark series is provided", () => {
    const portfolioSeries: ReturnData[] = [
      { date: "2025-01-01", value: 0 },
      { date: "2025-01-31", value: 0.05 },
    ];
    const benchmarkSeries: ReturnData[] = [
      { date: "2025-01-01", value: 0 },
      { date: "2025-01-31", value: 0.02 },
    ];

    render(
      <MonthlyPerformanceCard
        portfolioSeries={portfolioSeries}
        portfolioName="My Portfolio"
        benchmarkSeries={benchmarkSeries}
        benchmarkName="S&P 500"
      />,
    );

    expect(screen.getByText("My Portfolio")).toBeInTheDocument();
    expect(screen.getByText("S&P 500")).toBeInTheDocument();
    expect(screen.getByText("Relative (Alpha)")).toBeInTheDocument();
  });

  it("filters displayed years based on dateRange while keeping full year complete", () => {
    const portfolioSeries: ReturnData[] = [
      { date: "2023-01-01", value: 0 },
      { date: "2023-12-31", value: 0.1 },
      { date: "2024-12-31", value: 0.2 },
      { date: "2025-12-31", value: 0.3 },
      { date: "2026-06-30", value: 0.35 },
    ];

    // dateRange for 2025 - 2026 (e.g. 2Y)
    const dateRange = {
      from: new Date("2025-06-01"),
      to: new Date("2026-06-30"),
    };

    render(
      <MonthlyPerformanceCard
        portfolioSeries={portfolioSeries}
        portfolioName="My Portfolio"
        dateRange={dateRange}
      />,
    );

    // 2026 and 2025 should be in the document
    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.getByText("2025")).toBeInTheDocument();
    // 2023 and 2024 should not be in the document
    expect(screen.queryByText("2023")).not.toBeInTheDocument();
    expect(screen.queryByText("2024")).not.toBeInTheDocument();
  });
});
