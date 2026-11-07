import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  convertToInternalTransfer,
  findTransferMatchCandidates,
  getAssets,
  linkTransferPairs,
  reviewConvertToTransferSplitEffects,
  reviewTransferMatches,
} from "@/adapters";
import { ActivitySplitReviewProvider } from "@/features/spending/components/activity-split-review-provider";
import { ActivityStatus } from "@/lib/constants";
import type {
  Account,
  Activity,
  Asset,
  LinkTransferPairsResult,
  TransferMatchCandidate,
  TransferMatchReview,
  TransferPairLinkRequest,
  UnlinkedTransfer,
} from "@/lib/types";
import { act, fireEvent, render, screen, waitFor, within } from "@/test/render";
import { TransferReviewPage } from "./transfer-review-page";

const { updateActivity } = vi.hoisted(() => ({ updateActivity: vi.fn() }));

vi.mock("@/adapters", () => ({
  convertToInternalTransfer: vi.fn(),
  findTransferMatchCandidates: vi.fn().mockResolvedValue([]),
  getAssets: vi.fn().mockResolvedValue([]),
  getTransferPairForActivity: vi.fn(),
  linkTransferPairs: vi.fn(),
  reviewActivitiesSplitEffects: vi.fn(),
  reviewConvertToTransferSplitEffects: vi.fn(),
  reviewInternalTransferPairSplitEffects: vi.fn(),
  reviewTransferMatches: vi.fn(),
  searchActivities: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/features/spending/adapters/cash-activities", () => ({
  getActivitySplits: vi.fn().mockResolvedValue([]),
}));
vi.mock("../hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({
    linkTransferActivitiesMutation: { isPending: false },
    unlinkTransferActivitiesMutation: { isPending: false },
    updateActivityMutation: { isPending: false, mutateAsync: updateActivity },
  }),
}));

const timestamp = "2026-04-01T00:00:00+00:00";
function account(id: string, name: string): Account {
  return {
    id,
    name,
    accountType: "SECURITIES",
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    createdAt: new Date(timestamp),
    updatedAt: new Date(timestamp),
  };
}
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [account("tfsa", "TFSA"), account("rrsp", "RRSP"), account("bank", "Bank")],
  }),
}));

function leg(
  id: string,
  accountId: string,
  activityType: string,
  amount = "500",
  activityDate = timestamp,
): Activity {
  return {
    id,
    accountId,
    activityType,
    status: ActivityStatus.POSTED,
    activityDate,
    amount,
    currency: "USD",
    isUserModified: false,
    needsReview: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** A row's two sides, from and to, by account name. */
function sides(row: HTMLElement): (string | null)[] {
  return within(row)
    .getAllByTestId("transfer-review-side")
    .map((side) => side.textContent);
}

function candidate(
  activity: Activity,
  overrides: Partial<TransferMatchCandidate> = {},
): TransferMatchCandidate {
  return {
    activity,
    matchKind: "cash",
    confidence: "medium",
    score: 100,
    reasons: ["Same amount", "Same currency", "Same date"],
    warnings: [],
    reasonCodes: ["same_amount", "same_currency", "same_date"],
    warningCodes: [],
    ...overrides,
  };
}

function row(activity: Activity, candidates: TransferMatchCandidate[]): UnlinkedTransfer {
  return { activity, linkState: "needs_counterpart", candidates };
}

/** A certain pair: the in leg's row, with the out leg as its only candidate. */
function certainPair(index: number, from = "tfsa", to = "rrsp", date = timestamp) {
  return row(leg(`in-${index}`, to, "TRANSFER_IN", "500", date), [
    candidate(leg(`out-${index}`, from, "TRANSFER_OUT", "500", date), {
      confidence: "high",
      reasonCodes: ["same_amount", "same_currency", "same_time"],
    }),
  ]);
}

/** A transfer in whose one likely match left `days` days earlier. */
function datesDiffer(days: number) {
  return row(leg(`in-d${days}`, "tfsa", "TRANSFER_IN", `${days}00`), [
    candidate(leg(`out-d${days}`, "bank", "TRANSFER_OUT", `${days}00`), {
      reasonCodes: ["same_amount", "same_currency"],
      warningCodes: [{ code: "dates_differ", days }],
    }),
  ]);
}

function linkedAll(pairs: TransferPairLinkRequest[]): LinkTransferPairsResult {
  return {
    linked: pairs.map((pair) => ({
      transferInId: pair.activityAId,
      transferOutId: pair.activityBId,
    })),
    errors: [],
  };
}

function renderPage(review: TransferMatchReview) {
  vi.mocked(reviewTransferMatches).mockResolvedValue(review);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ActivitySplitReviewProvider>{children}</ActivitySplitReviewProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<TransferReviewPage />, { wrapper });
}

describe("Match transfers review", () => {
  beforeEach(() => {
    vi.mocked(linkTransferPairs)
      .mockReset()
      .mockImplementation((pairs) => Promise.resolve(linkedAll(pairs)));
    vi.mocked(convertToInternalTransfer).mockReset();
    vi.mocked(reviewConvertToTransferSplitEffects).mockReset().mockResolvedValue([]);
    updateActivity.mockReset().mockResolvedValue({});
  });

  it("sums many certain pairs up by account route and opens a route's pairs", async () => {
    renderPage({
      certain: [
        certainPair(1, "tfsa", "rrsp", "2026-04-15T12:00:00.123Z"),
        certainPair(2, "tfsa", "rrsp", "2026-06-15T12:00:00.123Z"),
        certainPair(3, "tfsa", "rrsp", "2026-05-15T12:00:00.123Z"),
        certainPair(4, "tfsa", "rrsp", "2026-06-20T12:00:00.123Z"),
        certainPair(5, "bank", "tfsa", "2026-05-15T12:00:00.123Z"),
        certainPair(6, "bank", "tfsa", "2026-05-20T12:00:00.123Z"),
      ],
      needsReview: [],
    });

    const routes = await screen.findAllByTestId("transfer-review-route");
    expect(routes).toHaveLength(2);
    // Largest route first, in the direction money moved, over its months,
    // with the cash it moved in the amount column.
    expect(routes[0]).toHaveTextContent(/^Apr – Jun 2026\s*TFSA\s*RRSP\s*\$2,000\.00\s*4 pairs$/);
    expect(routes[1]).toHaveTextContent(/^May 2026\s*Bank\s*TFSA\s*\$1,000\.00\s*2 pairs$/);
    expect(screen.queryByTestId("transfer-review-certain-row")).not.toBeInTheDocument();

    const toggle = within(routes[0]).getAllByRole("button")[0];
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Only this route's pairs, newest first, each with its own Link.
    const rows = within(routes[0]).getAllByTestId("transfer-review-certain-row");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Jun 20, 2026");
    expect(rows[3]).toHaveTextContent("Apr 15, 2026");
    // Under its route, a pair still names both of its sides.
    expect(sides(rows[0])).toEqual(["TFSA", "RRSP"]);
    expect(within(rows[0]).getByRole("button", { name: "Link" })).toBeInTheDocument();
    expect(within(routes[1]).queryByTestId("transfer-review-certain-row")).not.toBeInTheDocument();
  });

  it("lists a few certain pairs as they are, each with its own Link", async () => {
    renderPage({ certain: [certainPair(1, "bank", "rrsp")], needsReview: [] });

    expect(
      await screen.findByText(
        "This pair matches exactly on the same day, and nothing else matches either side.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("transfer-review-routes")).not.toBeInTheDocument();
    const [pair] = screen.getAllByTestId("transfer-review-certain-row");
    expect(sides(pair)).toEqual(["Bank", "RRSP"]);

    fireEvent.click(within(pair).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(linkTransferPairs).toHaveBeenCalledWith([
        { activityAId: "in-1", activityBId: "out-1" },
      ]),
    );
  });

  it("links every certain pair still shown, and says how many it linked", async () => {
    renderPage({ certain: [certainPair(1), certainPair(2), certainPair(3)], needsReview: [] });

    // A few pairs list as they are.
    const rows = await screen.findAllByTestId("transfer-review-certain-row");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    expect(await screen.findByText("1 skipped for now")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link all 2 pairs" }));

    expect(await screen.findByText("2 pairs linked")).toBeInTheDocument();
    expect(linkTransferPairs).toHaveBeenCalledTimes(1);
    expect(linkTransferPairs).toHaveBeenCalledWith([
      { activityAId: "in-1", activityBId: "out-1" },
      { activityAId: "in-3", activityBId: "out-3" },
    ]);
  });

  it("links in batches of 100, showing progress, and stops after the batch in flight", async () => {
    const pairs = Array.from({ length: 250 }, (_, index) => certainPair(index));
    const pending: (() => void)[] = [];
    vi.mocked(linkTransferPairs).mockImplementation(
      (batch) =>
        new Promise((resolve) => {
          pending.push(() => resolve(linkedAll(batch)));
        }),
    );
    renderPage({ certain: pairs, needsReview: [] });

    fireEvent.click(await screen.findByRole("button", { name: "Link all 250 pairs" }));
    expect(await screen.findByText("Linking 0 of 250 pairs")).toBeInTheDocument();
    expect(vi.mocked(linkTransferPairs).mock.calls[0][0]).toHaveLength(100);

    await act(() => Promise.resolve(pending[0]()));
    expect(await screen.findByText("Linking 100 of 250 pairs")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");

    fireEvent.click(screen.getByRole("button", { name: "Stop after this batch" }));
    expect(screen.getByRole("button", { name: "Stopping after this batch…" })).toBeDisabled();
    await act(() => Promise.resolve(pending[1]()));

    expect(await screen.findByText("200 pairs linked")).toBeInTheDocument();
    expect(screen.getByText("Stopped. 50 pairs are still ready to link.")).toBeInTheDocument();
    expect(linkTransferPairs).toHaveBeenCalledTimes(2);
  });

  it("lists the pairs that could not be linked, with the reason", async () => {
    vi.mocked(linkTransferPairs).mockResolvedValue({
      linked: [{ transferInId: "in-1", transferOutId: "out-1" }],
      errors: [{ index: 1, message: "Activity is not posted" }],
    });
    renderPage({
      certain: [certainPair(1), certainPair(2, "bank", "rrsp")],
      needsReview: [],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Link all 2 pairs" }));
    expect(await screen.findByText("1 pair linked")).toBeInTheDocument();
    expect(screen.getByText("1 could not be linked")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "See which" }));
    const failures = within(screen.getByTestId("transfer-review-failures")).getAllByRole(
      "listitem",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toHaveTextContent("Bank");
    expect(failures[0]).toHaveTextContent("Activity is not posted");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("transfer-review-result")).not.toBeInTheDocument();
  });

  it("stops and reports the batch when a call fails", async () => {
    vi.mocked(linkTransferPairs).mockRejectedValue(new Error("Database is locked"));
    renderPage({
      certain: Array.from({ length: 150 }, (_, index) => certainPair(index)),
      needsReview: [],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Link all 150 pairs" }));
    expect(await screen.findByText("0 pairs linked")).toBeInTheDocument();
    expect(screen.getByText("100 could not be linked")).toBeInTheDocument();
    expect(screen.getByText("Stopped. 50 pairs are still ready to link.")).toBeInTheDocument();
    expect(linkTransferPairs).toHaveBeenCalledTimes(1);
  });

  it("sorts many transfers needing a look into sections by the core's reason", async () => {
    renderPage({
      certain: [],
      needsReview: [
        row(leg("in-5", "tfsa", "TRANSFER_IN", "99"), []),
        datesDiffer(1),
        datesDiffer(2),
        datesDiffer(3),
        row(leg("out-c", "tfsa", "TRANSFER_OUT", "300"), [
          candidate(leg("in-c1", "rrsp", "TRANSFER_IN", "300"), {
            warningCodes: [{ code: "another_match" }],
          }),
          candidate(leg("in-c2", "bank", "TRANSFER_IN", "300"), {
            warningCodes: [{ code: "another_match" }],
          }),
        ]),
        row(leg("out-4", "rrsp", "TRANSFER_OUT", "420"), [
          candidate(leg("dep-4", "bank", "DEPOSIT", "420")),
        ]),
        row(leg("in-6", "tfsa", "TRANSFER_IN", "60"), [
          candidate(leg("out-6", "bank", "TRANSFER_OUT", "60"), {
            warningCodes: [{ code: "currencies_differ", source: "USD", candidate: "CAD" }],
          }),
        ]),
        row(leg("in-7", "rrsp", "TRANSFER_IN", "77"), []),
      ],
    });

    const rows = await screen.findAllByTestId("transfer-review-row");
    const sections = screen
      .getAllByTestId(/^transfer-review-section-/)
      .map((section) => section.dataset.testid);
    // Likely links first, no other side last.
    expect(sections).toEqual([
      "transfer-review-section-dates_differ",
      "transfer-review-section-more_than_one",
      "transfer-review-section-cash_flow",
      "transfer-review-section-other",
      "transfer-review-section-no_match",
    ]);
    expect(
      within(screen.getByTestId("transfer-review-section-dates_differ")).getByRole("heading"),
    ).toHaveTextContent("Arrived on a different day3");
    // Each of the two likely other sides is a pair of its own.
    expect(
      within(screen.getByTestId("transfer-review-section-more_than_one")).getByRole("heading"),
    ).toHaveTextContent("More than one possible match2");
    expect(rows).toHaveLength(9);
    expect(rows[0]).toHaveTextContent("Dates differ by 1 day.");
    expect(rows[3]).toHaveTextContent("Bank also matches. Link only the right one.");
    expect(rows[6]).toHaveTextContent("Currencies differ (USD / CAD).");
    expect(rows[8]).toHaveTextContent("No likely match within 7 days.");

    // Fewer than eight left: one list, in the same order.
    for (const index of [8, 6]) {
      fireEvent.click(
        within(screen.getAllByTestId("transfer-review-row")[index]).getByRole("button", {
          name: "More actions",
        }),
      );
      fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    }
    await waitFor(() =>
      expect(screen.queryByTestId(/^transfer-review-section-/)).not.toBeInTheDocument(),
    );
    const remaining = screen.getAllByTestId("transfer-review-row");
    expect(remaining).toHaveLength(7);
    expect(remaining[0]).toHaveTextContent("Dates differ by 1 day.");
    expect(remaining[6]).toHaveTextContent("No likely match within 7 days.");
  });

  it("shows each likely other side as a pair of its own, naming the other", async () => {
    renderPage({
      certain: [],
      needsReview: [
        row(leg("out-1", "tfsa", "TRANSFER_OUT"), [
          candidate(leg("in-1", "rrsp", "TRANSFER_IN"), {
            warningCodes: [{ code: "another_match" }],
          }),
          candidate(leg("in-2", "bank", "TRANSFER_IN"), {
            score: 80,
            reasonCodes: ["same_amount", "same_currency"],
            warningCodes: [{ code: "dates_differ", days: 2 }],
          }),
        ]),
      ],
    });

    const rows = await screen.findAllByTestId("transfer-review-row");
    expect(rows).toHaveLength(2);
    expect(sides(rows[0])).toEqual(["TFSA", "RRSP"]);
    expect(rows[0]).toHaveTextContent("Bank also matches. Link only the right one.");
    // The rival line says it once; the core's own "another match" is not repeated.
    expect(rows[0]).not.toHaveTextContent("Another transfer matches as well.");
    expect(sides(rows[1])).toEqual(["TFSA", "Bank"]);
    expect(rows[1]).toHaveTextContent("RRSP also matches. Link only the right one.");
    expect(rows[1]).toHaveTextContent("Dates differ by 2 days.");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Link" }));

    await waitFor(() =>
      expect(linkTransferPairs).toHaveBeenCalledWith([
        { activityAId: "out-1", activityBId: "in-2" },
      ]),
    );
  });

  it("shows each transfer claiming the same other side as a pair of its own", async () => {
    const shared = leg("out-1", "tfsa", "TRANSFER_OUT");
    renderPage({
      certain: [],
      needsReview: [
        row(leg("in-1", "rrsp", "TRANSFER_IN"), [
          candidate(shared, { warningCodes: [{ code: "another_match" }] }),
        ]),
        row(leg("in-2", "bank", "TRANSFER_IN"), [
          candidate(shared, { warningCodes: [{ code: "another_match" }] }),
        ]),
      ],
    });

    const rows = await screen.findAllByTestId("transfer-review-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Bank also matches. Link only the right one.");
    expect(rows[1]).toHaveTextContent("RRSP also matches. Link only the right one.");
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Link" }));

    await waitFor(() =>
      expect(linkTransferPairs).toHaveBeenCalledWith([
        { activityAId: "in-1", activityBId: "out-1" },
      ]),
    );
  });

  it("opens a pair's details with its other side selected", async () => {
    const other = candidate(leg("in-1", "rrsp", "TRANSFER_IN"), {
      warningCodes: [{ code: "dates_differ", days: 1 }],
    });
    vi.mocked(findTransferMatchCandidates).mockResolvedValueOnce([other]);
    renderPage({
      certain: [],
      needsReview: [row(leg("out-1", "tfsa", "TRANSFER_OUT"), [other])],
    });

    fireEvent.click(await screen.findByTestId("transfer-review-flow"));

    const details = await screen.findByTestId("transfer-match-details");
    // The other side is selected once the suggestions load, from the side
    // money left, as the row reads.
    await waitFor(() =>
      expect(within(details).getByRole("row", { name: /^Account/ })).toHaveTextContent(
        /^Account\s*TFSA\s*RRSP$/,
      ),
    );
    // The core's warning flags the Date row, and only that row.
    expect(within(details).getByRole("row", { name: /^Date/ })).toHaveTextContent(/differs/);
    expect(within(details).getAllByText(/differs/)).toHaveLength(1);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Link" })).toBeEnabled();
  });

  it("converts a matching deposit into the transfer's other side", async () => {
    renderPage({
      certain: [],
      needsReview: [
        row(leg("out-1", "tfsa", "TRANSFER_OUT"), [candidate(leg("dep-1", "bank", "DEPOSIT"))]),
      ],
    });

    expect(
      await screen.findByText("This becomes the other side of the transfer."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    await waitFor(() =>
      expect(convertToInternalTransfer).toHaveBeenCalledWith({
        activityId: "out-1",
        counterpartActivityId: "dep-1",
        splitReview: [],
      }),
    );
    expect(linkTransferPairs).not.toHaveBeenCalled();
  });

  it("marks a transfer with no match as external", async () => {
    const source: Activity = {
      ...leg("in-9", "bank", "DEPOSIT"),
      activityTypeOverride: "TRANSFER_IN",
    };
    renderPage({ certain: [], needsReview: [row(source, [])] });

    expect(await screen.findByText("No likely match within 7 days.")).toBeInTheDocument();
    // The side it came from is unknown.
    expect(sides(screen.getByTestId("transfer-review-row"))).toEqual(["No match", "Bank"]);
    fireEvent.click(screen.getByRole("button", { name: "Mark as external" }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalledTimes(1));
    expect(updateActivity.mock.calls[0][0]).toMatchObject({
      id: "in-9",
      // The displayed type, which keeps a broker row's override.
      activityType: "TRANSFER_IN",
      metadata: { flow: { is_external: true } },
    });
  });

  it("offers Mark as external, naming the account, from the menu of a row with a match", async () => {
    renderPage({
      certain: [],
      needsReview: [
        row(leg("out-1", "tfsa", "TRANSFER_OUT"), [
          candidate(leg("in-1", "rrsp", "TRANSFER_IN"), {
            warningCodes: [{ code: "another_match" }],
          }),
        ]),
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Mark the TFSA transfer as external",
      }),
    );

    await waitFor(() => expect(updateActivity).toHaveBeenCalledTimes(1));
    expect(updateActivity.mock.calls[0][0]).toMatchObject({ id: "out-1" });
    expect(linkTransferPairs).not.toHaveBeenCalled();
  });

  it("opens Find match for a broker row whose type is overridden to a transfer", async () => {
    const source: Activity = {
      ...leg("in-9", "bank", "DEPOSIT"),
      activityTypeOverride: "TRANSFER_IN",
    };
    renderPage({ certain: [], needsReview: [row(source, [])] });

    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Find match" }));

    expect(await screen.findByText("Link transfer")).toBeInTheDocument();
  });

  it("names a security by its ticker, not its asset id", async () => {
    const assetId = "7f3c2a1e-9b4d-4c6a-8e2f-1a2b3c4d5e6f";
    vi.mocked(getAssets).mockResolvedValueOnce([{ id: assetId, displayCode: "VFV" } as Asset]);
    const source: Activity = {
      ...leg("in-sec", "tfsa", "TRANSFER_IN"),
      amount: undefined,
      assetId,
      quantity: "10",
    };
    renderPage({ certain: [], needsReview: [row(source, [])] });

    expect(await screen.findByText("10 VFV")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(assetId))).not.toBeInTheDocument();
  });

  it("shows each row from the account money left", async () => {
    renderPage({
      certain: [],
      needsReview: [
        row(leg("in-1", "rrsp", "TRANSFER_IN", "300"), [
          candidate(leg("out-1", "tfsa", "TRANSFER_OUT", "300"), {
            warningCodes: [{ code: "another_match" }],
          }),
        ]),
        row(leg("out-2", "tfsa", "TRANSFER_OUT", "400"), [
          candidate(leg("in-2", "rrsp", "TRANSFER_IN", "400"), {
            warningCodes: [{ code: "another_match" }],
          }),
        ]),
      ],
    });

    const rows = await screen.findAllByTestId("transfer-review-row");
    for (const reviewRow of rows) {
      expect(sides(reviewRow)).toEqual(["TFSA", "RRSP"]);
    }
  });

  it("says when nothing is left to match", async () => {
    renderPage({ certain: [], needsReview: [] });
    expect(await screen.findByText("All transfers are matched")).toBeInTheDocument();
  });
});
