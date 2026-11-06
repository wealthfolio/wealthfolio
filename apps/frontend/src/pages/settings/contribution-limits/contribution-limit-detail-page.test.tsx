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
  logger: { error: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/adapters", () => mocks);
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: mocks.toast }));
vi.mock("./components/contribution-limit-edit-modal", () => ({
  ContributionLimitEditModal: () => null,
}));

const accounts: Account[] = ["retirement", "source"].map((id) => ({
  id,
  name: id === "retirement" ? "Current plan" : "Old plan",
  accountType: "SECURITIES",
  balance: 0,
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

async function reviewAmount(amount: string, user: ReturnType<typeof userEvent.setup>) {
  const row = screen.getByText(amount).closest("tr");
  if (!(row instanceof HTMLElement)) throw new Error("Activity row missing");
  await user.click(within(row).getByRole("button"));
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

  it.each(["ltr", "rtl"] as const)(
    "previews, saves and restores exclusions in %s",
    async (direction) => {
      const { client, user } = setup(direction);
      await screen.findByRole("heading", { name: "Retirement" });
      const progressKey = [QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, "retirement", 2025, "limit-a"];
      client.setQueryData(progressKey, details().calculation);
      client.setQueryData([QueryKeys.CONTRIBUTION_LIMIT_DETAILS, "limit-b"], details());
      expect(countedCard().getByText("$55,000.00")).toBeInTheDocument();
      await reviewAmount("$50,000.00", user);
      await user.click(screen.getByRole("combobox", { name: "Treatment in this limit" }));
      await user.click(await screen.findByRole("option", { name: "Exclude from this limit" }));
      expect(countedCard().getByText("$55,000.00")).toBeInTheDocument();
      expect(mocks.setContributionActivityExcluded).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Save treatment" }));
      await waitFor(() => expect(countedCard().getByText("$5,000.00")).toBeInTheDocument());
      expect(mocks.setContributionActivityExcluded).toHaveBeenLastCalledWith(
        "limit-a",
        "rollover",
        true,
      );
      expect(screen.getByText("Excluded by you")).toBeInTheDocument();
      expect(client.getQueryState(progressKey)?.isInvalidated).toBe(true);
      expect(
        client.getQueryState([QueryKeys.CONTRIBUTION_LIMIT_DETAILS, "limit-b"])?.isInvalidated,
      ).toBe(false);
      await user.click(screen.getByRole("combobox", { name: "Treatment in this limit" }));
      await user.click(await screen.findByRole("option", { name: "Count automatically" }));
      await user.click(screen.getByRole("button", { name: "Save treatment" }));
      await waitFor(() => expect(countedCard().getByText("$55,000.00")).toBeInTheDocument());
      expect(mocks.setContributionActivityExcluded).toHaveBeenLastCalledWith(
        "limit-a",
        "rollover",
        false,
      );
    },
  );

  it("keeps automatic exclusions read-only", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { name: "Retirement" });
    await reviewAmount("$2,000.00", user);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save treatment" })).not.toBeInTheDocument();
    expect(mocks.setContributionActivityExcluded).not.toHaveBeenCalled();
  });

  it("retains the draft and original total after a failed save", async () => {
    mocks.setContributionActivityExcluded.mockRejectedValueOnce(new Error("Save failed"));
    const { user } = setup();
    await screen.findByRole("heading", { name: "Retirement" });
    await reviewAmount("$50,000.00", user);
    await user.click(screen.getByRole("combobox", { name: "Treatment in this limit" }));
    await user.click(await screen.findByRole("option", { name: "Exclude from this limit" }));
    await user.click(screen.getByRole("button", { name: "Save treatment" }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })),
    );
    expect(countedCard().getByText("$55,000.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save treatment" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Treatment in this limit" })).toHaveTextContent(
      "Exclude from this limit",
    );
  });

  it("does not invent an FX conversion when restoring an excluded foreign-currency activity", async () => {
    const data = details(true);
    data.activities[0].currency = "CAD";
    mocks.getContributionLimitDetails.mockResolvedValue(data);
    const { user } = setup();
    await screen.findByRole("heading", { name: "Retirement" });
    const row = screen.getByText("Excluded by you").closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("Excluded row missing");
    await user.click(within(row).getByRole("button"));
    await user.click(screen.getByRole("combobox", { name: "Treatment in this limit" }));
    await user.click(await screen.findByRole("option", { name: "Count automatically" }));
    expect(screen.getAllByText("Calculated on save")).toHaveLength(2);
    expect(mocks.setContributionActivityExcluded).not.toHaveBeenCalled();
  });
});
