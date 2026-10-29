import { act, fireEvent, render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Activity } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import ActivityPage from "./activity-page";

const mocks = vi.hoisted(() => ({ searches: [] as string[] }));

vi.mock("@/adapters", () => ({ getAccounts: vi.fn().mockResolvedValue([]) }));
vi.mock("@/components/privacy-toggle", () => ({ PrivacyToggle: () => null }));
vi.mock("@/features/spending/hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: false, accountIds: [], isLoading: false }),
}));
vi.mock("@/features/spending/components/spending-transactions-tab", () => ({
  SpendingTransactionsTab: () => null,
}));
vi.mock("@/features/wealthfolio-connect/components/sync-button", () => ({
  SyncButton: () => null,
}));
vi.mock("@/features/wealthfolio-connect/hooks/use-show-connect-account-link", () => ({
  useShowConnectAccountLink: () => false,
}));
vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: () => ({ data: [] }) }));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ platform: null, isMobile: false, isTauri: false, loading: false }),
  useIsMobileViewport: () => false,
  useIsCompactTableViewport: () => false,
}));
vi.mock("@/pages/asset/alternative-assets", () => ({ AlternativeAssetQuickAddModal: () => null }));
vi.mock("./components/activity-data-grid/activity-data-grid", () => ({
  ActivityDataGrid: () => null,
}));
vi.mock("./components/activity-delete-modal", () => ({ ActivityDeleteModal: () => null }));
vi.mock("./components/activity-form", () => ({ ActivityForm: () => null }));
vi.mock("./components/activity-mobile-controls", () => ({ ActivityMobileControls: () => null }));
vi.mock("./components/activity-pagination", () => ({ ActivityPagination: () => null }));
vi.mock("./components/activity-table/activity-table", () => ({ default: () => null }));
vi.mock("./components/activity-table/activity-table-mobile", () => ({ default: () => null }));
vi.mock("./components/needs-review-banner", () => ({ NeedsReviewBanner: () => null }));
vi.mock("./components/forms/bulk-holdings-modal", () => ({ BulkHoldingsModal: () => null }));
vi.mock("./components/mobile-forms/mobile-activity-form", () => ({
  MobileActivityForm: () => null,
}));
vi.mock("./components/transfer-match-dialog", () => ({ TransferMatchDialog: () => null }));
vi.mock("./hooks/use-activity-action-dialogs", () => ({
  useActivityActionDialogs: () => ({ formOpen: false, deleteDialogOpen: false }),
}));
// The list's search, as the query it is asked for.
vi.mock("./hooks/use-activity-search", () => ({
  useActivitySearch: ({ searchQuery }: { searchQuery: string }) => {
    mocks.searches.push(searchQuery);
    return { data: [], isFetching: false, isLoading: false, totalRowCount: 0 };
  },
}));
// The filter bar, reduced to its search box.
vi.mock("./components/activity-view-controls", () => ({
  ActivityViewControls: ({
    searchQuery,
    onSearchQueryChange,
  }: {
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
  }) => (
    <input
      aria-label="Search activities"
      value={searchQuery}
      onChange={(event) => onSearchQueryChange(event.target.value)}
    />
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  mocks.searches = [];
});

it("searches for what was typed just before its phone screen was hidden", () => {
  // A phone screen kept under another one is a hidden <Activity>: its effects
  // clean up while it is out of sight.
  vi.useFakeTimers();
  const client = new QueryClient();
  const page = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <ActivityPage />
        </Activity>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(page(false));
  fireEvent.change(screen.getByLabelText("Search activities"), { target: { value: "AAPL" } });

  rerender(page(true));
  act(() => vi.advanceTimersByTime(1000));
  rerender(page(false));

  expect(screen.getByLabelText("Search activities")).toHaveValue("AAPL");
  expect(mocks.searches.at(-1)).toBe("AAPL");
});
