import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityType, HoldingType, QuoteMode } from "@/lib/constants";
import type { ActivityDetails, Holding } from "@/lib/types";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { AssetsTable } from "@/pages/asset/assets-table";
import type { ParsedAsset } from "@/pages/asset/asset-utils";
import { HoldingsTable } from "@/pages/holdings/components/holdings-table";
import { ActivityTable } from "@/pages/activity/components/activity-table/activity-table";

vi.mock("@/pages/activity/hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({ duplicateActivityMutation: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

const closedHolding: Holding = {
  id: "closed-xyz",
  accountId: "account-1",
  holdingType: HoldingType.SECURITY,
  isClosed: true,
  quantity: 0,
  localCurrency: "USD",
  baseCurrency: "USD",
  marketValue: { local: 0, base: 0 },
  costBasis: { local: 0, base: 0 },
  returnBasis: { local: 100, base: 100 },
  realizedGain: { local: 10, base: 10 },
  weight: 0,
  asOfDate: "2026-08-18",
  instrument: {
    id: "asset-xyz",
    symbol: "XYZ",
    name: "Acme Corporation",
    currency: "USD",
    quoteMode: QuoteMode.MARKET,
  },
};

const profile = vi.hoisted(() => ({ id: "profile-a", legacy: false }));
vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => profile.id,
  usesLegacyPreferences: () => profile.legacy,
}));

function renderHoldings() {
  return render(
    <HoldingsTable holdings={[closedHolding]} isLoading={false} visibilityFilters={["closed"]} />,
  );
}

const activity: ActivityDetails = {
  id: "activity-1",
  activityType: ActivityType.BUY,
  date: new Date("2026-01-01T00:00:00Z"),
  quantity: "1",
  unitPrice: "100",
  amount: null,
  fee: "0",
  currency: "USD",
  needsReview: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  assetId: "asset-xyz",
  assetSymbol: "XYZ",
  assetName: "Acme Corporation",
  accountId: "account-1",
  accountName: "Brokerage",
  accountCurrency: "USD",
};

function renderActivities() {
  return render(
    <ActivityTable
      activities={[activity]}
      isLoading={false}
      sorting={[]}
      onSortingChange={vi.fn()}
      handleEdit={vi.fn()}
      handleDelete={vi.fn()}
    />,
  );
}

const asset: ParsedAsset = {
  id: "asset-xyz",
  kind: "INVESTMENT",
  name: "Acme Corporation",
  displayCode: "XYZ",
  quoteMode: "MARKET",
  quoteCcy: "USD",
  instrumentType: "EQUITY",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  sectorsList: [],
  countriesList: [],
};
function renderAssets() {
  return render(
    <TooltipProvider>
      <AssetsTable
        assets={[asset]}
        heldAssetIds={new Set([asset.id])}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onUpdateQuotes={vi.fn()}
        onRefetchQuotes={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe.each([
  {
    name: "HoldingsTable",
    storageKey: "holdings-table-v4",
    filter: [{ id: "holdingType", value: ["ETF"] }],
    renderTable: renderHoldings,
  },
  {
    name: "AssetsTable",
    storageKey: "securities-table-v5",
    filter: [{ id: "holdingStatus", value: ["false"] }],
    renderTable: renderAssets,
  },
])("$name profile preferences", ({ storageKey, filter, renderTable }) => {
  const storedFilter = JSON.stringify(filter);

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    profile.id = "profile-a";
    profile.legacy = false;
  });

  it("keeps a profile's filters when returning, without filtering another profile", () => {
    localStorage.setItem(`profile:profile-a:${storageKey}:column-filters`, storedFilter);
    const first = renderTable();
    expect(screen.getByText("No results found.")).toBeInTheDocument();
    first.unmount();
    profile.id = "profile-b";
    const second = renderTable();
    expect(screen.getByText("Acme Corporation")).toBeInTheDocument();
    second.unmount();
    profile.id = "profile-a";
    renderTable();
    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });

  it("does not inherit global preferences in a new profile", () => {
    localStorage.setItem(`${storageKey}:column-filters`, storedFilter);
    renderTable();
    expect(screen.getByText("Acme Corporation")).toBeInTheDocument();
  });

  it("preserves global preferences for the adopted legacy profile", () => {
    profile.legacy = true;
    localStorage.setItem(`${storageKey}:column-filters`, storedFilter);
    renderTable();
    expect(screen.getByText("No results found.")).toBeInTheDocument();
  });

  it("writes legacy preference changes only to the selected profile", () => {
    profile.legacy = true;
    localStorage.setItem(`${storageKey}:column-filters`, storedFilter);
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("Acme Corporation")).toBeInTheDocument();
    expect(localStorage.getItem(`profile:profile-a:${storageKey}:column-filters`)).toBe("[]");
    expect(localStorage.getItem(`${storageKey}:column-filters`)).toBe(storedFilter);
  });

  it("prefers the legacy profile's scoped preferences over global values", () => {
    profile.legacy = true;
    localStorage.setItem(`${storageKey}:column-filters`, storedFilter);
    localStorage.setItem(`profile:profile-a:${storageKey}:column-filters`, "[]");
    renderTable();
    expect(screen.getByText("Acme Corporation")).toBeInTheDocument();
  });
});

describe.each([
  {
    name: "HoldingsTable",
    storageKey: "holdings-table-v4:column-visibility",
    toggleLabel: "Columns",
    visibleColumnLabel: "Cost Basis",
    renderTable: renderHoldings,
  },
  {
    name: "ActivityTable",
    storageKey: "activity-table-column-visibility",
    toggleLabel: "Toggle columns",
    visibleColumnLabel: "Quantity",
    renderTable: renderActivities,
  },
])("$name column visibility", ({ storageKey, toggleLabel, visibleColumnLabel, renderTable }) => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    profile.id = "profile-a";
    profile.legacy = false;
  });

  it("restores toggled columns after remounting and keeps profiles separate", async () => {
    const user = userEvent.setup();
    const first = renderTable();
    expect(screen.queryByRole("columnheader", { name: "Currency" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: toggleLabel }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Currency" }));
    expect(screen.getByRole("columnheader", { name: "Currency" })).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(`profile:profile-a:${storageKey}`) ?? "{}"),
    ).toMatchObject({ currency: true });
    first.unmount();

    const restored = renderTable();
    expect(screen.getByRole("columnheader", { name: "Currency" })).toBeInTheDocument();
    restored.unmount();

    profile.id = "profile-b";
    const otherProfile = renderTable();
    expect(screen.queryByRole("columnheader", { name: "Currency" })).not.toBeInTheDocument();
    otherProfile.unmount();

    profile.id = "profile-a";
    renderTable();
    expect(screen.getByRole("columnheader", { name: "Currency" })).toBeInTheDocument();
  });

  it("restores a hidden default-visible column", async () => {
    const user = userEvent.setup();
    const first = renderTable();
    expect(screen.getByRole("columnheader", { name: visibleColumnLabel })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: toggleLabel }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: visibleColumnLabel }));
    expect(
      screen.queryByRole("columnheader", { name: visibleColumnLabel }),
    ).not.toBeInTheDocument();
    first.unmount();

    renderTable();
    expect(
      screen.queryByRole("columnheader", { name: visibleColumnLabel }),
    ).not.toBeInTheDocument();
  });
});
