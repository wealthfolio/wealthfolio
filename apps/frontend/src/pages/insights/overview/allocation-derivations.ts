import type {
  Account,
  AccountValueSource,
  CategoryAllocation,
  CurrentValuationSummary,
  Holding,
} from "@/lib/types";

/** Cycling palette built from the theme chart tokens (retargeted to the allocation palette). */
export const CHART_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-stone)",
] as const;

export const OTHER_COLOR = "var(--chart-stone)";

export function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

/** A single row in a Portfolio Explorer lens (bar segment + list row). */
export interface LensItem {
  id: string;
  name: string;
  value: number;
  /** 0–100 */
  percentage: number;
  color: string;
  /** Marks the aggregated "Other …" row. */
  isOther?: boolean;
}

export interface ValueStripData {
  total: number;
  cash: number;
  invested: number;
  investedPercent: number;
  bookCost: number;
  holdingsCount: number;
  accountsCount: number;
  currencySplit: { currency: string; value: number; percentage: number }[];
  cashCurrencySplit: { currency: string; value: number; percentage: number }[];
  bookCostCurrencySplit: { currency: string; value: number; percentage: number }[];
}

const num = (v: number | null | undefined): number => Number(v) || 0;

/**
 * Total cost basis of invested (non-cash) holdings, plus a per-currency breakdown
 * (local value + base-weighted percentage) — mirrors the cash-by-currency split.
 */
export function computeBookCost(holdings: Holding[]): {
  total: number;
  currencySplit: { currency: string; value: number; percentage: number }[];
} {
  let total = 0;
  const byCurrency = new Map<string, { localValue: number; baseValue: number }>();

  for (const holding of holdings) {
    if (isCash(holding)) continue;
    const base = num(holding.costBasis?.base);
    const local = holding.costBasis?.local != null ? num(holding.costBasis.local) : base;
    const currency = holding.localCurrency || holding.baseCurrency;
    total += base;
    const existing = byCurrency.get(currency) ?? { localValue: 0, baseValue: 0 };
    byCurrency.set(currency, {
      localValue: existing.localValue + local,
      baseValue: existing.baseValue + base,
    });
  }

  const currencySplit = [...byCurrency.entries()]
    .map(([currency, value]) => ({
      currency,
      value: value.localValue,
      percentage: total > 0 ? (value.baseValue / total) * 100 : 0,
    }))
    .sort((a, b) => b.percentage - a.percentage);

  return { total, currencySplit };
}

function currencySymbol(currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 })
      .format(0)
      .replace(/[0-9.,\s]/g, "");
  } catch {
    return "";
  }
}

/** Compact money for tight spots (donut center, legend): $1.28M, $361K. */
export function formatCompact(value: number, currency: string): string {
  const symbol = currencySymbol(currency);
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${Math.round(abs / 1e3)}K`;
  return `${sign}${symbol}${Math.round(abs)}`;
}

/** Whole-dollar money for the value strip headline figures: $1,284,500. */
export function formatWhole(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Math.round(value)}`;
  }
}

function isCash(holding: Holding): boolean {
  return holding.holdingType?.toLowerCase() === "cash";
}

/** Headline figures for the value strip, derived from real holdings. */
export function computeValueStrip(holdings: Holding[], accounts: Account[]): ValueStripData {
  let total = 0;
  let cash = 0;
  const accountIds = new Set<string>();
  const byCurrency = new Map<string, number>();
  const cashByCurrency = new Map<string, { localValue: number; baseValue: number }>();

  for (const holding of holdings) {
    const base = num(holding.marketValue?.base);
    total += base;
    if (holding.accountId) accountIds.add(holding.accountId);
    const currency = holding.localCurrency || holding.baseCurrency;
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + base);

    if (isCash(holding)) {
      const localValue = holding.marketValue?.local != null ? num(holding.marketValue.local) : base;
      const existing = cashByCurrency.get(currency) ?? { localValue: 0, baseValue: 0 };
      cash += base;
      cashByCurrency.set(currency, {
        localValue: existing.localValue + localValue,
        baseValue: existing.baseValue + base,
      });
    }
  }

  const invested = total - cash;
  const currencySplit = [...byCurrency.entries()]
    .map(([currency, value]) => ({
      currency,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);
  const cashCurrencySplit = [...cashByCurrency.entries()]
    .map(([currency, value]) => ({
      currency,
      value: value.localValue,
      percentage: cash > 0 ? (value.baseValue / cash) * 100 : 0,
    }))
    .sort((a, b) => b.percentage - a.percentage);

  // Prefer in-scope accounts derived from holdings; fall back to the account list.
  const accountsCount = accountIds.size || accounts.length;

  const bookCost = computeBookCost(holdings);

  return {
    total,
    cash,
    invested,
    investedPercent: total > 0 ? (invested / total) * 100 : 0,
    bookCost: bookCost.total,
    holdingsCount: holdings.length,
    accountsCount,
    currencySplit,
    cashCurrencySplit,
    bookCostCurrencySplit: bookCost.currencySplit,
  };
}

/**
 * Map a scoped current-valuation summary into value-strip data. The summary has no cost basis,
 * so pass `holdings` to populate book cost; otherwise it falls back to 0.
 */
export function valueStripFromCurrentSummary(
  summary: CurrentValuationSummary,
  holdings: Holding[] = [],
): ValueStripData {
  const total = num(summary.totalValueBase);
  const cash = num(summary.cashBalanceBase);
  const invested = num(summary.investmentMarketValueBase);
  const bookCost = computeBookCost(holdings);

  return {
    total,
    cash,
    invested,
    investedPercent: total > 0 ? (invested / total) * 100 : 0,
    bookCost: bookCost.total,
    holdingsCount: summary.holdingsCount,
    accountsCount: summary.accountCount,
    currencySplit: summary.currencySplit.map((split) => ({
      currency: split.currency,
      value: num(split.valueBase),
      percentage: split.percentage,
    })),
    cashCurrencySplit: summary.cashCurrencySplit.map((split) => ({
      currency: split.currency,
      value: num(split.valueLocal ?? split.valueBase),
      percentage: split.percentage,
    })),
    bookCostCurrencySplit: bookCost.currencySplit,
  };
}

/** A node in the breakdown tree — supports nested taxonomies (parent → children → leaves). */
export interface BreakdownNode {
  id: string;
  name: string;
  value: number;
  /** 0–100, share of the lens total. */
  percentage: number;
  color: string;
  depth: number;
  children?: BreakdownNode[];
}

/**
 * Build a colored breakdown tree from a taxonomy's categories. Top-level nodes get distinct
 * theme chart colors; descendants inherit their parent's color so each branch reads as one family.
 */
export function buildBreakdownTree(
  categories: CategoryAllocation[] | undefined,
  total: number,
  depth = 0,
  inheritedColor?: string,
): BreakdownNode[] {
  if (!categories?.length) return [];
  return categories
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((c, index) => {
      const color = depth === 0 ? paletteColor(index) : (inheritedColor ?? paletteColor(index));
      return {
        id: c.categoryId,
        name: c.categoryName,
        value: c.value,
        percentage: total > 0 ? (c.value / total) * 100 : 0,
        color,
        depth,
        children: c.children?.length
          ? buildBreakdownTree(c.children, total, depth + 1, color)
          : undefined,
      };
    });
}

/** Flat lens items (currency, …) as breakdown nodes (no children). */
export function toBreakdownNodes(items: LensItem[]): BreakdownNode[] {
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    value: i.value,
    percentage: i.percentage,
    color: i.color,
    depth: 0,
  }));
}

function groupHoldings(
  holdings: Holding[],
  keyOf: (h: Holding) => { id: string; name: string } | null,
): LensItem[] {
  const totals = new Map<string, { name: string; value: number }>();
  let total = 0;
  for (const holding of holdings) {
    const key = keyOf(holding);
    if (!key) continue;
    const base = num(holding.marketValue?.base);
    total += base;
    const existing = totals.get(key.id);
    if (existing) existing.value += base;
    else totals.set(key.id, { name: key.name, value: base });
  }
  return [...totals.entries()]
    .map(([id, { name, value }], index) => ({
      id,
      name,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
      color: paletteColor(index),
    }))
    .sort((a, b) => b.value - a.value);
}

/** Per-currency lens, grouped by local currency. */
export function currencyLensItems(holdings: Holding[]): LensItem[] {
  return groupHoldings(holdings, (h) => {
    const currency = h.localCurrency || h.baseCurrency;
    return currency ? { id: currency, name: currency } : null;
  });
}

/**
 * Nested account breakdown: account groups at the top level, individual accounts as children.
 * Ungrouped accounts (no `account.group`) appear as flat top-level rows. Values come from real
 * per-account valuations (holdings are aggregated under a single id in "all" scope).
 */
export function accountTreeWeights(
  valuations: AccountValueSource[],
  accounts: Account[],
): BreakdownNode[] {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const groups = new Map<
    string,
    { name: string; value: number; accounts: { id: string; name: string; value: number }[] }
  >();
  let total = 0;
  for (const v of valuations) {
    const account = accountMap.get(v.accountId);
    if (!account) continue;
    const value =
      v.totalValueBase != null
        ? num(v.totalValueBase)
        : num(v.totalValue) * (num(v.fxRateToBase) || 1);
    if (value <= 0) continue;
    total += value;
    const key = account.group || account.name;
    const group = groups.get(key) ?? { name: key, value: 0, accounts: [] };
    group.value += value;
    group.accounts.push({ id: account.id, name: account.name, value });
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.value - a.value)
    .map((group, index) => {
      const color = paletteColor(index);
      const nested = group.accounts.length > 1;
      return {
        id: `grp:${group.name}`,
        name: group.name,
        value: group.value,
        percentage: total > 0 ? (group.value / total) * 100 : 0,
        color,
        depth: 0,
        children: nested
          ? group.accounts
              .sort((a, b) => b.value - a.value)
              .map((acc) => ({
                id: acc.id,
                name: acc.name,
                value: acc.value,
                percentage: total > 0 ? (acc.value / total) * 100 : 0,
                color,
                depth: 1,
              }))
          : undefined,
      };
    });
}
