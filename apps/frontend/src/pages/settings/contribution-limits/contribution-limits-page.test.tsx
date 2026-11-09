import { AccountType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, ContributionLimit, NewContributionLimit } from "@/lib/types";
import { render, screen, waitFor, within } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsContributionLimitPage from "./contribution-limits-page";

const adapters = vi.hoisted(() => ({
  getAccounts: vi.fn(),
  getContributionLimit: vi.fn(),
  calculateDepositsForLimit: vi.fn(),
  updateContributionLimit: vi.fn(),
  createContributionLimit: vi.fn(),
  deleteContributionLimit: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock("@/adapters", () => adapters);
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC", baseCurrency: "USD" } }),
}));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  name: id,
  accountType: AccountType.SECURITIES,
  currency: "USD",
  isDefault: false,
  isActive: true,
  isArchived: false,
  trackingMode: "TRANSACTIONS",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("contribution limit account selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["ltr", "rtl"] as const)(
    "can select and remove a hidden account and refresh usage in %s",
    async (direction) => {
      const accounts = [
        account("Current plan"),
        account("Old plan", { isActive: false }),
        account("Archived plan", { isArchived: true }),
        account("Credit card", { accountType: AccountType.CREDIT_CARD }),
      ];
      let limit: ContributionLimit = {
        id: "limit",
        groupName: "Retirement",
        contributionYear: new Date().getFullYear(),
        limitAmount: 24_000,
        accountIds: "Current plan",
      };
      adapters.getAccounts.mockImplementation(async (includeArchived: boolean) =>
        accounts.filter((account) => includeArchived || !account.isArchived),
      );
      adapters.getContributionLimit.mockImplementation(async () => [limit]);
      adapters.updateContributionLimit.mockImplementation(
        async (_id: string, updatedLimit: NewContributionLimit) => {
          limit = { ...limit, ...updatedLimit };
          return limit;
        },
      );
      // Model the existing backend behavior: the incoming leg counts unless
      // the source account is selected too. This test exercises frontend wiring.
      adapters.calculateDepositsForLimit.mockImplementation(async () => ({
        total: limit.accountIds?.split(",").includes("Old plan") ? 0 : 50_000,
        baseCurrency: "USD",
        byAccount: {},
      }));
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <DirectionProvider direction={direction}>
              <div dir={direction}>
                <SettingsContributionLimitPage />
              </div>
            </DirectionProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      const user = userEvent.setup();
      // The card's actions menu opens the shared edit dialog.
      const editAccounts = async () => {
        await user.click(screen.getAllByRole("button", { name: "Open" })[0]);
        await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
        return within(await screen.findByRole("group", { name: "Accounts that count" }));
      };

      await screen.findAllByText("$50,000.00");
      let picker = await editAccounts();
      const hiddenAccount = picker.getByRole("checkbox", { name: /Old plan\s*Hidden/ });
      expect(hiddenAccount).not.toBeChecked();
      expect(picker.queryByText("Archived plan")).not.toBeInTheDocument();
      expect(picker.queryByText("Credit card")).not.toBeInTheDocument();
      expect(adapters.getAccounts).toHaveBeenCalledWith(false);

      await user.click(hiddenAccount);
      await user.click(screen.getByRole("button", { name: "Update" }));
      await waitFor(() =>
        expect(adapters.updateContributionLimit).toHaveBeenLastCalledWith(
          "limit",
          expect.objectContaining({ accountIds: "Current plan,Old plan" }),
        ),
      );
      await screen.findAllByText("$0.00");
      expect(client.getQueryData([QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, "limit"])).toMatchObject({
        total: 0,
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      // Reopen the dialog to verify the saved hidden selection can be removed.
      picker = await editAccounts();
      const savedAccount = picker.getByRole("checkbox", { name: /Old plan\s*Hidden/ });
      expect(savedAccount).toBeChecked();
      await user.click(savedAccount);
      await user.click(screen.getByRole("button", { name: "Update" }));
      await waitFor(() =>
        expect(adapters.updateContributionLimit).toHaveBeenLastCalledWith(
          "limit",
          expect.objectContaining({ accountIds: "Current plan" }),
        ),
      );
      await screen.findAllByText("$50,000.00");
    },
  );
});
