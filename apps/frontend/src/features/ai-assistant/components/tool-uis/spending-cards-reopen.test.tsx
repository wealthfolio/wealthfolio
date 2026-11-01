import { fireEvent, render, screen, waitFor } from "@/test/render";
import type { ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { CategorizationProposalsContentImpl } from "./categorization-proposals-tool-ui";
import { CreateCategorizationRuleToolUIContentImpl } from "./create-categorization-rule-tool-ui";

const mocks = vi.hoisted(() => ({ assign: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("@/adapters", () => ({ updateToolResult: mocks.update }));
vi.mock("@/features/spending/hooks/use-cash-activities", () => ({
  useBulkAssignCategories: () => ({ mutateAsync: mocks.assign, isPending: false }),
}));
vi.mock("@/features/spending/hooks/use-categorization-rules", () => ({
  useCategorizationRuleMutations: () => ({
    create: { mutateAsync: mocks.create, isPending: false },
  }),
}));
vi.mock("../../hooks/use-runtime-context", () => ({
  useRuntimeContext: () => ({ currentThreadId: "thread" }),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/features/spending/components/quick-categorize-popover", () => ({
  QuickCategorizePopover: ({ trigger, scope }: { trigger: React.ReactNode; scope: string }) => (
    <div data-testid={`picker-${scope}`}>{trigger}</div>
  ),
}));
const proposal = {
  proposals: [
    {
      activityId: "a",
      activityDate: "2026-10-01T00:00:00Z",
      amount: 10,
      currency: "USD",
      notes: "Coffee transaction",
      taxonomyId: "spending_categories",
      categoryId: "food",
      categoryPath: "Food",
      confidence: 1,
      source: "history",
      explanation: "Matched",
    },
  ],
  taxonomies: [
    {
      taxonomyId: "spending_categories",
      taxonomyName: "Expense",
      categories: [
        { categoryId: "food", key: "food", name: "Food", path: "Food", color: "#808080" },
      ],
    },
  ],
  unproposed: [],
};
const rule = {
  rule: {
    id: "rule",
    name: "Coffee rule",
    pattern: "CAFE",
    matchType: "contains",
    taxonomyId: "spending_categories",
    categoryId: "food",
    accountId: null,
  },
  categoryPath: "Food",
  draftStatus: "draft",
};
const status = { type: "complete" } as ComponentProps<
  typeof CategorizationProposalsContentImpl
>["status"];
const props = {
  toolCallId: "call",
  toolName: "propose_transaction_categories",
  args: {},
  argsText: "{}",
  status,
  result: proposal,
} as ComponentProps<typeof CategorizationProposalsContentImpl>;
const ruleProps = {
  ...props,
  toolName: "create_categorization_rule",
  result: rule,
} as ComponentProps<typeof CreateCategorizationRuleToolUIContentImpl>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assign.mockResolvedValue([{ id: "saved-assignment" }]);
  mocks.create.mockResolvedValue({ id: "rule" });
  mocks.update.mockResolvedValue(undefined);
});

it("applies a category then reopens the saved {data,meta} result with its content and applied state", async () => {
  const first = render(<CategorizationProposalsContentImpl {...props} />);
  await screen.findByText("Coffee transaction");
  expect(screen.getByTestId("picker-expense")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  const patch = mocks.update.mock.calls[0][0].resultPatch;
  expect(patch).toMatchObject({ submitted: true, appliedCount: 1, draftStatus: "applied" });
  first.unmount();
  render(
    <CategorizationProposalsContentImpl
      {...props}
      result={{ data: { ...proposal, ...patch }, meta: patch }}
    />,
  );
  await screen.findByText("Coffee transaction");
  expect(screen.queryByText("No spending taxonomies are configured.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply 1 selected" })).not.toBeInTheDocument();
  expect(mocks.assign).toHaveBeenCalledTimes(1);
});

it("creates a rule then reopens its saved result without losing the rule or allowing another create", async () => {
  const first = render(<CreateCategorizationRuleToolUIContentImpl {...ruleProps} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create rule" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  const patch = mocks.update.mock.calls[0][0].resultPatch;
  expect(patch).toMatchObject({ submitted: true, draftStatus: "created", ruleId: "rule" });
  first.unmount();
  render(
    <CreateCategorizationRuleToolUIContentImpl
      {...ruleProps}
      result={{ data: { ...rule, ...patch }, meta: patch }}
    />,
  );
  expect(await screen.findByText("Coffee rule")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Rule created" })).toBeDisabled();
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
