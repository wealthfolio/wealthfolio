import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Activity } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import AssetsPage from "./assets-page";

const mocks = vi.hoisted(() => ({
  useCreateAsset: (() => undefined) as () => unknown,
}));

vi.mock("./hooks/use-assets", () => ({ useAssets: () => ({ assets: [], isLoading: false }) }));
vi.mock("./hooks/use-asset-management", () => ({
  useAssetManagement: () => ({
    createAssetMutation: mocks.useCreateAsset(),
    deleteAssetMutation: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock("./hooks/use-latest-quotes", () => ({
  useLatestQuotes: () => ({ data: {}, isLoading: false }),
}));
vi.mock("@/hooks/use-sync-market-data", () => ({
  useSyncMarketDataMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-holdings", () => ({ useHoldings: () => ({ holdings: [] }) }));
vi.mock("@/hooks/use-platform", () => ({ useIsCompactTableViewport: () => false }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("./assets-table", () => ({ AssetsTable: () => null }));
vi.mock("./assets-table-mobile", () => ({ AssetsTableMobile: () => null }));
vi.mock("./asset-edit-sheet", () => ({ AssetEditSheet: () => null }));
// The dialog's own fields have their coverage; what matters here is when it closes.
vi.mock("./create-security-dialog", () => ({
  CreateSecurityDialog: ({
    open,
    onSubmit,
  }: {
    open: boolean;
    onSubmit: (payload: object) => void;
  }) =>
    open ? (
      <div role="dialog">
        <button type="button" onClick={() => onSubmit({ symbol: "ACME" })}>
          Create ACME
        </button>
      </div>
    ) : null,
}));

it("closes the new security dialog when its save ends while the screen is out of sight", async () => {
  // On a phone, a screen left for another tab is a hidden <Activity>.
  let finish: () => void = () => undefined;
  const saved = new Promise<void>((resolve) => (finish = resolve));
  mocks.useCreateAsset = () => useMutation({ mutationFn: () => saved });
  const client = new QueryClient();
  const page = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <AssetsPage />
        </Activity>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
  const { rerender } = render(page(false));
  fireEvent.click(screen.getByRole("button", { name: "Add Security" }));
  fireEvent.click(screen.getByRole("button", { name: "Create ACME" }));
  await waitFor(() => expect(saveStatus()).toBe("pending"));

  rerender(page(true));
  act(() => finish());
  await waitFor(() => expect(saveStatus()).toBe("success"));
  rerender(page(false));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
