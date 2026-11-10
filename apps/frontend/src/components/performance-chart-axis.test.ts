import { describe, expect, it } from "vitest";
import { percentTicks, performanceAxis, valueRange } from "./performance-chart-axis";

function dailyDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let ms = Date.parse(`${from}T00:00:00Z`);
    ms <= Date.parse(`${to}T00:00:00Z`);
    ms += 86_400_000
  ) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

describe("percentTicks", () => {
  it("covers the highest value with its top tick", () => {
    const { ticks } = percentTicks([0, 0.22], 5);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(0.22);
    expect(ticks[0]).toBe(0);
  });

  it("puts a positive zero on the zero line of an all-negative chart", () => {
    const { ticks } = percentTicks([-0.3, -0.05], 5);
    expect(ticks.at(-1)).toBe(0);
    expect(Object.is(ticks.at(-1), -0)).toBe(false);
    expect(ticks[0]).toBeLessThanOrEqual(-0.3);
  });

  it("gives labels the decimals their step needs", () => {
    expect(percentTicks([0, 0.11], 5)).toMatchObject({ digits: 1 });
    expect(percentTicks([0, 0.011], 5)).toMatchObject({ digits: 2 });
    expect(percentTicks([0, 0.4], 5)).toMatchObject({ digits: 0 });
  });

  it("keeps huge ranges within the tick budget", () => {
    expect(percentTicks([0, 100], 5).ticks.length).toBeLessThanOrEqual(6);
  });

  it("returns the zero line alone for no values", () => {
    expect(percentTicks([], 5).ticks).toEqual([0]);
  });
});

describe("valueRange", () => {
  it("handles more values than a spread call accepts", () => {
    const values = Array.from({ length: 300_000 }, (_, index) => Math.sin(index));
    expect(valueRange(values).max).toBeGreaterThan(0.99);
  });
});

describe("performanceAxis", () => {
  it("shows the year when a 366-day span repeats a month", () => {
    const axis = performanceAxis(dailyDates("2024-02-29", "2025-03-01"), 6);
    expect(axis.granularity).toBe("month");
    expect(axis.showYear).toBe(true);
  });

  it("labels a 3-month range by day, without repeats", () => {
    const axis = performanceAxis(dailyDates("2026-08-09", "2026-11-09"), 6);
    expect(axis.granularity).toBe("day");
    expect(new Set(axis.ticks).size).toBe(axis.ticks.length);
    expect(axis.ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps day ticks out of the edges when a gap is given", () => {
    const dates = dailyDates("2026-10-09", "2026-11-09");
    const last = dates.length - 1;
    expect(performanceAxis(dates, 4).ticks[0]).toBe(dates[0]);

    const { ticks } = performanceAxis(dates, 4, 0.08);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const tick of ticks) {
      const position = dates.indexOf(tick) / last;
      expect(position).toBeGreaterThanOrEqual(0.08);
      expect(position).toBeLessThanOrEqual(0.92);
    }
  });

  it("drops month starts that fall in the edge gap", () => {
    // Dec 1 sits 2% into this range, Nov 1 of the next year 2% from its end.
    const dates = dailyDates("2024-11-24", "2025-11-08");
    expect(performanceAxis(dates, 12).ticks).toContain("2024-12-01");
    const { ticks } = performanceAxis(dates, 12, 0.05);
    expect(ticks).not.toContain("2024-12-01");
    expect(ticks).not.toContain("2025-11-01");
    expect(ticks).toContain("2025-01-01");
  });

  it("still labels a two-point range inside the gap", () => {
    expect(performanceAxis(["2026-11-08", "2026-11-09"], 4, 0.08).ticks).toHaveLength(1);
  });
});
