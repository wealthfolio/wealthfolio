import type { TFunction } from "i18next";
export interface ModelPreset {
  id: string;
  taxonomyId: string;
  name: string;
  description: string;
  risk: string;
  featured?: boolean;
  weights: Record<string, number>; // 0-100, keyed by taxonomy category id
}

export const BUILT_IN_PRESETS: ModelPreset[] = [
  // Asset Classes
  {
    id: "balanced_60_40",
    taxonomyId: "asset_classes",
    name: "Balanced 60 / 40",
    description: "Classic stock and bond mix",
    risk: "Moderate",
    featured: true,
    weights: { EQUITY: 60, FIXED_INCOME: 40 },
  },
  {
    id: "growth_80_20",
    taxonomyId: "asset_classes",
    name: "Growth 80 / 20",
    description: "Growth-oriented with a bond stabilizer",
    risk: "Aggressive",
    featured: true,
    weights: { EQUITY: 80, FIXED_INCOME: 20 },
  },
  {
    id: "all_weather",
    taxonomyId: "asset_classes",
    name: "All Weather",
    description: "Diversified across market regimes",
    risk: "Conservative",
    featured: true,
    weights: { EQUITY: 30, FIXED_INCOME: 55, COMMODITIES: 15 },
  },
  {
    id: "income_20_80",
    taxonomyId: "asset_classes",
    name: "Income 20 / 80",
    description: "Bond-heavy preservation mix",
    risk: "Conservative",
    weights: { EQUITY: 20, FIXED_INCOME: 80 },
  },
  {
    id: "conservative_growth_40_60",
    taxonomyId: "asset_classes",
    name: "Conservative Growth 40 / 60",
    description: "Conservative stock and bond mix",
    risk: "Conservative",
    weights: { EQUITY: 40, FIXED_INCOME: 60 },
  },
  {
    id: "aggressive_90_10",
    taxonomyId: "asset_classes",
    name: "Aggressive 90 / 10",
    description: "High-equity growth mix",
    risk: "Aggressive",
    weights: { EQUITY: 90, FIXED_INCOME: 10 },
  },
  {
    id: "permanent_portfolio",
    taxonomyId: "asset_classes",
    name: "Permanent Portfolio",
    description: "Equal stocks, bonds, cash and commodities",
    risk: "Conservative",
    weights: { EQUITY: 25, FIXED_INCOME: 25, CASH: 25, COMMODITIES: 25 },
  },

  // Industries GICS
  {
    id: "gics_sp500_weight",
    taxonomyId: "industries_gics",
    name: "S&P 500",
    description: "S&P 500 sector weights (May 2026)",
    risk: "Moderate",
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
    name: "Equal Weight",
    description: "Equal allocation across all 11 GICS sectors",
    risk: "Moderate",
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
    name: "Defensive Equity",
    description: "Health care, staples and utilities tilt",
    risk: "Conservative",
    weights: { "35": 40, "30": 35, "55": 25 },
  },

  // Risk Category
  {
    id: "risk_conservative",
    taxonomyId: "risk_category",
    name: "Conservative",
    description: "Heavy low-risk base, minimal high-risk exposure",
    risk: "Conservative",
    weights: { LOW: 70, MEDIUM: 25, HIGH: 5 },
  },
  {
    id: "risk_balanced",
    taxonomyId: "risk_category",
    name: "Balanced",
    description: "Medium-risk core with lower-risk ballast",
    risk: "Moderate",
    weights: { LOW: 30, MEDIUM: 50, HIGH: 20 },
  },
  {
    id: "risk_aggressive",
    taxonomyId: "risk_category",
    name: "Aggressive",
    description: "Growth-oriented with majority high-risk exposure",
    risk: "Aggressive",
    weights: { LOW: 10, MEDIUM: 30, HIGH: 60 },
  },

  // Regions
  {
    id: "regions_global_cap",
    taxonomyId: "regions",
    name: "Global Cap",
    description: "Approximate world market-cap weights (Apr 2026)",
    risk: "Moderate",
    weights: { R20: 67, R10: 16, R30: 14, R50: 2, R40: 1 },
  },
  {
    id: "regions_international_proxy",
    taxonomyId: "regions",
    name: "International Proxy",
    description: "Non-US equity proxy using continent buckets",
    risk: "Moderate",
    weights: { R10: 42, R30: 40, R20: 13, R50: 3, R40: 2 },
  },
  {
    id: "regions_equal_weight",
    taxonomyId: "regions",
    name: "Equal Weight",
    description: "Equal exposure across all five continents",
    risk: "Aggressive",
    weights: { R10: 20, R20: 20, R30: 20, R40: 20, R50: 20 },
  },
];

export function getPresetName(t: TFunction, preset: ModelPreset): string {
  return t(`allocation:builtInPresets.${preset.id}.name`, { defaultValue: preset.name });
}
