import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { useEligibleHoldingsSelection } from "./use-eligible-holdings";

function holding(assetId: string, symbol: string): Holding {
  return {
    id: assetId,
    accountId: "account-1",
    holdingType: HoldingType.SECURITY,
    instrument: {
      id: assetId,
      symbol,
      name: `${symbol} name`,
      currency: "USD",
      quoteMode: "MARKET",
    },
  } as Holding;
}

describe("useEligibleHoldingsSelection", () => {
  it("starts all current instruments selected and omits a full allowlist", () => {
    const { result } = renderHook(() =>
      useEligibleHoldingsSelection([holding("asset-b", "B"), holding("asset-a", "A")], "context-a"),
    );

    expect(result.current.selectedAssetIds).toEqual(["asset-a", "asset-b"]);
    expect(result.current.eligibleAssetIds).toBeUndefined();
  });

  it("preserves exclusions for refreshes, prunes removals, selects additions, and resets context", () => {
    const { result, rerender } = renderHook(
      ({ holdings, contextKey }: { holdings: Holding[]; contextKey: string }) =>
        useEligibleHoldingsSelection(holdings, contextKey),
      {
        initialProps: {
          holdings: [holding("asset-a", "A"), holding("asset-b", "B")],
          contextKey: "context-a",
        },
      },
    );

    act(() => result.current.toggle("asset-b"));
    expect(result.current.eligibleAssetIds).toEqual(["asset-a"]);

    rerender({
      holdings: [holding("asset-a", "A"), holding("asset-c", "C")],
      contextKey: "context-a",
    });
    expect(result.current.selectedAssetIds).toEqual(["asset-a", "asset-c"]);
    expect(result.current.eligibleAssetIds).toBeUndefined();

    rerender({
      holdings: [holding("asset-a", "A"), holding("asset-c", "C")],
      contextKey: "context-b",
    });
    expect(result.current.selectedAssetIds).toEqual(["asset-a", "asset-c"]);
    expect(result.current.eligibleAssetIds).toBeUndefined();
  });
});
