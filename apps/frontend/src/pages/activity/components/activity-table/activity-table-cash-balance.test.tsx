import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityType } from "@/lib/constants";
import type { ActivityDetails, CashBalanceScope } from "@/lib/types";
import { ActivityTable } from "./activity-table";
import { ActivityTableMobile } from "./activity-table-mobile";

vi.mock("@/pages/activity/hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({ duplicateActivityMutation: { mutateAsync: vi.fn() } }),
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { baseCurrency: "USD", timezone: "America/New_York" },
  }),
}));

// Avatars and the row menu's sheets load through the platform adapter, which
// jsdom lacks; neither is under test here.
vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));
vi.mock("../activity-operations", () => ({ ActivityOperations: () => null }));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));

// Lay out every row: jsdom has no sizes for the virtualizer to measure.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 60,
        size: 60,
        end: (index + 1) * 60,
        lane: 0,
      })),
    getTotalSize: () => count * 60,
    measureElement: () => undefined,
    options: { scrollMargin: 0 },
  }),
  observeElementOffset: vi.fn(),
}));

afterEach(cleanup);

function row(
  id: string,
  balance: string | null,
  scope: CashBalanceScope | null,
  date = "2026-04-02T15:00:00Z",
): ActivityDetails {
  return {
    id,
    activityType: ActivityType.DEPOSIT,
    date: new Date(date),
    quantity: null,
    unitPrice: null,
    amount: "100",
    fee: "0",
    currency: "USD",
    needsReview: false,
    createdAt: new Date(date),
    updatedAt: new Date(date),
    assetId: "",
    assetSymbol: "",
    accountId: "account-1",
    accountName: "Checking",
    accountCurrency: "USD",
    cashBalance: balance,
    cashBalanceCurrency: balance == null ? null : "USD",
    cashBalanceScope: scope,
  };
}

function renderTable(
  activities: ActivityDetails[],
  { groupByDay = false, hasNextPage = false } = {},
) {
  return render(
    <ActivityTable
      activities={activities}
      isLoading={false}
      sorting={[{ id: "date", desc: true }]}
      onSortingChange={vi.fn()}
      groupByDay={groupByDay}
      hasNextPage={hasNextPage}
      handleEdit={vi.fn()}
      handleDelete={vi.fn()}
    />,
    // Rows with an asset link to its page.
    { wrapper: MemoryRouter },
  );
}

function renderCards(
  activities: ActivityDetails[],
  isCompactView: boolean,
  { groupByDay = false } = {},
) {
  return render(
    <ActivityTableMobile
      activities={activities}
      isCompactView={isCompactView}
      groupByDay={groupByDay}
      handleEdit={vi.fn()}
      handleDelete={vi.fn()}
      onDuplicate={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
}

/** A purchase, so that the only "Cash" on screen is the day header's. */
function trade(id: string, balance: string, date: string): ActivityDetails {
  return {
    ...row(id, balance, "DAY", date),
    activityType: ActivityType.BUY,
    assetId: "AAPL",
    assetSymbol: "AAPL",
    quantity: "1",
    unitPrice: "100",
  };
}

/**
 * Days as the app's timezone (New York) sees them, not as UTC does: the first
 * two rows fall on different UTC dates but the same local day, and the last
 * two share a UTC date but not a local day.
 */
const daysAcrossUtcMidnight = () => [
  trade("late", "15480.19", "2026-10-15T03:30:00Z"),
  trade("early", "15480.19", "2026-10-14T17:25:00Z"),
  trade("previous-evening", "14973.29", "2026-10-14T03:00:00Z"),
];

/** Two days of a brokerage in date order, newest first, with end-of-day cash. */
const brokerageDays = () => [
  trade("buy", "15480.19", "2026-10-14T17:25:00Z"),
  trade("sell", "15480.19", "2026-10-14T17:20:00Z"),
  trade("withdrawal", "14973.29", "2026-10-09T16:00:00Z"),
];

describe("activity lists' cash balances", () => {
  it("leaves end-of-day balances out of a table without day headers", () => {
    renderTable([row("dividend", "3501.35", "DAY"), row("buy", "3501.35", "DAY")]);

    expect(screen.queryByRole("columnheader", { name: /balance/i })).toBeNull();
    expect(screen.queryByText("$3,501.35")).toBeNull();
  });

  it("shows the balance after each row, scoped or not, and no end-of-day value beside them", () => {
    renderTable([
      row("rent", "954.90", "ROW"),
      row("older-client", "1000.00", null),
      row("day-end", "3501.35", "DAY"),
    ]);

    expect(screen.getByRole("columnheader", { name: /balance/i })).toBeInTheDocument();
    expect(screen.getByText("$954.90")).toBeInTheDocument();
    expect(screen.getByText("$1,000.00")).toBeInTheDocument();
    expect(screen.queryByText("$3,501.35")).toBeNull();
  });

  it.each([true, false])("shows only after-row balances on cards (compact: %s)", (compact) => {
    renderCards([row("rent", "954.90", "ROW"), row("day-end", "3501.35", "DAY")], compact);

    expect(screen.getByText("$954.90")).toBeInTheDocument();
    expect(screen.queryByText("$3,501.35")).toBeNull();
  });
});

describe("day-grouped activity table", () => {
  it("heads each day with its date, count and end-of-day cash", () => {
    renderTable(brokerageDays(), { groupByDay: true });

    const [, firstDay, , , secondDay] = screen.getAllByRole("row");
    expect(within(firstDay).getByText("Wednesday, Oct 14, 2026")).toBeInTheDocument();
    expect(within(firstDay).getByText("2 activities")).toBeInTheDocument();
    expect(within(firstDay).getByText("Cash")).toBeInTheDocument();
    expect(within(firstDay).getByText("$15,480.19")).toBeInTheDocument();
    expect(within(secondDay).getByText("Friday, Oct 9, 2026")).toBeInTheDocument();
    expect(within(secondDay).getByText("$14,973.29")).toBeInTheDocument();
    // A single row needs no count.
    expect(within(secondDay).queryByText(/activit/)).toBeNull();
    // Each day's cash appears once, in its header, never as a column.
    expect(screen.getAllByText("$15,480.19")).toHaveLength(1);
    expect(screen.queryByRole("columnheader", { name: /balance/i })).toBeNull();
  });

  it("gives each row its time, leaving the date to the header", () => {
    renderTable(brokerageDays(), { groupByDay: true });

    expect(screen.getByText("1:25 PM")).toBeInTheDocument();
    expect(screen.getByText("12:00 PM")).toBeInTheDocument();
    expect(screen.queryByText("Oct 14, 2026")).toBeNull();
  });

  it("leaves the count off the last day while more pages are pending", () => {
    renderTable([...brokerageDays(), trade("deposit", "15473.29", "2026-10-09T13:00:00Z")], {
      groupByDay: true,
      hasNextPage: true,
    });

    expect(screen.getByText("2 activities")).toBeInTheDocument();
    expect(screen.getAllByText(/activities/)).toHaveLength(1);
    // The day's cash does not depend on how many of its rows are loaded.
    expect(screen.getByText("$14,973.29")).toBeInTheDocument();
  });

  it("groups rows by the day the app's timezone shows, not the UTC date", () => {
    renderTable(daysAcrossUtcMidnight(), { groupByDay: true });

    const [, firstDay, late, early, secondDay, previousEvening] = screen.getAllByRole("row");
    expect(within(firstDay).getByText("Wednesday, Oct 14, 2026")).toBeInTheDocument();
    expect(within(firstDay).getByText("2 activities")).toBeInTheDocument();
    expect(within(firstDay).getByText("$15,480.19")).toBeInTheDocument();
    expect(within(late).getByText("11:30 PM")).toBeInTheDocument();
    expect(within(early).getByText("1:25 PM")).toBeInTheDocument();
    expect(within(secondDay).getByText("Tuesday, Oct 13, 2026")).toBeInTheDocument();
    expect(within(secondDay).getByText("$14,973.29")).toBeInTheDocument();
    expect(within(previousEvening).getByText("11:00 PM")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });

  it("shows no cash in the header of a day without an end-of-day balance", () => {
    renderTable(
      [
        row("rent", "954.90", "ROW", "2026-10-14T17:25:00Z"),
        row("payroll", "2604.90", "ROW", "2026-10-14T12:00:00Z"),
      ],
      { groupByDay: true },
    );

    const [, header] = screen.getAllByRole("row");
    expect(within(header).getByText("Wednesday, Oct 14, 2026")).toBeInTheDocument();
    expect(within(header).queryByText("Cash")).toBeNull();
    // A cash account keeps the balance after each row.
    expect(screen.getByRole("columnheader", { name: /balance/i })).toBeInTheDocument();
    expect(screen.getByText("$954.90")).toBeInTheDocument();
    expect(screen.getByText("$2,604.90")).toBeInTheDocument();
  });
});

describe("day-grouped activity cards", () => {
  it("groups cards by the day the app's timezone shows, not the UTC date", () => {
    renderCards(daysAcrossUtcMidnight(), true, { groupByDay: true });

    expect(screen.getByText("Wednesday, Oct 14, 2026")).toBeInTheDocument();
    expect(screen.getByText("2 activities")).toBeInTheDocument();
    expect(screen.getByText("Tuesday, Oct 13, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Thursday, Oct 15, 2026")).toBeNull();
    expect(screen.getAllByText("Cash")).toHaveLength(2);
    expect(screen.getAllByText("$15,480.19")).toHaveLength(1);
    expect(screen.getAllByText("$14,973.29")).toHaveLength(1);
  });

  it("heads each day's cards with its date, count and end-of-day cash", () => {
    renderCards(brokerageDays(), true, { groupByDay: true });

    expect(screen.getByText("Wednesday, Oct 14, 2026")).toBeInTheDocument();
    expect(screen.getByText("2 activities")).toBeInTheDocument();
    expect(screen.getAllByText("Cash")).toHaveLength(2);
    expect(screen.getAllByText("$15,480.19")).toHaveLength(1);
    // Compact cards give the time once the heading has the date.
    expect(screen.getByText("1:25 PM")).toBeInTheDocument();
    expect(screen.queryByText("Oct 14, 2026")).toBeNull();
  });

  it("gives detailed cards the time alone under a day heading", () => {
    renderCards(brokerageDays(), false, { groupByDay: true });

    expect(screen.getByText("1:25 PM")).toBeInTheDocument();
    expect(screen.queryByText("Oct 14, 2026")).toBeNull();
    expect(screen.queryByText("1:25:00 PM")).toBeNull();
  });

  it("keeps the date on cards without day headings", () => {
    renderCards(brokerageDays(), true);

    expect(screen.getAllByText("Oct 14, 2026")).toHaveLength(2);
    expect(screen.queryByText("Wednesday, Oct 14, 2026")).toBeNull();
  });
});
