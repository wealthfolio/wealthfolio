import { act, render, screen, waitFor, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormattingProvider } from "@wealthfolio/ui";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import type { BudgetGroup, BudgetSnapshot } from "../types/budget";
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
import {
  assignCategoryToGroup,
  getBudget,
  updateBudgetGroup,
  upsertBudgetRolloverSetting,
} from "../adapters/budget";

const NEEDS_ID = "032ecb02-5912-42e8-9724-2cd566fc08d5";
const WANTS_ID = "a409e0d6-9152-49c8-a5b4-a147a8ac636e";

function budgetSnapshot(
  names = { category: "Housing", source: "Needs", target: "Wants" },
): BudgetSnapshot {
  const groups: BudgetGroup[] = [
    { id: NEEDS_ID, name: names.source, key: "needs" },
    { id: WANTS_ID, name: names.target, key: "wants" },
  ].map((group, index) => ({
    ...group,
    color: "#123456",
    icon: null,
    sortOrder: index,
    isSystem: true,
    createdAt: "",
    updatedAt: "",
  }));
  return {
    state: { groups, groupAssignments: [], targets: [], rolloverSettings: [] },
    computed: {
      currency: "USD",
      periodKey: "default",
      fxAsOf: null,
      groupRows: groups.map((group, index) => ({
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
        categories:
          index === 0
            ? [
                {
                  taxonomyId: "spending_categories",
                  categoryId: "cat_housing",
                  groupId: NEEDS_ID,
                  parentId: null,
                  name: names.category,
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
              ]
            : [],
      })),
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

async function setup(budget: BudgetSnapshot, locale = "US", direction: "ltr" | "rtl" = "ltr") {
  vi.mocked(getBudget).mockResolvedValue(budget);
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const editor = (region: string) => (
    <DirectionProvider direction={direction}>
      <FormattingProvider locale={region}>
        <MemoryRouter>
          <I18nextProvider i18n={i18n}>
            <QueryClientProvider client={queryClient}>
              <BudgetEditor mode="setup" periodKey="default" />
            </QueryClientProvider>
          </I18nextProvider>
        </MemoryRouter>
      </FormattingProvider>
    </DirectionProvider>
  );
  const view = render(editor(locale));
  await screen.findAllByRole("button", { name: zhSpending.budgetEditor.expandGroup });
  return {
    i18n,
    user: userEvent.setup(),
    setRegion: (region: string) => view.rerender(editor(region)),
  };
}

beforeEach(() => vi.clearAllMocks());

it.each([
  {
    kind: "built-in",
    names: { category: "Housing", source: "Needs", target: "Wants" },
    initialNames: { category: "住房", source: "必要支出", target: "非必要支出" },
  },
  {
    kind: "renamed",
    names: { category: "Home base", source: "Essentials", target: "Fun money" },
    initialNames: { category: "Home base", source: "Essentials", target: "Fun money" },
  },
])(
  "refreshes a pending move's $kind names without refetching or changing mutation inputs",
  async ({ names, initialNames }) => {
    const budget = budgetSnapshot(names);
    const original = structuredClone(budget);
    const { i18n, user } = await setup(budget);
    await user.click(
      screen.getAllByRole("button", { name: zhSpending.budgetEditor.expandGroup })[1],
    );
    await user.click(screen.getByRole("button", { name: zhSpending.budgetEditor.addCategory }));
    await user.click(
      await screen.findByRole("button", {
        name: `${initialNames.category} ${i18n.t("spending:budgetEditor.fromGroup", { name: initialNames.source })}`,
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent(
      i18n.t("spending:budgetEditor.moveCategoryTitle", {
        name: initialNames.category,
        group: initialNames.target,
      }),
    );

    await act(() => i18n.changeLanguage("en"));
    expect(within(dialog).getByRole("heading")).toHaveTextContent(
      `Move ${names.category} to ${names.target}?`,
    );
    expect(dialog).toHaveTextContent(`${names.category} is currently in ${names.source}.`);
    expect(getBudget).toHaveBeenCalledTimes(1);
    expect(assignCategoryToGroup).not.toHaveBeenCalled();
    expect(updateBudgetGroup).not.toHaveBeenCalled();
    expect(budget).toEqual(original);

    await user.click(
      within(dialog).getByRole("button", { name: enSpending.budgetEditor.moveCategory }),
    );
    await waitFor(() =>
      expect(assignCategoryToGroup).toHaveBeenCalledWith("cat_housing", WANTS_ID, "default"),
    );
    expect(budget).toEqual(original);
  },
);

it("keeps a group's raw editable name across language changes", async () => {
  const { i18n, user } = await setup(budgetSnapshot());
  await user.click(screen.getByRole("button", { name: "编辑 必要支出" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("textbox", { name: zhCommon.name })).toHaveValue("Needs");
  await act(() => i18n.changeLanguage("en"));
  const input = within(dialog).getByRole("textbox", { name: enCommon.name });
  expect(input).toHaveValue("Needs");
  await user.clear(input);
  await user.type(input, "My essentials");
  await user.click(within(dialog).getByRole("button", { name: enCommon.save }));
  await waitFor(() =>
    expect(updateBudgetGroup).toHaveBeenCalledWith(NEEDS_ID, { name: "My essentials" }, "default"),
  );
});

it.each([
  { direction: "ltr" as const, nextRegion: "ES" },
  { direction: "rtl" as const, nextRegion: "ES" },
  { direction: "ltr" as const, nextRegion: "US" },
  { direction: "rtl" as const, nextRegion: "US" },
])(
  "saves a negative Spain rollover draft in $direction after selecting $nextRegion",
  async ({ direction, nextRegion }) => {
    const budget = budgetSnapshot();
    budget.computed.groupRows[0].rolloverEnabled = true;
    budget.state.rolloverSettings = [
      {
        id: "rollover-needs",
        targetType: "group",
        groupId: NEEDS_ID,
        taxonomyId: null,
        categoryId: null,
        enabled: true,
        startMonth: "2025-03",
        startingBalance: "-123.5",
        createdAt: "",
        updatedAt: "",
      },
    ];
    vi.mocked(upsertBudgetRolloverSetting).mockResolvedValue(budget);
    const { i18n, user, setRegion } = await setup(budget, "ES", direction);
    await user.click(screen.getByRole("button", { name: "编辑 必要支出" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(i18n.t("spending:budgetEditor.startingBalance"));
    expect(input).toHaveValue("-123,5");
    await user.click(input);
    await user.keyboard("{End}{Backspace}6");
    setRegion(nextRegion);
    expect(input).toHaveValue(nextRegion === "US" ? "-123.6" : "-123,6");
    await user.click(within(dialog).getByRole("button", { name: zhCommon.save }));
    await waitFor(() =>
      expect(upsertBudgetRolloverSetting).toHaveBeenCalledWith(
        expect.objectContaining({ startingBalance: "-123.6", enabled: true }),
        "default",
      ),
    );
  },
);

it.each(["ltr", "rtl"] as const)(
  "does not save any group edits with an invalid starting balance in %s",
  async (direction) => {
    const budget = budgetSnapshot();
    budget.state.rolloverSettings = [
      {
        id: "rollover-needs",
        targetType: "group",
        groupId: NEEDS_ID,
        taxonomyId: null,
        categoryId: null,
        enabled: true,
        startMonth: "2025-03",
        startingBalance: "-123.5",
        createdAt: "",
        updatedAt: "",
      },
    ];
    vi.mocked(upsertBudgetRolloverSetting).mockResolvedValue(budget);
    vi.mocked(updateBudgetGroup).mockResolvedValue(budget);
    const { i18n, user } = await setup(budget, "ES", direction);
    await user.click(screen.getByRole("button", { name: "编辑 必要支出" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: zhCommon.name });
    await user.clear(name);
    await user.type(name, "New name");
    const colors = within(dialog).getAllByRole("button", { name: /#/ });
    await user.click(colors[0]);
    const balance = within(dialog).getByLabelText(i18n.t("spending:budgetEditor.startingBalance"));
    for (const invalid of ["12abc", "12,3,4"]) {
      await user.clear(balance);
      if (invalid) await user.type(balance, invalid);
      await user.click(within(dialog).getByRole("button", { name: zhCommon.save }));
      expect(updateBudgetGroup).not.toHaveBeenCalled();
      expect(upsertBudgetRolloverSetting).not.toHaveBeenCalled();
      expect(dialog).toBeInTheDocument();
    }
    // The retained draft remains correctable; explicit zero must still save.
    await user.clear(balance);
    await user.type(balance, "0");
    await user.click(within(dialog).getByRole("button", { name: zhCommon.save }));
    await waitFor(() =>
      expect(updateBudgetGroup).toHaveBeenCalledWith(
        NEEDS_ID,
        expect.objectContaining({ name: "New name" }),
        "default",
      ),
    );
    await waitFor(() =>
      expect(upsertBudgetRolloverSetting).toHaveBeenCalledWith(
        expect.objectContaining({ startingBalance: "0", enabled: true }),
        "default",
      ),
    );
  },
);

it("can disable rollover after entering an invalid starting balance", async () => {
  const budget = budgetSnapshot();
  budget.state.rolloverSettings = [
    {
      id: "rollover-needs",
      targetType: "group",
      groupId: NEEDS_ID,
      taxonomyId: null,
      categoryId: null,
      enabled: true,
      startMonth: "2025-03",
      startingBalance: "-123.5",
      createdAt: "",
      updatedAt: "",
    },
  ];
  vi.mocked(upsertBudgetRolloverSetting).mockResolvedValue(budget);
  const { i18n, user } = await setup(budget, "ES");
  await user.click(screen.getByRole("button", { name: "编辑 必要支出" }));
  const dialog = await screen.findByRole("dialog");
  const balance = within(dialog).getByLabelText(i18n.t("spending:budgetEditor.startingBalance"));
  await user.clear(balance);
  await user.type(balance, "12abc");
  await user.click(
    within(dialog).getByRole("switch", { name: i18n.t("spending:budgetEditor.enableRollover") }),
  );
  await user.click(within(dialog).getByRole("button", { name: zhCommon.save }));
  await waitFor(() =>
    expect(upsertBudgetRolloverSetting).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, startingBalance: "-123.5" }),
      "default",
    ),
  );
  expect(updateBudgetGroup).not.toHaveBeenCalled();
});

it.each([
  { locale: "US", direction: "ltr" as const, blank: "", nextRegion: "US" },
  { locale: "US", direction: "rtl" as const, blank: " ", nextRegion: "US" },
  { locale: "ES", direction: "ltr" as const, blank: "", nextRegion: "ES" },
  { locale: "ES", direction: "rtl" as const, blank: " ", nextRegion: "ES" },
  { locale: "ES", direction: "rtl" as const, blank: "", nextRegion: "US" },
  { locale: "US", direction: "ltr" as const, blank: " ", nextRegion: "ES" },
])(
  "saves an empty starting balance as zero with pending group edits in $locale $direction → $nextRegion",
  async ({ locale, direction, blank, nextRegion }) => {
    const budget = budgetSnapshot();
    budget.state.rolloverSettings = [
      {
        id: "rollover-needs",
        targetType: "group",
        groupId: NEEDS_ID,
        taxonomyId: null,
        categoryId: null,
        enabled: true,
        startMonth: "2025-03",
        startingBalance: "-123.5",
        createdAt: "",
        updatedAt: "",
      },
    ];
    vi.mocked(upsertBudgetRolloverSetting).mockResolvedValue(budget);
    vi.mocked(updateBudgetGroup).mockResolvedValue(budget);
    const { i18n, user, setRegion } = await setup(budget, locale, direction);
    await user.click(screen.getByRole("button", { name: "编辑 必要支出" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: zhCommon.name });
    await user.clear(name);
    await user.type(name, "New name");
    await user.click(within(dialog).getAllByRole("button", { name: /#/ })[0]);
    const balance = within(dialog).getByLabelText(i18n.t("spending:budgetEditor.startingBalance"));
    expect(balance).toHaveAttribute("placeholder", "0");
    await user.clear(balance);
    if (blank) await user.type(balance, blank);
    setRegion(nextRegion);
    expect(balance).toHaveValue(blank);
    await user.click(within(dialog).getByRole("button", { name: zhCommon.save }));
    await waitFor(() =>
      expect(updateBudgetGroup).toHaveBeenCalledWith(
        NEEDS_ID,
        expect.objectContaining({ name: "New name", color: "#fecaca" }),
        "default",
      ),
    );
    await waitFor(() =>
      expect(upsertBudgetRolloverSetting).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, startingBalance: "0" }),
        "default",
      ),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  },
);
