import type { CategoryAllocation, NetWorthHistoryPoint, TaxonomyAllocation } from "@/lib/types";
import { formatPercent } from "@/lib/utils";

// Goldish orange net-worth theme (matches the history chart). Reserved for the
// chart/brand; value numbers use semantic green/red tones (orange == warning).
export const THEME_COLOR = "hsl(38 75% 50%)";
export const THEME_COLOR_LIGHT = "hsl(38 75% 50% / 0.12)";

/** Semantic text tone for a signed value: green gain, red loss, muted when flat. */
export function toneClass(value: number): string {
  if (Math.abs(value) < 0.005) return "text-muted-foreground/60";
  return value > 0 ? "text-success" : "text-destructive";
}

/** Semantic fill color for bars/meters: green for positive/zero, red for negative. */
export function toneColor(value: number): string {
  return value < -0.005 ? "var(--destructive)" : "var(--success)";
}

/** Softened semantic fill for chart bars/areas (dimmer than the text tone). */
export function toneFill(value: number): string {
  const base = value < -0.005 ? "var(--destructive)" : "var(--success)";
  return `color-mix(in srgb, ${base} 60%, transparent)`;
}

export const CARD_LABEL = "text-muted-foreground/70 text-xs font-semibold uppercase tracking-wide";

// Muted, semantic category palette (tuned for the warm/cream theme). Used for
// the composition bar, breakdown row dots, and the detail-sheet icons so they
// stay consistent. Liabilities keep the semantic red.
// NOTE: tuned for light mode — dark-mode variants would need theme-aware tokens.
export const CATEGORY_CSS_COLORS: Record<string, string> = {
  properties: "#4b4137", // warm dark taupe / charcoal
  investments: "#6f7544", // muted olive green
  cash: "#d8c98f", // pale cream / light gold
  vehicles: "#6d7c86", // muted slate
  otherAssets: "#928d83", // medium warm gray
  preciousMetals: "#b8923a", // soft gold
  collectibles: "#8a6b49", // muted brown
  liabilities: "var(--destructive)",
};

export interface BreakdownEntry {
  category: string;
  name: string;
  value: number;
  assetId?: string;
  children?: BreakdownEntry[];
}

/** A breakdown row selected for the detail drawer. */
export interface SelectedCategory {
  /** History/breakdown key: the category key for assets, the assetId for liabilities. */
  key: string;
  name: string;
  value: number;
  isLiability: boolean;
  isInvestment: boolean;
  children: BreakdownEntry[];
}

export interface ParsedNetWorth {
  netWorth: number;
  assets: { total: number; breakdown: BreakdownEntry[] };
  liabilities: { total: number; breakdown: BreakdownEntry[] };
}

/**
 * The Asset-Classes allocation counts account cash as a "Cash" class, but net
 * worth tracks Cash as its own breakdown row. Drop the Cash class (and rescale
 * the remaining percentages) so the Investments drawer reflects the investment
 * portfolio and matches the Investments row value.
 */
export function investmentAllocation(
  allocation?: TaxonomyAllocation,
): TaxonomyAllocation | undefined {
  if (!allocation) return undefined;
  const kept = allocation.categories.filter(
    (category) => category.categoryName.toLowerCase() !== "cash",
  );
  const total = kept.reduce((sum, category) => sum + category.value, 0);
  const rescale = (categories: CategoryAllocation[]): CategoryAllocation[] =>
    categories.map((category) => ({
      ...category,
      percentage: total > 0 ? (category.value / total) * 100 : 0,
      children: category.children ? rescale(category.children) : category.children,
    }));
  return { ...allocation, categories: rescale(kept) };
}

export interface ParsedHistoryPoint {
  date: string;
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  portfolioValue: number;
  alternativeAssetsValue: number;
  netContribution: number;
  /** Per-category / per-liability value at this date (keys match the breakdown rows). */
  breakdown: Record<string, number>;
}

const num = (value: string | number | undefined | null): number => {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Parse the raw history response (decimal strings, or numbers in web mode) into numbers. */
export function parseHistory(history: NetWorthHistoryPoint[] | undefined): ParsedHistoryPoint[] {
  if (!history) return [];
  return history.map((point) => {
    const breakdown: Record<string, number> = {};
    for (const [key, value] of Object.entries(point.breakdown ?? {})) {
      breakdown[key] = num(value);
    }
    return {
      date: point.date,
      netWorth: num(point.netWorth),
      totalAssets: num(point.totalAssets),
      totalLiabilities: num(point.totalLiabilities),
      portfolioValue: num(point.portfolioValue),
      alternativeAssetsValue: num(point.alternativeAssetsValue),
      netContribution: num(point.netContribution),
      breakdown,
    };
  });
}

/** Series of values for a breakdown key across the history (forward-filled by the backend). */
export function seriesFor(history: ParsedHistoryPoint[], key: string): number[] {
  return history.map((point) => point.breakdown[key] ?? 0);
}

export interface Change {
  amount: number;
  percent: number;
}

/**
 * Change over the range from a value series. Liabilities are stored as positive
 * magnitudes, so a reduction is expressed as a positive (good) change.
 */
export function deriveChange(series: number[], isLiability: boolean): Change {
  if (series.length < 2) return { amount: 0, percent: 0 };
  const first = series[0];
  const last = series[series.length - 1];
  const amount = isLiability ? first - last : last - first;
  const base = Math.abs(first);
  return { amount, percent: base > 0 ? amount / base : 0 };
}

/** Percent is a ratio (0.145 = 14.5%); drop decimals for very large swings. */
export function formatChangePercent(percent: number): string {
  const abs = Math.abs(percent);
  return formatPercent(abs, { digits: abs >= 10 ? 0 : 1, signDisplay: "never" });
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 365.25 / 12;

function daysBetween(fromISO: string, toISO: string): number {
  return Math.max(0, (new Date(toISO).getTime() - new Date(fromISO).getTime()) / MS_PER_DAY);
}

/** Net worth as-of a date: last point on/before it, else the earliest point. */
function netWorthAsOf(history: ParsedHistoryPoint[], iso: string): number {
  let result: number | null = null;
  for (const point of history) {
    if (point.date <= iso) result = point.netWorth;
    else break;
  }
  return result ?? history[0]?.netWorth ?? 0;
}

export interface Velocity {
  netChange: number;
  marketGains: number;
  contributions: number;
  equityBuilt: number;
  perMonth: number;
  /** Number of months in the range (for per-month vs total displays). */
  months: number;
}

/**
 * Decompose net worth change over the range into market gains (portfolio price +
 * alternative-asset appreciation), contributions, and equity built (liability
 * reduction). These three sum to the net worth change.
 */
export function computeVelocity(history: ParsedHistoryPoint[]): Velocity | null {
  if (history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];

  const portfolioGain =
    last.portfolioValue - last.netContribution - (first.portfolioValue - first.netContribution);
  const altGain = last.alternativeAssetsValue - first.alternativeAssetsValue;
  const contributions = last.netContribution - first.netContribution;
  const equityBuilt = first.totalLiabilities - last.totalLiabilities;
  const netChange = last.netWorth - first.netWorth;

  const months = daysBetween(first.date, last.date) / DAYS_PER_MONTH;
  const perMonth = months > 0 ? netChange / months : netChange;

  return {
    netChange,
    marketGains: portfolioGain + altGain,
    contributions,
    equityBuilt,
    perMonth,
    months,
  };
}

/** Average monthly net worth change across a history span (for the trailing-year baseline). */
export function averageMonthlyChange(history: ParsedHistoryPoint[]): number {
  return computeVelocity(history)?.perMonth ?? 0;
}

export interface Momentum {
  currentChange: number;
  priorChange: number | null;
  beatBy: number | null;
  bars: { month: string; value: number; current: boolean }[];
}

/**
 * Compare the current range's net worth change to the equal-length prior window.
 * `longHistory` must extend back at least one range-length before `rangeStartISO`.
 */
export function computeMomentum(
  longHistory: ParsedHistoryPoint[],
  rangeStartISO: string,
  rangeEndISO: string,
): Momentum | null {
  if (longHistory.length < 2) return null;

  const rangeDays = daysBetween(rangeStartISO, rangeEndISO) || 1;
  const priorStartISO = new Date(new Date(rangeStartISO).getTime() - rangeDays * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);

  const nwEnd = netWorthAsOf(longHistory, rangeEndISO);
  const nwStart = netWorthAsOf(longHistory, rangeStartISO);
  const currentChange = nwEnd - nwStart;

  const earliest = longHistory[0].date;
  const hasPrior = earliest <= priorStartISO;
  const nwPriorStart = netWorthAsOf(longHistory, priorStartISO);
  const priorChange = hasPrior ? nwStart - nwPriorStart : null;
  const beatBy = priorChange != null ? currentChange - priorChange : null;

  // Monthly net worth change bars across the prior + current windows.
  const monthEnd = new Map<string, number>();
  for (const point of longHistory) {
    if (point.date < priorStartISO) continue;
    monthEnd.set(point.date.slice(0, 7), point.netWorth);
  }
  const months = [...monthEnd.keys()].sort();
  const currentMonth = rangeStartISO.slice(0, 7);
  let prev: number | null = null;
  const bars = months.map((month) => {
    const end = monthEnd.get(month)!;
    const value = prev == null ? 0 : end - prev;
    prev = end;
    return { month, value, current: month >= currentMonth };
  });

  return { currentChange, priorChange, beatBy, bars };
}
