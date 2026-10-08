import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enGoals from "@/i18n/locales/en/goals.json";
import type { Goal } from "@/lib/types";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { GoalEditDialog } from "./goal-edit-dialog";

const mocks = vi.hoisted(() => ({
  updateGoal: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/adapters", () => ({ updateGoal: mocks.updateGoal }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));

const goal: Goal = {
  id: "goal-1",
  goalType: "home",
  title: "Home",
  statusLifecycle: "active",
  statusHealth: "on_track",
  priority: 1,
  createdAt: "2026-08-18T00:00:00Z",
  updatedAt: "2026-08-18T00:00:00Z",
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GoalEditDialog save", () => {
  it("shows one success toast and closes", async () => {
    mocks.updateGoal.mockResolvedValue(goal);
    const onClose = vi.fn();
    render(<GoalEditDialog goal={goal} open onClose={onClose} />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.success.mock.calls).toEqual([[enGoals.goal_saved]]);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("shows the error toast and stays open when the update fails", async () => {
    mocks.updateGoal.mockRejectedValue(new Error("locked"));
    const onClose = vi.fn();
    render(<GoalEditDialog goal={goal} open onClose={onClose} />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(enGoals.goal_error));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
