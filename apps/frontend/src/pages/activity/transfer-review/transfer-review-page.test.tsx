import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  convertToInternalTransfer,
  linkTransferPairs,
  reviewConvertToTransferSplitEffects,
  reviewTransferMatches,
} from "@/adapters";
import { ActivitySplitReviewProvider } from "@/features/spending/components/activity-split-review-provider";
import { ActivityStatus } from "@/lib/constants";
import type {
  Account,
  Activity,
  TransferMatchCandidate,
  TransferMatchReview,
  UnlinkedTransfer,
} from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import { TransferReviewPage } from "./transfer-review-page";

const { updateActivity } = vi.hoisted(() => ({ updateActivity: vi.fn() }));

vi.mock("@/adapters", () => ({
  convertToInternalTransfer: vi.fn(),
  findTransferMatchCandidates: vi.fn().mockResolvedValue([]),
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
    balance: 0,
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

function leg(id: string, accountId: string, activityType: string, amount = "500"): Activity {
  return {
    id,
    accountId,
    activityType,
    status: ActivityStatus.POSTED,
    activityDate: timestamp,
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
      .mockResolvedValue({ linked: [{ transferInId: "in", transferOutId: "out" }], errors: [] });
    vi.mocked(convertToInternalTransfer).mockReset();
    vi.mocked(reviewConvertToTransferSplitEffects).mockReset().mockResolvedValue([]);
    updateActivity.mockReset().mockResolvedValue({});
  });

  it("links every certain pair still shown in one call", async () => {
    renderPage({
      certain: [
        row(leg("in-1", "rrsp", "TRANSFER_IN"), [
          candidate(leg("out-1", "tfsa", "TRANSFER_OUT"), { confidence: "high" }),
        ]),
        row(leg("in-2", "rrsp", "TRANSFER_IN", "70"), [
          candidate(leg("out-2", "tfsa", "TRANSFER_OUT", "70"), { confidence: "high" }),
        ]),
        row(leg("in-3", "bank", "TRANSFER_IN", "9"), [
          candidate(leg("out-3", "tfsa", "TRANSFER_OUT", "9"), { confidence: "high" }),
        ]),
      ],
      needsReview: [],
    });

    const rows = await screen.findAllByTestId("transfer-review-certain-row");
    expect(rows).toHaveLength(3);
    // Each pair reads from the side money leaves.
    const [from, to] = within(rows[0]).getAllByText(/TFSA|RRSP/);
    expect(from).toHaveTextContent("TFSA");
    expect(to).toHaveTextContent("RRSP");

    fireEvent.click(within(rows[1]).getByRole("button", { name: "Skip" }));
    expect(screen.getByText("1 skipped for now")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link all 2 pairs" }));

    await waitFor(() => expect(linkTransferPairs).toHaveBeenCalledTimes(1));
    expect(linkTransferPairs).toHaveBeenCalledWith([
      { activityAId: "in-1", activityBId: "out-1" },
      { activityAId: "in-3", activityBId: "out-3" },
    ]);
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

  it("says when nothing is left to match", async () => {
    renderPage({ certain: [], needsReview: [] });
    expect(await screen.findByText("All transfers are matched")).toBeInTheDocument();
  });
});
