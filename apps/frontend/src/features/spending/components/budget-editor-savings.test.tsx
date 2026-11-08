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
import { getBudget, upsertBudgetRolloverSetting } from "../adapters/budget";

const SAVINGS_ID = "1fb6f2a3-3245-4702-83e8-ab116458d13e";
const t = enSpending.budgetEditor;

function budgetSnapshot(rolloverSettings: BudgetRolloverSetting[]): BudgetSnapshot {
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
    state: { groups: [group], groupAssignments: [], targets: [], rolloverSettings },
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
          categories: [
            {
              taxonomyId: "savings_categories",
              categoryId: "cat_savings",
              groupId: SAVINGS_ID,
              parentId: null,
              name: "Savings",
              color: "#123456",
              icon: null,
              target: 0,
              actual: 0,
              rolloverIn: 0,
              rolloverOut: 0,
              remaining: 0,
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
