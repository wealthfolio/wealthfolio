import { beforeEach, describe, expect, it, vi } from "vitest";
import { findTransferMatchCandidates } from "@/adapters";
import { ActivityStatus } from "@/lib/constants";
import type { Account, Activity } from "@/lib/types";
import { render, screen, within } from "@/test/render";
import { TransferMatchDialog } from "./transfer-match-dialog";

vi.mock("@/adapters", () => ({
  findTransferMatchCandidates: vi.fn(),
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
