import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RuleForm, buildRuleFormSchema, ruleAmountPayload, type RuleFormValues } from "./rule-form";

vi.mock("@/hooks/use-taxonomies", () => {
  const categories = {
    spending_categories: [{ id: "cat_food", name: "Food", parentId: null, sortOrder: 0 }],
    income_sources: [{ id: "cat_salary", name: "Salary", parentId: null, sortOrder: 0 }],
    savings_categories: [
      {
        id: "cat_savings_investments",
        name: "Investment Contributions",
        parentId: null,
        sortOrder: 0,
      },
    ],
  };
  return {
    useTaxonomy: (id: keyof typeof categories) => ({ data: { categories: categories[id] } }),
  };
});

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

const t = (key: string) => key;
const schema = buildRuleFormSchema(t);

const baseValues: RuleFormValues = {
  name: "Coffee",
  pattern: "STARBUCKS",
  matchType: "contains",
  taxonomyId: "",
  categoryId: "spending_categories:cat_food",
  activityType: "",
  amountOp: "",
  amountValue: "",
  amountValue2: "",
  priority: 0,
  accountId: null,
};

const errorPaths = (values: RuleFormValues): string[][] => {
  const result = schema.safeParse(values);
  return result.success ? [] : result.error.issues.map((i) => i.path.map(String));
};

it("offers Savings categories when editing a categorization rule", async () => {
  const user = userEvent.setup();
  render(
    <RuleForm
      categoryOptions={[
        {
          value: "savings_categories:cat_savings_investments",
          label: "Investment Contributions",
          taxonomyId: "savings_categories",
          categoryId: "cat_savings_investments",
        },
      ]}
      accountOptions={[]}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("button", { name: "Select category" }));
  await user.type(screen.getByPlaceholderText("Search categories..."), "Investment Contributions");
  expect(screen.getByText("Investment Contributions")).toBeInTheDocument();
});

describe("rule form amount validation", () => {
  it("accepts 'Any amount' with blank value fields", () => {
    expect(schema.safeParse(baseValues).success).toBe(true);
  });

  it.each(["eq", "gt", "gte", "lt", "lte"] as const)("accepts %s with a single value", (op) => {
    expect(schema.safeParse({ ...baseValues, amountOp: op, amountValue: "10.50" }).success).toBe(
      true,
    );
  });

  it("accepts between with from < to and from == to", () => {
    expect(
      schema.safeParse({
        ...baseValues,
        amountOp: "between",
        amountValue: "45",
        amountValue2: "55",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...baseValues,
        amountOp: "between",
        amountValue: "45",
        amountValue2: "45",
      }).success,
    ).toBe(true);
  });

  it("rejects an operator with a blank value", () => {
    expect(errorPaths({ ...baseValues, amountOp: "gt" })).toContainEqual(["amountValue"]);
  });

  it("rejects non-numeric and negative values", () => {
    expect(errorPaths({ ...baseValues, amountOp: "gt", amountValue: "abc" })).toContainEqual([
      "amountValue",
    ]);
    expect(errorPaths({ ...baseValues, amountOp: "gt", amountValue: "-5" })).toContainEqual([
      "amountValue",
    ]);
  });

  it("rejects between without an upper value and flags it on the 'to' field", () => {
    expect(errorPaths({ ...baseValues, amountOp: "between", amountValue: "45" })).toContainEqual([
      "amountValue2",
    ]);
  });

  it("rejects between with from > to and flags it on the 'to' field", () => {
    expect(
      errorPaths({
        ...baseValues,
        amountOp: "between",
        amountValue: "100",
        amountValue2: "25",
      }),
    ).toContainEqual(["amountValue2"]);
  });
});

describe("ruleAmountPayload", () => {
  it("maps 'Any amount' to explicit nulls so updates clear the condition", () => {
    expect(ruleAmountPayload({ amountOp: "", amountValue: "50", amountValue2: "60" })).toEqual({
      amountOp: null,
      amountValue: null,
      amountValue2: null,
    });
  });

  it("maps single-value operators and drops the stale upper value", () => {
    expect(
      ruleAmountPayload({ amountOp: "gt", amountValue: "1000", amountValue2: "9999" }),
    ).toEqual({ amountOp: "gt", amountValue: 1000, amountValue2: null });
  });

  it("keeps both values for between and parses decimals", () => {
    expect(
      ruleAmountPayload({ amountOp: "between", amountValue: "45.5", amountValue2: "55" }),
    ).toEqual({ amountOp: "between", amountValue: 45.5, amountValue2: 55 });
  });
});

// The amount condition and the account scope are independent; neither should
// constrain the other in the schema.
describe("amount condition combined with account scope", () => {
  it("accepts an amount condition on an account-scoped rule", () => {
    expect(
      schema.safeParse({
        ...baseValues,
        accountId: "acct-1",
        amountOp: "between",
        amountValue: "10",
        amountValue2: "50",
      }).success,
    ).toBe(true);
  });

  it("still rejects a bad amount range on an account-scoped rule", () => {
    expect(
      errorPaths({
        ...baseValues,
        accountId: "acct-1",
        amountOp: "between",
        amountValue: "50",
        amountValue2: "10",
      }),
    ).toContainEqual(["amountValue2"]);
  });

  it("accepts a scoped rule with no amount condition", () => {
    expect(schema.safeParse({ ...baseValues, accountId: "acct-1" }).success).toBe(true);
  });
});
