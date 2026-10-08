import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import frGoals from "@/i18n/locales/fr/goals.json";
import type { Goal, NewGoal } from "@/lib/types";
import { renderHook, waitFor } from "@/test/render";
import { useCreateGoalFlow } from "./use-create-goal-flow";
import { useGoalPlanMutations } from "./use-goal-detail";
import { useGoalMutations } from "./use-goals";

const mocks = vi.hoisted(() => ({
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  deleteGoal: vi.fn(),
  saveGoalPlan: vi.fn(),
  saveGoalFunding: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  createGoal: mocks.createGoal,
  updateGoal: mocks.updateGoal,
  deleteGoal: mocks.deleteGoal,
  getGoals: vi.fn(),
  saveGoalPlan: mocks.saveGoalPlan,
  saveGoalFunding: mocks.saveGoalFunding,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const goal = { id: "goal-1" } as Goal;
const newGoal = {} as NewGoal;

beforeAll(() => {
  i18n.addResourceBundle("fr", "goals", frGoals);
});
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("fr");
});
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("goal mutation toasts", () => {
  it("shows goal create, update and delete outcomes in the selected language", async () => {
    mocks.createGoal.mockResolvedValue(goal);
    mocks.updateGoal.mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce(goal);
    mocks.deleteGoal.mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useGoalMutations(), { wrapper });

    await result.current.createMutation.mutateAsync(newGoal);
    await expect(result.current.updateMutation.mutateAsync(goal)).rejects.toThrow();
    await result.current.updateMutation.mutateAsync(goal);
    await expect(result.current.deleteMutation.mutateAsync(goal.id)).rejects.toThrow();
    await result.current.deleteMutation.mutateAsync(goal.id);

    // Update success is toasted by the caller.
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2));
    expect(mocks.success.mock.calls).toEqual([[frGoals.goal_saved], [frGoals.goal_deleted]]);
    expect(mocks.error.mock.calls).toEqual([[frGoals.goal_error], [frGoals.goal_delete_error]]);
  });

  it("shows plan and funding outcomes in the selected language", async () => {
    mocks.saveGoalPlan.mockRejectedValueOnce(new Error("bad plan")).mockResolvedValueOnce({});
    mocks.saveGoalFunding.mockResolvedValue([]);
    const { result } = renderHook(() => useGoalPlanMutations(goal.id), { wrapper });

    await expect(
      result.current.savePlanMutation.mutateAsync({ goalId: goal.id } as never),
    ).rejects.toThrow();
    await result.current.savePlanMutation.mutateAsync({ goalId: goal.id } as never);
    await result.current.saveFundingMutation.mutateAsync([]);

    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2));
    expect(mocks.error).toHaveBeenCalledWith(frGoals.plan_error);
    expect(mocks.success.mock.calls).toEqual([[frGoals.plan_saved], [frGoals.funding_saved]]);
  });

  it("shows the create-goal flow outcome in the selected language", async () => {
    mocks.createGoal.mockResolvedValueOnce(goal).mockRejectedValueOnce(new Error(""));
    const { result } = renderHook(() => useCreateGoalFlow(), { wrapper });

    await result.current.mutateAsync({ goal: newGoal });
    await expect(result.current.mutateAsync({ goal: newGoal })).rejects.toThrow();

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(frGoals.goal_error));
    expect(mocks.success).toHaveBeenCalledWith(frGoals.goal_saved);
  });
});
