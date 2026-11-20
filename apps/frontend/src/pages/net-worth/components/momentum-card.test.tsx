import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MomentumCard } from "./momentum-card";

vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

vi.mock("@/components/financial/compact-amount", () => ({
  CompactAmount: ({ value }: { value: number }) => <span>{value}</span>,
}));

describe("MomentumCard", () => {
  it("formats the monthly bars with the currency's format", () => {
    render(
      <FormattingProvider locale="US" currencyFormattingRegions={{ INR: "IN" }}>
        <MomentumCard
          momentum={{
            currentChange: 1234567,
            priorChange: null,
            beatBy: null,
            bars: [
              { month: "2026-08", value: -1234567, current: false },
              { month: "2026-09", value: 1234567, current: true },
            ],
          }}
          currency="INR"
          periodLabel="past 2 months"
        />
      </FormattingProvider>,
    );

    expect(screen.getByTitle(/: -12,34,567$/)).toBeInTheDocument();
    expect(screen.getByTitle(/: \+12,34,567$/)).toBeInTheDocument();
  });

  it("leaves a month without a known change empty", () => {
    const { container } = render(
      <FormattingProvider locale="US">
        <MomentumCard
          momentum={{
            currentChange: 100,
            priorChange: null,
            beatBy: null,
            bars: [
              { month: "2026-08", value: null, current: false },
              { month: "2026-09", value: 100, current: true },
            ],
          }}
          currency="USD"
          periodLabel="past 2 months"
        />
      </FormattingProvider>,
    );

    const empty = screen.getByTitle(/: N\/A$/);
    expect(empty.querySelector(".rounded-t-sm, .rounded-b-sm")).toBeNull();
    expect(screen.getByTitle(/: \+100$/).querySelector(".rounded-t-sm")).not.toBeNull();
    expect(container.querySelectorAll(".rounded-t-sm, .rounded-b-sm")).toHaveLength(1);
  });
});
