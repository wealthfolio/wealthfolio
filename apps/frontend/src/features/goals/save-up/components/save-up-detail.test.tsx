import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enGoals from "@/i18n/locales/en/goals.json";
import type { Goal, SaveUpOverviewDTO } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import SaveUpDetailPage from "./save-up-detail";

const mocks = vi.hoisted(() => ({
  saveGoalPlan: vi.fn(),
  updateGoal: vi.fn(),
  previewSaveUpOverview: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  saveGoalPlan: mocks.saveGoalPlan,
  updateGoal: mocks.updateGoal,
  previewSaveUpOverview: mocks.previewSaveUpOverview,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("../../components/goal-funding-editor", () => ({ GoalFundingEditor: () => null }));
vi.mock("./save-up-projection-card", () => ({ SaveUpProjectionCard: () => null }));

const goal: Goal = {
  id: "goal-1",
  goalType: "home",
  title: "Home",
  statusLifecycle: "active",
  statusHealth: "on_track",
  priority: 1,
  targetAmount: 10000,
  summaryCurrentValue: 1000,
  createdAt: "2026-08-18T00:00:00Z",
  updatedAt: "2026-08-18T00:00:00Z",
};

const preview: SaveUpOverviewDTO = {
  currentValue: 1000,
  targetAmount: 20000,
  progress: 0.05,
  health: "at_risk",
  projectedValueAtTargetDate: 19000,
  requiredMonthlyContribution: 500,
  projectedCompletionDate: null,
  trajectory: [],
};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function savePlan() {
  render(<SaveUpDetailPage goal={goal} plan={null} />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Edit Savings Inputs" }));
  fireEvent.change(screen.getAllByRole("slider")[0], { target: { value: "20000" } });
  // The header and footer both render Save; it reads "Previewing…" until the preview resolves.
  const [save] = await screen.findAllByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => {
    expect(mocks.saveGoalPlan).toHaveBeenCalledTimes(1);
    expect(mocks.updateGoal).toHaveBeenCalledTimes(1);
    expect(queryClient.isMutating()).toBe(0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.previewSaveUpOverview.mockResolvedValue(preview);
  mocks.saveGoalPlan.mockResolvedValue({});
});

describe("SaveUpDetailPage plan save", () => {
  it("shows one success toast and still syncs the goal summary", async () => {
    mocks.updateGoal.mockResolvedValue(goal);

    await savePlan();

    expect(mocks.updateGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAmount: 20000,
        summaryProgress: 0.05,
        projectedValueAtTargetDate: 19000,
        statusHealth: "at_risk",
      }),
    );
    expect(mocks.success.mock.calls).toEqual([[enGoals.plan_saved]]);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("still reports a failed goal summary sync", async () => {
    mocks.updateGoal.mockRejectedValue(new Error("locked"));

    await savePlan();

    expect(mocks.success.mock.calls).toEqual([[enGoals.plan_saved]]);
    expect(mocks.error.mock.calls).toEqual([[enGoals.goal_error]]);
  });
});
