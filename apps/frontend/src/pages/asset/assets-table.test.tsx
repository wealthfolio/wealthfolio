import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { expect, it, vi } from "vitest";
import type { LatestQuoteSnapshot } from "@/lib/types";
import type { ParsedAsset } from "./asset-utils";
import { AssetsTable } from "./assets-table";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
const navigate = vi.hoisted(() => () => undefined);
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));
vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => "profile-a",
  usesLegacyPreferences: () => false,
}));

const security = (id: string, displayCode: string): ParsedAsset => ({
  id,
  kind: "INVESTMENT",
  name: displayCode,
  displayCode,
  quoteMode: "MARKET",
  quoteCcy: "USD",
  instrumentType: "EQUITY",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  sectorsList: [],
  countriesList: [],
});

it("closes an open row menu when a refetch moves another security into its row", async () => {
  const user = userEvent.setup();
  // Stable across renders, as the page passes them, so the columns are kept.
  const handlers = {
    latestQuotes: {},
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onUpdateQuotes: vi.fn(),
    onRefetchQuotes: vi.fn(),
  };
  const table = (assets: ParsedAsset[]) => (
    <TooltipProvider>
      <AssetsTable
        assets={assets}
        heldAssetIds={new Set(assets.map((asset) => asset.id))}
        {...handlers}
      />
    </TooltipProvider>
  );
  const msft = security("msft", "MSFT");
  const { rerender } = render(table([msft]));
  await user.click(screen.getByRole("button", { name: "Open actions" }));
  expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeInTheDocument();

  // Rows are keyed by position, so AAPL now takes MSFT's row.
  rerender(table([security("aapl", "AAPL"), msft]));

  expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  expect(handlers.onDelete).not.toHaveBeenCalled();
});

it.each([
  ["isUpdatingQuotes", "Update quotes", "Refetch price history"],
  ["isRefetchingQuotes", "Refetch price history", "Update quotes"],
] as const)(
  "keeps a row's menu open and its button focused while %s and quotes change",
  async (flag, label, otherLabel) => {
    const user = userEvent.setup();
    const handlers = {
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onUpdateQuotes: vi.fn(),
      onRefetchQuotes: vi.fn(),
    };
    const msft = security("msft", "MSFT");
    const held = new Set([msft.id]);
    const emptyQuotes = {};
    const table = (props: {
      latestQuotes: Record<string, LatestQuoteSnapshot>;
      isUpdatingQuotes?: boolean;
      isRefetchingQuotes?: boolean;
    }) => (
      <TooltipProvider>
        <AssetsTable assets={[msft]} heldAssetIds={held} {...handlers} {...props} />
      </TooltipProvider>
    );
    const { rerender } = render(table({ latestQuotes: emptyQuotes }));
    const trigger = screen.getByRole("button", { name: "Open actions" });
    await user.click(trigger);
    expect(await screen.findByRole("menuitem", { name: label })).not.toHaveAttribute(
      "data-disabled",
    );

    // Change the pending flag and quotes separately: neither should remount the cells.
    rerender(table({ latestQuotes: emptyQuotes, [flag]: true }));
    expect(trigger.isConnected).toBe(true);
    expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: otherLabel })).not.toHaveAttribute("data-disabled");
    const quote = {
      id: "q1",
      createdAt: "2026-11-02T00:00:00Z",
      dataSource: "MANUAL",
      timestamp: "2026-11-02T00:00:00Z",
      assetId: msft.id,
      open: 412.5,
      high: 412.5,
      low: 412.5,
      volume: 0,
      close: 412.5,
      adjclose: 412.5,
      currency: "USD",
    };
    const quotes = { [msft.id]: { quote, isStale: false, effectiveMarketDate: "2026-11-02" } };
    rerender(table({ latestQuotes: quotes, [flag]: true }));

    expect(trigger.isConnected).toBe(true);
    expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute("data-disabled");
    expect(screen.getByText(/412\.50/)).toBeInTheDocument();

    // Focus goes back to the button when the menu closes; the update ending must keep it there.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    rerender(table({ latestQuotes: quotes }));
    expect(trigger).toHaveFocus();
  },
);
