import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Activity, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enGoals from "@/i18n/locales/en/goals.json";
import type { Goal } from "@/lib/types";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
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

  it("closes once a save ends while its phone screen is out of sight", async () => {
    // A phone screen kept under another one is a hidden <Activity>.
    let finish: () => void = () => undefined;
    mocks.updateGoal.mockReturnValue(new Promise((resolve) => (finish = () => resolve(goal))));
    const onClose = vi.fn();
    const client = new QueryClient();
    const view = (hidden: boolean) => (
      <QueryClientProvider client={client}>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <GoalEditDialog goal={goal} open onClose={onClose} />
        </Activity>
      </QueryClientProvider>
    );
    const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
    const { rerender } = render(view(false));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveStatus()).toBe("pending"));

    rerender(view(true));
    act(() => finish());
    await waitFor(() => expect(saveStatus()).toBe("success"));
    rerender(view(false));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.success.mock.calls).toEqual([[enGoals.goal_saved]]);
  });
});
