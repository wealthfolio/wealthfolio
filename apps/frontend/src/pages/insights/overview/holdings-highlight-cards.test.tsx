import { fireEvent, render, screen } from "@/test/render";
import type { Holding } from "@/lib/types";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConcentrationCard, TopMoversCard } from "./holdings-highlight-cards";

const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));
vi.mock("@/hooks/use-balance-privacy", () => ({ useBalancePrivacy: () => privacy }));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));
const stock = (id: string, value: number, change: number, percent: number) =>
  ({
    id,
    holdingType: "security",
    instrument: { id, symbol: id, name: `${id} company` },
    marketValue: { base: value, local: value },
    dayChange: { base: change, local: change },
    dayChangePct: percent,
  }) as Holding;
const holdings = [
  stock("AAA", 300, 30, 0.1),
  stock("BBB", 100, 10, 0.2),
  stock("CCC", 100, -5, -0.05),
];

beforeEach(() => {
  privacy.isBalanceHidden = false;
});

describe("holdings highlight cards", () => {
  it("switches daily ranking from amount to percentage and links to each holding", () => {
    render(
      <MemoryRouter>
        <TopMoversCard holdings={holdings} currency="USD" isLoading={false} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("link")[0]).toHaveAttribute("href", "/holdings/AAA");
    fireEvent.click(screen.getByRole("button", { name: "%" }));
    expect(screen.getAllByRole("link")[0]).toHaveAttribute("href", "/holdings/BBB");
    expect(screen.getByRole("button", { name: "%" })).toHaveAttribute("aria-pressed", "true");
  });

  it("includes cash in concentration without listing cash as a holding", () => {
    const cash = { ...stock("cash", 500, 0, 0), holdingType: "cash" } as Holding;
    render(
      <MemoryRouter>
        <ConcentrationCard holdings={[...holdings, cash]} currency="USD" isLoading={false} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText("30.00%").length).toBeGreaterThan(0);
    expect(screen.getByText("50.00%")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("masks monetary values and performance percentages when privacy is enabled", () => {
    privacy.isBalanceHidden = true;
    const { container } = render(
      <MemoryRouter>
        <TopMoversCard holdings={holdings} currency="USD" isLoading={false} />
        <ConcentrationCard holdings={holdings} currency="USD" isLoading={false} />
      </MemoryRouter>,
    );
    expect(container.textContent).not.toContain("$30");
    expect(container.textContent).not.toContain("60.00%");
    expect(container.textContent).not.toContain("10.00%");
    expect(container.textContent).toContain("••••");
  });
});
