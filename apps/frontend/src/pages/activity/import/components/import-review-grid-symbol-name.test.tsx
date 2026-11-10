import { fireEvent, render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { SymbolSearchResult } from "@/lib/types";
import type { DraftActivity } from "../context";
import { ImportReviewGrid } from "./import-review-grid";

const searchTicker = vi.hoisted(() => vi.fn());
vi.mock("@/adapters", () => ({ searchTicker }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/components/create-custom-asset-dialog", () => ({ CreateCustomAssetDialog: () => null }));
// Keep the real DataGrid; only supply jsdom viewport geometry.
vi.mock("@tanstack/react-virtual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 36,
        end: (index + 1) * 36,
        size: 36,
        lane: 0,
      })),
    getTotalSize: () => count * 36,
    measureElement: () => undefined,
    measure: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

// The symbol picker's command list needs browser APIs jsdom lacks.
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
});

const namedRow: DraftActivity = {
  rowIndex: 0,
  rawRow: [],
  isEdited: false,
  activityDate: "2026-05-01",
  activityType: "BUY",
  symbol: "EXCFX",
  symbolName: "Example Credit Bond Fund",
  currency: "USD",
  accountId: "account-1",
  quantity: "10",
  unitPrice: "10",
  status: "valid",
  errors: {},
  warnings: {},
};

it("does not carry a row's name to a picked search result that has none", async () => {
  const unnamedResult: SymbolSearchResult = {
    symbol: "OTHR",
    exchange: "NASDAQ",
    exchangeMic: "XNAS",
    currency: "USD",
    quoteType: "EQUITY",
    index: "",
    typeDisplay: "Equity",
    shortName: "",
    longName: "",
    score: 1,
  };
  searchTicker.mockResolvedValue([unnamedResult]);
  const onDraftUpdate = vi.fn();
  const user = userEvent.setup();
  render(
    <ImportReviewGrid
      drafts={[namedRow]}
      selectedRows={[]}
      onSelectionChange={vi.fn()}
      onDraftUpdate={onDraftUpdate}
    />,
  );

  await user.dblClick(screen.getByText("EXCFX"));
  await user.type(await screen.findByPlaceholderText(/Search symbol or company/i), "OTHR", {
    skipClick: true,
  });
  fireEvent.click(await screen.findByRole("option", { name: /NASDAQ/ }));

  const update = onDraftUpdate.mock.calls.find(([, updates]) => "symbolName" in updates)?.[1];
  expect(update).toMatchObject({ symbol: "OTHR" });
  // A blank name counts as none: validation and fallback creation use the ticker.
  expect(update?.symbolName ?? "").toBe("");
});
