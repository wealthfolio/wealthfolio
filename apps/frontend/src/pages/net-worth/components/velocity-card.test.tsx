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
          marketGains: 100,
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
});
