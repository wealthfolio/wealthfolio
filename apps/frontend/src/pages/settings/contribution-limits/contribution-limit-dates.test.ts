import { describe, expect, it } from "vitest";
import type { ContributionLimit } from "@/lib/types";
import { isContributionLimitCurrent } from "./contribution-limit-dates";

const limit = (fields: Partial<ContributionLimit>): ContributionLimit => ({
  id: "limit",
  groupName: "ISA",
  contributionYear: 2026,
  limitAmount: 20000,
  ...fields,
});

describe("isContributionLimitCurrent", () => {
  // Saved by the date picker in London: local midnight on each day.
  const taxYear2026 = limit({
    startDate: "2026-03-31T23:00:00.000Z",
    endDate: "2027-03-30T23:00:00.000Z",
  });
  const taxYear2027 = limit({
    contributionYear: 2027,
    startDate: "2027-03-31T23:00:00.000Z",
    endDate: "2028-03-30T23:00:00.000Z",
  });

  it("goes by a limit's dates rather than its year", () => {
    expect(isContributionLimitCurrent(taxYear2026, "2027-02-15", "Europe/London")).toBe(true);
    expect(isContributionLimitCurrent(taxYear2027, "2027-02-15", "Europe/London")).toBe(false);
  });

  it("includes the first and last days in the app's timezone", () => {
    expect(isContributionLimitCurrent(taxYear2026, "2026-03-31", "Europe/London")).toBe(false);
    expect(isContributionLimitCurrent(taxYear2026, "2026-04-01", "Europe/London")).toBe(true);
    expect(isContributionLimitCurrent(taxYear2026, "2027-03-31", "Europe/London")).toBe(true);
    expect(isContributionLimitCurrent(taxYear2026, "2027-04-01", "Europe/London")).toBe(false);
  });

  it("goes by the year for a limit without dates or with the former default dates", () => {
    const formerDefaults = limit({
      startDate: "2026-01-01T12:00:00.000Z",
      endDate: "2026-12-31T12:00:00.000Z",
    });
    for (const yearLimit of [limit({}), formerDefaults]) {
      // Noon UTC on 31 December is already 1 January in Auckland.
      expect(isContributionLimitCurrent(yearLimit, "2026-12-31", "Pacific/Auckland")).toBe(true);
      expect(isContributionLimitCurrent(yearLimit, "2027-01-01", "Pacific/Auckland")).toBe(false);
    }
  });

  it("leaves out a limit whose dates can't be read instead of throwing", () => {
    const unreadable = limit({ startDate: "not a date", endDate: "2026-12-31T00:00:00.000Z" });
    expect(isContributionLimitCurrent(unreadable, "2026-06-15", "Europe/London")).toBe(false);
  });
});
