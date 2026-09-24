import { useState } from "react";
import { createRoot } from "react-dom/client";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { FormattingProvider } from "@wealthfolio/ui";
import { PrivacyContext } from "@/context/privacy-context";
import en from "@/i18n/locales/en/insights.json";
import { VelocityCard } from "@/pages/net-worth/components/velocity-card";
import { computeVelocity } from "@/pages/net-worth/components/utils";
import de from "@/i18n/locales/de/insights.json";
import { BreakdownTable } from "@/pages/net-worth/components/breakdown-table";
import type { ParsedHistoryPoint, ParsedNetWorth } from "@/pages/net-worth/components/utils";
import "@/globals.css";

const data: ParsedNetWorth = {
  netWorth: 12_445_678,
  assets: {
    total: 12_745_678,
    breakdown: [
      { category: "investments", name: "Investments", value: 12_345_678 },
      { category: "properties", name: "Property with a long category name", value: 400_000 },
    ],
  },
  liabilities: {
    total: 300_000,
    breakdown: [{ category: "liabilities", assetId: "mortgage", name: "Mortgage", value: 300_000 }],
  },
};
const history: ParsedHistoryPoint[] = [
  {
    date: "2020-01-01",
    netWorth: 100,
    totalAssets: 100,
    totalLiabilities: 0,
    portfolioValue: 100,
    alternativeAssetsValue: 0,
    netContribution: 0,
    breakdown: { investments: 100, properties: 0, mortgage: 0 },
  },
  {
    date: "2026-09-06",
    netWorth: data.netWorth,
    totalAssets: data.assets.total,
    totalLiabilities: data.liabilities.total,
    portfolioValue: 12_345_678,
    alternativeAssetsValue: 400_000,
    netContribution: 0,
    breakdown: { investments: 12_345_678, properties: 400_000, mortgage: 300_000 },
  },
];

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [width, setWidth] = useState(params.get("width") ?? "auto");
  const [fallback, setFallback] = useState(params.get("fallback") === "1");
  const [scenario, setScenario] = useState(params.get("scenario") ?? "growth");
  const [locale, setLocale] = useState(params.get("locale") ?? "de-DE");
  const [hidden, setHidden] = useState(false);
  const current = structuredClone(data);
  const points = structuredClone(history);
  if (scenario === "extreme") {
    current.assets.breakdown[0].value = 1_234_567_890_123_456_000;
    current.assets.total = current.assets.breakdown[0].value + 400_000;
    current.netWorth = current.assets.total - current.liabilities.total;
    points[1].breakdown.investments = current.assets.breakdown[0].value;
    points[1].netWorth = current.netWorth;
  } else if (scenario === "loss") {
    points[0].breakdown = { investments: 24_691_356, properties: 800_000, mortgage: 600_000 };
    points[0].netWorth = 24_891_356;
  } else if (scenario === "zero") {
    points[0] = { ...points[1], date: points[0].date };
  } else if (scenario === "new") {
    points[0].breakdown = { investments: 0, properties: 0, mortgage: 0 };
    points[0].netWorth = 0;
  } else if (scenario === "negative") {
    current.liabilities.breakdown[0].value = 30_000_000;
    current.liabilities.total = 30_000_000;
    current.netWorth = current.assets.total - current.liabilities.total;
    points[1].netWorth = current.netWorth;
    points[1].breakdown.mortgage = 30_000_000;
  } else if (scenario === "assets-only") {
    current.liabilities = { total: 0, breakdown: [] };
    current.netWorth = current.assets.total;
    points[1].netWorth = current.netWorth;
  }
  points[1].totalAssets = current.assets.total;
  points[1].totalLiabilities = current.liabilities.total;
  points[1].portfolioValue = current.assets.breakdown[0].value;
  return (
    <FormattingProvider locale={locale}>
      <PrivacyContext.Provider
        value={{ isBalanceHidden: hidden, toggleBalanceVisibility: () => setHidden(!hidden) }}
      >
        <aside
          className="flex flex-wrap items-center gap-4 border-b p-4"
          aria-label="Fixture controls"
        >
          <label>
            Card width{" "}
            <select
              aria-label="Card width"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            >
              {[
                "auto",
                "240",
                "288",
                "320",
                "447",
                "448",
                "560",
                "639",
                "640",
                "767",
                "768",
                "960",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Scenario{" "}
            <select
              aria-label="Scenario"
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              {["growth", "loss", "zero", "new", "negative", "assets-only", "extreme"].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Number locale{" "}
            <select
              aria-label="Number locale"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              {["de-DE", "en-US", "fr-FR", "ja-JP"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={fallback}
              onChange={(e) => setFallback(e.target.checked)}
            />{" "}
            Simulate no subgrid
          </label>
          <label>
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />{" "}
            Hide balances
          </label>
        </aside>
        <nav className="flex gap-4 px-4 pt-3 text-sm underline" aria-label="Reproductions">
          <a href="?width=960&fallback=1">Column alignment case</a>
          <a href="?width=240&scenario=extreme&locale=en-US">Sign wrapping case</a>
        </nav>
        <p className="px-4 pt-3 text-sm">
          Fixed implementation. Compare Value alignment with “Simulate no subgrid”; narrow the card
          to inspect signs and wrapping. This simulates the CSS fallback, not an older browser
          engine.
        </p>
        {fallback && (
          <style>{`main [class*="supports-[grid-template-columns:subgrid]"] { grid-template-columns: var(--breakdown-fallback-columns) !important; }`}</style>
        )}
        <main
          aria-label="Net worth card"
          style={{ padding: 16, width: width === "auto" ? undefined : Number(width) + 32 }}
        >
          <BreakdownTable
            data={current}
            history={points}
            currency="EUR"
            periodLabel="ALL"
            onSelect={() => undefined}
          />
        </main>
        <section aria-label="Monthly pace card" style={{ padding: 16, maxWidth: 384 }}>
          <VelocityCard
            velocity={
              computeVelocity([
                {
                  ...history[0],
                  netWorth: 10000,
                  totalAssets: 10000,
                  portfolioValue: 5000,
                  alternativeAssetsValue: 5000,
                  netContribution: 5000,
                },
                {
                  ...history[0],
                  date: "2020-07-01",
                  netWorth: 11100,
                  totalAssets: 11100,
                  portfolioValue: 7300,
                  alternativeAssetsValue: 3800,
                  netContribution: 7000,
                },
              ])!
            }
            currency="EUR"
            periodLabel="YTD"
          />
        </section>
      </PrivacyContext.Provider>
    </FormattingProvider>
  );
}

async function renderFixture() {
  await i18next.use(initReactI18next).init({
    lng: new URLSearchParams(location.search).get("language") ?? "de",
    resources: { de: { insights: de }, en: { insights: en } },
    interpolation: { escapeValue: false },
  });
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
void renderFixture();
