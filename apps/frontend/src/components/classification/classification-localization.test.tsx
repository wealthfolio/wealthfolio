import { AssetForm } from "@/pages/asset/asset-form";
import type { ParsedAsset } from "@/pages/asset/asset-utils";
import { act, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeEach, expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enAsset from "@/i18n/locales/en/asset.json";
import zhAsset from "@/i18n/locales/zh/asset.json";
import enSettings from "@/i18n/locales/en/settings.json";
import zhSettings from "@/i18n/locales/zh/settings.json";
import enAllocation from "@/i18n/locales/en/allocation.json";
import zhAllocation from "@/i18n/locales/zh/allocation.json";
import type { TaxonomyCategory } from "@/lib/types";
import { SingleSelectTaxonomy } from "./single-select-taxonomy";
import { CategoryForm } from "@/pages/settings/taxonomies/components/category-form";
import { modelPresetTitle } from "@/pages/allocation-targets/components/model-preset-data";
import { ModelPresetPicker } from "@/pages/allocation-targets/components/model-preset-picker";
import { DrillableDonutChart } from "@/pages/holdings/components/drillable-donut-chart";

vi.mock("@/adapters", () => ({
  getTaxonomy: vi.fn(),
  getTaxonomies: vi.fn(),
  getAssetTaxonomyAssignments: vi.fn(),
  assignAssetToCategory: vi.fn(),
  updateCategory: vi.fn(),
  createCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));
import {
  getTaxonomy,
  getTaxonomies,
  getAssetTaxonomyAssignments,
  assignAssetToCategory,
  updateCategory,
} from "@/adapters";
const category: TaxonomyCategory = {
  id: "LOW",
  taxonomyId: "risk_category",
  key: "LOW",
  name: "Low",
  color: "#123456",
  sortOrder: 1,
  createdAt: "",
  updatedAt: "",
};

async function setup() {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        common: enCommon,
        taxonomies: enCommonTaxonomies,
        asset: enAsset,
        settings: enSettings,
        allocation: enAllocation,
      },
      zh: {
        common: zhCommon,
        taxonomies: zhCommonTaxonomies,
        asset: zhAsset,
        settings: zhSettings,
        allocation: zhAllocation,
      },
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
  return { i18n, queryClient, wrapper };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTaxonomy).mockResolvedValue({
    taxonomy: { id: "risk_category" },
    categories: [category],
  } as Awaited<ReturnType<typeof getTaxonomy>>);
  vi.mocked(getAssetTaxonomyAssignments).mockResolvedValue([]);
  vi.mocked(assignAssetToCategory).mockResolvedValue(
    {} as Awaited<ReturnType<typeof assignAssetToCategory>>,
  );
  vi.mocked(updateCategory).mockResolvedValue(category);
});

it("switches classification labels without fetching again or writing translated names", async () => {
  const user = userEvent.setup();
  const { i18n, wrapper } = await setup();
  render(<SingleSelectTaxonomy taxonomyId="risk_category" assetId="asset-1" />, { wrapper });
  expect(await screen.findByRole("radio", { name: "低" })).toBeVisible();
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("radio", { name: "Low" })).toBeVisible();
  expect(getTaxonomy).toHaveBeenCalledTimes(1);
  expect(getAssetTaxonomyAssignments).toHaveBeenCalledTimes(1);
  expect(assignAssetToCategory).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: "Low" }));
  await waitFor(() =>
    expect(assignAssetToCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: "LOW",
        taxonomyId: "risk_category",
        assetId: "asset-1",
      }),
    ),
  );
});

it.each(["Low", "My low-risk bucket"])(
  "keeps the raw name %s when another field is saved",
  async (name) => {
    const user = userEvent.setup();
    const { i18n, wrapper } = await setup();
    render(
      <CategoryForm
        category={{ ...category, name }}
        taxonomyId="risk_category"
        onClose={vi.fn()}
      />,
      { wrapper },
    );
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue(name);
    await user.type(screen.getByRole("textbox", { name: "描述" }), "My description");
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(name);
    await user.click(screen.getByRole("button", { name: enSettings.tax_save_changes }));
    await waitFor(() =>
      expect(updateCategory).toHaveBeenCalledWith(
        expect.objectContaining({ id: "LOW", key: "LOW", name, description: "My description" }),
      ),
    );
  },
);

it("translates weight-only example titles and keeps selected IDs unchanged", async () => {
  const { i18n, wrapper } = await setup();
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPresetPicker
      taxonomyId="asset_classes"
      selected="balanced_60_40"
      onSelect={onSelect}
      colorByCategory={new Map()}
      currentCategories={[]}
    />,
    { wrapper },
  );
  const name = `60% ${zhCommonTaxonomies.categoryNames.asset_classes.EQUITY} / 40% ${zhCommonTaxonomies.categoryNames.asset_classes.FIXED_INCOME}`;
  expect(screen.getByText(name)).toBeVisible();
  await user.click(screen.getByText(name));
  expect(onSelect).toHaveBeenCalledWith("balanced_60_40");
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText("60% Equity / 40% Fixed Income")).toBeVisible();
});

it("preserves renamed and custom categories in weight-only titles", async () => {
  const { i18n } = await setup();
  const preset = {
    id: "custom",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 60, MY_CLASS: 40 },
  };
  const categories = [
    { id: "EQUITY", name: "My Equity" },
    { id: "MY_CLASS", name: "我的分类" },
  ];
  const original = structuredClone({ preset, categories });
  expect(modelPresetTitle(preset, categories, i18n.t)).toBe("60% My Equity / 40% 我的分类");
  expect({ preset, categories }).toEqual(original);
});

it("refreshes chart labels on language changes and preserves the source allocation", async () => {
  const { i18n, wrapper } = await setup();
  const allocation = {
    taxonomyId: "asset_classes",
    taxonomyName: "Asset Classes",
    color: "#123456",
    categories: [
      {
        categoryId: "EQUITY",
        categoryName: "Equity",
        color: "#123456",
        value: 100,
        percentage: 100,
      },
    ],
  };
  const { container } = render(<DrillableDonutChart title="分类" allocation={allocation} />, {
    wrapper,
  });
  expect(container).toHaveTextContent("股票");
  await act(() => i18n.changeLanguage("en"));
  expect(container).toHaveTextContent("Equity");
  expect(allocation.categories[0].categoryName).toBe("Equity");
});

it("localizes asset-form taxonomy headings without changing asset or custom taxonomy names", async () => {
  const { i18n, wrapper } = await setup();
  const taxonomies = [
    { id: "risk_category", name: "Risk Category", isSingleSelect: true, sortOrder: 0 },
    { id: "asset_classes", name: "Asset Classes", isSingleSelect: false, sortOrder: 1 },
    { id: "custom", name: "Asset Classes", isSingleSelect: false, sortOrder: 2 },
  ] as Awaited<ReturnType<typeof getTaxonomies>>;
  vi.mocked(getTaxonomies).mockResolvedValue(taxonomies);
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const asset = {
    id: "asset-1",
    name: "Equity",
    quoteCcy: "USD",
    quoteMode: "MANUAL",
    notes: "My notes",
  } as ParsedAsset;
  render(<AssetForm asset={asset} onSubmit={onSubmit} />, { wrapper });
  expect(
    await screen.findByText(zhCommonTaxonomies.taxonomyNames.risk_category),
  ).toBeInTheDocument();
  expect(screen.getByText(zhCommonTaxonomies.taxonomyNames.asset_classes)).toBeInTheDocument();
  expect(screen.getByText("Asset Classes")).toBeInTheDocument();
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getAllByText("Asset Classes")).toHaveLength(2);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: enAsset.assetForm.save_changes }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Equity", notes: "My notes" }),
    ),
  );
  expect(getTaxonomies).toHaveBeenCalledTimes(1);
});
