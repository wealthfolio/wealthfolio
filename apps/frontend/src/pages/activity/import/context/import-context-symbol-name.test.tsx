import { checkActivitiesImport } from "@/adapters";
import type { ActivityImport } from "@/lib/types";
import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { buildNewAssetFromDraft } from "../utils/asset-review-utils";
import { ImportProvider, useImportContext, type DraftActivity } from "./import-context";

vi.mock("@/adapters", () => ({
  checkActivitiesImport: vi.fn(),
  previewImportAssets: vi.fn(),
  logger: { error: vi.fn() },
}));

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

function renderContext(drafts: DraftActivity[]) {
  let context!: ReturnType<typeof useImportContext>;
  function Probe() {
    context = useImportContext();
    return null;
  }
  render(
    <ImportProvider>
      <Probe />
    </ImportProvider>,
  );
  act(() => context.dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: drafts }));
  return () => context;
}

it("keeps a reviewed asset name through validation, revalidation, and fallback creation", async () => {
  const context = renderContext([reviewedFund, otherRow]);

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
