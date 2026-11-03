import { createInstance, type TFunction } from "i18next";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import type { TaxonomyCategory } from "@/lib/types";
import type { FilterOption } from "./transactions-filter-bar";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/test/render";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityUpdate } from "@/lib/types";
import {
  ActivityEditCancelled,
  ActivitySplitReviewProvider,
} from "./activity-split-review-provider";
import type { TransactionRowVM } from "../lib/transactions-helpers";
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
    categories: [] as TaxonomyCategory[],
    translate: undefined as TFunction | undefined,
    filterProps: undefined as
      | {
          categoryOptions: FilterOption[];
          subcategoryOptions: FilterOption[];
          viewToggle?: React.ReactNode;
          selectedNet: { byCurrency: unknown[] };
        }
      | undefined,
    compactViewport: false,
    gridProps: undefined as
      | undefined
      | { pageIndex: number; onPageChange: (index: number) => void },
    accounts,
    transferOut,
    mutation,
    getTransferPairForActivity: vi.fn(),
    invalidateQueries: vi.fn(),
    createActivity: vi.fn(),
    updateActivity: vi.fn(),
    reviewActivitiesSplitEffects: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    saveActivities: vi.fn(),
    useMutation: vi.fn(),
  };
});

vi.mock("@/adapters", () => ({
  createActivity: mocks.createActivity,
  saveActivities: mocks.saveActivities,
  deleteActivity: vi.fn(),
  updateActivity: mocks.updateActivity,
  reviewActivitiesSplitEffects: mocks.reviewActivitiesSplitEffects,
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  getTransferPairForActivity: mocks.getTransferPairForActivity,
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => mocks.translate?.(key) ?? key,
    i18n: { language: "en" },
  }),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useMutation: mocks.useMutation,
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
vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => false,
  useIsCompactTableViewport: () => mocks.compactViewport,
}));
vi.mock("@/hooks/use-virtual-scroll-container", () => ({
  observeCurrentScrollOffset: vi.fn(),
  useVirtualScrollContainer: () => ({
    listRef: { current: null },
    scrollElement: null,
    scrollMargin: 0,
  }),
}));
vi.mock("@/hooks/use-debounced-value", () => ({ useDebouncedValue: (value: unknown) => value }));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: () => ({ data: { categories: mocks.categories } }),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: undefined } }),
}));

vi.mock("../hooks/use-cash-activity-search", () => ({
  useCashActivityPage: () => ({
    items: [mocks.transferOut],
    totalCount: 1,
    pageCount: 1,
    net: null,
    baseCurrency: "EUR",
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
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
vi.mock("./spending-activity-data-grid", () => ({
  SpendingActivityDataGrid: (props: NonNullable<typeof mocks.gridProps>) => {
    mocks.gridProps = props;
    return <div data-testid="spending-grid" />;
  },
}));
vi.mock("./transactions-filter-bar", () => ({
  TransactionsFilterBar: (props: NonNullable<typeof mocks.filterProps>) => {
    mocks.filterProps = props;
    return null;
  },
}));

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
        onToggleSelect: (id: string) => void;
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
            data-testid={`select-${props.row.activity.id}`}
            onClick={() => props.onToggleSelect(props.row.activity.id)}
          >
            select
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
    mocks.getTransferPairForActivity.mockReset().mockResolvedValue({
      transferOut: mocks.transferOut,
      transferIn: {
        ...mocks.transferOut,
        id: "in-1",
        accountId: EUR_ACCOUNT,
        activityType: "TRANSFER_IN",
        currency: "EUR",
        amount: "920",
      },
    });
    mocks.createActivity.mockReset();
    mocks.saveActivities.mockReset();
    mocks.useMutation.mockReset().mockReturnValue(mocks.mutation);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("duplicates both legs of a same-account exchange through the atomic bulk API", async () => {
    const transferIn = {
      ...mocks.transferOut,
      id: "in-1",
      activityType: "TRANSFER_IN",
      currency: "EUR",
      amount: "920",
    };
    mocks.getTransferPairForActivity.mockResolvedValue({
      transferOut: mocks.transferOut,
      transferIn,
    });
    mocks.saveActivities.mockResolvedValue({
      created: [mocks.transferOut, transferIn],
      errors: [],
    });
    render(<SpendingTransactionsTab />);
    const duplicateOptions = mocks.useMutation.mock.calls[0][0] as {
      mutationFn: (row: TransactionRowVM) => Promise<unknown>;
    };
    await duplicateOptions.mutationFn({
      activity: {
        ...mocks.transferOut,
        activityType: ActivityType.TRANSFER_OUT,
        status: ActivityStatus.POSTED,
        cashFlowBucket: "neutral",
      },
      category: null,
      splitCount: 0,
      needsReview: false,
    });
    expect(mocks.createActivity).not.toHaveBeenCalled();
    expect(mocks.saveActivities).toHaveBeenCalledWith({
      creates: [
        expect.objectContaining({
          activityType: "TRANSFER_OUT",
          amount: "1000",
          currency: "USD",
          accountId: USD_ACCOUNT,
        }),
        expect.objectContaining({
          activityType: "TRANSFER_IN",
          amount: "920",
          currency: "EUR",
          accountId: USD_ACCOUNT,
        }),
      ],
    });
  });

  it.each(["Original notes\nSecond line", "", undefined])(
    "duplicates with today's date and preserves notes %j",
    async (notes) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = new Date(2026, 9, 8, 23, 30);
      vi.setSystemTime(now);
      render(<SpendingTransactionsTab />);
      const duplicateOptions = mocks.useMutation.mock.calls[0][0] as {
        mutationFn: (row: TransactionRowVM) => Promise<unknown>;
      };
      const source = { ...mocks.transferOut, notes };

      await duplicateOptions.mutationFn({
        activity: {
          ...source,
          activityType: ActivityType.TRANSFER_OUT,
          status: ActivityStatus.POSTED,
          cashFlowBucket: "neutral",
        },
        category: null,
        splitCount: 0,
        needsReview: false,
      });

      expect(mocks.createActivity).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          activityDate: now.toISOString(),
          comment: notes,
          accountId: source.accountId,
          amount: source.amount,
          metadata: { flow: { is_external: false } },
        }),
      );
      expect(source.activityDate).toBe("2026-09-17T11:06:00.000Z");
      expect(source.notes).toBe(notes);
    },
  );

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
    expect(mocks.getTransferPairForActivity).toHaveBeenCalledWith("out-1");
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
});

describe("SpendingTransactionsTab selection", () => {
  beforeEach(() => {
    mocks.useMutation.mockReset().mockReturnValue(mocks.mutation);
  });

  // Row checkboxes hide until hovered; this attribute is what keeps them all
  // on screen while a selection exists.
  it("marks the table as selecting while any row is selected", async () => {
    const { container } = render(<SpendingTransactionsTab />);
    const select = await screen.findByTestId("select-out-1");
    const list = container.querySelector(".group\\/list");
    expect(list).not.toHaveAttribute("data-selecting");

    select.click();
    await waitFor(() => expect(list).toHaveAttribute("data-selecting"));

    select.click();
    await waitFor(() => expect(list).not.toHaveAttribute("data-selecting"));
  });
});

it("localizes category filter options but keeps IDs and renamed labels raw", async () => {
  mocks.useMutation.mockReset().mockReturnValue(mocks.mutation);
  const i18n = createInstance();
  await i18n.init({
    lng: "zh",
    resources: { zh: { common: zhCommon, taxonomies: zhCommonTaxonomies } },
  });
  mocks.translate = i18n.getFixedT("zh");
  mocks.categories = [
    {
      id: "cat_food",
      taxonomyId: "spending_categories",
      name: "Food & Dining",
      parentId: null,
      sortOrder: 0,
    },
    {
      id: "cat_groceries",
      taxonomyId: "spending_categories",
      name: "Groceries",
      parentId: "cat_food",
      sortOrder: 1,
    },
    {
      id: "cat_coffee",
      taxonomyId: "spending_categories",
      name: "My coffee",
      parentId: "cat_food",
      sortOrder: 2,
    },
  ] as TaxonomyCategory[];
  const original = structuredClone(mocks.categories);
  try {
    render(<SpendingTransactionsTab />);
    const labels = zhCommonTaxonomies.categoryNames.spending_categories;
    expect(mocks.filterProps?.categoryOptions).toEqual([
      { value: "cat_food", label: labels.cat_food },
    ]);
    expect(mocks.filterProps?.subcategoryOptions).toEqual([
      { value: "cat_groceries", label: `${labels.cat_food} / ${labels.cat_groceries}` },
      { value: "cat_coffee", label: `${labels.cat_food} / My coffee` },
    ]);
    expect(mocks.categories).toEqual(original);
  } finally {
    mocks.categories = [];
    mocks.translate = undefined;
  }
});

describe("SpendingTransactionsTab reimbursement split review", () => {
  const effect = {
    activityId: "income-1",
    removedSplits: 2,
    hasRetainedCategoryAssignment: true,
    fingerprint: "reviewed-income",
  };
  const row = {
    activity: {
      ...mocks.transferOut,
      id: "income-1",
      activityType: ActivityType.DEPOSIT,
      status: ActivityStatus.POSTED,
      cashFlowBucket: "income",
    },
    category: null,
    splitCount: 2,
    needsReview: false,
  } as TransactionRowVM;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMutation.mockReset().mockReturnValue(mocks.mutation);
    mocks.updateActivity.mockResolvedValue({ ...row.activity, activityType: "CREDIT" });
    mocks.reviewActivitiesSplitEffects.mockReset().mockResolvedValue([[effect]]);
  });

  function mount() {
    render(
      <ActivitySplitReviewProvider>
        <SpendingTransactionsTab />
      </ActivitySplitReviewProvider>,
    );
    return mocks.useMutation.mock.calls[1][0] as {
      mutationFn: (row: TransactionRowVM) => Promise<unknown>;
      onError: (error: unknown) => void;
    };
  }

  it.each([false, true])(
    "reviews split removal before reimbursement (approve=%s)",
    async (approve) => {
      const options = mount();
      let result = Promise.resolve<unknown>(undefined);
      act(() => {
        result = options.mutationFn(row).catch((error) => {
          options.onError(error);
          return error;
        });
      });
      await screen.findByRole("alertdialog");
      expect(mocks.reviewActivitiesSplitEffects).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({
          id: row.activity.id,
          activityType: "CREDIT",
          subtype: "REIMBURSEMENT",
        }),
      ]);
      expect(mocks.updateActivity).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByText(approve ? "spending:splitEditReview.confirm" : "common:cancel"),
      );
      let outcome: unknown;
      await act(async () => {
        outcome = await result;
      });
      if (approve) {
        const update = mocks.reviewActivitiesSplitEffects.mock.calls[0][0][0] as ActivityUpdate;
        expect(mocks.updateActivity).toHaveBeenCalledExactlyOnceWith({
          ...update,
          splitReview: [effect],
        });
      } else {
        expect(outcome).toBeInstanceOf(ActivityEditCancelled);
        expect(mocks.updateActivity).not.toHaveBeenCalled();
        expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      }
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    },
  );

  it("does not write when review fails and keeps ordinary error reporting", async () => {
    mocks.reviewActivitiesSplitEffects.mockRejectedValue(new Error("Review unavailable"));
    const options = mount();
    await expect(options.mutationFn(row)).rejects.toThrow("Review unavailable");
    options.onError(new Error("Review unavailable"));
    expect(mocks.updateActivity).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("spending:txTab.markReimbursementFailed");
  });
});

describe("SpendingTransactionsTab view switch", () => {
  beforeEach(() => {
    mocks.useMutation.mockReset().mockReturnValue(mocks.mutation);
    mocks.compactViewport = false;
    localStorage.clear();
  });

  it("switches a desktop list to the grid", async () => {
    render(<SpendingTransactionsTab />);
    expect(screen.queryByTestId("spending-grid")).not.toBeInTheDocument();

    render(<>{mocks.filterProps?.viewToggle}</>);
    fireEvent.click(screen.getByTestId("spending-edit-mode-toggle"));

    expect(await screen.findByTestId("spending-grid")).toBeInTheDocument();
  });

  it("keeps the list, without the switch, on a compact screen", async () => {
    render(<SpendingTransactionsTab />);
    render(<>{mocks.filterProps?.viewToggle}</>);
    fireEvent.click(screen.getByTestId("spending-edit-mode-toggle"));
    await screen.findByTestId("spending-grid");

    // The grid stays the stored choice...
    cleanup();
    render(<SpendingTransactionsTab />);
    expect(await screen.findByTestId("spending-grid")).toBeInTheDocument();

    // ...but a compact screen shows the list.
    cleanup();
    mocks.compactViewport = true;
    render(<SpendingTransactionsTab />);
    expect(mocks.filterProps?.viewToggle).toBeUndefined();
    expect(screen.queryByTestId("spending-grid")).not.toBeInTheDocument();
    expect(await screen.findByTestId("select-out-1")).toBeInTheDocument();
  });

  it("drops the list's checked rows when switching to the grid", async () => {
    render(<SpendingTransactionsTab />);
    fireEvent.click(await screen.findByTestId("select-out-1"));
    await waitFor(() => expect(mocks.filterProps?.selectedNet.byCurrency).toHaveLength(1));

    render(<>{mocks.filterProps?.viewToggle}</>);
    fireEvent.click(screen.getByTestId("spending-edit-mode-toggle"));

    await screen.findByTestId("spending-grid");
    expect(mocks.filterProps?.selectedNet.byCurrency).toHaveLength(0);
  });

  it("steps back to the last page when the grid has fewer pages", async () => {
    render(<SpendingTransactionsTab />);
    render(<>{mocks.filterProps?.viewToggle}</>);
    fireEvent.click(screen.getByTestId("spending-edit-mode-toggle"));
    await screen.findByTestId("spending-grid");

    // The mocked search has one page.
    act(() => mocks.gridProps?.onPageChange(3));
    await waitFor(() => expect(mocks.gridProps?.pageIndex).toBe(0));
  });
});
