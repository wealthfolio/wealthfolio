import { render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Table, TableBody, TooltipProvider } from "@wealthfolio/ui";
import type { ComponentProps, ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AccountType } from "@/lib/constants";
import type { Account, TaxonomyCategory } from "@/lib/types";
import type { CashActivity } from "../types/cash-activity";

// The inline category and event popovers fetch on mount; see
// transaction-review-state.test.tsx for why these stand-ins are needed.
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: () => ({ data: null, isLoading: false }),
  useTaxonomies: () => ({ data: [], isLoading: false }),
}));
vi.mock("../hooks/use-spending-events", () => ({
  useSpendingEvents: () => ({ data: [], isLoading: false }),
  useEventTypes: () => ({ data: [], isLoading: false }),
  useEventSpendingSummaries: () => ({ data: [], isLoading: false }),
}));
vi.mock("./event-dialog-provider", () => ({
  useEventDialog: () => ({ openEventDialog: vi.fn(), openEventTypeDialog: vi.fn() }),
}));
beforeAll(() => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: () => Promise.resolve(null),
    transformCallback: () => 0,
  };
});
import {
  DEFAULT_TRANSACTION_COLUMN_VISIBILITY,
  transactionTableColumnCount,
  type TransactionColumnVisibility,
} from "../lib/transaction-columns";
import { toRowVM } from "../lib/transactions-helpers";
import { TransactionRow } from "./transaction-row";

const ALL_COLUMNS: TransactionColumnVisibility = {
  type: true,
  account: true,
  subcategory: true,
};

function category(overrides: Partial<TaxonomyCategory>): TaxonomyCategory {
  return {
    id: "category",
    taxonomyId: "spending_categories",
    name: "Category",
    key: "category",
    color: "#4385be",
    sortOrder: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const categories = new Map([
  ["food", category({ id: "food", name: "Food", key: "food" })],
  ["restaurants", category({ id: "restaurants", name: "Restaurants", parentId: "food" })],
]);

function activity(overrides: Partial<CashActivity> = {}): CashActivity {
  return {
    id: "activity-1",
    activityType: "WITHDRAWAL",
    activityDate: "2026-06-06T19:45:00.000Z",
    accountId: "account-1",
    amount: "64.97",
    currency: "USD",
    cashFlowBucket: "spending",
    assignments: [
      {
        id: "assignment-1",
        activityId: "activity-1",
        taxonomyId: "spending_categories",
        categoryId: "restaurants",
        weight: 1,
        source: "manual",
        createdAt: "2026-06-06T19:45:00.000Z",
        updatedAt: "2026-06-06T19:45:00.000Z",
      },
    ],
    splits: [],
    isUserModified: false,
    needsReview: false,
    netAmount: -64.97,
    notes: "Corner bistro",
    status: "POSTED",
    createdAt: "2026-06-06T19:45:00.000Z",
    updatedAt: "2026-06-06T19:45:00.000Z",
    ...overrides,
  } as CashActivity;
}

const account = {
  id: "account-1",
  name: "Everyday Checking",
  accountType: AccountType.CASH,
} as Account;

function withProviders({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function renderRow(props: Partial<ComponentProps<typeof TransactionRow>> = {}) {
  return render(
    <Table>
      <TableBody>
        <TransactionRow
          row={toRowVM(activity(), categories)}
          account={account}
          event={{ id: "event-1", name: "Lisbon trip", eventTypeId: "travel" }}
          eventTypeColor={null}
          appTimezone="UTC"
          showAccount
          isSelected={false}
          onToggleSelect={vi.fn()}
          onAssignCategory={vi.fn()}
          onClearCategory={vi.fn()}
          onSetEvent={vi.fn()}
          onMarkReimbursement={vi.fn()}
          onEditSplits={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          {...props}
        />
      </TableBody>
    </Table>,
    { wrapper: withProviders },
  );
}

describe("TransactionRow optional columns", () => {
  it("renders one cell per table column, so it lines up with the header", () => {
    for (const columns of [DEFAULT_TRANSACTION_COLUMN_VISIBILITY, ALL_COLUMNS]) {
      const { container, unmount } = renderRow({ columns });
      expect(container.querySelectorAll("td")).toHaveLength(transactionTableColumnCount(columns));
      unmount();
    }
  });

  it("keeps the original layout when no optional column is shown", () => {
    const { container } = renderRow();

    // Account and event stay beside the name, and the category names the
    // assigned subcategory as before.
    const nameCell = container.querySelectorAll("td")[2];
    expect(nameCell).toHaveTextContent("Everyday Checking");
    expect(nameCell).toHaveTextContent("Lisbon trip");
    expect(screen.getByText("Restaurants")).toBeInTheDocument();
    expect(screen.queryByText("Food")).not.toBeInTheDocument();
    expect(screen.queryByText("Withdrawal")).not.toBeInTheDocument();
  });

  it("moves the account out of the name cell into its own column", () => {
    const { container } = renderRow({ columns: ALL_COLUMNS });

    const nameCell = container.querySelectorAll("td")[2];
    expect(nameCell).not.toHaveTextContent("Everyday Checking");
    expect(nameCell).toHaveTextContent("Lisbon trip");
    expect(screen.getAllByText("Everyday Checking")).toHaveLength(1);
  });

  it("shows the account column even when every row shares one account", () => {
    renderRow({
      columns: { ...DEFAULT_TRANSACTION_COLUMN_VISIBILITY, account: true },
      showAccount: false,
    });

    expect(screen.getByText("Everyday Checking")).toBeInTheDocument();
  });

  it("splits parent and subcategory across the two category columns", () => {
    const { container } = renderRow({ columns: ALL_COLUMNS });

    const cells = [...container.querySelectorAll("td")].map((cell) => cell.textContent);
    // Checkbox, Time, Name, Type, Account, Category, Subcategory, Amount, actions.
    expect(cells[3]).toBe("Withdrawal");
    expect(cells[5]).toBe("Food");
    expect(cells[6]).toBe("Restaurants");
  });

  it("labels the type the way the activity form does for the account", () => {
    renderRow({
      account: { ...account, accountType: AccountType.CREDIT_CARD },
      columns: { ...DEFAULT_TRANSACTION_COLUMN_VISIBILITY, type: true },
    });

    expect(screen.getByText("Charge")).toBeInTheDocument();
  });
});
