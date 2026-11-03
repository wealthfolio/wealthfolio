import { act, fireEvent, render, screen } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import zhCommonSpending from "@/i18n/locales/zh/spending.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import enSettings from "@/i18n/locales/en/settings.json";
import zhSettings from "@/i18n/locales/zh/settings.json";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import { getBudgetGroupLabel } from "@/features/spending/lib/labels";
import type { TaxonomyCategory } from "@/lib/types";
import { BudgetOverviewCard } from "@/pages/settings/spending/components/budget-overview-card";
import {
  buildMoneyFlowGraph,
  focusMoneyFlowGraph,
  type MoneyFlowGraph,
  type MoneyFlowInput,
} from "../../lib/money-flow";
import type { BudgetCategoryRow, BudgetGroupRow } from "../../types/budget";
import type { EventSpendingSummary } from "../../types/event";
import { CategoryHierarchyTable } from "./category-hierarchy-table";
import { EventDetailPanel } from "./insights/event-detail-panel";
import { EventsTimelineCard } from "./insights/events-timeline-card";
import { localizeReportCategories } from "./report-localization";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
    },
  );
});

const NEEDS = "032ecb02-5912-42e8-9724-2cd566fc08d5";
const WANTS = "a409e0d6-9152-49c8-a5b4-a147a8ac636e";
const state = vi.hoisted(() => ({ budget: {} }));
vi.mock("../../hooks/use-budget", () => ({
  useBudget: () => ({ data: state.budget, isLoading: false }),
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("../../hooks/use-spending-events", () => ({
  useSpendingEvents: () => ({ data: [] }),
  useSpendingEventMutations: () => ({ update: { mutate: vi.fn() } }),
}));
vi.mock("../event-dialog-provider", () => ({
  useEventDialog: () => ({ openEventDialog: vi.fn() }),
}));

async function language() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        common: enCommon,
        taxonomies: enCommonTaxonomies,
        spending: enSpending,
        settings: enSettings,
      },
      zh: {
        common: zhCommon,
        taxonomies: zhCommonTaxonomies,
        spending: zhSpending,
        settings: zhSettings,
      },
    },
  });
  return i18n;
}
const category = (
  id: string,
  name: string,
  parentId: string | null = null,
  taxonomyId = "spending_categories",
): TaxonomyCategory => ({
  id,
  name,
  parentId,
  taxonomyId,
  key: id,
  color: "#123456",
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
});
const spending = [
  category("cat_housing", "Housing"),
  category("cat_housing_rent", "Rent/Mortgage", "cat_housing"),
  category("cat_housing_furnishing", "Furnishing", "cat_housing"),
  category("cat_housing_insurance", "Home Insurance", "cat_housing"),
  category("cat_food", "My meals"),
  category("custom-housing", "Housing"),
];
const budgetRow = (
  id: string,
  name: string,
  actual: number,
  groupId: string | null = NEEDS,
): BudgetCategoryRow => ({
  taxonomyId: "spending_categories",
  categoryId: id,
  name,
  actual,
  groupId,
  parentId: null,
  color: "#abcdef",
  icon: null,
  target: 200,
  rolloverIn: 0,
  rolloverOut: 0,
  remaining: 200 - actual,
  overspent: false,
  hasDefaultTarget: true,
  hasMonthOverride: false,
  rolloverEnabled: false,
});
const group = (id: string, name: string, categories: BudgetCategoryRow[]): BudgetGroupRow => ({
  group: {
    id,
    name,
    key: id,
    color: "#ab1234",
    icon: null,
    sortOrder: 0,
    isSystem: true,
    createdAt: "",
    updatedAt: "",
  },
  categoryTargetTotal: 200,
  buffer: 0,
  plannedTotal: 200,
  actual: 100,
  rolloverIn: 0,
  rolloverOut: 0,
  remaining: 100,
  overspent: false,
  rolloverEnabled: false,
  categories,
});
const groups = [
  group(NEEDS, "Needs", [budgetRow("cat_housing", "Housing", 100)]),
  group(WANTS, "My priorities", [budgetRow("cat_food", "My meals", 100, WANTS)]),
];
const breakdown = (categoryId: string, amount: number, taxonomyId = "spending_categories") => ({
  categoryId,
  amount,
  taxonomyId,
  count: 1,
});

/** Strip only display strings, retaining node/member order, values, IDs and colors. */
function mechanics(graph: MoneyFlowGraph) {
  return JSON.parse(
    JSON.stringify(graph, (key: string, value: unknown) => (key === "name" ? undefined : value)),
  ) as unknown;
}

it("creates display-only report categories without translating custom or renamed records", async () => {
  const i18n = await language();
  const raw = structuredClone(spending);
  const display = localizeReportCategories(i18n.t, spending);
  expect(display.map((row) => row.name)).toEqual([
    zhCommonTaxonomies.categoryNames.spending_categories.cat_housing,
    zhCommonTaxonomies.categoryNames.spending_categories.cat_housing_rent,
    zhCommonTaxonomies.categoryNames.spending_categories.cat_housing_furnishing,
    zhCommonTaxonomies.categoryNames.spending_categories.cat_housing_insurance,
    "My meals",
    "Housing",
  ]);
  expect(spending).toEqual(raw);
  expect(display.map(({ name: _name, ...row }) => row)).toEqual(
    raw.map(({ name: _name, ...row }) => row),
  );
});

it("refreshes hierarchy groups and nested categories in place while drilldowns retain IDs", async () => {
  const i18n = await language();
  const onCategoryClick = vi.fn();
  const raw = structuredClone({ spending, groups });
  const view = render(
    <I18nextProvider i18n={i18n}>
      <CategoryHierarchyTable
        breakdown={[
          breakdown("cat_housing_rent", 100),
          breakdown("cat_food", 100),
          breakdown("custom-housing", 20),
        ]}
        priorBreakdown={[]}
        budgetRows={groups.flatMap((row) => row.categories)}
        groupRows={groups}
        taxonomyCategories={spending}
        currency="USD"
        isLoading={false}
        onCategoryClick={onCategoryClick}
      />
    </I18nextProvider>,
  );
  expect(screen.getByText(zhCommonSpending.budgetGroupNames[NEEDS])).toBeInTheDocument();
  expect(screen.getByText("My priorities")).toBeInTheDocument();
  expect(screen.getByText(zhSpending.hero.other)).toBeInTheDocument();
  fireEvent.click(screen.getByTitle(zhSpending.hierarchy.expandAllRows));
  expect(screen.getByText("My meals")).toBeInTheDocument();
  expect(screen.getByText("Housing")).toBeInTheDocument();
  fireEvent.click(
    screen.getByText(zhCommonTaxonomies.categoryNames.spending_categories.cat_housing_rent),
  );
  expect(onCategoryClick).toHaveBeenCalledWith("cat_housing_rent");
  const styles = [...view.container.querySelectorAll("[style]")].map((element) =>
    element.getAttribute("style"),
  );
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText("Needs")).toBeInTheDocument();
  expect(screen.getByText("Rent/Mortgage")).toBeInTheDocument();
  expect(
    [...view.container.querySelectorAll("[style]")].map((element) => element.getAttribute("style")),
  ).toEqual(styles);
  expect({ spending, groups }).toEqual(raw);
});

it("localizes all Sankey flows, folded members and refund zooms without changing ordering or math", async () => {
  const i18n = await language();
  const input: MoneyFlowInput = {
    groupRows: [
      group(NEEDS, "Needs", [
        budgetRow("cat_housing", "Housing", 100),
        budgetRow("cat_food", "My meals", 100),
        budgetRow("cat_transport", "Transportation", -20),
      ]),
      group(WANTS, "My priorities", [budgetRow("custom-housing", "Housing", 200, WANTS)]),
    ],
    spendingCategories: spending,
    spendingBuckets: [
      breakdown("cat_housing_rent", 140),
      breakdown("cat_housing_furnishing", -20),
      breakdown("cat_housing_insurance", -20),
    ].map((row) => ({ ...row, date: "2026-04-01" })),
    incomeCategories: [
      category("cat_income_salary", "Salary", null, "income_sources"),
      category("custom-income", "Salary", null, "income_sources"),
      category("cat_income_other", "Other Income", null, "income_sources"),
    ],
    incomeBreakdown: [
      breakdown("custom-income", 400, "income_sources"),
      breakdown("cat_income_salary", 400, "income_sources"),
      breakdown("cat_income_other", 800, "income_sources"),
    ],
    savingsCategories: [
      category("cat_savings_retirement", "Retirement", null, "savings_categories"),
    ],
    savingsBreakdown: [breakdown("cat_savings_retirement", 100, "savings_categories")],
    uncategorizedSpent: 0,
    labels: {
      total: "Total",
      fromSavings: "From savings",
      shortfall: "Shortfall",
      refunds: "Refunds",
      saved: "Saved",
      surplus: "Surplus",
      uncategorized: "Uncategorized",
      uncategorizedIncome: "Uncategorized income",
      more: (n) => `${n} more`,
      direct: "Direct",
      netSpending: "Net",
    },
  };
  const raw = structuredClone({ ...input, labels: undefined });
  const translated = {
    ...input,
    labels: {
      ...input.labels,
      category: (taxonomyId: string, id: string, name: string) =>
        getCategoryLabel(i18n.t, taxonomyId, id, name),
      group: (id: string, name: string) => getBudgetGroupLabel(i18n.t, id, name),
    },
  };
  const options = { maxSources: 1, maxCategoriesPerGroup: 1, minLeafShare: 0 };
  const graph = buildMoneyFlowGraph(translated, options);
  expect(mechanics(graph)).toEqual(mechanics(buildMoneyFlowGraph(input, options)));
  expect(graph.nodes.find((node) => node.id === `group:${NEEDS}`)?.name).toBe(
    zhCommonSpending.budgetGroupNames[NEEDS],
  );
  expect(graph.nodes.find((node) => node.id === `group:${WANTS}`)?.name).toBe("My priorities");
  expect(graph.nodes.find((node) => node.id === "category:custom-housing")?.name).toBe("Housing");
  expect(graph.nodes.find((node) => node.id === "income:more")?.members).toEqual([
    { name: "Salary", value: 400 },
    { name: zhCommonTaxonomies.categoryNames.income_sources.cat_income_salary, value: 400 },
  ]);
  expect(
    graph.nodes.find((node) => node.id === "savings-category:cat_savings_retirement")?.name,
  ).toBe(zhCommonTaxonomies.categoryNames.savings_categories.cat_savings_retirement);
  expect(graph.nodes.find((node) => node.id === "refunds")?.members?.[0].name).toBe(
    zhCommonTaxonomies.categoryNames.spending_categories.cat_transport,
  );
  const focused = focusMoneyFlowGraph(graph, "category:cat_housing", translated.labels);
  expect(mechanics(focused)).toEqual(
    mechanics(
      focusMoneyFlowGraph(
        buildMoneyFlowGraph(input, options),
        "category:cat_housing",
        input.labels,
      ),
    ),
  );
  expect(
    focused.nodes.find((node) => node.kind === "refunds")?.members?.map((member) => member.name),
  ).toEqual([
    zhCommonTaxonomies.categoryNames.spending_categories.cat_housing_furnishing,
    zhCommonTaxonomies.categoryNames.spending_categories.cat_housing_insurance,
  ]);
  expect({ ...input, labels: undefined }).toEqual(raw);
});

it("refreshes budget overview labels and preserves renamed groups, amounts and colors", async () => {
  const i18n = await language();
  state.budget = {
    computed: {
      groupRows: groups,
      currency: "USD",
      totals: { spendingPlanned: 400, incomePlanned: 800 },
    },
  };
  const raw = structuredClone(state.budget);
  const view = render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <BudgetOverviewCard />
      </I18nextProvider>
    </MemoryRouter>,
  );
  expect(screen.getByText(zhCommonSpending.budgetGroupNames[NEEDS])).toBeInTheDocument();
  expect(screen.getByText("My priorities")).toBeInTheDocument();
  const styles = [...view.container.querySelectorAll("[style]")].map((element) =>
    element.getAttribute("style"),
  );
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText("Needs")).toBeInTheDocument();
  expect(screen.getByText("My priorities")).toBeInTheDocument();
  expect(
    [...view.container.querySelectorAll("[style]")].map((element) => element.getAttribute("style")),
  ).toEqual(styles);
  expect(state.budget).toEqual(raw);
});

const event: EventSpendingSummary = {
  eventId: "event",
  eventName: "My trip",
  eventTypeId: "255600dc-c2a3-47e0-979d-a602c21fc337",
  eventTypeName: "Travel",
  eventTypeColor: "#123456",
  startDate: "2026-04-01",
  endDate: "2026-04-03",
  totalSpending: 100,
  transactionCount: 1,
  currency: "USD",
  byCategory: {
    cat_housing: {
      categoryId: "cat_housing",
      categoryName: "Housing",
      color: "#abcdef",
      amount: 100,
      transactionCount: 1,
    },
  },
  dailySpending: { "2026-04-01": 100 },
};

describe("event report labels", () => {
  it.each(["Travel", "My travel"])(
    "refreshes timeline and detail without renaming %s",
    async (name) => {
      const i18n = await language();
      const current = { ...event, eventTypeName: name };
      const raw = structuredClone(current);
      render(
        <MemoryRouter>
          <I18nextProvider i18n={i18n}>
            <EventsTimelineCard
              events={[current]}
              currency="USD"
              rangeStart={new Date(2026, 3, 1)}
              rangeEnd={new Date(2026, 3, 30)}
              heatmapActivities={[]}
              selectedId={current.eventId}
              onSelect={vi.fn()}
              windowOffset={0}
              onPrevWindow={vi.fn()}
              onNextWindow={vi.fn()}
            />
            <EventDetailPanel
              event={current}
              events={[current]}
              taxonomyCategories={[]}
              currency="USD"
              heatmapActivities={[]}
              onSelect={vi.fn()}
            />
          </I18nextProvider>
        </MemoryRouter>,
      );
      const translated = name === "Travel" ? "旅行" : name;
      expect(screen.getAllByText(new RegExp(translated, "i")).length).toBeGreaterThan(0);
      expect(
        screen.getAllByText(zhCommonTaxonomies.categoryNames.spending_categories.cat_housing)
          .length,
      ).toBeGreaterThan(0);
      await act(() => i18n.changeLanguage("en"));
      expect(screen.getAllByText(new RegExp(name, "i")).length).toBeGreaterThan(0);
      expect(screen.getAllByText("Housing").length).toBeGreaterThan(0);
      expect(current).toEqual(raw);
    },
  );
});
