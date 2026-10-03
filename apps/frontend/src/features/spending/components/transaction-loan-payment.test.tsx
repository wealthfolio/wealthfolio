import { fireEvent, render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Table, TableBody, TooltipProvider } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ActionPaletteGroup } from "@/components/action-palette";
import { AccountType } from "@/lib/constants";
import type { Account } from "@/lib/types";
import type { CashActivity } from "../types/cash-activity";

// Both menus open on pointer gestures jsdom does not produce; render their
// items in place so the test reads what each menu offers.
vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("@/components/action-palette", () => ({
  ActionPalette: ({ groups }: { groups: ActionPaletteGroup[] }) => (
    <div>
      {groups.flatMap((group) =>
        group.items.map((item) => (
          <button key={item.label} type="button" onClick={item.onClick}>
            {item.label}
          </button>
        )),
      )}
    </div>
  ),
}));
// The inline category and event popovers fetch on mount; nothing here reads them.
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
import { toRowVM } from "../lib/transactions-helpers";
import { TransactionCard } from "./transaction-card";
import { TransactionRow } from "./transaction-row";

const MENU_ITEM = "Loan payment…";

function activity(overrides: Partial<CashActivity> = {}): CashActivity {
  return {
    id: "activity-1",
    activityType: "WITHDRAWAL",
    activityDate: "2026-09-18T12:00:00.000Z",
    accountId: "account-1",
    amount: "1689.49",
    currency: "USD",
    cashFlowBucket: "spending",
    assignments: [],
    splits: [],
    isUserModified: false,
    needsReview: false,
    netAmount: -1689.49,
    status: "POSTED",
    createdAt: "2026-09-18T12:00:00.000Z",
    updatedAt: "2026-09-18T12:00:00.000Z",
    ...overrides,
  } as CashActivity;
}

const account = (accountType: string) => ({ id: "account-1", accountType }) as Account;

function props(activityOverrides: Partial<CashActivity>, accountType: string) {
  return {
    row: toRowVM(activity(activityOverrides), new Map()),
    account: account(accountType),
    event: null,
    eventTypeColor: null,
    appTimezone: "UTC",
    isSelected: false,
    showAccount: false,
    onToggleSelect: vi.fn(),
    onAssignCategory: vi.fn(),
    onClearCategory: vi.fn(),
    onSetEvent: vi.fn(),
    onMarkReimbursement: vi.fn(),
    onEditSplits: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onLoanPayment: vi.fn(),
  };
}

function withProviders({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

const layouts = {
  row: (rowProps: ReturnType<typeof props>) =>
    render(
      <Table>
        <TableBody>
          <TransactionRow {...rowProps} />
        </TableBody>
      </Table>,
      { wrapper: withProviders },
    ),
  card: (rowProps: ReturnType<typeof props>) =>
    render(<TransactionCard {...rowProps} selectionMode={false} />, { wrapper: withProviders }),
};

describe.each(Object.entries(layouts))("loan payment action on a %s", (_, renderLayout) => {
  it("offers a withdrawal from a cash account and passes its row", () => {
    const rowProps = props({}, AccountType.CASH);
    renderLayout(rowProps);

    fireEvent.click(screen.getByRole("button", { name: MENU_ITEM }));

    expect(rowProps.onLoanPayment).toHaveBeenCalledWith(rowProps.row);
  });

  it("is not offered for a withdrawal from a credit card", () => {
    renderLayout(props({}, AccountType.CREDIT_CARD));

    expect(screen.queryByRole("button", { name: MENU_ITEM })).not.toBeInTheDocument();
  });

  it("is not offered for a deposit", () => {
    renderLayout(
      props({ activityType: "DEPOSIT", cashFlowBucket: "income", netAmount: 50 }, AccountType.CASH),
    );

    expect(screen.queryByRole("button", { name: MENU_ITEM })).not.toBeInTheDocument();
  });
});
