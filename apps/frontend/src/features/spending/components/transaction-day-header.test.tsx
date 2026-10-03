import { render, screen } from "@/test/render";
import { Table, TableBody } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";

import type { CashActivity } from "../types/cash-activity";
import { groupRowsByDay, toRowVM } from "../lib/transactions-helpers";
import { TransactionDayHeader } from "./transaction-day-header";

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
    status: "POSTED",
    createdAt: "2026-06-06T19:45:00.000Z",
    updatedAt: "2026-06-06T19:45:00.000Z",
    ...overrides,
  } as CashActivity;
}

function group(activities: Partial<CashActivity>[]) {
  const rows = activities.map((a) => toRowVM(activity(a), new Map()));
  return groupRowsByDay(rows, "UTC")[0];
}

function renderHeader(
  dayGroup: ReturnType<typeof group>,
  overrides: Partial<Parameters<typeof TransactionDayHeader>[0]> = {},
) {
  return render(
    <Table>
      <TableBody>
        <TransactionDayHeader
          group={dayGroup}
          appTimezone="UTC"
          selectionState={false}
          onToggleDay={vi.fn()}
          isPartial={false}
          {...overrides}
        />
      </TableBody>
    </Table>,
  );
}

describe("TransactionDayHeader", () => {
  it("spans exactly the six columns of the transactions table", () => {
    const { container } = renderHeader(group([{ id: "a" }]));

    const cells = [...container.querySelectorAll("td")];
    const spanned = cells.reduce((total, cell) => total + (cell.colSpan || 1), 0);
    expect(spanned).toBe(6);
  });

  it("widens its label across the optional columns that are shown", () => {
    const { container } = renderHeader(group([{ id: "a" }]), { labelColSpan: 3 + 3 });

    const cells = [...container.querySelectorAll("td")];
    const spanned = cells.reduce((total, cell) => total + (cell.colSpan || 1), 0);
    expect(spanned).toBe(9);
  });

  it("shows the day, its count and its net", () => {
    renderHeader(group([{ id: "a" }, { id: "b", amount: "35.03", netAmount: -35.03 }]));

    expect(screen.getByText("Saturday, Jun 6, 2026")).toBeInTheDocument();
    expect(screen.getByText("2 transactions")).toBeInTheDocument();
    // The total is unlabelled on screen; "Net" is carried as visually-hidden
    // text. Asserted through the rendered text rather than `getByLabelText`,
    // which also matches an `aria-label` on a bare span — something browsers
    // discard, so the query passed while screen readers heard nothing.
    expect(screen.getByText("Net").parentElement).toHaveTextContent("-$100.00");
  });

  it("hides the count and net for a day that is still loading more rows", () => {
    renderHeader(group([{ id: "a" }]), { isPartial: true });

    expect(screen.getByText("Saturday, Jun 6, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Net")).not.toBeInTheDocument();
  });

  it("omits a count that would only restate the single row below it", () => {
    renderHeader(group([{ id: "a" }]));

    expect(screen.getByText("Saturday, Jun 6, 2026")).toBeInTheDocument();
    expect(screen.queryByText("1 transaction")).not.toBeInTheDocument();
    expect(screen.getByText("Net").parentElement).toHaveTextContent("-$64.97");
  });

  it("omits the net when the day mixes currencies", () => {
    renderHeader(group([{ id: "a" }, { id: "b", currency: "EUR", netAmount: -30 }]));

    expect(screen.getByText("2 transactions")).toBeInTheDocument();
    expect(screen.queryByText("Net")).not.toBeInTheDocument();
  });
});
