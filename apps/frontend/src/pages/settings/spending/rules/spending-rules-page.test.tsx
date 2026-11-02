import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Activity } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { RuleFormValues } from "@/features/spending/components/rule-form";
import SpendingRulesPage from "./spending-rules-page";

const mocks = vi.hoisted(() => ({ create: vi.fn<() => Promise<void>>() }));

vi.mock("@/features/spending/hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: true, isLoading: false, accountIds: [] }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: () => ({ data: { categories: [] }, isLoading: false, isError: false }),
}));
vi.mock("@/features/spending/hooks/use-categorization-rules", () => ({
  useCategorizationRules: () => ({ data: [], isLoading: false, isError: false }),
  useRulePresets: () => ({ data: [], isError: false }),
  useCategorizationRuleMutations: () => ({
    create: useMutation({ mutationFn: mocks.create }),
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutate: vi.fn() },
    rerun: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/features/spending/components/rule-preset-picker", () => ({
  RulePresetPicker: () => null,
}));
const values: RuleFormValues = {
  name: "Coffee",
  pattern: "STARBUCKS",
  matchType: "contains",
  amountOp: "",
  amountValue: "",
  amountValue2: "",
  priority: 0,
  accountId: null,
};
// The modal's form, reduced to its save.
vi.mock("@/features/spending/components/rule-edit-modal", () => ({
  RuleEditModal: ({ open, onSave }: { open: boolean; onSave: (v: RuleFormValues) => void }) =>
    open ? (
      <div role="dialog">
        <button type="button" onClick={() => onSave(values)}>
          Save rule
        </button>
      </div>
    ) : null,
}));

it("closes the new rule once its save ends while the screen is out of sight", async () => {
  // On a phone, a screen kept under another one is a hidden <Activity>; a save
  // left open there would be saved again from the same form.
  let finish: () => void = () => undefined;
  mocks.create.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const client = new QueryClient();
  const page = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <SpendingRulesPage />
        </Activity>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
  const { rerender } = render(page(false));
  fireEvent.click(screen.getAllByRole("button", { name: "Add rule" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(saveStatus()).toBe("pending"));

  rerender(page(true));
  act(() => finish());
  await waitFor(() => expect(saveStatus()).toBe("success"));
  rerender(page(false));

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
