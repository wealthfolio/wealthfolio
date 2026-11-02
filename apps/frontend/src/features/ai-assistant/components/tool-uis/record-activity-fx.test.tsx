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

describe.each(["FEE", "TAX"])("editing an AI %s draft", (activityType) => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.createActivity.mockResolvedValue({ id: "created-charge" });
  });

  it.each(["untouched", "changed", "cleared"])(
    "submits the %s FX rate on creation",
    async (edit) => {
      const result = {
        draft: {
          activityType,
          activityDate: "2026-04-01",
          accountId: "usd-account",
          amount: 5,
          currency: "EUR",
          fxRate: 1.08,
          priceSource: "none",
          quoteMode: "MARKET",
          isCustomAsset: false,
        },
        validation: { isValid: true, missingFields: [], errors: [] },
        availableAccounts: [{ id: "usd-account", name: "USD account", currency: "USD" }],
        availableSubtypes: [],
      };
      render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <ActivitySplitReviewProvider>{toolUi.render?.({ result })}</ActivitySplitReviewProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Edit" }));
      await user.click(screen.getByTestId("advanced-options-button"));
      await user.type(screen.getByRole("textbox", { name: /notes/i }), "Edited note only");
      if (edit !== "untouched") {
        await user.clear(screen.getByTestId("fx-rate-input"));
        if (edit === "changed") await user.type(screen.getByTestId("fx-rate-input"), "1.35");
      }
      await user.click(screen.getByRole("button", { name: /update/i }));
      await waitFor(() => expect(adapter.createActivity).toHaveBeenCalledTimes(1));
      expect(adapter.createActivity.mock.calls[0][0]).toMatchObject({
        activityType,
        currency: "EUR",
        comment: "Edited note only",
        fxRate: edit === "untouched" ? "1.08" : edit === "changed" ? "1.35" : null,
      });
    },
  );
});
