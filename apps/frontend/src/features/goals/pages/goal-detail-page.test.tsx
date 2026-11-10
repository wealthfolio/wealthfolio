import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Activity } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { Goal, SaveUpOverviewDTO } from "@/lib/types";
import GoalDetailPage from "./goal-detail-page";

const mocks = vi.hoisted(() => ({
  useDeleteGoal: (() => undefined) as () => unknown,
  saveUpOverview: undefined as SaveUpOverviewDTO | undefined,
  save: vi.fn((_content: Blob, _name: string) => Promise.resolve(true)),
}));

const goal: Goal = {
  id: "goal-1",
  goalType: "custom_save_up",
  title: "Sabbatical",
  statusLifecycle: "active",
  statusHealth: "on_track",
  priority: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as Goal;

vi.mock("../hooks/use-goal-detail", () => ({
  useGoalDetail: () => ({ goal, plan: null, fundingRules: [], isLoading: false, error: null }),
  useGoalPlanMutations: () => ({ savePlanMutation: { mutate: vi.fn() } }),
  useRetirementOverview: () => ({}),
  useSaveUpOverview: () => ({ data: mocks.saveUpOverview }),
}));
vi.mock("../hooks/use-goals", () => ({
  useGoalMutations: () => ({ deleteMutation: mocks.useDeleteGoal() }),
  useGoals: () => ({ goals: [] }),
}));
vi.mock("@/adapters", async (original) => ({
  ...(await original<typeof import("@/adapters")>()),
  openFileSaveDialog: mocks.save,
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC", baseCurrency: "USD" } }),
}));
vi.mock("@/features/goals/retirement-planner/hooks/use-portfolio", () => ({
  usePortfolioData: () => ({}),
}));
vi.mock("@/features/goals/retirement-planner/pages/dashboard-page", () => ({
  default: () => null,
}));
vi.mock("@/features/goals/retirement-planner/pages/risk-lab-page", () => ({ default: () => null }));
vi.mock("../save-up/components/save-up-detail", () => ({ default: () => null }));
vi.mock("../components/goal-edit-dialog", () => ({ GoalEditDialog: () => null }));
// The page's actions, as plain buttons.
vi.mock("@/components/action-palette", () => ({
  ActionPalette: ({ groups }: { groups: { items: { label: string; onClick: () => void }[] }[] }) =>
    groups
      .flatMap((group) => group.items)
      .map((item) => (
        <button key={item.label} type="button" onClick={item.onClick}>
          {item.label}
        </button>
      )),
}));

it("goes back to the goals once a delete ends while the screen is out of sight", async () => {
  // On a phone, a screen left for another tab is a hidden <Activity>.
  let finish: () => void = () => undefined;
  const deleted = new Promise<void>((resolve) => (finish = resolve));
  mocks.useDeleteGoal = () => useMutation({ mutationFn: () => deleted });
  const client = new QueryClient();
  const page = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/goals/goal-1"]}>
        <Routes>
          <Route
            path="/goals/:goalId"
            element={
              <Activity mode={hidden ? "hidden" : "visible"}>
                <GoalDetailPage />
              </Activity>
            }
          />
          <Route path="/goals" element={<p>Goals list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const deleteStatus = () => client.getMutationCache().getAll()[0]?.state.status;
  const { rerender } = render(page(false));
  fireEvent.click(screen.getByRole("button", { name: "Delete goal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(deleteStatus()).toBe("pending"));

  rerender(page(true));
  act(() => finish());
  await waitFor(() => expect(deleteStatus()).toBe("success"));
  expect(screen.queryByText("Goals list")).not.toBeInTheDocument();

  rerender(page(false));
  await waitFor(() => expect(screen.getByText("Goals list")).toBeInTheDocument());
});

it("exports the save-up projection only once the goal has one", async () => {
  mocks.useDeleteGoal = () => ({ isSuccess: false, isPending: false, mutate: vi.fn() });
  const page = () => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/goals/goal-1"]}>
        <Routes>
          <Route path="/goals/:goalId" element={<GoalDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  mocks.saveUpOverview = undefined;
  const { unmount } = render(page());
  expect(screen.queryByRole("button", { name: "Export projection" })).not.toBeInTheDocument();
  unmount();

  mocks.saveUpOverview = {
    currentValue: 1000,
    targetAmount: 5000,
    progress: 0.2,
    health: "on_track",
    projectedValueAtTargetDate: 5200,
    requiredMonthlyContribution: 300,
    projectedCompletionDate: "2027-06-30",
    trajectory: [
      {
        date: "2026-11-08",
        nominal: 1000,
        optimistic: 1000,
        pessimistic: 1000,
        target: 5000,
        needed: 950,
      },
    ],
  };
  render(page());
  fireEvent.click(screen.getByRole("button", { name: "Export projection" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  const [file, name] = mocks.save.mock.calls[0];
  expect(name).toMatch(/^goal-projection_sabbatical_\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await file.text();
  expect(csv).toContain('"2026-11-08","1000.00","1000.00","1000.00","5000.00","950.00"');
  expect(csv).toContain('"Goal","Sabbatical"');
  mocks.saveUpOverview = undefined;
});
