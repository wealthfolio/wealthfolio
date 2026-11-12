import { act, fireEvent, render, screen } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import enTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enInsights from "@/i18n/locales/en/insights.json";
import zhInsights from "@/i18n/locales/zh/insights.json";
import zhHantInsights from "@/i18n/locales/zh-Hant/insights.json";
import arInsights from "@/i18n/locales/ar/insights.json";
import type {
  Account,
  AccountValueSource,
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

interface SetupOptions {
  language?: string;
  accounts?: Account[];
  accountValuations?: AccountValueSource[];
}

async function setup(
  data = allocations(),
  {
    language = "zh",
    accounts = [{ id: "account-1", name: "Equity" } as Account],
    accountValuations = [{ accountId: "account-1", totalValueBase: 100 }],
  }: SetupOptions = {},
) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: { common: enCommon, taxonomies: enTaxonomies, insights: enInsights },
      zh: { common: zhCommon, taxonomies: zhTaxonomies, insights: zhInsights },
      "zh-Hant": { insights: zhHantInsights },
      ar: { insights: arInsights },
    },
  });
  const onOpenAllocation = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <PortfolioExplorer
        allocations={data}
        holdings={[]}
        accounts={accounts}
        accountValuations={accountValuations}
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

describe("PortfolioExplorer collapsed row counts", () => {
  function withRows(count: number) {
    const data = allocations();
    data.assetClasses.categories = Array.from({ length: count }, (_, i) =>
      category(`category-${i}`, `Category ${i + 1}`),
    );
    return data;
  }

  it.each([
    { language: "en", top: "Top 5 items", other: "Other 2 items" },
    { language: "zh", top: "前 5 项", other: "其他 2 项" },
    { language: "zh-Hant", top: "前 5 項", other: "其他 2 項" },
    { language: "ar", top: "أبرز 5 عناصر", other: "عنصران آخران" },
  ])("renders complete $language labels for seven rows", async ({ language, top, other }) => {
    await setup(withRows(7), { language });
    expect(screen.getByText(top)).toBeInTheDocument();
    expect(screen.getAllByText(other)).toHaveLength(2);
    expect(screen.getByTitle(`${other} · 28.6%`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Category 5/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Category 6/ })).not.toBeInTheDocument();
  });

  it.each([0, 5, 6])("does not collapse %i rows", async (count) => {
    await setup(withRows(count), { language: "en" });
    expect(screen.queryByText("Top 5 items")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Other \d+ items$/)).not.toBeInTheDocument();
  });

  it("keeps the bar aggregated while expanding the list and refreshes counts on language change", async () => {
    const { i18n } = await setup(withRows(9), { language: "en" });
    expect(screen.getByText("Top 5 items")).toBeInTheDocument();
    expect(screen.getAllByText("Other 4 items")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.queryByText("Top 5 items")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Category 9/ })).toBeInTheDocument();
    expect(screen.getAllByText("Other 4 items")).toHaveLength(1);
    await act(() => i18n.changeLanguage("zh"));
    expect(screen.getByTitle("其他 4 项 · 44.4%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getByText("前 5 项")).toBeInTheDocument();
    expect(screen.getAllByText("其他 4 项")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Category 9/ })).not.toBeInTheDocument();
  });

  it.each(["ltr", "rtl"])(
    "counts grouped rows rather than child accounts in %s",
    async (direction) => {
      const previousDirection = document.documentElement.dir;
      document.documentElement.dir = direction;
      try {
        const accounts = Array.from(
          { length: 14 },
          (_, i) =>
            ({
              id: `account-${i}`,
              name: `Account ${i}`,
              group: `Group ${Math.floor(i / 2)}`,
            }) as Account,
        );
        await setup(allocations(), {
          language: "en",
          accounts,
          accountValuations: accounts.map((account) => ({
            accountId: account.id,
            totalValueBase: 100,
          })),
        });
        fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
        expect(screen.getByText("Top 5 items")).toBeInTheDocument();
        expect(screen.getAllByText("Other 2 items")).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: /^Group 0/ }));
        expect(screen.getByText("Account 0")).toBeInTheDocument();
        expect(screen.getByText("Account 1")).toBeInTheDocument();
        expect(screen.getAllByText("Other 2 items")).toHaveLength(2);
      } finally {
        document.documentElement.dir = previousDirection;
      }
    },
  );
});
