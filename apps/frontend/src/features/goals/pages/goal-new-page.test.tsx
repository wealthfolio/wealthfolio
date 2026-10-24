import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { FormattingProvider } from "@wealthfolio/ui";
import { Activity } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import GoalNewPage from "./goal-new-page";
import type { RetirementPlan } from "../retirement-planner/types";

const mocks = vi.hoisted(() => ({
  settings: null as { timezone: string; baseCurrency: string } | null,
  mutate: vi.fn(),
  // Swapped for a real save in tests that need one.
  useCreateGoalFlow: null as null | (() => unknown),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: mocks.settings }),
}));
vi.mock("../hooks/use-goals", () => ({ useGoals: () => ({ goals: [] }) }));
vi.mock("../hooks/use-create-goal-flow", () => ({
  useCreateGoalFlow: () =>
    mocks.useCreateGoalFlow?.() ?? { mutate: mocks.mutate, isPending: false },
}));

afterEach(() => {
  vi.useRealTimers();
  mocks.settings = null;
  mocks.mutate.mockClear();
  mocks.useCreateGoalFlow = null;
});

it("reseeds the retirement birth month when selected after settings load", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
  const content = () => (
    <MemoryRouter>
      <FormattingProvider locale="en-US">
        <GoalNewPage />
      </FormattingProvider>
    </MemoryRouter>
  );
  const { rerender } = render(content());
  mocks.settings = { timezone: "America/Los_Angeles", baseCurrency: "USD" };
  rerender(content());

  fireEvent.click(screen.getByText("Retirement", { exact: true }));
  expect(screen.getByLabelText("Birth month")).toHaveValue("1995-12");
  expect(screen.getByText("Current age is 30.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create Goal" }));
  const input = mocks.mutate.mock.calls[0][0] as { initialPlan: { settingsJson: string } };
  const plan = JSON.parse(input.initialPlan.settingsJson) as RetirementPlan;
  expect(plan.personal).toMatchObject({
    birthYearMonth: "1995-12",
    currentAge: 30,
  });
});

it("opens the new goal when its save ends while the screen is out of sight", async () => {
  // On a phone, a screen left for another tab is a hidden <Activity>.
  let finish: (result: { goal: { id: string }; plan: null }) => void = () => undefined;
  const saved = new Promise<{ goal: { id: string }; plan: null }>((resolve) => (finish = resolve));
  mocks.useCreateGoalFlow = () => useMutation({ mutationFn: () => saved });
  mocks.settings = { timezone: "UTC", baseCurrency: "USD" };
  const client = new QueryClient();
  const content = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/goals/new"]}>
        <FormattingProvider locale="en-US">
          <Routes>
            <Route
              path="/goals/new"
              element={
                <Activity mode={hidden ? "hidden" : "visible"}>
                  <GoalNewPage />
                </Activity>
              }
            />
            <Route path="/goals/:id" element={<p>Goal page</p>} />
          </Routes>
        </FormattingProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
  const { rerender } = render(content(false));
  fireEvent.click(screen.getByText("Retirement", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Create Goal" }));
  await waitFor(() => expect(saveStatus()).toBe("pending"));

  rerender(content(true));
  act(() => finish({ goal: { id: "goal-1" }, plan: null }));
  await waitFor(() => expect(saveStatus()).toBe("success"));
  expect(screen.queryByText("Goal page")).not.toBeInTheDocument();

  rerender(content(false));
  await waitFor(() => expect(screen.getByText("Goal page")).toBeInTheDocument());
});
