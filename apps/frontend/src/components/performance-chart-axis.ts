import type { useDateFormatting } from "@wealthfolio/ui";

type DateFormattingApi = ReturnType<typeof useDateFormatting>;

export type PerformanceAxisGranularity = "day" | "month" | "year";

export interface PerformanceAxis {
  ticks: string[];
  granularity: PerformanceAxisGranularity;
  /** Month labels carry the year once the range passes a year. */
  showYear: boolean;
}

const DAY_LABEL_MAX_DAYS = 92;
const MONTH_LABEL_MAX_DAYS = 3 * 366;

function daysBetween(from: string, to: string): number {
  const ms =
    Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * X-axis ticks whose labels never repeat: evenly spaced days up to about three
 * months, then the first date of each month (or year), thinned to `maxTicks`.
 * A fixed index interval with month labels put two "Aug" ticks on a 3M chart.
 *
 * `edgeGap` is the share of the plot at each end where a centred label would be
 * cut off (phones plot to the card's edge); no tick is placed there.
 */
export function performanceAxis(dates: string[], maxTicks: number, edgeGap = 0): PerformanceAxis {
  if (dates.length < 2) return { ticks: dates, granularity: "day", showYear: false };

  const last = dates.length - 1;
  const firstIndex = Math.ceil(edgeGap * last);
  const lastIndex = Math.floor((1 - edgeGap) * last);
  const span = daysBetween(dates[0], dates[last]);
  if (span <= DAY_LABEL_MAX_DAYS) {
    if (firstIndex > lastIndex) {
      return { ticks: [dates[Math.round(last / 2)]], granularity: "day", showYear: false };
    }
    const step = Math.max(1, Math.ceil((lastIndex - firstIndex) / Math.max(1, maxTicks - 1)));
    const ticks: string[] = [];
    for (let index = firstIndex; index <= lastIndex; index += step) ticks.push(dates[index]);
    return { ticks, granularity: "day", showYear: false };
  }

  const granularity: PerformanceAxisGranularity = span <= MONTH_LABEL_MAX_DAYS ? "month" : "year";
  const periodOf = (date: string) =>
    granularity === "month" ? date.slice(0, 7) : date.slice(0, 4);
  // The first point opens a partial period; label where each full period starts.
  const starts: string[] = [];
  let previous = periodOf(dates[0]);
  dates.forEach((date, index) => {
    const period = periodOf(date);
    if (period !== previous) {
      if (index >= firstIndex && index <= lastIndex) starts.push(date);
      previous = period;
    }
  });
  const step = Math.max(1, Math.ceil(starts.length / maxTicks));
  const ticks = starts.filter((_, index) => index % step === 0);
  // Month labels need the year once the same month appears twice (a 366-day span can do that).
  const months = new Set(ticks.map((date) => date.slice(5, 7)));
  return { ticks, granularity, showYear: span > 366 || months.size < ticks.length };
}

export function formatPerformanceAxisDate(
  date: string,
  axis: PerformanceAxis,
  formatting: DateFormattingApi,
): string {
  switch (axis.granularity) {
    case "day":
      return formatting.formatCalendarDate(date, { month: "short", day: "numeric" });
    case "month":
      return formatting.formatCalendarDate(
        date,
        axis.showYear ? { month: "short", year: "2-digit" } : { month: "short" },
      );
    case "year":
      return formatting.formatCalendarDate(date, { year: "numeric" });
  }
}

const PERCENT_STEPS = [
  0.001, 0.0025, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50,
  100,
];
/** Float slack when deciding which step a value falls on. */
const STEP_EPSILON = 1e-9;

/**
 * Smallest and largest value, always including 0. A loop, because spreading long
 * daily series into Math.min can exceed the engine's argument limit.
 */
export function valueRange(values: Iterable<number>) {
  let min = 0;
  let max = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** Decimals a percent label needs to show the step exactly (2.5% → 1, 0.25% → 2). */
function percentDigits(step: number): number {
  const percent = step * 100;
  let digits = 0;
  while (
    digits < 3 &&
    Math.abs(Math.round(percent * 10 ** digits) - percent * 10 ** digits) > STEP_EPSILON
  ) {
    digits += 1;
  }
  return digits;
}

/** Round y-axis ticks (10%, 20%, not 10.50%) that cover every value, and the digits they need. */
export function percentTicks(values: Iterable<number>, maxIntervals: number) {
  const { min, max } = valueRange(values);
  const lowIndex = (step: number) => Math.floor(min / step + STEP_EPSILON);
  const highIndex = (step: number) => Math.ceil(max / step - STEP_EPSILON);
  const step =
    PERCENT_STEPS.find((candidate) => highIndex(candidate) - lowIndex(candidate) <= maxIntervals) ??
    PERCENT_STEPS[PERCENT_STEPS.length - 1];
  const ticks: number[] = [];
  // Whole multiples of the step: no float drift, and `+ 0` turns -0 into 0 so no "-0%".
  for (let index = lowIndex(step); index <= highIndex(step); index += 1) {
    ticks.push(index * step + 0);
  }
  return { ticks, digits: percentDigits(step) };
}
