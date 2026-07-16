import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketDataProviderSetting } from "@/adapters";
import MarketDataSettingsPage from "./market-data-settings";

const hookMocks = vi.hoisted(() => ({
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
  getSecret: hookMocks.getSecret,
}));

vi.mock("@wealthfolio/ui", () => ({
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
});
