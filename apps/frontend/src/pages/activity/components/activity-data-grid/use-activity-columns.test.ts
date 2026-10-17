import { renderHook } from "@testing-library/react";
import { createFormatter } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";
import type { LocalTransaction } from "./types";
import {
  getSymbolDisplayContext,
  shouldDisplaySubtypeInTypeColumn,
  useActivityColumns,
} from "./use-activity-columns";

describe("shouldDisplaySubtypeInTypeColumn", () => {
  it("hides the subtype from Type when the Subtype column is visible", () => {
    expect(shouldDisplaySubtypeInTypeColumn(false, undefined, "INTEREST", "STAKING_REWARD")).toBe(
      false,
    );
  });

  it("shows the subtype with Type when the Subtype column is hidden", () => {
    expect(shouldDisplaySubtypeInTypeColumn(true, undefined, "INTEREST", "STAKING_REWARD")).toBe(
      true,
    );
  });
});

describe("getSymbolDisplayContext", () => {
  const formatting = createFormatter("en-US");
  const usdOption = "AAPL260619C00150000";
  const cadOption = "AAPL260619C00160000";
  const loadedRow = {
    assetSymbol: usdOption,
    _originalAssetSymbol: usdOption,
    instrumentType: "OPTION",
    currency: "CAD",
    assetQuoteCcy: "USD",
  } as LocalTransaction;

  it("shows a loaded option's strike in its quote currency, not the activity's", () => {
    expect(getSymbolDisplayContext(loadedRow, formatting)).toBe("Jun 19 $150.00 CALL");
  });

  it("uses the picked symbol's quote currency once the symbol changes", () => {
    const row = { ...loadedRow, assetSymbol: cadOption, pendingQuoteCcy: "CAD" };
    expect(getSymbolDisplayContext(row, formatting)).toBe("Jun 19 CA$160.00 CALL");
  });

  it("goes back to the loaded quote currency when the original symbol returns", () => {
    const row = { ...loadedRow, pendingQuoteCcy: "CAD" };
    expect(getSymbolDisplayContext(row, formatting)).toBe("Jun 19 $150.00 CALL");
  });

  it("falls back to the row currency for a new row without a quote currency", () => {
    const row = {
      assetSymbol: usdOption,
      instrumentType: "OPTION",
      currency: "CAD",
    } as LocalTransaction;
    expect(getSymbolDisplayContext(row, formatting)).toBe("Jun 19 CA$150.00 CALL");
  });

  it("re-renders the symbol cell when only the quote currency changes", () => {
    const { result } = renderHook(() =>
      useActivityColumns({
        accounts: [],
        onEditActivity: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        showSubtypeInType: false,
      }),
    );
    const symbolColumn = result.current.find(
      (column) => "accessorKey" in column && column.accessorKey === "assetSymbol",
    );
    const getRenderKey = symbolColumn?.meta?.getRenderKey;
    // A picked symbol's currency is confirmed after the symbol is set.
    const picked = { ...loadedRow, assetSymbol: cadOption, pendingQuoteCcy: "USD" };
    const confirmed = { ...picked, pendingQuoteCcy: "CAD" };

    expect(getRenderKey).toBeDefined();
    expect(getRenderKey?.(picked)).not.toBe(getRenderKey?.(confirmed));
  });
});
