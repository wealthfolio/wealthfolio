import { render, screen } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Table, TableBody, TooltipProvider } from "@wealthfolio/ui";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { CashActivity } from "../types/cash-activity";

// The inline category and event popovers fetch on mount. Nothing here depends
// on what they return, but without a stand-in they reach for a Tauri bridge
// that does not exist under jsdom and fill the run with IPC errors.
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
// Anything these rows reach for goes through Tauri's IPC bridge, which does not
// exist under jsdom: the call rejects, the failure is logged, and the logger is
// itself an IPC call that rejects unhandled. A stub bridge keeps that noise out
// of the run — the tests below assert on markup, not on what it returns.
beforeAll(() => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: () => Promise.resolve(null),
    transformCallback: () => 0,
  };
});
import { toRowVM } from "../lib/transactions-helpers";
import { TransactionCard } from "./transaction-card";
import { TransactionRow } from "./transaction-row";

function activity(overrides: Partial<CashActivity>): CashActivity {
  return {
    id: "activity-1",
    activityType: "WITHDRAWAL",
    activityDate: "2026-06-06T19:45:00.000Z",
    accountId: "account-1",
    amount: "64.97",
    currency: "USD",
    cashFlowBucket: "spending",
    assignments: [],
    splits: [],
    isUserModified: false,
    needsReview: false,
    netAmount: -64.97,
    notes: "Corner shop",
    status: "POSTED",
    createdAt: "2026-06-06T19:45:00.000Z",
    updatedAt: "2026-06-06T19:45:00.000Z",
    ...overrides,
  } as CashActivity;
}

const handlers = {
  onToggleSelect: vi.fn(),
  onAssignCategory: vi.fn(),
  onClearCategory: vi.fn(),
  onSetEvent: vi.fn(),
  onMarkReimbursement: vi.fn(),
  onEditSplits: vi.fn(),
  onEdit: vi.fn(),
  onDuplicate: vi.fn(),
  onDelete: vi.fn(),
};

const shared = {
  account: undefined,
  event: null,
  eventTypeColor: null,
  appTimezone: "UTC",
  isSelected: false,
  showAccount: false,
  ...handlers,
};

/** The rows reach for taxonomies and events through their inline popovers. */
function withProviders({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function renderRow(needsReview: boolean) {
  return render(
    <Table>
      <TableBody>
        <TransactionRow row={toRowVM(activity({ needsReview }), new Map())} {...shared} />
      </TableBody>
    </Table>,
    { wrapper: withProviders },
  );
}

function renderCard(needsReview: boolean) {
  return render(
    <TransactionCard
      row={toRowVM(activity({ needsReview }), new Map())}
      selectionMode={false}
      {...shared}
    />,
    { wrapper: withProviders },
  );
}

/**
 * The amber stripe and tint are the visual cue, but they cannot be the only
 * one: colour reaches neither a screen reader nor a reader who cannot separate
 * amber from the row behind it. Both layouts have to say it in text as well.
 */
describe("needs-review state", () => {
  it("announces review state on a table row that needs it", () => {
    renderRow(true);

    // The row's review icon is a button; its name carries the state.
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("says nothing about review on a row that does not need it", () => {
    renderRow(false);

    expect(screen.queryByText("Review")).not.toBeInTheDocument();
  });

  it("announces review state on a card that needs it", () => {
    renderCard(true);

    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("says nothing about review on a card that does not need it", () => {
    renderCard(false);

    expect(screen.queryByText("Review")).not.toBeInTheDocument();
  });

  /**
   * `aria-label` on a bare `span` is silently dropped: the element has an
   * implicit `generic` role, which prohibits naming, so assistive technology
   * announces nothing. The state has to live in real text instead.
   */
  it("does not rely on an aria-label attached to a role-less element", () => {
    const { container } = renderRow(true);

    const labelledGenerics = [...container.querySelectorAll("span[aria-label]")].filter(
      (element) => !element.getAttribute("role"),
    );

    expect(labelledGenerics.map((element) => element.getAttribute("aria-label"))).not.toContain(
      "Review",
    );
  });
});

describe("running balance", () => {
  const balanced = { cashBalance: "850", cashBalanceCurrency: "USD" };

  it("shows the balance in its own cell when the table shows the column", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TransactionRow row={toRowVM(activity(balanced), new Map())} {...shared} showBalance />
        </TableBody>
      </Table>,
      { wrapper: withProviders },
    );

    const cells = container.querySelectorAll("td");
    expect(cells).toHaveLength(7);
    expect(cells[5]).toHaveTextContent("$850.00");
  });

  it("keeps the row's cells unchanged when the table has no Balance column", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TransactionRow row={toRowVM(activity({}), new Map())} {...shared} />
        </TableBody>
      </Table>,
      { wrapper: withProviders },
    );

    expect(container.querySelectorAll("td")).toHaveLength(6);
    expect(screen.queryByText("$850.00")).not.toBeInTheDocument();
  });

  it("shows the balance on a card", () => {
    render(
      <TransactionCard
        row={toRowVM(activity(balanced), new Map())}
        selectionMode={false}
        {...shared}
      />,
      { wrapper: withProviders },
    );

    expect(screen.getByText(/Balance/)).toHaveTextContent("Balance $850.00");
  });
});

describe("no notes", () => {
  it.each(["", "  ", null])("shows a dash instead of a blank title for notes %j", (notes) => {
    const row = toRowVM(activity({ notes } as Partial<CashActivity>), new Map());
    render(
      <>
        <TransactionCard row={row} selectionMode={false} {...shared} />
        <Table>
          <TableBody>
            <TransactionRow row={row} {...shared} />
          </TableBody>
        </Table>
      </>,
      { wrapper: withProviders },
    );

    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
