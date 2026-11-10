import { act, render, screen, fireEvent, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import type { TaxonomyCategory } from "@/lib/types";
import { FormattingProvider, stripBidiControls } from "@wealthfolio/ui";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import type { SpendingInsight } from "../types/insight";
import SpendingInsightsPage from "./spending-insights-page";

const { insightQuery, eventsQuery, cashQuery, testSettings, taxonomyData } = vi.hoisted(() => ({
  taxonomyData: { categories: [] as TaxonomyCategory[] },
  insightQuery: vi.fn(),
  eventsQuery: vi.fn(),
  cashQuery: vi.fn(),
  testSettings: { timezone: "America/Toronto", hidden: false },
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { baseCurrency: "USD", timezone: testSettings.timezone },
  }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: testSettings.hidden }),
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
    return insightQuery(request, enabled) ?? {};
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
function sharedPick() {
  return JSON.parse(localStorage.getItem("dashboard-period") ?? "null");
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
  testSettings.hidden = false;
  insightQuery.mockReset();
  taxonomyData.categories = [];
});

it("keeps desktop toolbar controls in sync and clears them when leaving the tab", async () => {
  function ToolbarHost() {
    const [actions, setActions] = useState<ReactNode | null>(null);
    const [showSpending, setShowSpending] = useState(true);
    return (
      <>
        <div data-testid="spending-toolbar">{actions}</div>
        <button onClick={() => setShowSpending(false)}>Leave Spending</button>
        {showSpending && <SpendingInsightsPage onToolbarActionsChange={setActions} />}
      </>
    );
  }

  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/insights?tab=spending&period=MTD"]}>
      <ToolbarHost />
    </MemoryRouter>,
  );
  const toolbar = screen.getByTestId("spending-toolbar");
  const ytd = () => within(toolbar).getByRole("button", { name: "YTD" });
  expect(screen.getAllByRole("button", { name: "YTD" })).toHaveLength(1);
  await user.click(ytd());
  expect(ytd()).toHaveAttribute("aria-pressed", "true");
  expect(sharedPick()).toEqual({ kind: "spending", code: "YTD" });
  await user.click(within(toolbar).getByRole("button", { name: /This month/ }));
  expect(ytd()).toHaveAttribute("aria-pressed", "false");
  expect(sharedPick()).toEqual({ kind: "spending", code: "MTD" });
  await user.click(screen.getByRole("button", { name: "Leave Spending" }));
  expect(toolbar).toBeEmptyDOMElement();
});

describe("This month comparisons", () => {
  it("compares 1W using seven calendar days across DST in Insights", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
    try {
      render(
        <MemoryRouter initialEntries={["/insights?tab=spending&period=1W"]}>
          <SpendingInsightsPage />
        </MemoryRouter>,
      );
      expect(insightQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2026-03-04T05:00:00.000Z",
          endDate: "2026-03-11T03:59:59.999Z",
          compareStartDate: "2026-02-25T05:00:00.000Z",
          compareEndDate: "2026-03-04T04:59:59.999Z",
        }),
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    [
      "2026-12-15T12:00:00Z",
      "spendingMonth=2026-11",
      "2026-09-30T22:00:00.000Z",
      "2026-10-31T22:59:59.999Z",
    ],
    [
      "2026-04-15T12:00:00Z",
      "spendingMonth=2026-03",
      "2026-01-31T23:00:00.000Z",
      "2026-02-28T22:59:59.999Z",
    ],
    [
      "2024-04-15T12:00:00Z",
      "spendingMonth=2024-03",
      "2024-01-31T23:00:00.000Z",
      "2024-02-29T22:59:59.999Z",
    ],
    ["2026-11-08T12:00:00Z", "period=MTD", "2026-09-30T22:00:00.000Z", "2026-10-31T22:59:59.999Z"],
    [
      "2026-12-15T12:00:00Z",
      "period=LAST_MONTH",
      "2026-09-30T22:00:00.000Z",
      "2026-10-31T22:59:59.999Z",
    ],
  ])(
    "compares %s / %s with the entire prior calendar month in every stage (#2553)",
    (now, query, start, end) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      testSettings.timezone = "Europe/Madrid";
      try {
        for (const stage of ["where", "changed", "when"]) {
          const view = render(
            <MemoryRouter initialEntries={[`/spending/insights?stage=${stage}&${query}`]}>
              <SpendingInsightsPage />
            </MemoryRouter>,
          );
          expect(insightQuery).toHaveBeenCalledWith(
            expect.objectContaining({ compareStartDate: start, compareEndDate: end }),
            undefined,
          );
          view.unmount();
          insightQuery.mockClear();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
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

  it("keeps linked dates when switching stage and replaces them when selecting a preset", async () => {
    const user = setup();
    // The link's dates are applied once and then dropped from the URL.
    expect(screen.getByTestId("location")).not.toHaveTextContent("spendingFrom");
    await user.click(screen.getByRole("button", { name: "What changed" }));
    expect(screen.getByTestId("location")).toHaveTextContent("stage=changed");
    expect(screen.getByTestId("spending-selected-range")).toHaveTextContent(
      "Mar 8, 2025 – Mar 10, 2025",
    );
    await user.click(screen.getByRole("button", { name: "YTD" }));
    expect(screen.getByTestId("location")).not.toHaveTextContent("period=");
    expect(sharedPick()).toEqual({ kind: "spending", code: "YTD" });
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
    expect(sharedPick()).toEqual({ kind: "range", from: "2025-01-01", to: "2025-12-31" });
    expect(screen.getByTestId("location")).not.toHaveTextContent("spendingFrom");
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(sharedPick()).toEqual({ kind: "spending", code: "MTD" });
    expect(screen.getByRole("button", { name: /This month/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
        en: { common: enCommon, taxonomies: enCommonTaxonomies, spending: enSpending },
        zh: { common: zhCommon, taxonomies: zhCommonTaxonomies, spending: zhSpending },
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
      `${zhCommonTaxonomies.categoryNames.spending_categories.cat_housing} / My meals / Housing`,
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

describe("period shared with the dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it.each(["2026", "invalid"])(
    "consumes invalid year-only link %s without replacing the shared selection",
    (year) => {
      localStorage.setItem("dashboard-period", JSON.stringify({ kind: "year", year: 2025 }));
      render(
        <MemoryRouter initialEntries={[`/insights?tab=spending&spendingYear=${year}`]}>
          <SpendingInsightsPage />
          <Location />
        </MemoryRouter>,
      );
      expect(sharedPick()).toEqual({ kind: "year", year: 2025 });
      expect(screen.getByTestId("location")).toHaveTextContent("?tab=spending");
      expect(screen.getByTestId("location")).not.toHaveTextContent("spendingYear");
      expect(screen.getByTestId("spending-selected-range")).toHaveTextContent("2025");
    },
  );

  it.each(["2026", "1969", "2025.5", "invalid"])(
    "rejects invalid year %s in a link and uses its valid preset",
    (year) => {
      render(
        <MemoryRouter initialEntries={[`/insights?tab=spending&spendingYear=${year}&period=3M`]}>
          <SpendingInsightsPage />
          <Location />
        </MemoryRouter>,
      );
      expect(sharedPick()).toEqual({ kind: "spending", code: "3M" });
      expect(screen.getByTestId("location")).toHaveTextContent("?tab=spending");
      expect(screen.queryByTestId("spending-selected-range")).not.toBeInTheDocument();
    },
  );

  it("prioritizes a custom range over a conflicting year link", () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/insights?tab=spending&spendingYear=2025&spendingFrom=2024-02-01&spendingTo=2024-02-29",
        ]}
      >
        <SpendingInsightsPage />
      </MemoryRouter>,
    );
    expect(sharedPick()).toEqual({ kind: "range", from: "2024-02-01", to: "2024-02-29" });
  });

  it("consumes a year link once, preserving year identity and calendar comparisons", () => {
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "spending", code: "MTD" }));
    render(
      <MemoryRouter
        initialEntries={[
          "/insights?tab=spending&spendingYear=2025&spendingMonth=2024-06&period=YTD",
        ]}
      >
        <SpendingInsightsPage />
        <Location />
      </MemoryRouter>,
    );
    expect(sharedPick()).toEqual({ kind: "year", year: 2025 });
    expect(screen.getByTestId("location")).toHaveTextContent("?tab=spending");
    expect(screen.getByTestId("spending-selected-range")).toHaveTextContent("2025");
    expect(insightQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2025-01-01T05:00:00.000Z",
        endDate: "2026-01-01T04:59:59.999Z",
        compareStartDate: "2024-01-01T05:00:00.000Z",
        compareEndDate: "2025-01-01T04:59:59.999Z",
      }),
      undefined,
    );
    expect(screen.getByRole("button", { name: "Previous period" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
  });

  it("follows a dashboard year instead of an old month preference", () => {
    localStorage.setItem("spending-month", JSON.stringify("2024-06"));
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "year", year: 2025 }));
    render(
      <MemoryRouter initialEntries={["/insights?tab=spending"]}>
        <SpendingInsightsPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("spending-selected-range")).toHaveTextContent("2025");
    expect(insightQuery).toHaveBeenCalledWith(
      expect.objectContaining({ compareStartDate: "2024-01-01T05:00:00.000Z" }),
      undefined,
    );
  });
  function renderAt(search: string) {
    render(
      <MemoryRouter initialEntries={[`/spending/insights${search}`]}>
        <SpendingInsightsPage />
        <Location />
      </MemoryRouter>,
    );
    return userEvent.setup();
  }

  it.each([
    ["3M", "2026-01-01T05:00:00.000Z", "2026-04-01T03:59:59.999Z"],
    ["6M", "2025-04-01T04:00:00.000Z", "2025-10-01T03:59:59.999Z"],
    ["1Y", "2023-10-01T04:00:00.000Z", "2024-10-01T03:59:59.999Z"],
  ])(
    "compares a historical calendar-aligned %s window with the preceding calendar block",
    async (code, start, end) => {
      const user = renderAt(`?stage=where&period=${code}`);
      await user.click(screen.getByRole("button", { name: "Previous period" }));
      expect(insightQuery).toHaveBeenCalledWith(
        expect.objectContaining({ compareStartDate: start, compareEndDate: end }),
        undefined,
      );
    },
  );

  it("follows the period picked on the dashboard when the URL names none", () => {
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "portfolio", code: "6M" }));
    renderAt("?stage=where");
    expect(screen.getByRole("button", { name: "6M" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows dashboard custom dates", () => {
    localStorage.setItem(
      "dashboard-period",
      JSON.stringify({ kind: "range", from: "2025-03-08", to: "2025-03-10" }),
    );
    renderAt("?stage=where");
    expect(screen.getByTestId("spending-selected-range")).toHaveTextContent(
      "Mar 8, 2025 – Mar 10, 2025",
    );
  });

  it("applies a period named in the URL once, then drops it from the URL", () => {
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "portfolio", code: "6M" }));
    renderAt("?stage=where&period=YTD");
    expect(screen.getByRole("button", { name: "YTD" })).toHaveAttribute("aria-pressed", "true");
    expect(sharedPick()).toEqual({ kind: "spending", code: "YTD" });
    expect(screen.getByTestId("location")).toHaveTextContent("?stage=where");
    expect(screen.getByTestId("location")).not.toHaveTextContent("period=");
  });

  it("replaces Last month with Previous and returns to This month with Next", async () => {
    const user = renderAt("?stage=where");
    expect(screen.queryByRole("button", { name: /Last month/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous period" }));
    expect(sharedPick()).toEqual({ kind: "month", monthKey: "2026-08" });
    expect(screen.getByTestId("spending-selected-range")).toHaveTextContent("August 2026");
    expect(insightQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-08-01T04:00:00.000Z",
        endDate: "2026-09-01T03:59:59.999Z",
      }),
      undefined,
    );
    await user.click(screen.getByRole("button", { name: "Next period" }));
    expect(sharedPick()).toEqual({ kind: "spending", code: "MTD" });
    expect(screen.getByRole("button", { name: /This month/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
    // Back/forward can only revive what is in the URL, so a pick never goes there.
    expect(screen.getByTestId("location")).not.toHaveTextContent("period=");
  });

  it.each([
    ["3M", "2026-04-01T04:00:00.000Z", "2026-07-01T03:59:59.999Z"],
    ["6M", "2025-10-01T04:00:00.000Z", "2026-04-01T03:59:59.999Z"],
    ["YTD", "2025-01-01T05:00:00.000Z", "2025-09-16T03:59:59.999Z"],
    ["1Y", "2024-10-01T04:00:00.000Z", "2025-10-01T03:59:59.999Z"],
  ])(
    "navigates the shared %s windows and retains the selected preset",
    async (code, startDate, endDate) => {
      const user = renderAt(`?stage=where&period=${code}`);
      await user.click(screen.getByRole("button", { name: "Previous period" }));
      expect(screen.getByRole("button", { name: code })).toHaveAttribute("aria-pressed", "true");
      expect(sharedPick()).toMatchObject({
        kind: "range",
        presetWindow: { preset: { kind: "spending", code }, anchor: "2026-09-15", offset: -1 },
      });
      expect(insightQuery).toHaveBeenCalledWith(
        expect.objectContaining({ startDate, endDate }),
        undefined,
      );
      await user.click(screen.getByRole("button", { name: "Next period" }));
      expect(sharedPick()).toEqual({ kind: "spending", code });
      expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
    },
  );

  it("restores historical navigation after remount and returns by reselecting the preset", async () => {
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "portfolio", code: "6M" }));
    const user = userEvent.setup();
    const first = render(
      <MemoryRouter>
        <SpendingInsightsPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "Previous period" }));
    first.unmount();
    render(
      <MemoryRouter>
        <SpendingInsightsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "6M" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Next period" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "6M" }));
    expect(sharedPick()).toEqual({ kind: "spending", code: "6M" });
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
  });

  it("clears a stepped month back to the visible preset rather than a stale Insights preference", async () => {
    localStorage.setItem("spending-insights-period", JSON.stringify("6M"));
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "spending", code: "MTD" }));
    const user = renderAt("?stage=where");
    await user.click(screen.getByRole("button", { name: "Previous period" }));
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(sharedPick()).toEqual({ kind: "spending", code: "MTD" });
    expect(screen.getByRole("button", { name: /This month/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("continues a dashboard 1M pick instead of treating it as a manual range", async () => {
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "portfolio", code: "1M" }));
    const user = renderAt("?stage=where");
    expect(screen.getByRole("button", { name: /This month/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Previous period" }));
    expect(sharedPick()).toMatchObject({
      kind: "range",
      from: "2026-07-15",
      to: "2026-08-15",
      presetWindow: { preset: { kind: "portfolio", code: "1M" }, offset: -1 },
    });
    await user.click(screen.getByRole("button", { name: "Next period" }));
    expect(sharedPick()).toEqual({ kind: "portfolio", code: "1M" });
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
  });

  it("keeps manual custom ranges fixed and accepts legacy Last month links", async () => {
    const user = renderAt("?stage=where&period=LAST_MONTH");
    expect(sharedPick()).toEqual({ kind: "spending", code: "LAST_MONTH" });
    expect(screen.queryByRole("button", { name: /Last month/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next period" }));
    expect(sharedPick()).toEqual({ kind: "spending", code: "MTD" });
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    await user.click(screen.getByRole("button", { name: "Choose custom dates" }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-03-08" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-03-10" } });
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Previous period" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
  });

  it("clears an older month opened from a legacy Last month link to This month", async () => {
    const user = renderAt("?stage=where&period=LAST_MONTH");
    await user.click(screen.getByRole("button", { name: "Previous period" }));
    expect(sharedPick()).toEqual({ kind: "month", monthKey: "2026-07" });
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(sharedPick()).toEqual({ kind: "spending", code: "MTD" });
    expect(screen.getByRole("button", { name: /This month/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

function foreignCurrencyInsight(nativeOutflowByCurrency: Record<string, number>): SpendingInsight {
  const period = {
    start: "2025-03-08T00:00:00Z",
    end: "2025-03-10T23:59:59Z",
    months: ["2025-03"],
    dayCount: 3,
  };
  return {
    period,
    prior: period,
    currency: "USD",
    foreignCurrencies: Object.keys(nativeOutflowByCurrency),
    nativeOutflowByCurrency,
    headline: {
      spent: 0,
      income: 0,
      saved: 0,
      netCashflow: 0,
      budget: 0,
      remaining: 0,
      priorSpent: 0,
      deltaVsPriorPct: null,
      status: "on_track",
      pace: {
        dailyAvg: 0,
        daysElapsed: 3,
        daysRemaining: 0,
        projectedSpend: 0,
        expectedSpendToDate: 0,
      },
    },
    groups: [],
    uncategorized: {
      spent: 0,
      priorSpent: 0,
      deltaVsPriorPct: null,
      pctOfTotalSpent: null,
      txnCount: 0,
    },
    incomeBreakdown: [],
    savingsBreakdown: [],
    byDay: [],
    byDayByCategory: [],
    byMonth: [],
  };
}

it.each(["ltr", "rtl"] as const)(
  "retains custom currency labels and Spain rounding in %s source totals",
  (direction) => {
    insightQuery.mockReturnValue({
      data: foreignCurrencyInsight({ USDT: -12345.6, MyCoin: 6789.4 }),
    });
    render(
      <DirectionProvider direction={direction}>
        <FormattingProvider locale="ES">
          <MemoryRouter>
            <SpendingInsightsPage />
          </MemoryRouter>
        </FormattingProvider>
      </DirectionProvider>,
    );
    const notice = screen.getByText("Multi-currency:").parentElement!;
    expect(stripBidiControls(notice.textContent ?? "")).toContain("12.346 USDT + 6.789 MyCoin");
  },
);

it("hides custom currency source amounts with balance privacy", () => {
  testSettings.hidden = true;
  insightQuery.mockReturnValue({ data: foreignCurrencyInsight({ USDT: 12345.6 }) });
  setup();
  const notice = screen.getByText("Multi-currency:").parentElement!;
  expect(notice).toHaveTextContent("••••");
  expect(notice).not.toHaveTextContent("12346");
});
