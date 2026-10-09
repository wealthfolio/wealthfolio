export interface ModelPreset {
  id: string;
  taxonomyId: string;
  weights: Record<string, number>; // 0-100, keyed by taxonomy category id
}

export const CATEGORY_LABELS: Record<string, string> = {
  CASH: "Cash",
  EQUITY: "Equity",
  FIXED_INCOME: "Fixed Income",
  REAL_ESTATE: "Real Estate",
  COMMODITIES: "Commodities",
  ALTERNATIVES: "Alternatives",
  DIGITAL_ASSETS: "Digital Assets",
  "10": "Energy",
  "15": "Materials",
  "20": "Industrials",
  "25": "Consumer Discretionary",
  "30": "Consumer Staples",
  "35": "Health Care",
  "40": "Financials",
  "45": "Information Technology",
  "50": "Communication Services",
  "55": "Utilities",
  "60": "Real Estate",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  R10: "Europe",
  R20: "Americas",
  R30: "Asia",
  R40: "Africa",
  R50: "Oceania",
};

function formattedPct(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

/**
 * An example is named by its weights alone (§10): no label that ranks it,
 * describes a risk level or ties it to anything outside the app.
 */
export function modelPresetTitle(
  preset: ModelPreset,
  categories: { id: string; name: string; sortOrder?: number }[],
): string {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const entries = Object.entries(preset.weights)
    .filter(([, pct]) => pct > 0)
    .sort(([left], [right]) => {
      const leftCategory = categoryById.get(left);
      const rightCategory = categoryById.get(right);
      return (
        (leftCategory?.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (rightCategory?.sortOrder ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
      );
    });
  const visible = entries.slice(0, 3).map(([categoryId, pct]) => {
    const label = categoryById.get(categoryId)?.name ?? CATEGORY_LABELS[categoryId] ?? categoryId;
    return `${formattedPct(pct)} ${label}`;
  });
  if (entries.length > visible.length) visible.push(`+${entries.length - visible.length}`);
  return visible.join(" / ");
}

export const BUILT_IN_PRESETS: ModelPreset[] = [
  // Asset Classes
  {
    id: "balanced_60_40",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 60, FIXED_INCOME: 40 },
  },
  {
    id: "growth_80_20",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 80, FIXED_INCOME: 20 },
  },
  {
    id: "all_weather",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 30, FIXED_INCOME: 55, COMMODITIES: 15 },
  },
  {
    id: "income_20_80",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 20, FIXED_INCOME: 80 },
  },
  {
    id: "conservative_growth_40_60",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 40, FIXED_INCOME: 60 },
  },
  {
    id: "aggressive_90_10",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 90, FIXED_INCOME: 10 },
  },
  {
    id: "permanent_portfolio",
    taxonomyId: "asset_classes",
    weights: { EQUITY: 25, FIXED_INCOME: 25, CASH: 25, COMMODITIES: 25 },
  },

  // Industries GICS
  {
    id: "gics_sp500_weight",
    taxonomyId: "industries_gics",
    weights: {
      "45": 39,
      "40": 11,
      "50": 10,
      "25": 10,
      "35": 8,
      "20": 8,
      "30": 5,
      "10": 3,
      "55": 2,
      "15": 2,
      "60": 2,
    },
  },
  {
    id: "gics_equal_weight",
    taxonomyId: "industries_gics",
    weights: {
      "10": 9,
      "15": 9,
      "20": 9,
      "25": 9,
      "30": 9,
      "35": 9,
      "40": 9,
      "45": 10,
      "50": 9,
      "55": 9,
      "60": 9,
    },
  },
  {
    id: "gics_defensive",
    taxonomyId: "industries_gics",
    weights: { "35": 40, "30": 35, "55": 25 },
  },

  // Risk Category
  {
    id: "risk_conservative",
    taxonomyId: "risk_category",
    weights: { LOW: 70, MEDIUM: 25, HIGH: 5 },
  },
  {
    id: "risk_balanced",
    taxonomyId: "risk_category",
    weights: { LOW: 30, MEDIUM: 50, HIGH: 20 },
  },
  {
    id: "risk_aggressive",
    taxonomyId: "risk_category",
    weights: { LOW: 10, MEDIUM: 30, HIGH: 60 },
  },

  // Regions
  {
    id: "regions_global_cap",
    taxonomyId: "regions",
    weights: { R20: 67, R10: 16, R30: 14, R50: 2, R40: 1 },
  },
  {
    id: "regions_international_proxy",
    taxonomyId: "regions",
    weights: { R10: 42, R30: 40, R20: 13, R50: 3, R40: 2 },
  },
  {
    id: "regions_equal_weight",
    taxonomyId: "regions",
    weights: { R10: 20, R20: 20, R30: 20, R40: 20, R50: 20 },
  },
];
