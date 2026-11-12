import { fireEvent, render, screen } from "@/test/render";
import type { Holding } from "@/lib/types";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldingsDonutCard } from "./holdings-donut-card";
import { spreadChipAngles } from "./holdings-highlights";

const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));
vi.mock("@/hooks/use-balance-privacy", () => ({ useBalancePrivacy: () => privacy }));
const avatar = vi.hoisted(() => vi.fn((_props: { symbol: string }) => null));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: avatar }));

const stock = (id: string, value: number, holdingType = "security") =>
  ({
    id,
    holdingType,
    instrument: holdingType === "cash" ? null : { id, symbol: id, name: `${id} company` },
    marketValue: { base: value, local: value },
    localCurrency: "USD",
  }) as Holding;

function renderCard(holdings: Holding[]) {
  return render(
    <MemoryRouter>
      <HoldingsDonutCard holdings={holdings} currency="USD" isLoading={false} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  privacy.isBalanceHidden = false;
  avatar.mockClear();
});

describe("HoldingsDonutCard", () => {
  it("draws one slice per holding and labels each chip with its share", () => {
    renderCard([stock("AAA", 600), stock("BBB", 200), stock("cash", 200, "cash")]);
    expect(screen.getByRole("group").querySelectorAll(":scope > svg > path")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "AAA company: 60.00%" })).toHaveAttribute(
      "href",
      "/holdings/AAA",
    );
    expect(screen.getByRole("link", { name: "Cash: 20.00%" })).toHaveAttribute("href", "/holdings");
  });

  it("shows the focused holding in the centre and restores the total on blur", () => {
    renderCard([stock("AAA", 600), stock("BBB", 400)]);
    const chip = screen.getByRole("link", { name: "BBB company: 40.00%" });
    fireEvent.focus(chip);
    expect(screen.getByText("BBB company")).toBeInTheDocument();
    expect(screen.getAllByText("40.00%")).toHaveLength(2);
    fireEvent.blur(chip);
    expect(screen.queryByText("BBB company")).toBeNull();
    expect(screen.getAllByText("40.00%")).toHaveLength(1);
  });

  it("hides shares when balances are hidden", () => {
    privacy.isBalanceHidden = true;
    renderCard([stock("AAA", 600), stock("BBB", 400)]);
    expect(screen.queryByText("60.00%")).toBeNull();
    expect(screen.getAllByText("••••").length).toBeGreaterThan(0);
  });

  it("explains why the chart is unavailable for a short position", () => {
    renderCard([stock("AAA", 600), stock("SHORT", -100)]);
    expect(screen.getByText(/holdings chart needs positive/)).toBeInTheDocument();
  });
});

describe("spreadChipAngles", () => {
  const box = { radius: 42, width: 24, height: 11 };
  const centre = (degrees: number) => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return { x: 42 * Math.cos(radians), y: 42 * Math.sin(radians) };
  };
  const overlap = (a: number, b: number) =>
    Math.abs(centre(a).x - centre(b).x) < box.width &&
    Math.abs(centre(a).y - centre(b).y) < box.height;

  it("separates crowded chips while keeping their order", () => {
    const spread = spreadChipAngles([200, 205, 210, 215, 300], box);
    for (let index = 0; index < spread.length - 1; index += 1) {
      expect(spread[index + 1]).toBeGreaterThan(spread[index]);
      expect(overlap(spread[index], spread[index + 1])).toBe(false);
    }
  });

  it("needs less spacing beside the ring than above it", () => {
    const side = spreadChipAngles([88, 92], box);
    const top = spreadChipAngles([-2, 2], box);
    expect(side[1] - side[0]).toBeLessThan(top[1] - top[0]);
  });

  it("leaves well-spaced chips in place", () => {
    expect(spreadChipAngles([10, 120, 240], box)).toEqual([10, 120, 240]);
  });
});
