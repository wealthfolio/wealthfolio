import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { SavingGoals } from "./goals";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [
      {
        id: "goal-1",
        goalType: "retirement",
        title: "Retirement",
        statusLifecycle: "active",
        statusHealth: "at_risk",
        priority: 1,
        currency: "CAD",
        targetDate: "2034-08-09",
        summaryCurrentValue: 980_000,
        summaryTargetAmount: 3_433_731,
        summaryProgress: 0.285,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; years?: number; months?: number }) => {
      if (key === "goals:card.months_left") return `${options?.count} MOIS RESTANTS`;
      if (key === "goals:card.years_left") return `${options?.count} ANS RESTANTS`;
      if (key === "goals:card.years_months_left") {
        return `${options?.years} A ${options?.months} M RESTANTS`;
      }
      return key;
    },
  }),
}));

describe("SavingGoals localization", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("formats progress and remaining time with the active locales", () => {
    render(
      <MemoryRouter>
        <FormattingProvider locale="fr-FR" uiLocale="fr">
          <SavingGoals />
        </FormattingProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText(/^29[\u00a0\u202f ]%$/)).toBeInTheDocument();
    expect(screen.getByText("7 A 11 M RESTANTS")).toBeInTheDocument();
  });
});
