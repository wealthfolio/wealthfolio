import { checkActivitiesImport } from "@/adapters";
import type { ActivityImport, NewAsset } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AssetReviewStep } from "../steps/asset-review-step";
import {
  buildImportAssetCandidateFromDraft,
  buildNewAssetFromDraft,
} from "../utils/asset-review-utils";
import { ImportProvider, useImportContext, type DraftActivity } from "./import-context";

vi.mock("@/adapters", () => ({
  checkActivitiesImport: vi.fn(),
  previewImportAssets: vi.fn(),
  getExchanges: vi.fn().mockResolvedValue([{ mic: "XNAS", longName: "NASDAQ" }]),
  logger: { error: vi.fn() },
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/components/ticker-search", () => ({ default: () => null }));
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));

const reviewedFund: DraftActivity = {
  rowIndex: 0,
  isEdited: false,
  rawRow: [],
  activityDate: "2026-05-01",
  activityType: "BUY",
  symbol: "EXCFX",
  symbolName: "Example Credit Bond Fund",
  currency: "USD",
  quoteCcy: "USD",
  accountId: "account-1",
  instrumentType: "EQUITY",
  instrumentTypeLabel: "MUTUALFUND",
  quoteMode: "MANUAL",
  quantity: "10",
  unitPrice: "10",
  amount: "100",
  status: "valid",
  errors: {},
  warnings: {},
};

const otherRow: DraftActivity = {
  ...reviewedFund,
  rowIndex: 1,
  symbol: "AAPL",
  symbolName: "Apple Inc.",
  instrumentType: "EQUITY",
  instrumentTypeLabel: undefined,
  quoteMode: "MARKET",
};

beforeEach(() => {
  // Mirrors the backend check for an asset that does not exist yet: it keeps a
  // reviewed name from the request, otherwise falls back to the ticker.
  vi.mocked(checkActivitiesImport).mockReset();
  vi.mocked(checkActivitiesImport).mockImplementation(
    async ({ activities }: { activities: ActivityImport[] }) =>
      activities.map((activity) => ({
        ...activity,
        symbolName: activity.symbolName?.trim() ? activity.symbolName : activity.symbol,
        isValid: true,
      })),
  );
});

function renderContext(drafts: DraftActivity[], children?: ReactNode) {
  let context!: ReturnType<typeof useImportContext>;
  function Probe() {
    context = useImportContext();
    return null;
  }
  render(
    <ImportProvider>
      <Probe />
      {children}
    </ImportProvider>,
  );
  act(() => context.dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: drafts }));
  return () => context;
}

it("keeps a reviewed asset name through validation, revalidation, and fallback creation", async () => {
  const unnamedFund = { ...reviewedFund, symbolName: undefined };
  const key = buildImportAssetCandidateFromDraft(unnamedFund)!.key;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const context = renderContext(
    [unnamedFund, otherRow],
    <QueryClientProvider client={client}>
      <AssetReviewStep />
    </QueryClientProvider>,
  );

  const previewAsset: NewAsset = {
    kind: "INVESTMENT",
    name: "Provider Fund Name",
    displayCode: "EXCFX",
    isActive: true,
    quoteMode: "MARKET",
    quoteCcy: "USD",
    instrumentType: "EQUITY",
    instrumentTypeLabel: "MUTUALFUND",
    instrumentSymbol: "EXCFX",
    instrumentExchangeMic: "XNAS",
  };
  act(() =>
    context().dispatch({
      type: "SET_ASSET_PREVIEW_ITEMS",
      payload: [
        {
          key,
          status: "AUTO_RESOLVED_NEW_ASSET",
          resolutionSource: "provider_resolution",
          draft: previewAsset,
        },
      ],
    }),
  );
  expect(context().state.draftActivities[0].symbolName).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Name")).toHaveValue("Provider Fund Name");
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Example Credit Bond Fund" },
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Quote mode" }));
  await user.click(await screen.findByRole("option", { name: "Manual" }));
  fireEvent.click(screen.getByRole("button", { name: "Use Edited Asset" }));
  await waitFor(() =>
    expect(context().state.draftActivities[0].symbolName).toBe("Example Credit Bond Fund"),
  );
  expect(context().state.pendingImportAssets[key].draft).toMatchObject({
    name: "Example Credit Bond Fund",
    quoteMode: "MANUAL",
  });

  await act(() => context().validateDrafts(context().state.draftActivities));

  const request = vi.mocked(checkActivitiesImport).mock.calls[0][0].activities;
  expect(request[0].symbolName).toBe("Example Credit Bond Fund");
  expect(context().state.draftActivities[0].symbolName).toBe("Example Credit Bond Fund");

  // Editing another row's type clears pending assets, so confirmation falls back
  // to building the new asset from the row.
  act(() =>
    context().dispatch({
      type: "UPDATE_DRAFT",
      payload: { rowIndex: 1, updates: { activityType: "DIVIDEND" } },
    }),
  );
  expect(context().state.pendingImportAssets).toEqual({});
  await act(() => context().validateDrafts(context().state.draftActivities));

  const revalidated = context().state.draftActivities[0];
  expect(vi.mocked(checkActivitiesImport).mock.calls[1][0].activities[0].symbolName).toBe(
    "Example Credit Bond Fund",
  );
  expect(revalidated.symbolName).toBe("Example Credit Bond Fund");
  expect(buildNewAssetFromDraft(revalidated)?.name).toBe("Example Credit Bond Fund");
});

it.each([
  ["a symbol change", { symbol: "OTHER" }, undefined],
  ["an exchange change", { exchangeMic: "XLON" }, undefined],
  ["an ISIN change", { isin: "US0000000000" }, undefined],
  ["a symbol change with its own name", { symbol: "OTHER", symbolName: "Other" }, "Other"],
  ["an unchanged symbol", { symbol: "EXCFX" }, "Example Credit Bond Fund"],
  ["an instrument type change", { instrumentType: "BOND" }, "Example Credit Bond Fund"],
  ["a pricing change", { quoteMode: "MARKET" }, "Example Credit Bond Fund"],
] as const)(
  "keeps a row's name only while its asset is unchanged (%s)",
  async (_, updates, name) => {
    const context = renderContext([reviewedFund]);

    act(() =>
      context().dispatch({
        type: "UPDATE_DRAFT",
        payload: { rowIndex: 0, updates: { ...updates } },
      }),
    );
    expect(context().state.draftActivities[0].symbolName).toBe(name);

    await act(() => context().validateDrafts(context().state.draftActivities));
    expect(vi.mocked(checkActivitiesImport).mock.calls[0][0].activities[0].symbolName).toBe(name);
  },
);
