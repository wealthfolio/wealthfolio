import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { Activity, type ReactNode } from "react";
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
  useIsSavingProviderSettings: vi.fn(),
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
  ActionConfirm: ({
    button,
    handleConfirm,
    isPending,
  }: {
    button: ReactNode;
    handleConfirm: () => void;
    isPending?: boolean;
  }) => (
    <>
      {button}
      <button type="button" disabled={isPending} onClick={handleConfirm}>
        Confirm delete
      </button>
    </>
  ),
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
  CustomProviderForm: ({ open }: { open: boolean }) =>
    open ? <div>Custom provider form</div> : null,
}));

vi.mock("./use-market-data-settings", () => ({
  useDeleteApiKey: hookMocks.useDeleteApiKey,
  useIsSavingProviderSettings: hookMocks.useIsSavingProviderSettings,
  useMarketDataProviderSettings: hookMocks.useMarketDataProviderSettings,
  useSetApiKey: hookMocks.useSetApiKey,
  useUpdateMarketDataProviderSettings: hookMocks.useUpdateMarketDataProviderSettings,
}));

const mutate = vi.fn();
const mutateAsync = vi.fn();

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
  hookMocks.useMarketDataProviderSettings.mockReturnValue({
    data: [marketDataProvider({ enabled: true })],
    isLoading: false,
    error: null,
  });
  renderPage();

  await user.click(screen.getByRole("button", { name: "Alpha Vantage settings" }));
  return screen.findByLabelText<HTMLInputElement>("API key");
}

describe("MarketDataSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.useMarketDataProviderSettings.mockReturnValue({
      data: [marketDataProvider()],
      isLoading: false,
      error: null,
    });
    mutateAsync.mockResolvedValue(undefined);
    hookMocks.useUpdateMarketDataProviderSettings.mockReturnValue({ mutate, mutateAsync });
    hookMocks.useIsSavingProviderSettings.mockReturnValue(false);
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
      {
        ...assignedAsset("aapl", "AAPL", "fund"),
        providerConfig: {
          preferred_provider: "YAHOO",
          overrides: { "CUSTOM:fund": { type: "equity_symbol", symbol: "apple" } },
        },
      },
      {
        ...assignedAsset("msft", "MSFT", "fund"),
        providerConfig: { preferred_provider: "YAHOO", custom_provider_code: "fund" },
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    const row = (name: string) => screen.getByText(name).closest<HTMLElement>("li")!;
    return { user, row };
  }

  it("frees a provider's switch once a change ends while the screen is out of sight", async () => {
    // On a phone, a screen kept under another one is a hidden <Activity>.
    let finish: () => void = () => undefined;
    hookMocks.useUpdateCustomProvider.mockImplementation(() =>
      useMutation({ mutationFn: () => new Promise<void>((resolve) => (finish = resolve)) }),
    );
    hookMocks.useCustomProviders.mockReturnValue({
      data: [customProvider("fund", "Private fund", false, "https://funds.example.com/{ISIN}")],
    });
    const client = new QueryClient();
    const page = (hidden: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Activity mode={hidden ? "hidden" : "visible"}>
            <MarketDataSettingsPage />
          </Activity>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const changeStatus = () => client.getMutationCache().getAll()[0]?.state.status;
    const user = userEvent.setup();
    const { rerender } = render(page(false));
    await user.click(screen.getByRole("switch", { name: "Private fund" }));
    await waitFor(() => expect(changeStatus()).toBe("pending"));
    expect(screen.getByRole("switch", { name: "Private fund" })).toHaveAttribute("data-disabled");

    rerender(page(true));
    act(() => finish());
    await waitFor(() => expect(changeStatus()).toBe("success"));
    rerender(page(false));

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Private fund" })).not.toHaveAttribute(
        "data-disabled",
      ),
    );
  });

  it("frees a provider's delete once it fails while the screen is out of sight", async () => {
    let fail: () => void = () => undefined;
    hookMocks.useDeleteCustomProvider.mockImplementation(() =>
      useMutation({
        mutationFn: () => new Promise<void>((_, reject) => (fail = () => reject(new Error()))),
      }),
    );
    hookMocks.useCustomProviders.mockReturnValue({
      data: [customProvider("fund", "Private fund", false, "https://funds.example.com/{ISIN}")],
    });
    const client = new QueryClient();
    const page = (hidden: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Activity mode={hidden ? "hidden" : "visible"}>
            <MarketDataSettingsPage />
          </Activity>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const deleteStatus = () => client.getMutationCache().getAll()[0]?.state.status;
    const user = userEvent.setup();
    const { rerender } = render(page(false));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(deleteStatus()).toBe("pending"));
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeDisabled();

    rerender(page(true));
    act(() => fail());
    await waitFor(() => expect(deleteStatus()).toBe("error"));
    rerender(page(false));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm delete" })).toBeEnabled(),
    );
  });

  it("marks fallback providers and counts the securities each one serves", async () => {
    const { row } = await openCustomProviders();

    expect(await within(row("Private fund")).findByText("3 securities")).toBeInTheDocument();
    expect(within(row("Private fund")).queryByText("Fallback")).not.toBeInTheDocument();
    expect(within(row("General API")).getByText("Fallback")).toBeInTheDocument();
  });

  it("names the securities blocking a delete and how to release each kind", async () => {
    const { user, row } = await openCustomProviders();
    await within(row("Private fund")).findByText("3 securities");

    await user.click(within(row("Private fund")).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Can't delete Private fund yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 securities are assigned to it. Choose a different market data provider for them.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 security has a symbol mapped for it. Remove that mapping in its market data settings.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "FUNDA" })).toHaveAttribute("href", "/holdings/fund-a");
    expect(screen.getByRole("link", { name: "FUNDB" })).toHaveAttribute("href", "/holdings/fund-b");
    expect(screen.getByRole("link", { name: "AAPL" })).toHaveAttribute("href", "/holdings/aapl");
    // A code left under another provider isn't an assignment but still blocks deletion.
    expect(
      screen.getByText(
        "1 security still carries an old reference to it. Open its market data settings and save to clear it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MSFT" })).toHaveAttribute("href", "/holdings/msft");
    expect(mutate).not.toHaveBeenCalled();
  });

  function setProviders(...providers: MarketDataProviderSetting[]) {
    hookMocks.useMarketDataProviderSettings.mockReturnValue({
      data: providers,
      isLoading: false,
      error: null,
    });
  }

  const yahoo = marketDataProvider({
    id: "YAHOO",
    name: "Yahoo Finance",
    priority: 1,
    enabled: true,
    requiresApiKey: false,
  });
  const treasury = marketDataProvider({
    id: "US_TREASURY_CALC",
    name: "US Treasury (Calculated)",
    priority: 10,
    enabled: true,
    requiresApiKey: false,
  });
  const amfi = marketDataProvider({
    id: "AMFI",
    name: "AMFI",
    description: "Daily NAVs for Indian mutual funds",
    priority: 15,
    requiresApiKey: false,
  });

  it("lists the providers that are on in fetch order and keeps the rest in the catalog", async () => {
    setProviders(treasury, marketDataProvider(), yahoo, amfi);
    const user = userEvent.setup();
    renderPage();

    const list = screen.getByRole("list", { name: "Built-in providers" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("Yahoo Finance");
    expect(names[1]).toContain("US Treasury (Calculated)");
    expect(within(list).queryByText("Alpha Vantage")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    const catalog = await screen.findByRole("list", { name: "Add a provider" });
    expect(within(catalog).getByText("Alpha Vantage")).toBeInTheDocument();
    expect(within(catalog).getByText("AMFI")).toBeInTheDocument();
    expect(within(catalog).queryByText("Yahoo Finance")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search providers" }), "alpha");
    expect(within(catalog).getByText("Alpha Vantage")).toBeInTheDocument();
    expect(within(catalog).queryByText("AMFI")).not.toBeInTheDocument();
  });

  it("moves a provider by trading priorities with its neighbour", async () => {
    setProviders(yahoo, treasury);
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByRole("button", { name: "Move Yahoo Finance up" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move US Treasury (Calculated) down" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Move US Treasury (Calculated) up" }));

    // One write at a time, in order.
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls.map(([change]) => change)).toEqual([
      { providerId: "US_TREASURY_CALC", priority: 1, enabled: true },
      { providerId: "YAHOO", priority: 10, enabled: true },
    ]);
  });

  it("stops a move when its first write fails", async () => {
    setProviders(yahoo, treasury);
    mutateAsync.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Move US Treasury (Calculated) up" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // Yahoo keeps priority 1 instead of being written alone to 10.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("turns a provider on from the catalog without changing its place", async () => {
    setProviders(yahoo, marketDataProvider());
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.click(await screen.findByRole("button", { name: "Add Alpha Vantage" }));

    expect(mutate).toHaveBeenCalledWith({
      providerId: "ALPHA_VANTAGE",
      priority: 3,
      enabled: true,
    });
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Add a provider" })).not.toBeInTheDocument(),
    );
  });

  it("puts back what a move saved when its second write fails", async () => {
    setProviders(yahoo, treasury);
    mutateAsync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Move US Treasury (Calculated) up" }));

    // Treasury was saved at 1 before Yahoo's write failed; it goes back to 10.
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(3));
    expect(mutateAsync.mock.calls.map(([change]) => change)).toEqual([
      { providerId: "US_TREASURY_CALC", priority: 1, enabled: true },
      { providerId: "YAHOO", priority: 10, enabled: true },
      { providerId: "US_TREASURY_CALC", priority: 10, enabled: true },
    ]);
  });

  it("handles a failed undo without throwing", async () => {
    setProviders(yahoo, treasury);
    mutateAsync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Move US Treasury (Calculated) up" }));

    // The mutation hook reports each failure; the move only has to finish cleanly.
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(3));
  });

  it("locks the order and switches while a move is saving", async () => {
    setProviders(yahoo, treasury);
    let finishFirst: () => void = () => undefined;
    mutateAsync.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );
    const user = userEvent.setup();
    renderPage();
    const controls = () => [
      screen.getByRole("button", { name: "Move Yahoo Finance down" }),
      screen.getByRole("button", { name: "Move US Treasury (Calculated) up" }),
      screen.getByRole("switch", { name: "Yahoo Finance" }),
      screen.getByRole("switch", { name: "US Treasury (Calculated)" }),
    ];

    await user.click(screen.getByRole("button", { name: "Move US Treasury (Calculated) up" }));

    // A second move or a switch now could save on top of a half-saved order.
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    for (const control of controls()) {
      expect(control).toHaveAttribute("data-disabled");
    }

    act(() => finishFirst());
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      for (const control of controls()) {
        expect(control).not.toHaveAttribute("data-disabled");
      }
    });
  });

  it("locks the order and switches while another provider save is pending", () => {
    setProviders(yahoo, treasury);
    hookMocks.useIsSavingProviderSettings.mockReturnValue(true);
    renderPage();

    // A provider just switched on is still saving; a move now could race it.
    expect(
      screen.getByRole("button", { name: "Move US Treasury (Calculated) up" }),
    ).toHaveAttribute("data-disabled");
    expect(screen.getByRole("switch", { name: "Yahoo Finance" })).toHaveAttribute("data-disabled");
  });

  it("clears the catalog search after adding a provider", async () => {
    setProviders(yahoo, marketDataProvider(), amfi);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.type(await screen.findByRole("searchbox", { name: "Search providers" }), "alpha");
    await user.click(screen.getByRole("button", { name: "Add Alpha Vantage" }));
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Add a provider" })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByRole("searchbox", { name: "Search providers" })).toHaveValue("");
    expect(screen.getByText("AMFI")).toBeInTheDocument();
  });

  it("keeps a provider switched off in place until the next visit", async () => {
    setProviders(yahoo, treasury, amfi);
    const client = new QueryClient();
    const page = () => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MarketDataSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    const { rerender, unmount } = render(page());

    await user.click(screen.getByRole("switch", { name: "US Treasury (Calculated)" }));
    expect(mutate).toHaveBeenCalledWith({
      providerId: "US_TREASURY_CALC",
      priority: 10,
      enabled: false,
    });

    // The refetch reports it off; the row stays, so the switch can be flipped back.
    setProviders(yahoo, { ...treasury, enabled: false }, amfi);
    rerender(page());
    const list = screen.getByRole("list", { name: "Built-in providers" });
    expect(within(list).getByText("US Treasury (Calculated)")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "US Treasury (Calculated)" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Move US Treasury (Calculated) up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Yahoo Finance down" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    const catalog = await screen.findByRole("list", { name: "Add a provider" });
    expect(within(catalog).queryByText("US Treasury (Calculated)")).not.toBeInTheDocument();
    unmount();

    // On the next visit it waits in the catalog like any provider that's off.
    renderPage();
    expect(
      within(screen.getByRole("list", { name: "Built-in providers" })).queryByText(
        "US Treasury (Calculated)",
      ),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add provider" }));
    expect(
      within(await screen.findByRole("list", { name: "Add a provider" })).getByText(
        "US Treasury (Calculated)",
      ),
    ).toBeInTheDocument();
  });

  it("adds custom providers from their own card, not the built-in catalog", async () => {
    const user = userEvent.setup();
    renderPage();

    // With none set up, the card still shows its button and a line on what it's for.
    expect(
      screen.getByText("Add a custom data source to scrape prices from any website or API."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await screen.findByRole("list", { name: "Add a provider" });
    expect(screen.queryByRole("button", { name: "Add custom provider" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(await screen.findByRole("button", { name: "Add custom provider" }));
    expect(await screen.findByText("Custom provider form")).toBeInTheDocument();
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
