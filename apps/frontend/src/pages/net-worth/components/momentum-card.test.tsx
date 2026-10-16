import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MomentumCard } from "./momentum-card";

vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

vi.mock("./compact-amount", () => ({
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
});
