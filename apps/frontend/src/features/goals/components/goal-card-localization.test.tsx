import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { Goal } from "@/lib/types";
import { GoalCard } from "./goal-card";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { baseCurrency: "EUR", timezone: "America/Los_Angeles" },
  }),
}));

const goal: Goal = {
  id: "goal-1",
  goalType: "home",
  title: "Home",
  statusLifecycle: "active",
  statusHealth: "on_track",
  priority: 1,
  summaryCurrentValue: 125,
  summaryTargetAmount: 1000,
  summaryProgress: 0.125,
  createdAt: "2026-08-18T00:00:00Z",
  updatedAt: "2026-08-18T00:00:00Z",
};

describe("GoalCard localization", () => {
  it("formats visible progress percentages with the formatting locale", () => {
    render(
      <MemoryRouter>
        <FormattingProvider locale="fr-FR" uiLocale="en">
          <GoalCard goal={goal} />
        </FormattingProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText(/12,5[\u00a0\u202f ]%/)).toBeInTheDocument();
  });
  it("does not mark tomorrow's deadline due when UTC has already crossed midnight", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      render(
        <MemoryRouter>
          <GoalCard goal={{ ...goal, targetDate: "2026-01-01" }} />
        </MemoryRouter>,
      );
      expect(screen.queryByText(/DUE/)).not.toBeInTheDocument();
      expect(screen.getByText(/0M LEFT/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
