import { act, render, screen, waitFor } from "@/test/render";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpendingTransactionsTab } from "./spending-transactions-tab";

const USD_ACCOUNT = "acct-usd";
const EUR_ACCOUNT = "acct-eur";

const mocks = vi.hoisted(() => {
  const accounts = [
    {
      id: "acct-usd",
      name: "Revolut (USD)",
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "acct-eur",
      name: "Revolut (EUR)",
      accountType: "CASH",
      currency: "EUR",
      isDefault: false,
      isActive: true,
      isArchived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const transferOut = {
    id: "out-1",
    accountId: "acct-usd",
    activityType: "TRANSFER_OUT",
    status: "POSTED",
    activityDate: "2026-09-17T11:06:00.000Z",
    amount: "1000",
    currency: "USD",
    notes: "-> Revolut (EUR)",
    sourceGroupId: "group-1",
    metadata: { flow: { is_external: false } },
    isUserModified: false,
    needsReview: false,
    createdAt: "2026-09-17T11:06:00.000Z",
    updatedAt: "2026-09-17T11:06:00.000Z",
    cashFlowBucket: "neutral",
    assignments: [],
    splits: [],
    netAmount: -1000,
  };

  const mutation = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    isError: false,
  };

  return {
    accounts,
    transferOut,
    mutation,
    getTransferPairForActivity: vi.fn(),
    invalidateQueries: vi.fn(),
  };
});

vi.mock("@/adapters", () => ({
  createActivity: vi.fn(),
  deleteActivity: vi.fn(),
  updateActivity: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  getTransferPairForActivity: mocks.getTransferPairForActivity,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useMutation: () => mocks.mutation,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: `virtual-${index}`,
        start: index * 45,
        end: index * 45 + 45,
      })),
    getTotalSize: () => opts.count * 45,
    measureElement: () => undefined,
    scrollMargin: 0,
  }),
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: mocks.accounts, isLoading: false }),
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/hooks/use-virtual-scroll-container", () => ({
  useVirtualScrollContainer: () => ({
    listRef: { current: null },
    scrollElement: null,
    scrollMargin: 0,
  }),
}));
vi.mock("@/hooks/use-debounced-value", () => ({ useDebouncedValue: (value: unknown) => value }));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({ data: { categories: [] } }) }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: undefined } }),
}));

vi.mock("../hooks/use-cash-activity-search", () => ({
  useCashActivitySearch: () => ({
    items: [mocks.transferOut],
    totalCount: 1,
    net: [],
    baseCurrency: "EUR",
    isLoading: false,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isError: false,
    error: null,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../hooks/use-cash-activities", () => ({
  useAssignActivityCategory: () => mocks.mutation,
  useBulkAssignCategories: () => mocks.mutation,
  useUnassignActivityCategory: () => mocks.mutation,
  useReplaceActivitySplits: () => mocks.mutation,
  useClearActivitySplits: () => mocks.mutation,
  useSetActivityEvent: () => mocks.mutation,
}));
vi.mock("../hooks/use-spending-events", () => ({
  useSpendingEvents: () => ({ data: [] }),
  useEventTypes: () => ({ data: [] }),
}));
vi.mock("../hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ accountIds: [USD_ACCOUNT, EUR_ACCOUNT] }),
}));

vi.mock("./cash-activity-form", () => ({ CashActivityForm: () => null }));
vi.mock("@/pages/activity/components/mobile-forms/mobile-activity-form", () => ({
  MobileActivityForm: () => null,
}));
vi.mock("@/pages/activity/components/transfer-match-dialog", () => ({
  TransferMatchDialog: () => null,
}));
vi.mock("@/pages/activity/components/activity-form", () => ({
  ActivityForm: ({ activity, open }: { activity?: unknown; open: boolean }) =>
    open ? <div data-testid="activity-form">{JSON.stringify(activity)}</div> : null,
}));
vi.mock("./delete-transactions-dialog", () => ({ DeleteTransactionsDialog: () => null }));
vi.mock("./transaction-card", () => ({ TransactionCard: () => null }));
vi.mock("./selection-toolbar", () => ({ SelectionToolbar: () => null }));
vi.mock("./split-transaction-sheet", () => ({ SplitTransactionSheet: () => null }));
vi.mock("./transactions-bulk-bar", () => ({ TransactionsBulkBar: () => null }));
vi.mock("./transactions-filter-bar", () => ({ TransactionsFilterBar: () => null }));

vi.mock("./transaction-day-header", async () => {
  const React = await import("react");
  const Null = React.forwardRef((_props: unknown, _ref: unknown) => null);
  Null.displayName = "NullDayHeader";
  return { TransactionDayHeader: Null, TransactionDayHeading: Null };
});

vi.mock("./transaction-row", async () => {
  const React = await import("react");
  const TransactionRow = React.forwardRef(
    (
      props: {
        row: { activity: { id: string } };
        onEdit: (row: unknown) => void;
        onDelete?: (row: unknown) => void;
        onLinkTransfer?: (row: unknown) => void;
      },
      _ref: unknown,
    ) => (
      <tr>
        <td>
          <button
            type="button"
            data-testid={`edit-${props.row.activity.id}`}
            onClick={() => props.onEdit(props.row)}
          >
            edit
          </button>
          <button
            type="button"
            data-testid={`delete-${props.row.activity.id}`}
            onClick={() => props.onDelete?.(props.row)}
          >
            delete
          </button>
          <button
            type="button"
            data-testid={`link-${props.row.activity.id}`}
            onClick={() => props.onLinkTransfer?.(props.row)}
          >
            link
          </button>
        </td>
      </tr>
    ),
  );
  TransactionRow.displayName = "TransactionRow";
  return { TransactionRow };
});

describe("SpendingTransactionsTab transfer edit", () => {
  beforeEach(() => {
    mocks.getTransferPairForActivity.mockReset();
  });

  it("loads the counterpart leg when editing a linked transfer (#1563)", async () => {
    mocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: {
        id: "out-1",
        accountId: USD_ACCOUNT,
        activityType: ActivityType.TRANSFER_OUT,
        status: ActivityStatus.POSTED,
        activityDate: "2026-09-17T11:06:00.000Z",
        amount: "1000",
        currency: "USD",
      },
      transferIn: {
        id: "in-1",
        accountId: EUR_ACCOUNT,
        activityType: ActivityType.TRANSFER_IN,
        status: ActivityStatus.POSTED,
        activityDate: "2026-09-17T11:06:00.000Z",
        amount: "920",
        currency: "EUR",
        fxRate: "0.92",
      },
    });

    render(<SpendingTransactionsTab />);

    (await screen.findByTestId("edit-out-1")).click();

    await waitFor(() => {
      expect(screen.getByTestId("activity-form")).toBeInTheDocument();
    });

    expect(mocks.getTransferPairForActivity).toHaveBeenCalledWith("out-1");
    const activityForm = JSON.parse(
      screen.getByTestId("activity-form").textContent ?? "{}",
    ) as Record<string, unknown>;
    expect(activityForm).toMatchObject({
      id: "out-1",
      activityType: ActivityType.TRANSFER_OUT,
      counterpartAccountId: EUR_ACCOUNT,
      transferOutId: "out-1",
      transferInId: "in-1",
    });
  });

  it("still opens single-leg when the pair cannot be resolved", async () => {
    mocks.getTransferPairForActivity.mockResolvedValue(null);

    render(<SpendingTransactionsTab />);

    (await screen.findByTestId("edit-out-1")).click();

    await waitFor(() => {
      expect(screen.getByTestId("activity-form")).toBeInTheDocument();
    });

    const activityForm = JSON.parse(
      screen.getByTestId("activity-form").textContent ?? "{}",
    ) as Record<string, unknown>;
    expect(activityForm.counterpartAccountId).toBeUndefined();
    expect(activityForm.sourceGroupId).toBe("group-1");
  });

  it("ignores a late pair resolution after another dialog was opened", async () => {
    let resolvePair: (value: unknown) => void = (_value) => undefined;
    mocks.getTransferPairForActivity.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePair = resolve;
        }),
    );

    render(<SpendingTransactionsTab />);

    (await screen.findByTestId("edit-out-1")).click();
    (await screen.findByTestId("delete-out-1")).click();

    await act(async () => {
      resolvePair({
        transferOut: {
          id: "out-1",
          accountId: USD_ACCOUNT,
          activityType: ActivityType.TRANSFER_OUT,
          status: ActivityStatus.POSTED,
          activityDate: "2026-09-17T11:06:00.000Z",
          amount: "1000",
          currency: "USD",
        },
        transferIn: {
          id: "in-1",
          accountId: EUR_ACCOUNT,
          activityType: ActivityType.TRANSFER_IN,
          status: ActivityStatus.POSTED,
          activityDate: "2026-09-17T11:06:00.000Z",
          amount: "920",
          currency: "EUR",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.getTransferPairForActivity).toHaveBeenCalledWith("out-1");
    expect(screen.queryByTestId("activity-form")).toBeNull();
  });

  it("ignores a late pair resolution after the link-transfer dialog was opened", async () => {
    let resolvePair: (value: unknown) => void = (_value) => undefined;
    mocks.getTransferPairForActivity.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePair = resolve;
        }),
    );

    render(<SpendingTransactionsTab />);

    (await screen.findByTestId("edit-out-1")).click();
    (await screen.findByTestId("link-out-1")).click();

    await act(async () => {
      resolvePair({
        transferOut: {
          id: "out-1",
          accountId: USD_ACCOUNT,
          activityType: ActivityType.TRANSFER_OUT,
          status: ActivityStatus.POSTED,
          activityDate: "2026-09-17T11:06:00.000Z",
          amount: "1000",
          currency: "USD",
        },
        transferIn: {
          id: "in-1",
          accountId: EUR_ACCOUNT,
          activityType: ActivityType.TRANSFER_IN,
          status: ActivityStatus.POSTED,
          activityDate: "2026-09-17T11:06:00.000Z",
          amount: "920",
          currency: "EUR",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.getTransferPairForActivity).toHaveBeenCalledWith("out-1");
    expect(screen.queryByTestId("activity-form")).toBeNull();
  });
});
