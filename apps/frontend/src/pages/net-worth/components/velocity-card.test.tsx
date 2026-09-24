import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { VelocityCard } from "./velocity-card";

vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({
    children,
    title,
    meta,
  }: {
    children: ReactNode;
    title: string;
    meta?: string;
  }) => (
    <section aria-label={title}>
      <span>{meta}</span>
      {children}
    </section>
  ),
}));

vi.mock("./compact-amount", () => ({
  CompactAmount: ({ value }: { value: number }) => <span>{value}</span>,
}));

describe("VelocityCard", () => {
  it("renders the localized period separately from the drivers heading", () => {
    render(
      <VelocityCard
        velocity={{
          netChange: 300,
          portfolioGains: 100,
          otherAssetChanges: 0,
          contributions: 100,
          equityBuilt: 100,
          perMonth: 100,
          months: 3,
        }}
        currency="USD"
        periodLabel="past 3 months"
      />,
    );

    const card = screen.getByRole("region", { name: "Monthly pace" });
    expect(within(card).getByText("past 3 months")).toBeInTheDocument();
    expect(within(card).getByText("Drivers of change")).toBeInTheDocument();
    expect(within(card).queryByText("Drivers of past 3 months change")).not.toBeInTheDocument();
  });
  it.each([false, true])("renders separate signed drivers and shares (zero=%s)", (zero) => {
    render(
      <VelocityCard
        velocity={{
          netChange: zero ? 0 : 1100,
          portfolioGains: zero ? 0 : 300,
          otherAssetChanges: zero ? 0 : -1200,
          contributions: zero ? 0 : 2000,
          equityBuilt: 0,
          perMonth: zero ? 0 : 275,
          months: 4,
        }}
        currency="EUR"
        periodLabel="YTD"
      />,
    );
    const portfolio = screen.getByText("Portfolio gains/losses").parentElement!.parentElement!;
    const other = screen.getByText("Other asset value changes").parentElement!.parentElement!;
    expect(portfolio).toHaveTextContent(zero ? "0/mo" : "+75/mo");
    expect(portfolio).toHaveTextContent(zero ? "0% · 0" : "9% · +300");
    expect(other).toHaveTextContent(zero ? "0/mo" : "-300/mo");
    expect(other).toHaveTextContent(zero ? "0% · 0" : "34% · -1200");
    expect(screen.queryByText("Market returns")).not.toBeInTheDocument();
  });
});
