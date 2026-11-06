import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  convertToInternalTransfer,
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

  it("sums certain pairs up by account route and lists them on request", async () => {
    renderPage({
      certain: [
        certainPair(1, "tfsa", "rrsp", "2026-04-15T12:00:00.123Z"),
        certainPair(2, "tfsa", "rrsp", "2026-06-15T12:00:00.123Z"),
        certainPair(3, "bank", "tfsa", "2026-05-15T12:00:00.123Z"),
      ],
      needsReview: [],
    });

    expect(await screen.findByText("3 pairs")).toBeInTheDocument();
    const routes = within(screen.getByTestId("transfer-review-routes")).getAllByRole("listitem");
    expect(routes).toHaveLength(2);
    // Largest route first, in the direction money moved, over its months.
    expect(routes[0]).toHaveTextContent(/^TFSA\s*RRSP\s*Apr – Jun 2026\s*2 pairs$/);
    expect(routes[1]).toHaveTextContent(/^Bank\s*TFSA\s*May 2026\s*1 pair$/);
    expect(screen.queryByTestId("transfer-review-certain-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show the 3 pairs" }));
    const rows = screen.getAllByTestId("transfer-review-certain-row");
    expect(rows).toHaveLength(3);
    // Each pair reads from the side money leaves, and says how it matched.
    const [from, to] = within(rows[0]).getAllByText(/TFSA|RRSP/);
    expect(from).toHaveTextContent("TFSA");
    expect(to).toHaveTextContent("RRSP");
    expect(within(rows[0]).getByText("Same time")).toBeInTheDocument();
  });

  it("links every certain pair still shown, and says how many it linked", async () => {
    renderPage({ certain: [certainPair(1), certainPair(2), certainPair(3)], needsReview: [] });

    fireEvent.click(await screen.findByRole("button", { name: "Show the 3 pairs" }));
    const rows = screen.getAllByTestId("transfer-review-certain-row");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Skip" }));
    expect(screen.getByText("1 skipped for now")).toBeInTheDocument();
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

  it("groups transfers needing a look by the core's reason", async () => {
    renderPage({
      certain: [],
      needsReview: [
        row(leg("out-1", "tfsa", "TRANSFER_OUT", "300"), [
          candidate(leg("in-1", "rrsp", "TRANSFER_IN", "300"), {
            warningCodes: [{ code: "another_match" }],
          }),
          candidate(leg("in-2", "bank", "TRANSFER_IN", "300"), {
            warningCodes: [{ code: "another_match" }],
          }),
        ]),
        row(leg("in-3", "tfsa", "TRANSFER_IN", "750"), [
          candidate(leg("out-3", "bank", "TRANSFER_OUT", "750"), {
            reasonCodes: ["same_amount", "same_currency"],
            warningCodes: [{ code: "dates_differ", days: 2 }],
          }),
        ]),
        row(leg("out-4", "rrsp", "TRANSFER_OUT", "420"), [
          candidate(leg("dep-4", "bank", "DEPOSIT", "420"), {
            warningCodes: [{ code: "dates_differ", days: 1 }],
          }),
        ]),
        row(leg("in-5", "tfsa", "TRANSFER_IN", "99"), []),
        row(leg("in-6", "tfsa", "TRANSFER_IN", "60"), [
          candidate(leg("out-6", "bank", "TRANSFER_OUT", "60"), {
            warningCodes: [{ code: "currencies_differ", source: "USD", candidate: "CAD" }],
          }),
        ]),
      ],
    });

    const filters = await screen.findByRole("group", { name: "Filter by reason" });
    const chips = within(filters)
      .getAllByRole("button")
      .map((chip) => chip.textContent);
    // The currency difference shows under All only.
    expect(chips).toEqual([
      "All5",
      "More than one match1",
      "Dates differ1",
      "Recorded as a deposit or withdrawal1",
      "No likely match1",
    ]);
    expect(screen.getAllByTestId("transfer-review-row")).toHaveLength(5);

    fireEvent.click(within(filters).getByRole("button", { name: /^Dates differ/ }));
    const shown = screen.getAllByTestId("transfer-review-row");
    expect(shown).toHaveLength(1);
    expect(within(shown[0]).getByText("Dates differ by 2 days.")).toBeInTheDocument();
    expect(within(filters).getByRole("button", { name: /^Dates differ/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Its last row skipped, the reason falls back to All.
    fireEvent.click(within(shown[0]).getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Skip" }));
    await waitFor(() => expect(screen.getAllByTestId("transfer-review-row")).toHaveLength(4));
  });

  it("links the chosen match, translating the matcher's warnings", async () => {
    const source = leg("out-1", "tfsa", "TRANSFER_OUT");
    renderPage({
      certain: [],
      needsReview: [
        row(source, [
          candidate(leg("in-1", "rrsp", "TRANSFER_IN"), {
            warningCodes: [{ code: "another_match" }],
            warnings: ["Another transfer matches as well."],
          }),
          candidate(leg("in-2", "bank", "TRANSFER_IN"), {
            score: 80,
            reasonCodes: ["same_amount", "same_currency"],
            warningCodes: [{ code: "dates_differ", days: 2 }],
            warnings: ["Dates differ by 2 day(s)."],
          }),
        ]),
      ],
    });

    expect(await screen.findByText("Another transfer matches as well.")).toBeInTheDocument();
    expect(screen.queryByText("Dates differ by 2 days.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+1 other match" }));
    const later = screen.getByText("Dates differ by 2 days.").closest("button")!;
    fireEvent.click(later);
    expect(later).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    await waitFor(() =>
      expect(linkTransferPairs).toHaveBeenCalledWith([
        { activityAId: "out-1", activityBId: "in-2" },
      ]),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Make it a transfer" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Not a transfer" }));

    await waitFor(() => expect(updateActivity).toHaveBeenCalledTimes(1));
    expect(updateActivity.mock.calls[0][0]).toMatchObject({
      id: "in-9",
      // The displayed type, which keeps a broker row's override.
      activityType: "TRANSFER_IN",
      metadata: { flow: { is_external: true } },
    });
  });

  it("offers Not a transfer from the menu of a row with a match", async () => {
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
    fireEvent.click(await screen.findByRole("menuitem", { name: "Not a transfer" }));

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

  it("points a row's arrow the way the money moved", async () => {
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
    const direction = (index: number) =>
      within(rows[index]).getByTestId("transfer-flow-arrow").getAttribute("data-direction");
    expect(direction(0)).toBe("backward");
    expect(direction(1)).toBe("forward");
  });

  it("says when nothing is left to match", async () => {
    renderPage({ certain: [], needsReview: [] });
    expect(await screen.findByText("All transfers are matched")).toBeInTheDocument();
  });
});
