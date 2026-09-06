import { useAccountScopeStore } from "@/lib/account-scope-store";
import { PORTFOLIO_SCOPE_ID } from "@/lib/constants";
import type { AccountScope, TrackedItem } from "@/lib/types";
import { act, renderHook } from "@testing-library/react";
import { useCallback, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_PORTFOLIO_ITEM } from "../performance-selection";
import { usePerformanceScopeBridge } from "./use-performance-scope-bridge";

const hookMocks = vi.hoisted(() => ({ usePortfolios: vi.fn() }));

vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: hookMocks.usePortfolios }));

const accounts = [
  { id: "acc-1", name: "Brokerage" },
  { id: "acc-2", name: "TFSA" },
];

const brokerageItem: TrackedItem = {
  id: "acc-1",
  type: "account",
  name: "Brokerage",
  accountScope: { type: "account", accountId: "acc-1" },
};

const tfsaItem: TrackedItem = {
  id: "acc-2",
  type: "account",
  name: "TFSA",
  accountScope: { type: "account", accountId: "acc-2" },
};

const initialState = useAccountScopeStore.getState();

function setScope(scope: AccountScope) {
  act(() => {
    useAccountScopeStore.getState().setScope(scope);
  });
}

/** Mounts the bridge over a real tracked list, the way the page holds it. */
function renderBridge(initialItems: TrackedItem[], isAccountsLoading = false) {
  const setSelectedItems = vi.fn();
  const setSelectedItemId = vi.fn();

  const view = renderHook(() => {
    const [items, setItems] = useState(initialItems);
    const applyItems = useCallback((next: TrackedItem[]) => {
      setSelectedItems(next);
      setItems(next);
    }, []);

    usePerformanceScopeBridge({
      accounts,
      isAccountsLoading,
      selectedItems: items,
      setSelectedItems: applyItems,
      setSelectedItemId,
      sortItems: (next) => next,
    });

    return items;
  });

  return { ...view, setSelectedItems, setSelectedItemId };
}

describe("usePerformanceScopeBridge", () => {
  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
    hookMocks.usePortfolios.mockReturnValue({ data: [{ id: "p-1", name: "Retirement" }] });
  });

  it("leaves the tracked list alone on a fresh session", () => {
    const { setSelectedItems, setSelectedItemId } = renderBridge([ALL_PORTFOLIO_ITEM]);

    expect(setSelectedItems).not.toHaveBeenCalled();
    expect(setSelectedItemId).not.toHaveBeenCalled();
  });

  it("tracks and highlights a scope chosen elsewhere", () => {
    setScope({ type: "account", accountId: "acc-1" });

    const { result, setSelectedItemId } = renderBridge([ALL_PORTFOLIO_ITEM]);

    expect(result.current).toEqual([ALL_PORTFOLIO_ITEM, brokerageItem]);
    expect(setSelectedItemId).toHaveBeenCalledWith("acc-1");
    expect(useAccountScopeStore.getState().bridgedItemId).toBe("acc-1");
  });

  it("does nothing when remounted with an unchanged scope", () => {
    setScope({ type: "account", accountId: "acc-1" });
    renderBridge([ALL_PORTFOLIO_ITEM]).unmount();

    const { setSelectedItems, setSelectedItemId } = renderBridge([
      ALL_PORTFOLIO_ITEM,
      brokerageItem,
    ]);

    expect(setSelectedItems).not.toHaveBeenCalled();
    expect(setSelectedItemId).not.toHaveBeenCalled();
  });

  it("replaces the bridged series when the scope is swapped", () => {
    const { result, setSelectedItemId } = renderBridge([ALL_PORTFOLIO_ITEM]);

    setScope({ type: "account", accountId: "acc-1" });
    expect(result.current).toEqual([ALL_PORTFOLIO_ITEM, brokerageItem]);

    setScope({ type: "account", accountId: "acc-2" });

    expect(result.current).toEqual([ALL_PORTFOLIO_ITEM, tfsaItem]);
    expect(setSelectedItemId).toHaveBeenLastCalledWith("acc-2");
    expect(useAccountScopeStore.getState().bridgedItemId).toBe("acc-2");
  });

  it("drops the bridged series and highlights the whole portfolio when the scope resets", () => {
    const { result, setSelectedItemId } = renderBridge([ALL_PORTFOLIO_ITEM]);

    setScope({ type: "account", accountId: "acc-1" });
    setScope({ type: "all" });

    expect(result.current).toEqual([ALL_PORTFOLIO_ITEM]);
    expect(setSelectedItemId).toHaveBeenLastCalledWith(PORTFOLIO_SCOPE_ID);
    expect(useAccountScopeStore.getState().bridgedItemId).toBeNull();
  });

  it("adopts a series the user already tracks and never removes it", () => {
    setScope({ type: "account", accountId: "acc-1" });

    const { result, setSelectedItems, setSelectedItemId } = renderBridge([
      ALL_PORTFOLIO_ITEM,
      brokerageItem,
    ]);

    expect(setSelectedItems).not.toHaveBeenCalled();
    expect(setSelectedItemId).toHaveBeenCalledWith("acc-1");
    expect(useAccountScopeStore.getState().bridgedItemId).toBeNull();

    setScope({ type: "account", accountId: "acc-2" });

    expect(result.current).toEqual([ALL_PORTFOLIO_ITEM, brokerageItem, tfsaItem]);
  });

  it("tracks a multi-account scope as a single aggregated series", () => {
    setScope({ type: "accounts", accountIds: ["acc-2", "acc-1"] });

    const { result, setSelectedItemId } = renderBridge([ALL_PORTFOLIO_ITEM]);

    expect(result.current).toEqual([
      ALL_PORTFOLIO_ITEM,
      {
        id: "accounts:acc-1,acc-2",
        type: "account",
        name: "TFSA + Brokerage",
        accountScope: { type: "accounts", accountIds: ["acc-2", "acc-1"] },
      },
    ]);
    expect(setSelectedItemId).toHaveBeenCalledWith("accounts:acc-1,acc-2");
  });

  it("waits while accounts load", () => {
    setScope({ type: "account", accountId: "acc-1" });

    const { setSelectedItems, setSelectedItemId } = renderBridge([ALL_PORTFOLIO_ITEM], true);

    expect(setSelectedItems).not.toHaveBeenCalled();
    expect(setSelectedItemId).not.toHaveBeenCalled();
  });

  it("skips a scope it cannot name", () => {
    setScope({ type: "account", accountId: "deleted" });

    const { setSelectedItems, setSelectedItemId } = renderBridge([ALL_PORTFOLIO_ITEM]);

    expect(setSelectedItems).not.toHaveBeenCalled();
    expect(setSelectedItemId).not.toHaveBeenCalled();
  });
});
