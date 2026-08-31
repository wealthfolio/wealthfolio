import { useAccountScopeStore } from "@/lib/account-scope-store";
import type { AccountScope } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IncomePage from "./income-page";

const mocks = vi.hoisted(() => ({
  getIncomeSummary: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@/adapters", () => ({ getIncomeSummary: mocks.getIncomeSummary }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

// Stub the popover-driven selector so the scope can be read and changed directly.
vi.mock("@/components/account-filter-selector", () => ({
  AccountScopeSelector: ({
    value,
    onChange,
  }: {
    value: AccountScope;
    onChange: (scope: AccountScope) => void;
  }) => (
    <button
      data-testid="account-scope-selector"
      data-scope={JSON.stringify(value)}
      onClick={() => onChange({ type: "account", accountId: "acc-2" })}
    >
      scope
    </button>
  ),
}));

vi.mock("./income-mobile-filter-sheet", () => ({ IncomeMobileFilterSheet: () => null }));

const initialState = useAccountScopeStore.getState();

function renderPage() {
  return render(<IncomePage />);
}

function selectorScope(): AccountScope {
  return JSON.parse(screen.getByTestId("account-scope-selector").dataset.scope ?? "null");
}

describe("IncomePage account scope", () => {
  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
    mocks.getIncomeSummary.mockResolvedValue([]);
    // No summaries: renders the empty state, which still shows the selector.
    mocks.useQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  it("renders the scope held in the shared store", () => {
    useAccountScopeStore.getState().setScope({ type: "account", accountId: "acc-1" });

    renderPage();

    expect(selectorScope()).toEqual({ type: "account", accountId: "acc-1" });
  });

  it("publishes a scope change to the shared store", async () => {
    renderPage();

    await userEvent.click(screen.getByTestId("account-scope-selector"));

    expect(useAccountScopeStore.getState().scope).toEqual({
      type: "account",
      accountId: "acc-2",
    });
  });

  it("keeps the scope when the page unmounts on a tab switch", async () => {
    const { unmount } = renderPage();
    await userEvent.click(screen.getByTestId("account-scope-selector"));

    // Switching insights tabs unmounts the inactive view on desktop.
    unmount();
    renderPage();

    expect(selectorScope()).toEqual({ type: "account", accountId: "acc-2" });
  });

  it("queries income for the shared scope", () => {
    useAccountScopeStore.getState().setScope({ type: "portfolio", portfolioId: "p-1" });

    renderPage();

    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.arrayContaining([{ type: "portfolio", portfolioId: "p-1" }]),
      }),
    );
  });
});
