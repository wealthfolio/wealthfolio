import { renderHook } from "@/test/render";
import type { Holding } from "@/lib/types";
import { describe, expect, it, vi } from "vitest";
import { useSellHoldings } from "./use-sell-holdings";

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: () => ({
    holdings: [
      { instrument: { id: "shop-tsx", symbol: "SHOP", exchangeMic: "XTSE" }, quantity: 10 },
      { instrument: { id: "shop-nasdaq", symbol: "SHOP", exchangeMic: "XNAS" }, quantity: 20 },
      { instrument: { id: "apple", symbol: "AAPL", exchangeMic: "XNAS" }, quantity: 5 },
    ] as Holding[],
    isLoading: false,
    isError: false,
    isFetching: false,
  }),
}));

describe("sell holding identity", () => {
  it.each([
    { assetId: "SHOP", exchangeMic: "XNAS", expected: 20 },
    { assetId: "SHOP", exchangeMic: "XLON", expected: 0 },
    { assetId: "SHOP", exchangeMic: undefined, expected: 0 },
    { assetId: "AAPL", exchangeMic: undefined, expected: 5 },
    { assetId: "shop-tsx", exchangeMic: "XTSE", expected: 10 },
  ])(
    "matches $assetId on $exchangeMic without borrowing another position",
    ({ assetId, exchangeMic, expected }) => {
      const { result } = renderHook(() =>
        useSellHoldings({ accountId: "brokerage", assetId, exchangeMic }),
      );
      expect(result.current.availableQuantity).toBe(expected);
    },
  );
});
