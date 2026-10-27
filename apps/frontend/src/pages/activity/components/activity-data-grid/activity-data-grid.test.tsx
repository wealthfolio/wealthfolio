import { resolveSymbolQuote } from "@/adapters";
import type { ActivityDetails, ResolvedQuote } from "@/lib/types";
import { act, render } from "@testing-library/react";
import type { SymbolSearchResult, useDataGrid } from "@wealthfolio/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityDataGrid } from "./activity-data-grid";
import type { LocalTransaction } from "./types";

type GridOptions = Parameters<typeof useDataGrid<LocalTransaction>>[0];

const grid = vi.hoisted(() => ({
  options: undefined as unknown as GridOptions,
  api: undefined as unknown as ReturnType<typeof useDataGrid<LocalTransaction>>,
  onSymbolSelect: undefined as unknown as (rowIndex: number, result: SymbolSearchResult) => void,
  onDuplicate: undefined as unknown as (activity: ActivityDetails) => Promise<void>,
  onEdit: undefined as unknown as (activity: ActivityDetails) => void,
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  resolveSymbolQuote: vi.fn(),
}));
vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  return {
    ...actual,
    DataGrid: () => null,
    useDataGrid: (options: GridOptions) => {
      grid.options = options;
      grid.api = actual.useDataGrid(options);
      return grid.api;
    },
  };
});
vi.mock("./use-activity-columns", () => ({
  useActivityColumns: (options: {
    onSymbolSelect: typeof grid.onSymbolSelect;
    onDuplicate: typeof grid.onDuplicate;
    onEditActivity: typeof grid.onEdit;
  }) => {
    grid.onSymbolSelect = options.onSymbolSelect;
    grid.onDuplicate = options.onDuplicate;
    grid.onEdit = options.onEditActivity;
    return [];
  },
}));
vi.mock("@/pages/asset/hooks/use-assets", () => ({ useAssets: () => ({ assets: [] }) }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
const mutations = vi.hoisted(() => ({ duplicate: vi.fn() }));
vi.mock("../../hooks/use-activity-mutations", () => ({
  // Every mutation idle: these tests never save; a duplicate is only recorded.
  useActivityMutations: () =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "duplicateActivityMutation"
            ? { isPending: false, mutate: mutations.duplicate }
            : { isPending: false },
      },
    ),
}));

const AAPL: SymbolSearchResult = {
  symbol: "AAPL",
  longName: "Apple Inc.",
  exchangeMic: "XNAS",
  currency: "USD",
  quoteType: "EQUITY",
  providerId: "YAHOO",
  providerSymbol: "AAPL",
  dataSource: "YAHOO",
  score: 1,
};

function deferQuote() {
  let resolve!: (quote: ResolvedQuote) => void;
  vi.mocked(resolveSymbolQuote).mockReturnValueOnce(
    new Promise<ResolvedQuote | null>((done) => {
      resolve = done;
    }),
  );
  return (quote: ResolvedQuote) => act(async () => resolve(quote));
}

const rows = () => grid.options.data;
const row = (id: string) => rows().find((transaction) => transaction.id === id);

const AAPL_OPTION: SymbolSearchResult = {
  ...AAPL,
  symbol: "AAPL260619C00150000",
  providerSymbol: "AAPL260619C00150000",
  quoteType: "OPTION",
};

const SAVED_MSFT = {
  id: "saved-msft",
  accountId: "acct",
  accountName: "Brokerage",
  accountCurrency: "USD",
  activityType: "BUY",
  date: new Date("2026-01-01T15:00:00Z"),
  quantity: "1",
  unitPrice: "10",
  amount: "10",
  fee: "0",
  currency: "USD",
  needsReview: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  assetId: "SEC:MSFT:XNAS",
  assetSymbol: "MSFT",
  exchangeMic: "XNAS",
  instrumentType: "EQUITY",
} as ActivityDetails;

function renderGrid(
  activities: ActivityDetails[],
  onEditActivity: (activity: ActivityDetails) => void = () => undefined,
) {
  render(
    <ActivityDataGrid
      accounts={[]}
      activities={activities}
      onRefetch={() => Promise.resolve()}
      onEditActivity={onEditActivity}
      sorting={[]}
      onSortingChange={() => undefined}
      pageIndex={0}
      pageSize={50}
      pageCount={1}
      totalRowCount={0}
      isFetching={false}
      onPageChange={() => undefined}
      onPageSizeChange={() => undefined}
    />,
  );
}

function renderGridWithNewRow() {
  renderGrid([]);
  act(() => {
    grid.options.onRowAdd?.();
  });
  return rows()[0].id;
}

// Writes cells the way edits and pastes do.
function editRow(id: string, values: Partial<LocalTransaction>) {
  const rowIndex = rows().findIndex((transaction) => transaction.id === id);
  grid.api.table.options.meta?.onDataUpdate?.(
    Object.entries(values).map(([columnId, value]) => ({ rowIndex, columnId, value })),
  );
}

function pasteOnto(id: string, values: Partial<LocalTransaction>) {
  act(() => editRow(id, values));
}

// Like the symbol cell: set the cell's value, then report the search result.
function pick(id: string, result: SymbolSearchResult) {
  act(() => {
    const rowIndex = rows().findIndex((transaction) => transaction.id === id);
    editRow(id, { assetSymbol: result.symbol });
    grid.onSymbolSelect(rowIndex, result);
  });
}

describe("ActivityDataGrid symbol pick", () => {
  beforeEach(() => {
    vi.mocked(resolveSymbolQuote).mockReset();
  });

  it("keeps a search pick's asset details", () => {
    const id = renderGridWithNewRow();
    deferQuote();
    pick(id, AAPL);

    expect(row(id)).toMatchObject({
      assetSymbol: "AAPL",
      exchangeMic: "XNAS",
      instrumentType: "EQUITY",
      pendingAssetName: "Apple Inc.",
      pendingQuoteCcy: "USD",
      pendingProviderId: "YAHOO",
      pendingProviderSymbol: "AAPL",
    });
  });

  it("prices the picked row, not a row added while the quote loads", async () => {
    const pickedId = renderGridWithNewRow();
    const resolveQuote = deferQuote();
    pick(pickedId, AAPL);

    act(() => {
      grid.options.onRowAdd?.();
    });
    const addedId = rows()[0].id;
    await resolveQuote({ price: 190.5, currency: "USD" });

    expect(row(pickedId)?.unitPrice).toBe("190.5");
    expect(row(addedId)?.unitPrice).toBeNull();
  });

  it("drops the picked asset and its late quote when another symbol is pasted", async () => {
    const id = renderGridWithNewRow();
    const resolveQuote = deferQuote();
    pick(id, AAPL);
    expect(row(id)).toMatchObject({ pendingAssetName: "Apple Inc.", pendingQuoteCcy: "USD" });

    pasteOnto(id, { assetSymbol: "RY" });
    await resolveQuote({ price: 190.5, currency: "USD" });

    expect(row(id)).toMatchObject({ assetSymbol: "RY", exchangeMic: "XNAS", unitPrice: null });
    expect(row(id)?.pendingAssetName).toBeUndefined();
    expect(row(id)?.pendingQuoteCcy).toBeUndefined();
    expect(row(id)?.pendingProviderSymbol).toBeUndefined();
  });

  it.each(["OPTION", "EQUITY"])(
    "keeps an instrument type (%s) pasted together with the symbol",
    (instrumentType) => {
      const id = renderGridWithNewRow();
      deferQuote();
      pick(id, AAPL);

      pasteOnto(id, { assetSymbol: "AAPL250117C00150000", instrumentType });

      expect(row(id)).toMatchObject({ instrumentType, pendingInstrumentType: instrumentType });
      expect(row(id)?.pendingAssetName).toBeUndefined();
    },
  );

  it("drops the picked instrument type when only the symbol is pasted", () => {
    const id = renderGridWithNewRow();
    deferQuote();
    pick(id, AAPL);

    pasteOnto(id, { assetSymbol: "MSFT" });

    expect(row(id)?.instrumentType).toBeUndefined();
    expect(row(id)?.pendingInstrumentType).toBeUndefined();
  });

  it.each(["OPTION", "EQUITY"])(
    "keeps an instrument type (%s) the user sets after a pick when a symbol is pasted later",
    (instrumentType) => {
      const id = renderGridWithNewRow();
      deferQuote();
      pick(id, AAPL);

      pasteOnto(id, { instrumentType });
      pasteOnto(id, { assetSymbol: "MSFT" });

      expect(row(id)).toMatchObject({ instrumentType, pendingInstrumentType: instrumentType });
    },
  );

  it.each([
    ["new", () => renderGridWithNewRow()],
    [
      "saved",
      () => {
        renderGrid([SAVED_MSFT]);
        return SAVED_MSFT.id;
      },
    ],
  ])("keeps the type a duplicate copies from a picked %s row", async (_, renderSource) => {
    const sourceId = renderSource();
    deferQuote();
    pick(sourceId, AAPL_OPTION);

    await act(() => grid.onDuplicate(row(sourceId)!));
    const duplicateId = rows()[0].id;
    expect(duplicateId).not.toBe(sourceId);
    pasteOnto(duplicateId, { assetSymbol: "AAPL260619C00160000" });
    expect(row(duplicateId)).toMatchObject({
      instrumentType: "OPTION",
      pendingInstrumentType: "OPTION",
    });

    // A pick on the duplicate is its own and drops as usual.
    deferQuote();
    pick(duplicateId, AAPL);
    pasteOnto(duplicateId, { assetSymbol: "MSFT" });
    expect(row(duplicateId)?.instrumentType).toBeUndefined();
  });
});

describe("ActivityDataGrid conversion duplicate", () => {
  it("duplicates a conversion whole, its other row off the page included", async () => {
    // Only the arriving row is on this page.
    const arriving = {
      ...SAVED_MSFT,
      id: "conv-in",
      activityType: "ADJUSTMENT",
      subtype: "CONVERSION_IN",
      sourceGroupId: "conv-1",
      quantity: "40",
      unitPrice: null,
      amount: null,
    } as unknown as ActivityDetails;
    renderGrid([arriving]);

    await act(() => grid.onDuplicate(row("conv-in")!));

    expect(mutations.duplicate).toHaveBeenCalledWith(expect.objectContaining({ id: "conv-in" }));
    // Nothing is staged: the pair is saved whole.
    expect(rows()).toHaveLength(1);
  });
});

describe("ActivityDataGrid conversion edit", () => {
  const conversionRow = (id: string, subtype: string) =>
    ({
      ...SAVED_MSFT,
      id,
      activityType: "ADJUSTMENT",
      subtype,
      sourceGroupId: "conv-1",
      unitPrice: null,
      amount: null,
    }) as unknown as ActivityDetails;

  it("opens the form only once the other row's grid edits are saved", () => {
    const onEdit = vi.fn();
    renderGrid(
      [conversionRow("conv-out", "CONVERSION_OUT"), conversionRow("conv-in", "CONVERSION_IN")],
      onEdit,
    );

    act(() => grid.onEdit(row("conv-in")!));
    expect(onEdit).toHaveBeenCalledTimes(1);

    // The form saves both rows; the grid would then resend the leaving row.
    pasteOnto("conv-out", { quantity: "26" });
    act(() => grid.onEdit(row("conv-in")!));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
