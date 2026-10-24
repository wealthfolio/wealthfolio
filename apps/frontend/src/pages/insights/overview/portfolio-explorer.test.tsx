import { act, fireEvent, render, screen } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import enInsights from "@/i18n/locales/en/insights.json";
import zhInsights from "@/i18n/locales/zh/insights.json";
import type {
  Account,
  CategoryAllocation,
  PortfolioAllocations,
  TaxonomyAllocation,
} from "@/lib/types";
import { PortfolioExplorer } from "./portfolio-explorer";

vi.mock("@/hooks/use-accounts-simple-performance", () => ({
  useAccountsSimplePerformance: () => ({ data: [] }),
}));

function category(categoryId: string, categoryName: string, value = 100): CategoryAllocation {
  return { categoryId, categoryName, value, percentage: value, color: "#123456" };
}

function taxonomy(taxonomyId: string, categories: CategoryAllocation[]): TaxonomyAllocation {
  return { taxonomyId, taxonomyName: taxonomyId, color: "#123456", categories };
}

function allocations(): PortfolioAllocations {
  return {
    assetClasses: taxonomy("asset_classes", [category("FIXED_INCOME", "Fixed Income")]),
    sectors: taxonomy("industries_gics", [category("10", "Energy")]),
    regions: taxonomy("regions", [category("R10", "Europe")]),
    riskCategory: taxonomy("risk_category", [category("LOW", "Low")]),
    securityTypes: taxonomy("instrument_type", [category("EQUITY_SECURITY", "Stocks")]),
    customGroups: [],
    totalValue: 100,
  };
}

async function setup(data = allocations()) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: { common: enCommon, insights: enInsights },
      zh: { common: zhCommon, insights: zhInsights },
    },
  });
  const onOpenAllocation = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <PortfolioExplorer
        allocations={data}
        holdings={[]}
        accounts={[{ id: "account-1", name: "Equity" } as Account]}
        accountValuations={[{ accountId: "account-1", totalValueBase: 100 }]}
        currency="USD"
        onOpenAllocation={onOpenAllocation}
      />
    </I18nextProvider>,
  );
  return { i18n, onOpenAllocation };
}

describe("PortfolioExplorer taxonomy labels", () => {
  it.each([
    {
      lens: "allocation",
      key: "assetClasses",
      name: "Fixed Income",
      label: "固定收益",
      id: "FIXED_INCOME",
    },
    { lens: "sectors", key: "sectors", name: "Energy", label: "能源", id: "10" },
    { lens: "regions", key: "regions", name: "Europe", label: "欧洲", id: "R10" },
    { lens: "risk", key: "riskCategory", name: "Low", label: "低", id: "LOW" },
    {
      lens: "security",
      key: "securityTypes",
      name: "Stocks",
      label: "股票",
      id: "EQUITY_SECURITY",
    },
  ] as const)(
    "localizes $lens rows, bar labels and tooltips without changing detail inputs",
    async ({ lens, key, name, label, id }) => {
      const data = allocations();
      const original = structuredClone(data);
      const { i18n, onOpenAllocation } = await setup(data);
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t(`insights:insights.explorer.lens_${lens}`),
        }),
      );
      expect(screen.getAllByText(label)).toHaveLength(2);
      const segment = screen.getByTitle(`${label} · 100.0%`);
      const style = segment.getAttribute("style");
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
      expect(onOpenAllocation).toHaveBeenCalledWith(data[key], id);
      expect(onOpenAllocation.mock.lastCall?.[0]).toBe(data[key]);
      await act(() => i18n.changeLanguage("en"));
      expect(screen.getAllByText(name)).toHaveLength(2);
      expect(screen.getByTitle(`${name} · 100.0%`)).toHaveAttribute("style", style);
      expect(data).toEqual(original);
    },
  );

  it("refreshes expanded nested and residual labels on language change", async () => {
    const data = allocations();
    data.assetClasses.categories = [
      {
        ...category("COMMODITIES", "Commodities"),
        children: [
          {
            ...category("COMM_PRECIOUS", "Precious Metals", 75),
            children: [category("COMM_PRECIOUS_GOLD", "Gold", 75)],
          },
          { ...category("residual", "Other Commodities", 25), isResidual: true },
        ],
      },
    ];
    const { i18n, onOpenAllocation } = await setup(data);
    fireEvent.click(screen.getByRole("button", { name: /^大宗商品/ }));
    fireEvent.click(screen.getByRole("button", { name: /^贵金属/ }));
    expect(screen.getByText("黄金")).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("common:allocation_other_in_category", { category: "大宗商品" })),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^黄金/ }));
    expect(onOpenAllocation).toHaveBeenCalledWith(data.assetClasses, "COMM_PRECIOUS_GOLD");
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByText("Gold")).toBeInTheDocument();
    expect(screen.getByText("Precious Metals")).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("common:allocation_other_in_category", { category: "Commodities" })),
    ).toBeInTheDocument();
  });

  it("preserves renamed, unknown and custom categories and account names", async () => {
    const data = allocations();
    data.assetClasses.categories = [
      category("EQUITY", "My stocks", 60),
      category("custom", "Cash", 40),
    ];
    data.customGroups = [
      { ...taxonomy("custom", [category("EQUITY", "Equity")]), taxonomyName: "Asset Classes" },
    ];
    const original = structuredClone(data);
    const { i18n } = await setup(data);
    expect(screen.getAllByText("My stocks")).toHaveLength(2);
    expect(screen.getAllByText("Cash")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Asset Classes" }));
    expect(screen.getAllByText("Equity")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("insights:insights.explorer.lens_accounts"),
      }),
    );
    expect(screen.getAllByText("Equity")).toHaveLength(2);
    expect(data).toEqual(original);
  });
});
