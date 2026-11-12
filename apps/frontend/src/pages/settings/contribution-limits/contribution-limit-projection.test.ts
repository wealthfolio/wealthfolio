import { describe, expect, it } from "vitest";
import type { ContributionLimit } from "@/lib/types";
import { withProjectedRecurringLimits } from "./contribution-limit-projection";

const limit = (overrides: Partial<ContributionLimit>): ContributionLimit => ({
  id: "limit1",
  groupName: "TFSA",
  contributionYear: 2026,
  limitAmount: 7000,
  isRecurring: true,
  ...overrides,
});

const projectedYears = (limits: ContributionLimit[], timezone = "UTC") =>
  withProjectedRecurringLimits(limits, 2026, 3, timezone)
    .filter((projection) => projection.isProjected)
    .map(({ contributionYear, startDate, endDate, sourceYear }) => ({
      contributionYear,
      startDate,
      endDate,
      sourceYear,
    }));

describe("withProjectedRecurringLimits", () => {
  it.each([false, true])("bounds work for an extreme saved year (recurring: %s)", (isRecurring) => {
    const future = limit({ id: "extreme", contributionYear: 2147483647, isRecurring });
    const result = withProjectedRecurringLimits([limit({}), future], 2026, 3, "UTC");
    expect(
      result.filter((entry) => entry.isProjected).map((entry) => entry.contributionYear),
    ).toEqual([2027, 2028, 2029]);
    expect(result.find((entry) => entry.id === "extreme")).toMatchObject(future);
  });

  it.each([
    // Local midnight on 1 January is still 31 December in UTC east of Greenwich.
    [
      "Europe/Berlin",
      "2025-12-31T23:00:00.000Z",
      "2026-12-30T23:00:00.000Z",
      "2026-12-31T23:00:00.000Z",
      "2027-12-30T23:00:00.000Z",
    ],
    [
      "Asia/Tokyo",
      "2025-12-31T15:00:00.000Z",
      "2026-12-30T15:00:00.000Z",
      "2026-12-31T15:00:00.000Z",
      "2027-12-30T15:00:00.000Z",
    ],
    [
      "America/New_York",
      "2026-01-01T05:00:00.000Z",
      "2026-12-31T05:00:00.000Z",
      "2027-01-01T05:00:00.000Z",
      "2027-12-31T05:00:00.000Z",
    ],
  ])(
    "keeps the year's first and last days in %s",
    (timezone, startDate, endDate, nextStart, nextEnd) => {
      const [nextYear] = projectedYears([limit({ startDate, endDate })], timezone);
      expect(nextYear).toEqual({
        contributionYear: 2027,
        startDate: nextStart,
        endDate: nextEnd,
        sourceYear: 2026,
      });
    },
  );

  it("keeps a tax year that starts in April across the new year", () => {
    // UK ISA: 6 April 2026 to 5 April 2027, local midnights in London (BST).
    const [nextYear, yearAfter] = projectedYears(
      [
        limit({
          groupName: "ISA",
          startDate: "2026-04-05T23:00:00.000Z",
          endDate: "2027-04-04T23:00:00.000Z",
        }),
      ],
      "Europe/London",
    );
    expect(nextYear).toMatchObject({
      contributionYear: 2027,
      startDate: "2027-04-05T23:00:00.000Z",
      endDate: "2028-04-04T23:00:00.000Z",
    });
    expect(yearAfter).toMatchObject({
      contributionYear: 2028,
      startDate: "2028-04-05T23:00:00.000Z",
      endDate: "2029-04-04T23:00:00.000Z",
    });
  });

  it("moves a 29 February to the 28th in a year without one", () => {
    const [nextYear] = projectedYears([
      limit({
        contributionYear: 2028,
        startDate: "2028-02-29T00:00:00.000Z",
        endDate: "2029-02-27T00:00:00.000Z",
      }),
    ]).filter((projection) => projection.contributionYear === 2029);
    expect(nextYear.startDate).toBe("2029-02-28T00:00:00.000Z");
  });

  it("keeps projecting the years before a later year saved first", () => {
    const years = projectedYears([
      limit({ id: "limit2026" }),
      // The projected 2028 card, saved before 2027's.
      limit({ id: "limit2028", contributionYear: 2028 }),
    ]);
    expect(years.map(({ contributionYear, sourceYear }) => [contributionYear, sourceYear])).toEqual(
      [
        [2027, 2026],
        [2029, 2028],
      ],
    );
  });

  it("stops after a limit that doesn't recur, and resumes before it", () => {
    const years = projectedYears([
      limit({ id: "limit2026" }),
      limit({ id: "limit2028", contributionYear: 2028, isRecurring: false }),
    ]);
    expect(years.map(({ contributionYear }) => contributionYear)).toEqual([2027]);
  });

  it("projects same-named limits for different accounts separately", () => {
    const projections = withProjectedRecurringLimits(
      [
        limit({ id: "spouseA2026", accountIds: "a" }),
        limit({ id: "spouseB2026", accountIds: "b" }),
        // Only spouse A has saved 2027; spouse B's 2027 still projects.
        limit({ id: "spouseA2027", accountIds: "a", contributionYear: 2027 }),
      ],
      2026,
      1,
      "UTC",
    ).filter((projection) => projection.isProjected);
    expect(
      projections.map(({ sourceLimitId, contributionYear }) => [sourceLimitId, contributionYear]),
    ).toEqual([["spouseB2026", 2027]]);
  });

  it("matches the same accounts listed in another order", () => {
    const years = projectedYears([
      limit({ id: "limit2026", accountIds: "a,b" }),
      limit({ id: "limit2027", accountIds: "b, a", contributionYear: 2027, isRecurring: false }),
    ]);
    expect(years).toEqual([]);
  });
});
