import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  convertToInternalTransfer,
  findTransferMatchCandidates,
  reviewConvertToTransferSplitEffects,
} from "@/adapters";
import { ActivitySplitReviewProvider } from "@/features/spending/components/activity-split-review-provider";
import { ActivityStatus } from "@/lib/constants";
import type { Account, Activity } from "@/lib/types";
import { fireEvent, render, screen, waitFor, within } from "@/test/render";
import { TransferMatchDialog } from "./transfer-match-dialog";

vi.mock("@/adapters", () => ({
  convertToInternalTransfer: vi.fn(),
  findTransferMatchCandidates: vi.fn(),
  reviewActivitiesSplitEffects: vi.fn(),
  reviewConvertToTransferSplitEffects: vi.fn(),
  reviewInternalTransferPairSplitEffects: vi.fn(),
  getTransferPairForActivity: vi.fn(),
  searchActivities: vi.fn(),
  logger: { warn: vi.fn() },
}));
vi.mock("../hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({
    linkTransferActivitiesMutation: { isPending: false },
    unlinkTransferActivitiesMutation: { isPending: false },
    updateActivityMutation: { isPending: false },
  }),
}));

const timestamp = "2026-04-01T00:00:00+00:00";
const account: Account = {
  id: "synthetic-account",
  name: "Synthetic account",
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
const activity: Activity = {
  id: "synthetic-transfer",
  accountId: account.id,
  activityType: "TRANSFER_OUT",
  status: ActivityStatus.POSTED,
  activityDate: timestamp,
  amount: "105.31",
  currency: "CAD",
  isUserModified: false,
  needsReview: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function renderActivity(overrides: Partial<Activity> = {}) {
  return render(
    <TransferMatchDialog
      open
      mode="link"
      sourceActivity={{ ...activity, ...overrides }}
      accounts={[account, { ...account, id: "candidate-account", name: "Candidate account" }]}
      onOpenChange={vi.fn()}
    />,
  );
}

describe("transfer activity summary", () => {
  beforeEach(() => {
    vi.mocked(findTransferMatchCandidates).mockResolvedValue([]);
  });

  it("labels cash source and suggested transfers with their activity currency", async () => {
    vi.mocked(findTransferMatchCandidates).mockResolvedValue([
      {
        activity: {
          ...activity,
          id: "synthetic-candidate",
          accountId: "candidate-account",
          activityType: "TRANSFER_IN",
        },
        matchKind: "cash",
        confidence: "high",
        score: 100,
        reasons: ["Same currency"],
        warnings: [],
      },
    ]);
    renderActivity();

    const reason = await screen.findByText("Same currency");
    const candidate = reason.closest("button");
    expect(candidate).not.toBeNull();
    expect(within(candidate!).getByText("CAD")).toBeInTheDocument();
    expect(screen.getAllByText("CA$105.31")).toHaveLength(2);
    expect(screen.getAllByText("CAD", { selector: "span" })).toHaveLength(2);
    expect(screen.queryByText("USD", { selector: "span" })).not.toBeInTheDocument();
  });

  it("preserves the security quantity and symbol label", async () => {
    renderActivity({ assetId: "SYNTHETIC", quantity: "2" });
    expect(screen.getByText("2 SYNTHETIC")).toBeInTheDocument();
    await screen.findByText("No matches within 7 days of this activity.");
  });
});

describe("converting a deposit or withdrawal into a transfer", () => {
  const withQueryClient = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <ActivitySplitReviewProvider>{children}</ActivitySplitReviewProvider>
    </QueryClientProvider>
  );
  const withdrawal = {
    ...activity,
    id: "synthetic-withdrawal",
    activityType: "WITHDRAWAL",
    currency: "USD",
  };
  const deposit: Activity = {
    ...activity,
    id: "synthetic-deposit",
    accountId: "candidate-account",
    activityType: "DEPOSIT",
    currency: "USD",
  };

  const depositMatch = {
    activity: deposit,
    matchKind: "cash",
    confidence: "high",
    score: 100,
    reasons: ["Same amount"],
    warnings: [],
  };
  const renderConversion = (onOpenChange = vi.fn()) =>
    render(
      <TransferMatchDialog
        open
        mode="link"
        sourceActivity={withdrawal}
        accounts={[account, { ...account, id: "candidate-account", name: "Candidate account" }]}
        onOpenChange={onOpenChange}
      />,
      { wrapper: withQueryClient },
    );

  beforeEach(() => {
    vi.mocked(convertToInternalTransfer).mockReset();
    vi.mocked(reviewConvertToTransferSplitEffects).mockReset().mockResolvedValue([]);
  });

  it("pairs the withdrawal with the chosen deposit", async () => {
    vi.mocked(findTransferMatchCandidates).mockResolvedValue([depositMatch]);
    const onOpenChange = vi.fn();
    renderConversion(onOpenChange);

    fireEvent.click((await screen.findByText("Same amount")).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Convert to transfer" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(convertToInternalTransfer).toHaveBeenCalledWith({
      activityId: "synthetic-withdrawal",
      counterpartActivityId: "synthetic-deposit",
      splitReview: [],
    });
  });

  it("asks before removing splits and sends the reviewed state", async () => {
    const effect = {
      activityId: "synthetic-withdrawal",
      removedSplits: 2,
      hasRetainedCategoryAssignment: false,
      fingerprint: "state",
    };
    vi.mocked(reviewConvertToTransferSplitEffects).mockResolvedValue([effect]);
    vi.mocked(findTransferMatchCandidates).mockResolvedValue([depositMatch]);
    renderConversion();

    fireEvent.click((await screen.findByText("Same amount")).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Convert to transfer" }));

    expect(
      await screen.findByText("This edit will remove 2 split allocations."),
    ).toBeInTheDocument();
    expect(convertToInternalTransfer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save and remove splits" }));

    await waitFor(() =>
      expect(convertToInternalTransfer).toHaveBeenCalledWith({
        activityId: "synthetic-withdrawal",
        counterpartActivityId: "synthetic-deposit",
        splitReview: [effect],
      }),
    );
  });

  it("asks for an account when no matching activity exists", async () => {
    vi.mocked(findTransferMatchCandidates).mockResolvedValue([]);
    render(
      <TransferMatchDialog
        open
        mode="link"
        sourceActivity={withdrawal}
        accounts={[account, { ...account, id: "candidate-account", name: "Candidate account" }]}
        onOpenChange={vi.fn()}
      />,
      { wrapper: withQueryClient },
    );

    await screen.findByText("No matching activity within 7 days.");
    expect(screen.getByRole("button", { name: "Convert to transfer" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Other account" })).toBeInTheDocument();
  });
});
