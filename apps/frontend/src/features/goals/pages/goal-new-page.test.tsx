import { fireEvent, render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import GoalNewPage from "./goal-new-page";
import type { RetirementPlan } from "../retirement-planner/types";

const mocks = vi.hoisted(() => ({
  settings: null as { timezone: string; baseCurrency: string } | null,
  mutate: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: mocks.settings }),
}));
vi.mock("../hooks/use-goals", () => ({ useGoals: () => ({ goals: [] }) }));
vi.mock("../hooks/use-create-goal-flow", () => ({
  useCreateGoalFlow: () => ({ mutate: mocks.mutate, isPending: false }),
}));

afterEach(() => {
  vi.useRealTimers();
  mocks.settings = null;
  mocks.mutate.mockClear();
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
