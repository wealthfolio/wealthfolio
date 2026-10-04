import { fireEvent, render, screen, within } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketDataProviderSetting } from "@/adapters";
import type { Asset } from "@/lib/types";
import type { CustomProviderWithSources } from "@/lib/types/custom-provider";
import MarketDataSettingsPage from "./market-data-settings";

const hookMocks = vi.hoisted(() => ({
  getAssets: vi.fn(),
  getSecret: vi.fn(),
  useCustomProviders: vi.fn(),
  useDeleteApiKey: vi.fn(),
  useDeleteCustomProvider: vi.fn(),
  useMarketDataProviderSettings: vi.fn(),
  useRecalculatePortfolioMutation: vi.fn(),
  useSetApiKey: vi.fn(),
  useUpdateCustomProvider: vi.fn(),
  useUpdateMarketDataProviderSettings: vi.fn(),
  useUpdatePortfolioMutation: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getAssets: hookMocks.getAssets,
  getSecret: hookMocks.getSecret,
}));

vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  ActionConfirm: ({ button }: { button: ReactNode }) => <>{button}</>,
}));

vi.mock("@/hooks/use-calculate-portfolio", () => ({
  useRecalculatePortfolioMutation: hookMocks.useRecalculatePortfolioMutation,
  useUpdatePortfolioMutation: hookMocks.useUpdatePortfolioMutation,
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: hookMocks.useCustomProviders,
  useDeleteCustomProvider: hookMocks.useDeleteCustomProvider,
  useUpdateCustomProvider: hookMocks.useUpdateCustomProvider,
}));

vi.mock("./custom-provider-form", () => ({
  CustomProviderForm: () => null,
}));

vi.mock("./use-market-data-settings", () => ({
  useDeleteApiKey: hookMocks.useDeleteApiKey,
  useMarketDataProviderSettings: hookMocks.useMarketDataProviderSettings,
  useSetApiKey: hookMocks.useSetApiKey,
  useUpdateMarketDataProviderSettings: hookMocks.useUpdateMarketDataProviderSettings,
}));

const mutate = vi.fn();

function marketDataProvider(
  overrides: Partial<MarketDataProviderSetting> = {},
): MarketDataProviderSetting {
  return {
    id: "ALPHA_VANTAGE",
    name: "Alpha Vantage",
    description: "Alpha Vantage market data",
    url: "https://www.alphavantage.co/",
    priority: 3,
    enabled: false,
    logoFilename: null,
    capabilities: {
      instruments: "Stocks",
      coverage: "Global",
      features: ["Real-time"],
    },
    requiresApiKey: true,
    hasApiKey: false,
    assetCount: 0,
    errorCount: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    uniqueErrors: [],
    providerType: "builtin",
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MarketDataSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openProviderSettings(): Promise<HTMLInputElement> {
  const user = userEvent.setup();
  renderPage();

  const providerRow = screen
    .getByText("Alpha Vantage")
    .closest<HTMLElement>(".flex.items-center.gap-4.px-4.py-3");
  if (!providerRow) {
    throw new Error("Provider row not found");
  }

  await user.click(within(providerRow).getAllByRole("button")[0]);
  return screen.findByLabelText<HTMLInputElement>("API Key");
}

describe("MarketDataSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.useMarketDataProviderSettings.mockReturnValue({
      data: [marketDataProvider()],
      isLoading: false,
      error: null,
    });
    hookMocks.useUpdateMarketDataProviderSettings.mockReturnValue({ mutate });
    hookMocks.useUpdatePortfolioMutation.mockReturnValue({ mutate, isPending: false });
    hookMocks.useRecalculatePortfolioMutation.mockReturnValue({ mutate, isPending: false });
    hookMocks.getAssets.mockResolvedValue([]);
    hookMocks.useCustomProviders.mockReturnValue({ data: [] });
    hookMocks.useDeleteCustomProvider.mockReturnValue({ mutate });
    hookMocks.useUpdateCustomProvider.mockReturnValue({ mutate });
    hookMocks.useSetApiKey.mockReturnValue({ mutate });
    hookMocks.useDeleteApiKey.mockReturnValue({ mutate });
  });

  it("keeps a new market data API key visible while typing or pasting", async () => {
    const user = userEvent.setup();
    const input = await openProviderSettings();

    await user.type(input, "alpha-key");
    expect(input).toHaveValue("alpha-key");

    fireEvent.change(input, { target: { value: "pasted-key" } });
    expect(input).toHaveValue("pasted-key");
  });

  function customProvider(
    id: string,
    name: string,
    useAsFallback: boolean,
    url: string,
  ): CustomProviderWithSources {
    return {
      id,
      name,
      description: "",
      enabled: true,
      priority: 50,
      useAsFallback,
      sources: [
        {
          id: `${id}:latest`,
          providerId: id,
          kind: "latest",
          format: "json",
          url,
          pricePath: "$.price",
        },
      ],
    };
  }

  function assignedAsset(id: string, displayCode: string, code: string): Asset {
    return {
      id,
      kind: "INVESTMENT",
      displayCode,
      quoteMode: "MARKET",
      quoteCcy: "USD",
      providerConfig: { preferred_provider: "CUSTOM_SCRAPER", custom_provider_code: code },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as Asset;
  }

  async function openCustomProviders() {
    hookMocks.useCustomProviders.mockReturnValue({
      data: [
        customProvider("general", "General API", true, "https://api.example.com/{SYMBOL}"),
        customProvider("fund", "Private fund", false, "https://funds.example.com/{ISIN}"),
      ],
    });
    hookMocks.getAssets.mockResolvedValue([
      assignedAsset("fund-b", "FUNDB", "fund"),
      assignedAsset("fund-a", "FUNDA", "fund"),
    ]);
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: /custom providers/i }));
    const row = (name: string) =>
      screen.getByText(name).closest<HTMLElement>(".flex.items-center.gap-4.px-4.py-3")!;
    return { user, row };
  }

  it("marks fallback providers and counts the securities each one serves", async () => {
    const { row } = await openCustomProviders();

    expect(await within(row("Private fund")).findByText("2 securities")).toBeInTheDocument();
    expect(within(row("Private fund")).queryByText("Fallback")).not.toBeInTheDocument();
    expect(within(row("General API")).getByText("Fallback")).toBeInTheDocument();
  });

  it("names the securities blocking a delete instead of offering to delete", async () => {
    const { user, row } = await openCustomProviders();
    await within(row("Private fund")).findByText("2 securities");

    await user.click(within(row("Private fund")).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Can't delete Private fund yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "FUNDA" })).toHaveAttribute("href", "/holdings/fund-a");
    expect(screen.getByRole("link", { name: "FUNDB" })).toHaveAttribute("href", "/holdings/fund-b");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps history maintenance in one menu and confirms a full refresh", async () => {
    const recalculate = vi.fn();
    hookMocks.useRecalculatePortfolioMutation.mockReturnValue({
      mutate: recalculate,
      isPending: false,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "History" }));

    expect(
      await screen.findByRole("menuitem", { name: /import prices from csv/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /reset provider history/i })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: /refresh full history/i }));
    expect(recalculate).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Refresh full history" }));

    expect(recalculate).toHaveBeenCalledTimes(1);
  });
});
