import type { ReturnData } from "@/lib/types";

export interface MonthlyReturnCell {
  month: number; // 0-indexed (0 = Jan, 11 = Dec)
  value: number; // Decimal (e.g. 0.05 for 5%)
}

export interface YearPerformanceData {
  year: number;
  months: (number | null)[]; // Array of length 12 (Jan = index 0 .. Dec = index 11), null if no data
  yearTotal: number | null; // Compounded annual return (or YTD)
}

export interface MonthlyComparisonCell {
  month: number;
  portfolioReturn: number | null;
  benchmarkReturn: number | null;
  relativeReturn: number | null; // portfolioReturn - benchmarkReturn
}

export interface YearComparisonData {
  year: number;
  months: (MonthlyComparisonCell | null)[]; // 12 elements
  portfolioYearTotal: number | null;
  benchmarkYearTotal: number | null;
  relativeYearTotal: number | null;
}

export type MonthlyViewMode = "portfolio" | "benchmark" | "relative";

const ONE = 1;

/**
 * Parses "YYYY-MM-DD" into { year, monthIndex (0..11), day }
 */
function parseDateParts(dateStr: string): { year: number; month: number; day: number } | null {
  const parts = dateStr.split("-");
  if (parts.length < 3) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // 0-based
  const day = parseInt(parts[2], 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
  return { year, month, day };
}

/**
 * Calculates monthly returns for every year/month present in a cumulative return series.
 * Series should be sorted by date ascending.
 *
 * For each month:
 * Return = (1 + R_end_of_month) / (1 + R_end_of_previous_month) - 1
 */
export function calculateMonthlyReturns(series: ReturnData[]): YearPerformanceData[] {
  if (!series || series.length < 2) {
    return [];
  }

  // Sort series by date ascending
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));

  // Map of "YYYY-MM" to the last ReturnData point in that month
  // Also track the first point of each month to find the starting baseline
  const pointsByMonth = new Map<string, ReturnData[]>();

  for (const point of sorted) {
    const parts = parseDateParts(point.date);
    if (!parts) continue;
    const monthKey = `${parts.year}-${String(parts.month + 1).padStart(2, "0")}`;
    const list = pointsByMonth.get(monthKey) ?? [];
    list.push(point);
    pointsByMonth.set(monthKey, list);
  }

  const sortedMonthKeys = Array.from(pointsByMonth.keys()).sort();
  if (sortedMonthKeys.length === 0) return [];

  // Map of monthKey -> monthly return (number)
  const monthlyReturnMap = new Map<string, number>();

  // Map of monthKey -> last cumulative value
  const lastCumulativeByMonth = new Map<string, number>();
  for (const [key, pts] of pointsByMonth.entries()) {
    lastCumulativeByMonth.set(key, pts[pts.length - 1].value);
  }

  // To compute the return for the first month in history:
  // we look at the first point in that month.
  for (let i = 0; i < sortedMonthKeys.length; i++) {
    const monthKey = sortedMonthKeys[i];
    const pts = pointsByMonth.get(monthKey)!;
    const endPoint = pts[pts.length - 1];

    let baseFactor: number;

    if (i === 0) {
      // First month: base is the first point in this month
      const startPoint = pts[0];
      baseFactor = ONE + Number(startPoint.value);
    } else {
      // Base is the last point of the previous available month
      const prevMonthKey = sortedMonthKeys[i - 1];
      const prevVal = lastCumulativeByMonth.get(prevMonthKey)!;
      baseFactor = ONE + Number(prevVal);
    }

    const endFactor = ONE + Number(endPoint.value);

    if (baseFactor !== 0 && Number.isFinite(baseFactor) && Number.isFinite(endFactor)) {
      const monthReturn = endFactor / baseFactor - ONE;
      monthlyReturnMap.set(monthKey, monthReturn);
    }
  }

  // Group months by year
  const yearsMap = new Map<number, (number | null)[]>();

  for (const [monthKey, ret] of monthlyReturnMap.entries()) {
    const [yStr, mStr] = monthKey.split("-");
    const year = parseInt(yStr, 10);
    const monthIdx = parseInt(mStr, 10) - 1;

    if (!yearsMap.has(year)) {
      yearsMap.set(year, Array(12).fill(null));
    }
    yearsMap.get(year)![monthIdx] = ret;
  }

  const sortedYears = Array.from(yearsMap.keys()).sort((a, b) => b - a); // Descending years

  return sortedYears.map((year) => {
    const months = yearsMap.get(year)!;
    // Compounded year total: product of (1 + r_m) - 1 for all non-null months
    let compoundFactor = ONE;
    let hasAnyMonth = false;

    for (const mRet of months) {
      if (mRet !== null && Number.isFinite(mRet)) {
        compoundFactor *= ONE + mRet;
        hasAnyMonth = true;
      }
    }

    const yearTotal = hasAnyMonth ? compoundFactor - ONE : null;

    return {
      year,
      months,
      yearTotal,
    };
  });
}

/**
 * Combines portfolio monthly returns with benchmark monthly returns to produce
 * a full comparison matrix including excess returns (alpha).
 */
export function buildMonthlyComparison(
  portfolioData: YearPerformanceData[],
  benchmarkData: YearPerformanceData[] | null | undefined,
): YearComparisonData[] {
  const benchmarkYearMap = new Map<number, YearPerformanceData>();
  if (benchmarkData) {
    for (const b of benchmarkData) {
      benchmarkYearMap.set(b.year, b);
    }
  }

  // Collect all unique years in descending order
  const allYearsSet = new Set<number>();
  for (const p of portfolioData) allYearsSet.add(p.year);
  if (benchmarkData) {
    for (const b of benchmarkData) allYearsSet.add(b.year);
  }
  const allYears = Array.from(allYearsSet).sort((a, b) => b - a);

  const portfolioYearMap = new Map<number, YearPerformanceData>();
  for (const p of portfolioData) {
    portfolioYearMap.set(p.year, p);
  }

  return allYears.map((year) => {
    const pYear = portfolioYearMap.get(year);
    const bYear = benchmarkYearMap.get(year);

    const months: (MonthlyComparisonCell | null)[] = Array(12).fill(null);

    for (let m = 0; m < 12; m++) {
      const pRet = pYear?.months[m] ?? null;
      const bRet = bYear?.months[m] ?? null;

      if (pRet === null && bRet === null) {
        months[m] = null;
      } else {
        const relativeReturn =
          pRet !== null && bRet !== null ? pRet - bRet : pRet !== null ? pRet : null;

        months[m] = {
          month: m,
          portfolioReturn: pRet,
          benchmarkReturn: bRet,
          relativeReturn,
        };
      }
    }

    const portfolioYearTotal = pYear?.yearTotal ?? null;
    const benchmarkYearTotal = bYear?.yearTotal ?? null;
    const relativeYearTotal =
      portfolioYearTotal !== null && benchmarkYearTotal !== null
        ? portfolioYearTotal - benchmarkYearTotal
        : portfolioYearTotal;

    return {
      year,
      months,
      portfolioYearTotal,
      benchmarkYearTotal,
      relativeYearTotal,
    };
  });
}
