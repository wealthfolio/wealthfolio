import { useAccountScopeStore } from "@/lib/account-scope-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialState = useAccountScopeStore.getState();

describe("account scope store", () => {
  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts on the all-accounts scope with the bridge idle", () => {
    const state = useAccountScopeStore.getState();

    expect(state.scope).toEqual({ type: "all" });
    expect(state.bridgedScopeKey).toBe("all");
    expect(state.bridgedItemId).toBeNull();
  });

  it("shares the scope with every other reader", () => {
    useAccountScopeStore.getState().setScope({ type: "account", accountId: "acc-1" });

    expect(useAccountScopeStore.getState().scope).toEqual({
      type: "account",
      accountId: "acc-1",
    });
  });

  it("keeps the selection in memory only", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    useAccountScopeStore.getState().setScope({ type: "portfolio", portfolioId: "p-1" });
    useAccountScopeStore.getState().setBridged("portfolio:p-1", "p-1");

    expect(setItem).not.toHaveBeenCalled();
  });
});
