import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeEach, expect, it, vi } from "vitest";
import type { AllocationTarget } from "@/lib/types";
import enAllocation from "@/i18n/locales/en/allocation.json";
import zhAllocation from "@/i18n/locales/zh/allocation.json";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import enTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enUi from "@/i18n/locales/en/ui.json";
import zhUi from "@/i18n/locales/zh/ui.json";
import { TargetsTab } from "./targets-tab";

const mocks = vi.hoisted(() => ({ save: vi.fn(), renamed: false }));
const builtinCategories = [
  { id: "EQUITY", name: "Equity", parentId: null, sortOrder: 0 },
  { id: "FIXED_INCOME", name: "Fixed Income", parentId: null, sortOrder: 1 },
];
const customCategories = builtinCategories.map((category, index) => ({
  ...category,
  name: index === 0 ? "My shares" : "My bonds",
}));
const builtinTaxonomy = {
  id: "asset_classes",
  name: "Asset Classes",
  categories: builtinCategories,
};
const customTaxonomy = { ...builtinTaxonomy, name: "My allocation", categories: customCategories };
const weights = builtinCategories.map((category, index) => ({
  categoryId: category.id,
  targetBps: index === 0 ? 7000 : 3000,
  isLocked: false,
}));
const categories = builtinCategories.map((category, index) => ({
  categoryId: category.id,
  categoryName: category.name,
  percentage: index === 0 ? 70 : 30,
  value: index === 0 ? 70 : 30,
  children: [],
}));
const allocations = {
  assetClasses: { categories },
  sectors: { categories: [] },
  regions: { categories: [] },
  securityTypes: { categories: [] },
  riskCategory: { categories: [] },
  customGroups: [],
};
const customAllocations = {
  ...allocations,
  assetClasses: {
    categories: categories.map((category, index) => ({
      ...category,
      categoryName: customCategories[index].name,
    })),
  },
};
const savedTarget: AllocationTarget = {
  id: "saved-target",
  name: "My saved target",
  scopeType: "all",
  taxonomyId: "asset_classes",
  triggerType: "threshold",
  driftBandBps: 100,
  bandType: "absolute",
  relativeFactorBps: 2000,
  rebalanceGoal: "nearest_band",
  minTradeAmount: "0",
  wholeSharesOnly: false,
  allowSells: true,
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomies: () => ({ data: [mocks.renamed ? customTaxonomy : builtinTaxonomy] }),
  useTaxonomy: () => ({ data: mocks.renamed ? customTaxonomy : builtinTaxonomy, isLoading: false }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-holdings", () => ({ useHoldings: () => ({ holdings: [] }) }));
vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: () => ({ data: [] }) }));
vi.mock("@/hooks/use-portfolio-allocations", () => ({
  usePortfolioAllocations: () => ({
    allocations: mocks.renamed ? customAllocations : allocations,
    isLoading: false,
  }),
}));
vi.mock("../hooks/use-allocation-target-mutations", () => ({
  useDeleteAllocationTarget: () => ({}),
  useAllocationTargetWeights: () => ({ data: weights, isLoading: false }),
  useSaveAllocationTargetWithWeights: () => ({ mutateAsync: mocks.save, isPending: false }),
}));
const constraints: never[] = [];
vi.mock("../hooks/use-target-constraints", () => ({
  useTargetConstraints: () => ({ constraints, isLoading: false, saveConstraints: vi.fn() }),
}));
vi.mock("./target-weight-editor", () => ({ TargetWeightEditor: () => null }));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));

beforeEach(() => {
  mocks.renamed = false;
  mocks.save.mockReset().mockResolvedValue({ target: savedTarget, weights });
});

async function renderEditor(existing = false) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: { allocation: enAllocation, common: enCommon, taxonomies: enTaxonomies, ui: enUi },
      zh: { allocation: zhAllocation, common: zhCommon, taxonomies: zhTaxonomies, ui: zhUi },
    },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <FormattingProvider locale="en-US">
        <TooltipProvider>
          <TargetsTab
            targets={existing ? [savedTarget] : []}
            selectedTargetId={existing ? savedTarget.id : null}
            editorMode={existing ? "edit" : "create"}
            accountScope={{ type: "all" }}
            onTargetChange={vi.fn()}
          />
        </TooltipProvider>
      </FormattingProvider>
    </I18nextProvider>,
  );
  await act(() => i18n.changeLanguage("zh"));
  return { i18n, user: userEvent.setup() };
}

it.each([false, true])(
  "keeps raw built-in names in saved suggestions (preset: %s)",
  async (preset) => {
    const { i18n, user } = await renderEditor();
    expect(screen.getByRole("button", { name: /资产类别/ })).toBeInTheDocument();
    const localizedPreset = `60% ${zhTaxonomies.categoryNames.asset_classes.EQUITY} / 40% ${zhTaxonomies.categoryNames.asset_classes.FIXED_INCOME}`;
    expect(screen.getByRole("button", { name: localizedPreset })).toBeInTheDocument();
    if (preset) await user.click(screen.getByRole("button", { name: localizedPreset }));
    const rawName = preset ? "60% Equity / 40% Fixed Income" : "Asset Classes";
    await waitFor(() =>
      expect(screen.getByPlaceholderText(zhAllocation.editor.targetName)).toHaveValue(
        `${rawName} 目标`,
      ),
    );
    expect(
      screen.getByRole("heading", {
        name: i18n.t("allocation:editor.targetWeightsTitle", {
          start: preset ? localizedPreset : zhAllocation.presets.currentAllocation,
        }),
      }),
    ).toBeInTheDocument();
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByPlaceholderText(enAllocation.editor.targetName)).toHaveValue(
      `${rawName} target`,
    );
    await act(() => i18n.changeLanguage("zh"));
    await user.click(screen.getByRole("button", { name: zhAllocation.editor.createTarget }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ name: `${rawName} 目标`, taxonomyId: "asset_classes" }),
        }),
      ),
    );
  },
);

it.each([false, true])(
  "preserves renamed taxonomy/category names in suggestions (preset: %s)",
  async (preset) => {
    mocks.renamed = true;
    const { i18n, user } = await renderEditor();
    expect(screen.getByRole("button", { name: /My allocation/ })).toBeInTheDocument();
    const rawPreset = "60% My shares / 40% My bonds";
    if (preset) await user.click(screen.getByRole("button", { name: rawPreset }));
    const rawName = preset ? rawPreset : "My allocation";
    await waitFor(() =>
      expect(screen.getByPlaceholderText(zhAllocation.editor.targetName)).toHaveValue(
        `${rawName} 目标`,
      ),
    );
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByPlaceholderText(enAllocation.editor.targetName)).toHaveValue(
      `${rawName} target`,
    );
    await user.click(screen.getByRole("button", { name: enAllocation.editor.createTarget }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ name: `${rawName} target` }),
        }),
      ),
    );
  },
);

it.each([false, true])(
  "does not rename edited drafts or saved targets on language change (saved: %s)",
  async (existing) => {
    const original = structuredClone(savedTarget);
    const { i18n, user } = await renderEditor(existing);
    const name = existing ? savedTarget.name : "My edited draft";
    if (!existing) {
      await user.clear(screen.getByPlaceholderText(zhAllocation.editor.targetName));
      await user.type(screen.getByPlaceholderText(zhAllocation.editor.targetName), name);
    }
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByPlaceholderText(enAllocation.editor.targetName)).toHaveValue(name);
    await act(() => i18n.changeLanguage("zh"));
    expect(screen.getByPlaceholderText(zhAllocation.editor.targetName)).toHaveValue(name);
    if (existing) {
      await user.click(screen.getByRole("button", { name: zhAllocation.editor.reductionsOff }));
    }
    await user.click(
      screen.getByRole("button", {
        name: existing ? zhAllocation.editor.saveTarget : zhAllocation.editor.createTarget,
      }),
    );
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ name }),
        }),
      ),
    );
    expect(savedTarget).toEqual(original);
  },
);
