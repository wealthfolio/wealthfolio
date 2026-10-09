import type { ContributionLimit } from "@/lib/types";

export interface ProjectedContributionLimit extends ContributionLimit {
  isProjected: boolean;
  sourceLimitId?: string;
  /** The year of the real limit this projection was derived from. */
  sourceYear?: number;
}

/** How many years past the reference year to project a recurring limit forward. */
const FUTURE_PROJECTION_YEARS = 3;

function shiftIsoYear(isoDate: string, year: number): string {
  return isoDate.replace(/^\d{4}/, String(year));
}

/**
 * Combines real limits with virtual, non-persisted projections for recurring
 * limits that don't yet have an explicit row for a given future year. The
 * most recent limit in a group (matched by groupName) that has
 * `isRecurring: true` is used as the template for every missing year between
 * itself and `referenceYear + yearsAhead`.
 */
export function withProjectedRecurringLimits(
  limits: ContributionLimit[],
  referenceYear: number = new Date().getFullYear(),
  yearsAhead: number = FUTURE_PROJECTION_YEARS,
): ProjectedContributionLimit[] {
  const real: ProjectedContributionLimit[] = limits.map((limit) => ({
    ...limit,
    isProjected: false,
  }));

  const byGroup = new Map<string, ContributionLimit[]>();
  for (const limit of limits) {
    const group = byGroup.get(limit.groupName) ?? [];
    group.push(limit);
    byGroup.set(limit.groupName, group);
  }

  const projected: ProjectedContributionLimit[] = [];

  for (const groupLimits of byGroup.values()) {
    const maxYear = Math.max(...groupLimits.map((limit) => limit.contributionYear));
    const latestYearLimits = groupLimits.filter((limit) => limit.contributionYear === maxYear);
    // Prefer a recurring row when several limits share the same group name and year
    // (e.g. one per account) so recurrence isn't lost to arbitrary ordering.
    const latest = latestYearLimits.find((limit) => limit.isRecurring) ?? latestYearLimits[0];
    if (!latest?.isRecurring) continue;

    const existingYears = new Set(groupLimits.map((limit) => limit.contributionYear));
    const lastProjectedYear = Math.max(referenceYear, latest.contributionYear) + yearsAhead;
    // Only project forward from today — an old, unrenewed recurring limit
    // shouldn't backfill placeholders for years the user simply never visited.
    const firstProjectedYear = Math.max(latest.contributionYear + 1, referenceYear);

    for (let year = firstProjectedYear; year <= lastProjectedYear; year++) {
      if (existingYears.has(year)) continue;
      projected.push({
        ...latest,
        id: `projected:${latest.id}:${year}`,
        contributionYear: year,
        startDate: latest.startDate ? shiftIsoYear(latest.startDate, year) : latest.startDate,
        endDate: latest.endDate ? shiftIsoYear(latest.endDate, year) : latest.endDate,
        createdAt: undefined,
        updatedAt: undefined,
        isProjected: true,
        sourceLimitId: latest.id,
        sourceYear: latest.contributionYear,
      });
    }
  }

  return [...real, ...projected];
}
