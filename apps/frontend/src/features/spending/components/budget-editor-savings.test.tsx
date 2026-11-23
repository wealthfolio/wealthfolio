import { render, screen, waitFor, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import enSpending from "@/i18n/locales/en/spending.json";
import type { BudgetGroup, BudgetRolloverSetting, BudgetSnapshot } from "../types/budget";
import { BudgetEditor } from "./budget-editor";

vi.mock("../adapters/budget", () => ({
  getBudget: vi.fn(),
  assignCategoryToGroup: vi.fn(),
  copyBudgetTargets: vi.fn(),
  createBudgetGroup: vi.fn(),
  deleteBudgetGroup: vi.fn(),
  deleteBudgetRolloverSetting: vi.fn(),
  deleteBudgetTarget: vi.fn(),
  resetBudgetGroups: vi.fn(),
  updateBudgetGroup: vi.fn(),
  upsertBudgetRolloverSetting: vi.fn(),
  upsertBudgetTarget: vi.fn(),
}));
import { assignCategoryToGroup, getBudget, upsertBudgetRolloverSetting } from "../adapters/budget";

const SAVINGS_ID = "1fb6f2a3-3245-4702-83e8-ab116458d13e";
const NEEDS_ID = "032ecb02-5912-42e8-9724-2cd566fc08d5";
const t = enSpending.budgetEditor;

function budgetSnapshot(
  rolloverSettings: BudgetRolloverSetting[],
  saving: { target: number; actual: number } = { target: 0, actual: 0 },
): BudgetSnapshot {
  const needs: BudgetGroup = {
    id: NEEDS_ID,
    name: "Needs",
    key: "needs",
    color: "#4F6B92",
    icon: null,
    sortOrder: 1,
    isSystem: true,
    createdAt: "",
    updatedAt: "",
  };
  const group: BudgetGroup = {
    id: SAVINGS_ID,
    name: "Savings",
    key: "savings",
    color: "#123456",
    icon: null,
    sortOrder: 3,
    isSystem: true,
    createdAt: "",
    updatedAt: "",
  };
  return {
    state: { groups: [needs, group], groupAssignments: [], targets: [], rolloverSettings },
    computed: {
      currency: "USD",
      periodKey: "default",
      fxAsOf: null,
      groupRows: [
        {
          group,
          categoryTargetTotal: 0,
          buffer: 0,
          plannedTotal: 0,
          actual: 0,
          rolloverIn: 0,
          rolloverOut: 0,
          remaining: 0,
          overspent: false,
          rolloverEnabled: false,
          savingsTargetTotal: saving.target,
          savingsActual: saving.actual,
          categories: [
            {
              taxonomyId: "savings_categories",
              categoryId: "cat_savings",
              groupId: SAVINGS_ID,
              parentId: null,
              name: "Savings",
              color: "#123456",
              icon: null,
              target: saving.target,
              actual: saving.actual,
              rolloverIn: 0,
              rolloverOut: 0,
              remaining: saving.target - saving.actual,
              overspent: false,
              hasDefaultTarget: false,
              hasMonthOverride: false,
              rolloverEnabled: false,
            },
          ],
        },
      ],
      ungroupedRows: [],
      incomeRows: [],
      totals: {
        spendingPlanned: 0,
        spendingActual: 0,
        spendingRemaining: 0,
        savingsPlanned: saving.target,
        savingsActual: saving.actual,
        incomePlanned: 0,
        incomeActual: 0,
        groupBuffer: 0,
        rolloverIn: 0,
        rolloverOut: 0,
        overspentCount: 0,
      },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

it.each([true, false])(
  "reads and toggles a savings row's rollover (saved %s) in the savings taxonomy",
  async (enabled) => {
    const budget = budgetSnapshot([
      {
        id: "rollover-savings",
        targetType: "category",
        taxonomyId: "savings_categories",
        categoryId: "cat_savings",
        groupId: null,
        enabled,
        startMonth: "2026-06",
        startingBalance: "25",
        createdAt: "",
        updatedAt: "",
      },
    ]);
    vi.mocked(getBudget).mockResolvedValue(budget);
    vi.mocked(upsertBudgetRolloverSetting).mockResolvedValue(budget);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <BudgetEditor mode="setup" periodKey="default" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    const section = (await screen.findByRole("button", { name: t.expandGroup })).closest(
      "section",
    )!;
    await user.click(within(section).getByRole("button", { name: t.expandGroup }));
    await user.click(within(section).getByRole("button", { name: t.rowOptions }));
    const item = await screen.findByRole("menuitem", { name: new RegExp(t.rollover) });
    expect(item).toHaveTextContent(enabled ? t.on : t.off);

    await user.click(item);
    await waitFor(() =>
      expect(upsertBudgetRolloverSetting).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: "category",
          taxonomyId: "savings_categories",
          categoryId: "cat_savings",
          enabled: !enabled,
          startingBalance: "25",
        }),
        "default",
      ),
    );
  },
);

function renderEditor(budget: BudgetSnapshot, periodKey = "default") {
  vi.mocked(getBudget).mockResolvedValue(budget);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BudgetEditor mode={periodKey === "default" ? "setup" : "monthly"} periodKey={periodKey} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function openSavingsGroup() {
  const user = userEvent.setup();
  const sections = await screen.findAllByRole("button", { name: t.expandGroup });
  const section = sections
    .map((button) => button.closest("section")!)
    .find((candidate) => within(candidate).queryByText("Savings"))!;
  await user.click(within(section).getByRole("button", { name: t.expandGroup }));
  return { user, section };
}

it("draws a savings row past its goal as ahead, not over budget", async () => {
  const { container } = renderEditor(budgetSnapshot([], { target: 400, actual: 450 }));
  await openSavingsGroup();

  expect(container.querySelector('[style*="--destructive"]')).toBeNull();
});

it("moves a savings category by its taxonomy and id", async () => {
  const budget = budgetSnapshot([]);
  vi.mocked(assignCategoryToGroup).mockResolvedValue(budget);
  renderEditor(budget);
  const { user, section } = await openSavingsGroup();
  await user.click(within(section).getByRole("button", { name: t.rowOptions }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Needs" }));

  await waitFor(() =>
    expect(assignCategoryToGroup).toHaveBeenCalledWith(
      "savings_categories",
      "cat_savings",
      NEEDS_ID,
      "default",
    ),
  );
});

it("shows a savings group's goal as saved and counts it in the plan", async () => {
  renderEditor(budgetSnapshot([], { target: 400, actual: 350 }));
  const { section } = await openSavingsGroup();

  expect(within(section).getByText(t.saved).parentElement).toHaveTextContent(
    `${t.saved}$350.00 / $400.00`,
  );
  // The plan sets aside the savings goal, so the summary counts it.
  expect(screen.getByText(t.defaultMonthlyPlan).parentElement).toHaveTextContent("$400.00");
});

it("keeps a savings row's own rollover while its group rolls over", async () => {
  renderEditor(
    budgetSnapshot([
      {
        id: "rollover-group",
        targetType: "group",
        taxonomyId: null,
        categoryId: null,
        groupId: SAVINGS_ID,
        enabled: true,
        startMonth: "2026-06",
        startingBalance: "0",
        createdAt: "",
        updatedAt: "",
      },
    ]),
  );
  const { user, section } = await openSavingsGroup();
  await user.click(within(section).getByRole("button", { name: t.rowOptions }));
  const item = await screen.findByRole("menuitem", { name: new RegExp(t.rollover) });

  expect(item).not.toHaveAttribute("aria-disabled", "true");
  expect(item).toHaveTextContent(t.off);
});

it("measures a rolled-over row against what's available, for an expense and a goal", async () => {
  // November, rollover on since October with nothing spent or saved then:
  // groceries 150 of 100 + 100 carried, savings 450 of 400 + 400 carried.
  const budget = budgetSnapshot([], { target: 400, actual: 450 });
  const savingsRow = budget.computed.groupRows[0].categories[0];
  Object.assign(savingsRow, { rolloverEnabled: true, rolloverIn: 400, remaining: 350 });
  budget.computed.groupRows.unshift({
    ...budget.computed.groupRows[0],
    group: budget.state.groups[0],
    plannedTotal: 100,
    actual: 150,
    savingsTargetTotal: 0,
    savingsActual: 0,
    categories: [
      {
        ...savingsRow,
        taxonomyId: "spending_categories",
        categoryId: "cat_groceries",
        groupId: NEEDS_ID,
        name: "Groceries",
        target: 100,
        actual: 150,
        rolloverIn: 100,
        remaining: 50,
      },
    ],
  });
  const { container } = renderEditor(budget, "2026-11");
  const user = userEvent.setup();
  for (const button of await screen.findAllByRole("button", { name: t.expandGroup })) {
    await user.click(button);
  }

  const groceries = screen.getByText("Groceries").parentElement!;
  expect(groceries).toHaveTextContent(`$100.00 ${t.carriedIn}·$50.00 ${t.left}`);
  const savings = screen.getAllByText("Savings").at(-1)!.parentElement!;
  expect(savings).toHaveTextContent(`$400.00 ${t.carriedIn}·$350.00 ${t.toGo}`);
  // 150 of the 200 available is within budget, so nothing is drawn as over.
  expect(container.querySelector('[style*="--destructive"]')).toBeNull();
});
