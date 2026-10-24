import { act, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import { FormattingProvider } from "@wealthfolio/ui";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";

import type { BudgetCategoryRow, BudgetGroupRow, BudgetSnapshot } from "../../../types/budget";
import type { DayCategoryBucket } from "../../../types/insight";
import type { CategoryBreakdownRow, MonthlyReport } from "../../../types/report";
import { MoneyFlowSection } from "./money-flow-section";

const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => privacy,
}));

// jsdom has no layout: give the chart a fixed size so the Sankey draws nodes.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, {
            width: 900,
            height: 500,
          })
        : null,
  };
});

// jsdom has no canvas either: label measuring falls back to an average advance.
// Nor does it tell keyboard from mouse focus: `:focus-visible` follows `focusModality`.
let focusModality: "keyboard" | "mouse" = "keyboard";
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    if (selector === ":focus-visible") {
      return focusModality === "keyboard" && this === document.activeElement;
    }
    return matches.call(this, selector);
  });
});

afterEach(() => {
  privacy.isBalanceHidden = false;
  localStorage.removeItem("privacy-settings");
  focusModality = "keyboard";
});

const spend = (categoryId: string, name: string, actual: number): BudgetCategoryRow => ({
  taxonomyId: "spending_categories",
  categoryId,
  groupId: "needs",
  parentId: null,
  name,
  color: "#A35742",
  icon: null,
  target: 0,
  actual,
  rolloverIn: 0,
  rolloverOut: 0,
  remaining: 0,
  overspent: false,
  hasDefaultTarget: false,
  hasMonthOverride: false,
  rolloverEnabled: false,
});

const needs: BudgetGroupRow = {
  group: {
    id: "needs",
    name: "Needs",
    key: "needs",
    color: "#4F6B92",
    icon: null,
    sortOrder: 0,
    isSystem: true,
    createdAt: "",
    updatedAt: "",
  },
  categoryTargetTotal: 0,
  buffer: 0,
  plannedTotal: 0,
  actual: 1618,
  rolloverIn: 0,
  rolloverOut: 0,
  remaining: 0,
  overspent: false,
  rolloverEnabled: false,
  categories: [spend("cat_housing", "Housing", 1498), spend("cat_bills", "Bills", 120)],
};

// The section reads only the computed group rows of the budget snapshot.
const budget = { computed: { groupRows: [needs] } } as unknown as BudgetSnapshot;

const taxonomyCategory = (
  id: string,
  name: string,
  parentId: string | null = null,
  taxonomyId = "spending_categories",
): TaxonomyCategory => ({
  id,
  taxonomyId,
  parentId,
  name,
  key: id,
  color: "#5A7A3E",
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
});

const spendingCategories = [
  taxonomyCategory("cat_housing", "Housing"),
  taxonomyCategory("cat_rent", "Rent", "cat_housing"),
  taxonomyCategory("cat_maintenance", "Maintenance", "cat_housing"),
  taxonomyCategory("cat_returns", "Returns", "cat_housing"),
  taxonomyCategory("cat_bills", "Bills"),
];

const salaryOnly = [taxonomyCategory("cat_income_salary", "Salary", null, "income_sources")];
const employment = [
  taxonomyCategory("cat_income_employment", "Employment", null, "income_sources"),
  taxonomyCategory("cat_income_salary", "Salary", "cat_income_employment", "income_sources"),
  taxonomyCategory("cat_income_bonus", "Bonus", "cat_income_employment", "income_sources"),
];

const incomeRow = (categoryId: string, amount: number): CategoryBreakdownRow => ({
  taxonomyId: "income_sources",
  categoryId,
  amount,
  count: 1,
});

const bucket = (categoryId: string, amount: number): DayCategoryBucket => ({
  date: "2026-04-01",
  taxonomyId: "spending_categories",
  categoryId,
  amount,
  count: 1,
});

/** Housing's $1,498 by subcategory, with $198 assigned to Housing itself. */
const housingDetail = [
  bucket("cat_rent", 1000),
  bucket("cat_maintenance", 300),
  bucket("cat_housing", 198),
  bucket("cat_bills", 120),
];

/** The same $1,498 net, after a $200 refund that outweighs Returns' spending. */
const refundedHousing = [
  bucket("cat_rent", 1500),
  bucket("cat_maintenance", 198),
  bucket("cat_returns", -200),
  bucket("cat_bills", 120),
];

function report(
  income: number,
  buckets: DayCategoryBucket[],
  incomeBreakdown?: CategoryBreakdownRow[],
): MonthlyReport {
  const summary = { income, outflow: 1618, saved: 0, net: income - 1618, count: 3 };
  return {
    baseCurrency: "USD",
    current: summary,
    prior: summary,
    spendingBreakdown: [],
    incomeBreakdown: incomeBreakdown ?? (income ? [incomeRow("cat_income_salary", income)] : []),
    savingsBreakdown: [],
    byDay: [],
    byDayByCategory: buckets,
  };
}

interface FlowOptions {
  income?: number;
  onCategoryClick?: (id: string) => void;
  groups?: BudgetSnapshot;
  isMobile?: boolean;
  buckets?: DayCategoryBucket[];
  incomeBreakdown?: CategoryBreakdownRow[];
  incomeCategories?: TaxonomyCategory[];
}

function flow({
  income = 2500,
  onCategoryClick,
  groups = budget,
  isMobile = false,
  buckets = [],
  incomeBreakdown,
  incomeCategories = salaryOnly,
}: FlowOptions) {
  return (
    <FormattingProvider locale="en-US">
      <MoneyFlowSection
        periodLabel="April"
        currentReport={report(income, buckets, incomeBreakdown)}
        budget={groups}
        spendingCategories={spendingCategories}
        incomeCategories={incomeCategories}
        savingsCategories={[]}
        currency="USD"
        isLoading={false}
        isMobile={isMobile}
        onCategoryClick={onCategoryClick}
      />
    </FormattingProvider>
  );
}

function setup(options: FlowOptions = {}) {
  const onCategoryClick = options.onCategoryClick ?? vi.fn();
  const view = render(flow({ ...options, onCategoryClick }));
  return { onCategoryClick, ...view };
}

describe("MoneyFlowSection", () => {
  it("draws income into groups and categories, with the rest left over", () => {
    setup();

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Housing, $1,498. View transactions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Left over")).toBeInTheDocument();
    expect(screen.getByText("$882")).toBeInTheDocument();
  });

  it("opens a category's transactions", () => {
    const { onCategoryClick } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. View transactions" }));

    expect(onCategoryClick).toHaveBeenCalledWith("cat_housing");
  });

  it("zooms into a group, focuses the way back, and returns focus to the group on Escape", () => {
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Needs, $1,618. Show every category" }));

    expect(screen.getByRole("heading", { name: "Needs" })).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "All flows" });
    expect(back).toHaveFocus();
    expect(screen.queryByText("Salary")).not.toBeInTheDocument();

    fireEvent.keyDown(back, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    ).toHaveFocus();
  });

  it("leaves focus alone when the zoom is left with the mouse", () => {
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Needs, $1,618. Show every category" }));
    fireEvent.click(screen.getByRole("button", { name: "All flows" }), { detail: 1 });

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    ).not.toHaveFocus();
  });

  it("opens a category from the keyboard", () => {
    const { onCategoryClick } = setup();

    fireEvent.keyDown(screen.getByRole("button", { name: "Bills, $120. View transactions" }), {
      key: "Enter",
    });

    expect(onCategoryClick).toHaveBeenCalledWith("cat_bills");
  });

  it("is a single Tab stop navigated with the arrow keys", () => {
    const { container } = setup();

    const stops = container.querySelectorAll('[aria-label^="Money flow chart"] [tabindex="0"]');
    expect(stops).toHaveLength(1);
    const salary = screen.getByRole("img", { name: "Salary, $2,500" });
    expect(stops[0]).toBe(salary);

    salary.focus();
    fireEvent.keyDown(salary, { key: "ArrowRight" });
    const total = screen.getByRole("img", { name: "Total, $2,500" });
    expect(total).toHaveFocus();

    fireEvent.keyDown(total, { key: "ArrowRight" });
    const needs = screen.getByRole("button", { name: "Needs, $1,618. Show every category" });
    expect(needs).toHaveFocus();

    fireEvent.keyDown(needs, { key: "ArrowDown" });
    expect(screen.getByRole("img", { name: "Left over, $882" })).toHaveFocus();
    expect(
      container.querySelectorAll('[aria-label^="Money flow chart"] [tabindex="0"]'),
    ).toHaveLength(1);

    fireEvent.keyDown(screen.getByRole("img", { name: "Left over, $882" }), { key: "ArrowLeft" });
    expect(total).toHaveFocus();
  });

  it("brings back the focused node's tooltip after the mouse passes over another", () => {
    setup();

    const leftOver = screen.getByRole("img", { name: "Left over, $882" });
    act(() => leftOver.focus());
    const housing = screen.getByRole("button", { name: "Housing, $1,498. View transactions" });
    fireEvent.mouseEnter(housing);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Housing");

    fireEvent.mouseLeave(housing);

    expect(screen.getByRole("tooltip")).toHaveTextContent("Left over");
    expect(leftOver).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
  });

  it("does not pin the tooltip of a node focused by a mouse click", () => {
    setup();
    focusModality = "mouse";

    const leftOver = screen.getByRole("img", { name: "Left over, $882" });
    fireEvent.mouseEnter(leftOver);
    act(() => leftOver.focus());
    fireEvent.mouseLeave(leftOver);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("leaves modified arrows to the browser", () => {
    setup();

    const salary = screen.getByRole("img", { name: "Salary, $2,500" });
    act(() => salary.focus());
    const altRight = fireEvent.keyDown(salary, { key: "ArrowRight", altKey: true });

    expect(altRight).toBe(true);
    expect(salary).toHaveFocus();
    // A plain arrow with nowhere to go stays in the chart instead of scrolling the page.
    expect(fireEvent.keyDown(salary, { key: "ArrowUp" })).toBe(false);
  });

  it("describes the total as money out when nothing came in", () => {
    setup({ income: 0 });

    act(() => screen.getByRole("img", { name: "Total, $1,618" }).focus());

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Everything spent and set aside, before any refunds.",
    );
  });

  it("explains a synthetic node to keyboard users", () => {
    setup();

    const leftOver = screen.getByRole("img", { name: "Left over, $882" });
    act(() => leftOver.focus());

    const tooltip = screen.getByRole("tooltip");
    expect(leftOver).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("Came in but wasn't spent or set aside.");
  });

  it("draws net refunds and a shortfall as sources", () => {
    const refunded = {
      computed: {
        groupRows: [
          {
            ...needs,
            categories: [...needs.categories, spend("cat_deposit", "Deposit", -200)],
          },
        ],
      },
    } as unknown as BudgetSnapshot;
    setup({ income: 1000, groups: refunded });

    expect(screen.getByRole("img", { name: "Net refunds, $200" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Shortfall, $418" })).toBeInTheDocument();

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Before subtracting $200.00 in net refunds.",
    );
  });

  it("masks every amount in privacy mode", () => {
    privacy.isBalanceHidden = true;
    const { container } = setup();

    expect(
      screen.getByRole("button", { name: "Needs, ••••. Show every category" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  it("shows tooltips on keyboard focus at narrow widths too", () => {
    setup({ isMobile: true });

    const total = screen.getByRole("img", { name: "Total, $2,500" });
    act(() => total.focus());

    const tooltip = screen.getByRole("tooltip");
    expect(total).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("Money in, plus net refunds and any shortfall.");
  });

  it("stops at groups on mobile and shows a tooltip on tap", () => {
    setup({ isMobile: true });

    expect(
      screen.queryByRole("button", { name: "Housing, $1,498. View transactions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("img", { name: "Total, $2,500" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Money in, plus net refunds and any shortfall.",
    );
  });

  it("notes when no income was recorded", () => {
    setup({ income: 0 });

    expect(screen.getByText("No income in selected accounts for this period.")).toBeInTheDocument();
    expect(screen.queryByText("Shortfall")).not.toBeInTheDocument();
  });

  it("renders nothing when no money moved", () => {
    const empty = { computed: { groupRows: [] } } as unknown as BudgetSnapshot;
    setup({ income: 0, groups: empty });

    expect(screen.queryByRole("heading", { name: "Money flow" })).not.toBeInTheDocument();
  });
});

describe("MoneyFlowSection subcategories", () => {
  it("marks a category that zooms in apart from one that opens its transactions", () => {
    setup({ buckets: housingDetail });

    const housing = screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" });
    expect(housing).toHaveTextContent("›");
    const bills = screen.getByRole("button", { name: "Bills, $120. View transactions" });
    expect(bills).not.toHaveTextContent("›");
    expect(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    ).toHaveTextContent("›");

    act(() => housing.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Click to see subcategories");
  });

  it("zooms into a category's subcategories, each opening its own transactions", () => {
    const { onCategoryClick } = setup({ buckets: housingDetail });

    fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }));

    expect(onCategoryClick).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Housing" })).toBeInTheDocument();
    expect(screen.getByText("Every subcategory for April.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All flows" })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Maintenance, $300. View transactions" }),
    ).toBeVisible();
    // Spending assigned to Housing itself stays its own leaf, with nothing to open.
    expect(screen.getByRole("img", { name: "Direct, $198" })).toBeInTheDocument();
    expect(screen.queryByText("Salary")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rent, $1,000. View transactions" }));
    expect(onCategoryClick).toHaveBeenLastCalledWith("cat_rent");

    fireEvent.click(screen.getByRole("button", { name: "View transactions" }));
    expect(onCategoryClick).toHaveBeenLastCalledWith("cat_housing");
  });

  it("zooms into a category from the keyboard and returns to it on Escape", () => {
    setup({ buckets: housingDetail });

    const housing = screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" });
    act(() => housing.focus());
    fireEvent.keyDown(housing, { key: "Enter" });

    const back = screen.getByRole("button", { name: "All flows" });
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }),
    ).toHaveFocus();
  });

  it("reaches subcategories through a group on mobile, then steps back one level at a time", () => {
    setup({ buckets: housingDetail, isMobile: true });

    expect(screen.queryByRole("button", { name: /^Housing/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Needs, $1,618. Show every category" }));
    fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }));

    expect(screen.getByRole("heading", { name: "Housing" })).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Back to Needs" });
    expect(back).toHaveFocus();
    expect(screen.getByRole("button", { name: "All flows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rent, $1,000. View transactions" })).toBeVisible();

    fireEvent.keyDown(back, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "Needs" })).toBeInTheDocument();
    const housing = screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" });
    expect(housing).toHaveFocus();

    fireEvent.keyDown(housing, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    ).toHaveFocus();
  });

  it("returns straight to the overview with All flows", () => {
    setup({ buckets: housingDetail, isMobile: true });
    fireEvent.click(screen.getByRole("button", { name: "Needs, $1,618. Show every category" }));
    fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }));

    // Enter on the button: the keyboard lands on the node that opened the first zoom.
    fireEvent.click(screen.getByRole("button", { name: "All flows" }), { detail: 0 });

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs, $1,618. Show every category" }),
    ).toHaveFocus();
  });

  it("steps back to the group with the mouse without moving focus to the category", () => {
    setup({ buckets: housingDetail });
    fireEvent.click(screen.getByRole("button", { name: "Needs, $1,618. Show every category" }));
    fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }));

    fireEvent.click(screen.getByRole("button", { name: "Back to Needs" }), { detail: 1 });

    expect(screen.getByRole("heading", { name: "Needs" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }),
    ).not.toHaveFocus();
  });

  it("falls back to the overview when a refresh leaves the zoomed category without subcategories", () => {
    const { rerender } = setup({ buckets: housingDetail });
    fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }));
    expect(screen.getByRole("heading", { name: "Housing" })).toBeInTheDocument();

    // Everything recategorized onto Housing itself while the zoom was open.
    rerender(flow({ buckets: [bucket("cat_housing", 1498), bucket("cat_bills", 120)] }));

    expect(screen.getByRole("heading", { name: "Money flow" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Housing, $1,498. View transactions" }),
    ).toBeInTheDocument();
  });

  it("reaches an income category folded into +N more, then its subcategories", () => {
    setup({
      income: 6050,
      incomeBreakdown: [
        incomeRow("cat_income_salary", 6000),
        incomeRow("cat_income_dividends", 30),
        incomeRow("cat_income_gifts", 20),
      ],
      incomeCategories: [
        ...employment,
        taxonomyCategory("cat_income_investment", "Investment", null, "income_sources"),
        taxonomyCategory(
          "cat_income_dividends",
          "Dividends",
          "cat_income_investment",
          "income_sources",
        ),
        taxonomyCategory("cat_income_other", "Other", null, "income_sources"),
        taxonomyCategory("cat_income_gifts", "Gifts", "cat_income_other", "income_sources"),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "+2 more, $50. Show every category" }));

    expect(screen.getByRole("heading", { name: "Total" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Investment, $30. Show subcategories" }));

    expect(screen.getByRole("heading", { name: "Investment" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Dividends, $30" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Total" })).toHaveFocus();
  });

  it("rolls income up to its category and zooms into where it came from", () => {
    setup({
      incomeBreakdown: [incomeRow("cat_income_salary", 2000), incomeRow("cat_income_bonus", 500)],
      incomeCategories: employment,
    });

    expect(screen.queryByText("Salary")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Left over, $882" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Employment, $2,500. Show subcategories" }));

    expect(screen.getByRole("heading", { name: "Employment" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Salary, $2,000" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Bonus, $500" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Employment, $2,500" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View transactions" })).not.toBeInTheDocument();
  });

  it("explains gross and net spending when a subcategory was mostly refunded", () => {
    setup({ buckets: refundedHousing });

    fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. Show subcategories" }));

    expect(screen.getByRole("img", { name: "Net spending, $1,498" })).toBeInTheDocument();
    const refunds = screen.getByRole("img", { name: "Net refunds, $200" });
    fireEvent.mouseEnter(refunds);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Returns");

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "Housing, $1,698. View transactions" }),
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Before subtracting $200.00 in net refunds. Net spending: $1,498.00.",
    );
  });

  it("masks every amount of a zoomed category in privacy mode", () => {
    privacy.isBalanceHidden = true;
    // `PrivacyAmount` reads the stored setting the app's privacy hook is built on.
    localStorage.setItem("privacy-settings", "true");
    const { container } = setup({ buckets: refundedHousing });

    fireEvent.click(screen.getByRole("button", { name: "Housing, ••••. Show subcategories" }));

    expect(screen.getByRole("img", { name: "Net spending, ••••" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rent, ••••. View transactions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View transactions" })).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Housing, ••••. View transactions" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Before subtracting •••• in net refunds. Net spending: ••••.",
    );
    fireEvent.mouseEnter(screen.getByRole("img", { name: "Net refunds, ••••" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Returns");
    expect(container.textContent).not.toMatch(/\$\d/);
  });
});

it("refreshes raw category and budget-group names inside an already-open Sankey", async () => {
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
  const seededGroup = {
    ...needs,
    group: { ...needs.group, id: "032ecb02-5912-42e8-9724-2cd566fc08d5" },
  };
  const snapshot = { computed: { groupRows: [seededGroup] } } as unknown as BudgetSnapshot;
  const original = structuredClone(snapshot);
  const onCategoryClick = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>{flow({ groups: snapshot, onCategoryClick })}</I18nextProvider>,
  );
  expect(
    screen.getByText(zhCommon.categoryNames.income_sources.cat_income_salary),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(
        `^${zhCommon.budgetGroupNames[seededGroup.group.id as keyof typeof zhCommon.budgetGroupNames]}`,
      ),
    }),
  );
  expect(
    screen.getByRole("heading", {
      name: zhCommon.budgetGroupNames[
        seededGroup.group.id as keyof typeof zhCommon.budgetGroupNames
      ],
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(zhCommon.categoryNames.spending_categories.cat_housing),
  ).toBeInTheDocument();
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("heading", { name: "Needs" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Housing, $1,498. View transactions" }));
  expect(onCategoryClick).toHaveBeenCalledWith("cat_housing");
  expect(snapshot).toEqual(original);
});
