import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { expect, it, vi } from "vitest";
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
