import { act, render, screen, fireEvent } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import type { TaxonomyCategory } from "@/lib/types";
import SpendingInsightsPage from "./spending-insights-page";

const { insightQuery, eventsQuery, cashQuery, testSettings, taxonomyData } = vi.hoisted(() => ({
  taxonomyData: { categories: [] as TaxonomyCategory[] },
  insightQuery: vi.fn(),
  eventsQuery: vi.fn(),
  cashQuery: vi.fn(),
  testSettings: { timezone: "America/Toronto" },
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { baseCurrency: "USD", timezone: testSettings.timezone },
  }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({ data: taxonomyData }) }));
vi.mock("../hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: true, isLoading: false }),
}));
vi.mock("../hooks/use-cash-activities", () => ({
  useCashActivities: (request: unknown) => {
    cashQuery(request);
    return { data: [] };
  },
}));
vi.mock("../hooks/use-spending-insight", () => ({
  useSpendingInsight: (request: unknown, enabled?: boolean) => {
    insightQuery(request, enabled);
    return {};
  },
}));
vi.mock("../hooks/use-spending-events", () => ({
  useEventSpendingSummaries: (request: unknown) => {
    eventsQuery(request);
    return { data: [] };
  },
}));
vi.mock("../components/reports/insights/where-i-am-stage", () => ({
  WhereIAmStage: () => <div>Where stage</div>,
}));
vi.mock("../components/reports/insights/what-changed-stage", () => ({
  WhatChangedStage: ({ taxonomyCategories }: { taxonomyCategories: TaxonomyCategory[] }) => (
    <div>
      Changed stage
      <output data-testid="report-category-names">
        {taxonomyCategories.map((row) => row.name).join(" / ")}
      </output>
    </div>
  ),
}));
vi.mock("../components/reports/insights/when-where-stage", () => ({
  WhenWhereStage: ({ taxonomyCategories }: { taxonomyCategories: TaxonomyCategory[] }) => (
    <div>
      When stage
      <output data-testid="report-category-names">
        {taxonomyCategories.map((row) => row.name).join(" / ")}
      </output>
    </div>
  ),
}));
vi.mock("../components/reports/category-transactions-sheet", () => ({
  CategoryTransactionsSheet: () => null,
}));
vi.mock("../components/reports/heatmap-cell-sheet", () => ({ HeatmapCellSheet: () => null }));

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}
function setup(stage = "where") {
  render(
    <MemoryRouter
      initialEntries={[
        `/spending/insights?stage=${stage}&period=MTD&spendingFrom=2025-03-08&spendingTo=2025-03-10`,
      ]}
    >
      <SpendingInsightsPage />
      <Location />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  vi.clearAllMocks();
  testSettings.timezone = "America/Toronto";
  taxonomyData.categories = [];
});

describe("This month comparisons", () => {
  it.each([
    [
      "2026-09-29T12:00:00Z",
      "America/Toronto",
      "2026-08-01T04:00:00.000Z",
      "2026-08-30T03:59:59.999Z",
    ],
    [
      "2026-09-30T12:00:00Z",
      "America/Toronto",
      "2026-08-01T04:00:00.000Z",
      "2026-09-01T03:59:59.999Z",
    ],
    [
      "2026-09-29T23:00:00Z",
      "Pacific/Kiritimati",
      "2026-07-31T10:00:00.000Z",
      "2026-08-31T09:59:59.999Z",
    ],
    [
      "2026-02-28T12:00:00Z",
      "America/Toronto",
      "2026-01-01T05:00:00.000Z",
      "2026-02-01T04:59:59.999Z",
    ],
    [
      "2024-02-29T12:00:00Z",
      "America/Toronto",
      "2024-01-01T05:00:00.000Z",
      "2024-02-01T04:59:59.999Z",
    ],
    [
      "2026-03-31T12:00:00Z",
      "America/Toronto",
      "2026-02-01T05:00:00.000Z",
      "2026-03-01T04:59:59.999Z",
    ],
    [
      "2026-01-31T12:00:00Z",
      "America/Toronto",
      "2025-12-01T05:00:00.000Z",
      "2026-01-01T04:59:59.999Z",
    ],
    ["2026-05-30T12:00:00Z", "UTC", "2026-04-01T00:00:00.000Z", "2026-04-30T23:59:59.999Z"],
  ])(
    "uses the matching prior month, including a completed month at %s in %s",
    (now, timezone, expectedStart, expectedEnd) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      testSettings.timezone = timezone;
      try {
        render(
          <MemoryRouter initialEntries={["/spending/insights?stage=changed&period=MTD"]}>
            <SpendingInsightsPage />
          </MemoryRouter>,
        );
        expect(insightQuery).toHaveBeenCalledWith(
          expect.objectContaining({
            compareStartDate: expectedStart,
            compareEndDate: expectedEnd,
          }),
          true,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("custom range in Spending Insights", () => {
  it.each(["where", "changed", "when"])(
    "retains exact custom dates and calendar-day comparison in %s",
    (stage) => {
      setup(stage);
      expect(insightQuery).toHaveBeenCalledWith(
        {
          startDate: "2025-03-08T05:00:00.000Z",
          endDate: "2025-03-11T03:59:59.999Z",
          compare: "prior",
          compareStartDate: "2025-03-05T05:00:00.000Z",
          compareEndDate: "2025-03-08T04:59:59.999Z",
        },
        undefined,
      );
      expect(eventsQuery).toHaveBeenCalledWith({
        startDate: "2025-03-08T05:00:00.000Z",
        endDate: "2025-03-11T03:59:59.999Z",
      });
      expect(cashQuery).toHaveBeenCalledWith({
        startDate: "2025-03-08T05:00:00.000Z",
        endDate: "2025-03-11T03:59:59.999Z",
      });
      expect(screen.getByTestId("spending-selected-range")).toHaveTextContent(
        "Mar 8, 2025 – Mar 10, 2025",
      );
    },
  );

  it("preserves dates when switching stage and removes them when selecting a preset", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "What changed" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "spendingFrom=2025-03-08&spendingTo=2025-03-10",
    );
    await user.click(screen.getByRole("button", { name: "YTD" }));
    expect(screen.getByTestId("location")).toHaveTextContent("period=YTD");
    expect(screen.getByTestId("location")).not.toHaveTextContent("spendingFrom");
    expect(screen.queryByTestId("spending-selected-range")).not.toBeInTheDocument();
  });

  // Opening the date picker twice dominates this test: each Base UI popover open
  // costs about 0.5 s in jsdom (0.15 s with Radix), so it runs 1.6 s locally and
  // went over 5 s in CI's full run. In Chrome the picker opens in ~115 ms either way.
  it("applies a new range and clears back to the preset", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-12-31" } });
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "spendingFrom=2025-01-01&spendingTo=2025-12-31",
    );
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("location")).not.toHaveTextContent("spendingFrom");
    expect(screen.getByTestId("location")).toHaveTextContent("period=MTD");
  }, 15_000);
});

it.each(["where", "changed", "when"])(
  "shows the selected historical month and year in %s",
  (stage) => {
    render(
      <MemoryRouter
        initialEntries={[`/spending/insights?stage=${stage}&period=MTD&spendingMonth=2025-02`]}
      >
        <SpendingInsightsPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("spending-selected-range")).toHaveTextContent("February 2025");
  },
);

it.each(["changed", "when"])(
  "refreshes %s display labels from stable raw query data",
  async (stage) => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: "zh",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      resources: {
        en: { common: enCommon, spending: enSpending },
        zh: { common: zhCommon, spending: zhSpending },
      },
    });
    taxonomyData.categories = [
      ["cat_housing", "Housing"],
      ["cat_food", "My meals"],
      ["custom-housing", "Housing"],
    ].map(([id, name]) => ({
      id,
      name,
      taxonomyId: "spending_categories",
      color: "#123456",
      parentId: null,
      key: id,
      sortOrder: 0,
      createdAt: "",
      updatedAt: "",
    }));
    const raw = structuredClone(taxonomyData);
    render(
      <MemoryRouter initialEntries={[`/spending/insights?stage=${stage}&period=MTD`]}>
        <I18nextProvider i18n={i18n}>
          <SpendingInsightsPage />
        </I18nextProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("report-category-names")).toHaveTextContent(
      `${zhCommon.categoryNames.spending_categories.cat_housing} / My meals / Housing`,
    );
    const initialRequests = new Set(insightQuery.mock.calls.map((args) => JSON.stringify(args)));
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByTestId("report-category-names")).toHaveTextContent(
      "Housing / My meals / Housing",
    );
    expect(new Set(insightQuery.mock.calls.map((args) => JSON.stringify(args)))).toEqual(
      initialRequests,
    );
    expect(taxonomyData).toEqual(raw);
  },
);
