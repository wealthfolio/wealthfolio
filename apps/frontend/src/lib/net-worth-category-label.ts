import type { TFunction } from "i18next";

const NET_WORTH_CATEGORY_KEYS: Record<string, string> = {
  cash: "holdings:group_cash",
  investments: "holdings:group_investments",
  properties: "holdings:group_properties",
  vehicles: "holdings:group_vehicles",
  collectibles: "holdings:group_collectibles",
  preciousMetals: "holdings:group_precious_metals",
  otherAssets: "holdings:group_other_assets",
};

/** Localize a built-in top-level net-worth category, preserving unknown names. */
export function getNetWorthCategoryLabel(t: TFunction, category: string, fallback: string): string {
  const key = NET_WORTH_CATEGORY_KEYS[category];
  return key ? t(key, fallback) : fallback;
}
