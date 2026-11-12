import { ActivitySplitReviewProvider } from "@/features/spending/components/activity-split-review-provider";
import { render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  createActivity: vi.fn(),
  deleteActivity: vi.fn(),
  updateToolResult: vi.fn(),
  logger: { error: vi.fn() },
}));
const toolUi = vi.hoisted(() => ({
  render: undefined as ((props: { result: unknown }) => ReactNode) | undefined,
}));
vi.mock("@/adapters", () => adapter);
vi.mock("@assistant-ui/react", () => ({
  makeAssistantToolUI: (config: { render: typeof toolUi.render }) => {
    toolUi.render = config.render;
    return () => null;
  },
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: () => ({ data: { baseCurrency: "USD" } }) }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("../../hooks/use-runtime-context", () => ({
  useRuntimeContext: () => ({ currentThreadId: null }),
}));
import "./record-activity-tool-ui";

const ACCOUNTS = [
  { id: "acc-brokerage", name: "Brokerage", currency: "USD" },
  { id: "acc-retirement", name: "Retirement", currency: "USD" },
];

/** A deposit draft, which needs no asset lookup, with or without an account. */
function draftResult(accountId?: string) {
  return {
    draft: {
      activityType: "DEPOSIT",
      activityDate: "2026-11-03",
      accountId,
      accountName: accountId ? "Brokerage" : undefined,
      amount: 500,
      currency: "USD",
      priceSource: "none",
      quoteMode: "MARKET",
      isCustomAsset: false,
    },
    validation: accountId
      ? { isValid: true, missingFields: [], errors: [] }
      : { isValid: false, missingFields: ["account_id"], errors: [] },
    availableAccounts: ACCOUNTS,
    availableSubtypes: [],
  };
}

function renderCard(result: unknown) {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <ActivitySplitReviewProvider>{toolUi.render?.({ result })}</ActivitySplitReviewProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("an AI draft without an account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.createActivity.mockResolvedValue({ id: "created-deposit" });
  });

  it("offers the accounts in place and confirms with the one picked", async () => {
    renderCard(draftResult());
    const user = userEvent.setup();

    expect(screen.getByText("Missing: Account")).toBeInTheDocument();
    expect(screen.queryByText(/account_id/)).not.toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByTestId("draft-account-select"));
    await user.click(await screen.findByRole("option", { name: /Retirement/ }));

    expect(screen.queryByText("Missing: Account")).not.toBeInTheDocument();
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(adapter.createActivity).toHaveBeenCalledTimes(1));
    expect(adapter.createActivity.mock.calls[0][0]).toMatchObject({
      accountId: "acc-retirement",
      activityType: "DEPOSIT",
    });
  });

  it("shows the draft's own account without a picker", () => {
    renderCard(draftResult("acc-brokerage"));

    expect(screen.queryByTestId("draft-account-select")).not.toBeInTheDocument();
    expect(screen.getByText("Brokerage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });
});
