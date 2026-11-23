import { QueryKeys } from "@/lib/query-keys";
import type { Account, ContributionLimitDetails } from "@/lib/types";
import { render, screen, waitFor, within } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContributionLimitDetailPage } from "./contribution-limit-detail-page";

const mocks = vi.hoisted(() => ({
  getContributionLimitDetails: vi.fn(),
  setContributionActivityExcluded: vi.fn(),
  getAccounts: vi.fn(),
  createContributionLimit: vi.fn(),
  updateContributionLimit: vi.fn(),
  deleteContributionLimit: vi.fn(),
  calculateDepositsForLimit: vi.fn(),
  searchActivities: vi.fn(),
  logger: { error: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/adapters", () => mocks);
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: mocks.toast }));
// The activity edit form stands in as a dialog naming the activity it opened with.
const forms = vi.hoisted(() => ({
  activityForm: ({ activity, open }: { activity?: { id?: string }; open?: boolean }) =>
    open ? <div role="dialog" aria-label={`Edit ${activity?.id}`} /> : null,
}));
vi.mock("@/pages/activity/components/activity-form", () => ({ ActivityForm: forms.activityForm }));
vi.mock("@/pages/activity/components/mobile-forms/mobile-activity-form", () => ({
  MobileActivityForm: forms.activityForm,
}));
vi.mock("@/pages/activity/hooks/use-activity-mutations", () => ({
  useActivityMutations: () => ({
    deleteActivityMutation: { mutateAsync: vi.fn(), isPending: false },
    duplicateActivityMutation: { mutateAsync: vi.fn() },
  }),
}));
vi.mock("./components/contribution-limit-edit-modal", () => ({
  ContributionLimitEditModal: () => null,
}));

const accounts: Account[] = ["retirement", "source"].map((id) => ({
  id,
  name: id === "retirement" ? "Current plan" : "Old plan",
  accountType: "SECURITIES",
  currency: "USD",
  isDefault: false,
  isActive: id !== "source",
  isArchived: false,
  trackingMode: "TRANSACTIONS",
  createdAt: new Date(),
  updatedAt: new Date(),
}));
const details = (excluded = false): ContributionLimitDetails => ({
  limit: {
    id: "limit-a",
    groupName: "Retirement",
    contributionYear: 2025,
    limitAmount: 24000,
    accountIds: "retirement,source",
  },
  calculation: { total: excluded ? 5000 : 55000, baseCurrency: "USD", byAccount: {} },
  activities: [
    {
      id: "rollover",
      accountId: "retirement",
      activityType: "TRANSFER_IN",
      activityInstant: "2025-06-15T12:00:00Z",
      amount: 50000,
      currency: "USD",
      countedAmount: excluded ? 0 : 50000,
      treatment: excluded ? "excludedByUser" : "counted",
      canExclude: true,
    },
    {
      id: "deposit",
      accountId: "retirement",
      activityType: "DEPOSIT",
      activityInstant: "2025-05-15T12:00:00Z",
      amount: 5000,
      currency: "USD",
      countedAmount: 5000,
      treatment: "counted",
      canExclude: true,
    },
    {
      id: "internal",
      accountId: "retirement",
      activityType: "TRANSFER_IN",
      activityInstant: "2025-04-15T12:00:00Z",
      amount: 2000,
      currency: "USD",
      countedAmount: 0,
      treatment: "internalTransfer",
      canExclude: false,
    },
  ],
});

function setup(direction: "ltr" | "rtl" = "ltr") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings/contribution-limits/limit-a"]}>
        <DirectionProvider direction={direction}>
          <div dir={direction}>
            <Routes>
              <Route
                path="/settings/contribution-limits/:limitId"
                element={<ContributionLimitDetailPage />}
              />
            </Routes>
          </div>
        </DirectionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, user: userEvent.setup() };
}

function countedCard() {
  const card = screen.getByText("Counted contributions").closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error("Counted summary card missing");
  return within(card);
}

function countsSwitch(amount: string) {
  const row = screen.getByText(amount).closest("li");
  if (!(row instanceof HTMLElement)) throw new Error("Activity row missing");
  return within(row).getByRole("switch");
}

describe("contribution limit detail", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    mocks.getAccounts.mockResolvedValue(accounts);
    let excluded = false;
    mocks.getContributionLimitDetails.mockImplementation(() => Promise.resolve(details(excluded)));
    mocks.setContributionActivityExcluded.mockImplementation(
      (_limitId: string, _activityId: string, value: boolean) => {
        excluded = value;
        return Promise.resolve();
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists the limit's accounts with what each contributed", async () => {
    mocks.getContributionLimitDetails.mockResolvedValue({
      ...details(),
      // "gone" was deleted after the limit was saved.
      limit: { ...details().limit, accountIds: "retirement,gone,source" },
      calculation: {
        total: 55000,
        baseCurrency: "USD",
        byAccount: { retirement: { amount: 55000, currency: "USD", convertedAmount: 55000 } },
      },
    });
    setup();
    const list = await screen.findByRole("list", { name: "Accounts that count" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Current plan$55,000.00",
      "Old plan$0.00",
    ]);
    expect(screen.queryByText("Select accounts")).not.toBeInTheDocument();
    // $55,000 counted against a $24,000 limit.
    const bar = screen.getByRole("progressbar", { name: "Counted contributions" });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(countedCard().getAllByText("Over limit")).toHaveLength(2);
    expect(countedCard().getByText("$31,000.00")).toBeInTheDocument();
  });

  it("offers to choose accounts when the limit has none", async () => {
    mocks.getContributionLimitDetails.mockResolvedValue({
      ...details(),
      limit: { ...details().limit, accountIds: "" },
    });
    setup();
    expect(await screen.findByText("No accounts selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose accounts" })).toBeInTheDocument();
  });

  it.each(["ltr", "rtl"] as const)(
    "excludes and restores an activity from its switch in %s",
    async (direction) => {
      const { client, user } = setup(direction);
      await screen.findByRole("heading", { name: "Retirement" });
      const progressKey = [QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, "retirement", 2025, "limit-a"];
      client.setQueryData(progressKey, details().calculation);
      client.setQueryData([QueryKeys.CONTRIBUTION_LIMIT_DETAILS, "limit-b"], details());
      expect(countedCard().getByText("$55,000.00")).toBeInTheDocument();
      const rollover = countsSwitch("$50,000.00");
      expect(rollover).toHaveAccessibleName("Count Transfer In · Jun 15, 2025 in this limit");
      expect(rollover).toBeChecked();

      await user.click(rollover);
      await waitFor(() => expect(countedCard().getByText("$5,000.00")).toBeInTheDocument());
      expect(mocks.setContributionActivityExcluded).toHaveBeenLastCalledWith(
        "limit-a",
        "rollover",
        true,
      );
      expect(countsSwitch("$50,000.00")).not.toBeChecked();
      expect(screen.getByText("Excluded by you")).toBeInTheDocument();
      expect(client.getQueryState(progressKey)?.isInvalidated).toBe(true);
      expect(
        client.getQueryState([QueryKeys.CONTRIBUTION_LIMIT_DETAILS, "limit-b"])?.isInvalidated,
      ).toBe(false);

      await user.click(countsSwitch("$50,000.00"));
      await waitFor(() => expect(countedCard().getByText("$55,000.00")).toBeInTheDocument());
      expect(mocks.setContributionActivityExcluded).toHaveBeenLastCalledWith(
        "limit-a",
        "rollover",
        false,
      );
      expect(countsSwitch("$50,000.00")).toBeChecked();
    },
  );

  it("shows why an automatic exclusion can't be switched", async () => {
    setup();
    await screen.findByRole("heading", { name: "Retirement" });
    const row = screen.getByText("$2,000.00").closest("li");
    if (!(row instanceof HTMLElement)) throw new Error("Activity row missing");
    expect(within(row).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(row).getByText("Internal transfer")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });

  it("keeps the saved state and total after a failed save", async () => {
    mocks.setContributionActivityExcluded.mockRejectedValueOnce(new Error("Save failed"));
    const { user } = setup();
    await screen.findByRole("heading", { name: "Retirement" });
    await user.click(countsSwitch("$50,000.00"));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })),
    );
    expect(countedCard().getByText("$55,000.00")).toBeInTheDocument();
    expect(countsSwitch("$50,000.00")).toBeChecked();
    expect(countsSwitch("$50,000.00")).toBeEnabled();
  });

  it("lists activities that can't be switched below, with an edit action for unmarked transfers", async () => {
    const data = details();
    data.activities.push(
      {
        id: "unmarked-transfer",
        accountId: "retirement",
        activityType: "TRANSFER_IN",
        activityInstant: "2025-03-15T12:00:00Z",
        amount: 800,
        currency: "USD",
        countedAmount: 0,
        treatment: "notExternal",
        canExclude: false,
      },
      {
        id: "interest",
        accountId: "retirement",
        activityType: "CREDIT",
        activityInstant: "2025-02-15T12:00:00Z",
        amount: 25,
        currency: "USD",
        countedAmount: 0,
        treatment: "notExternal",
        canExclude: false,
      },
    );
    mocks.getContributionLimitDetails.mockResolvedValue(data);
    mocks.searchActivities.mockResolvedValue({
      data: [{ id: "unmarked-transfer", activityType: "TRANSFER_IN", accountId: "retirement" }],
    });
    const { user } = setup();
    await screen.findByRole("heading", { name: "Retirement" });

    const group = (name: string) => {
      const section = screen.getByRole("heading", { name }).closest("section");
      if (!(section instanceof HTMLElement)) throw new Error(`${name} group missing`);
      return within(section);
    };
    expect(group("Contributions").getAllByRole("switch")).toHaveLength(2);
    const notCounted = group("Not counted automatically");
    expect(notCounted.queryByRole("switch")).not.toBeInTheDocument();
    expect(notCounted.getByText("Internal transfer")).toBeInTheDocument();
    // The edit form can mark a transfer external; it has no such option for a credit.
    const edit = notCounted.getAllByRole("button", { name: /^Edit / });
    expect(edit).toHaveLength(1);
    expect(edit[0]).toHaveAccessibleName("Edit Transfer In · Mar 15, 2025");

    await user.click(edit[0]);
    expect(await screen.findByRole("dialog", { name: "Edit unmarked-transfer" })).toBeVisible();
    expect(mocks.searchActivities).toHaveBeenCalledWith(
      0,
      1,
      { activityIds: ["unmarked-transfer"] },
      "",
    );
  });

  it.each([
    ["fails", () => mocks.searchActivities.mockRejectedValue(new Error("offline"))],
    ["finds nothing", () => mocks.searchActivities.mockResolvedValue({ data: [] })],
  ])("reports it when loading the activity to edit %s", async (_case, arrange) => {
    const data = details();
    data.activities.push({
      id: "unmarked-transfer",
      accountId: "retirement",
      activityType: "TRANSFER_IN",
      activityInstant: "2025-03-15T12:00:00Z",
      amount: 800,
      currency: "USD",
      countedAmount: 0,
      treatment: "notExternal",
      canExclude: false,
    });
    mocks.getContributionLimitDetails.mockResolvedValue(data);
    arrange();
    const { user } = setup();
    await screen.findByRole("heading", { name: "Retirement" });

    const edit = screen.getByRole("button", { name: "Edit Transfer In · Mar 15, 2025" });
    await user.click(edit);

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        description: "Couldn't open this activity. Try again.",
        variant: "destructive",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(edit).toBeEnabled();
  });
});
