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

const base = {
  netChange: 0,
  portfolioGains: 0,
  otherAssetChanges: 0,
  contributions: 0,
  equityBuilt: 0,
  perMonth: 0,
  months: 4,
  startDate: "2024-01-01",
};

describe("VelocityCard", () => {
  it("renders the localized period separately from the drivers heading", () => {
    render(
      <VelocityCard
        velocity={{
          ...base,
          netChange: 300,
          portfolioGains: 100,
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
    expect(card).toHaveTextContent(/since .*2024/);
  });

  it("lists moving drivers largest first with bars scaled to the largest", () => {
    render(
      <VelocityCard
        velocity={{
          ...base,
          netChange: 1100,
          portfolioGains: 300,
          otherAssetChanges: -1200,
          contributions: 2000,
          perMonth: 275,
        }}
        currency="EUR"
        periodLabel="YTD"
      />,
    );
    const labels = screen
      .getAllByText(/^(Investment gains|Other assets|Contributions|Debt paid down)$/)
      .map((element) => element.textContent);
    expect(labels).toEqual(["Contributions", "Other assets", "Investment gains"]);

    const row = (label: string) => screen.getByText(label).parentElement!.parentElement!;
    const bar = (label: string) =>
      row(label).querySelector<HTMLElement>("[style*='width']")!.style.width;
    expect(row("Contributions")).toHaveTextContent("+500");
    expect(row("Other assets")).toHaveTextContent("-300");
    expect(row("Investment gains")).toHaveTextContent("+75");
    expect(bar("Contributions")).toBe("100%");
    expect(bar("Other assets")).toBe("60%");
    expect(bar("Investment gains")).toBe("15%");
  });

  it("names drivers by their direction", () => {
    render(
      <VelocityCard
        velocity={{
          ...base,
          netChange: -160,
          portfolioGains: -100,
          contributions: -50,
          equityBuilt: -10,
          perMonth: -40,
        }}
        currency="USD"
        periodLabel="YTD"
      />,
    );
    expect(screen.getByText("Investment losses")).toBeInTheDocument();
    expect(screen.getByText("Withdrawals")).toBeInTheDocument();
    expect(screen.getByText("New debt")).toBeInTheDocument();
  });

  it("shows a sole driver as the whole change instead of repeating the headline", () => {
    render(
      <VelocityCard
        velocity={{ ...base, netChange: 400, portfolioGains: 400, perMonth: 100 }}
        currency="USD"
        periodLabel="ALL"
      />,
    );
    const row = screen.getByText("Investment gains").parentElement!;
    expect(row).toHaveTextContent("100%");
    expect(row.querySelector("[style*='width']")).toBeNull();
    expect(screen.queryByText("Other assets")).not.toBeInTheDocument();
  });

  it.each([
    [150, "· 1.5× your 12-month average"],
    [-150, null],
  ])("compares with the trailing year only for same-signed paces (%s)", (trailing, text) => {
    render(
      <VelocityCard
        velocity={{ ...base, netChange: 900, portfolioGains: 900, perMonth: 225 }}
        trailingYearMonthly={trailing}
        currency="USD"
        periodLabel="3M"
      />,
    );
    const card = screen.getByRole("region", { name: "Monthly pace" });
    if (text) expect(card).toHaveTextContent(text);
    else expect(card).not.toHaveTextContent("12-month average");
  });

  it("hides the drivers section when nothing moved", () => {
    render(<VelocityCard velocity={base} currency="USD" periodLabel="1M" />);
    expect(screen.queryByText("Drivers of change")).not.toBeInTheDocument();
  });
});
