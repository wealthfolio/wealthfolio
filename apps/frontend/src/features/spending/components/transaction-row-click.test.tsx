import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
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
// The category popover measures itself once opened.
if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}
beforeAll(() => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: () => Promise.resolve(null),
    transformCallback: () => 0,
  };
});
import { toRowVM } from "../lib/transactions-helpers";
import { TransactionRow } from "./transaction-row";

const categories = new Map<string, TaxonomyCategory>([
  [
    "restaurants",
    {
      id: "restaurants",
      taxonomyId: "spending_categories",
      name: "Restaurants",
      key: "restaurants",
      color: "#4385be",
      sortOrder: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
]);

const activity = {
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
} as CashActivity;

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
          row={toRowVM(activity, categories)}
          account={account}
          event={{ id: "event-1", name: "Lisbon trip", eventTypeId: "travel" }}
          eventTypeColor={null}
          appTimezone="UTC"
          showAccount={false}
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

describe("TransactionRow click to edit", () => {
  it("opens the row for editing when its body is clicked", async () => {
    const onEdit = vi.fn();
    renderRow({ onEdit });

    await userEvent.click(screen.getByText("Corner bistro"));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0].activity.id).toBe("activity-1");
  });

  it("leaves selection, category, event and the actions cell to their own controls", async () => {
    const onEdit = vi.fn();
    const onToggleSelect = vi.fn();
    const { container } = renderRow({ onEdit, onToggleSelect });
    const cells = container.querySelectorAll("td");

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(cells[0]);
    await userEvent.click(cells[cells.length - 1]);
    await userEvent.click(screen.getByRole("button", { name: /Restaurants/ }));
    await userEvent.click(screen.getByRole("button", { name: /Lisbon trip/ }));

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does not open the form a second time from a click inside the row menu", async () => {
    const onEdit = vi.fn();
    renderRow({ onEdit });

    await userEvent.click(screen.getByRole("button", { name: "Row actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
