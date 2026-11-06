import { fromAbsolute } from "@internationalized/date";
import { MAX_CONTRIBUTION_YEAR } from "@/lib/constants";
import type { ContributionLimit } from "@/lib/types";

export interface ProjectedContributionLimit extends ContributionLimit {
  isProjected: boolean;
  sourceLimitId?: string;
  /** The year of the real limit this projection was derived from. */
  sourceYear?: number;
}

/** How many years past the reference year to project a recurring limit forward. */
const FUTURE_PROJECTION_YEARS = 3;

/**
 * Moves a saved date by whole years on the calendar of `timezone`, keeping its
 * time of day; 29 February moves to the 28th. Saved dates are instants, so
 * their UTC year can differ from the day they fall on (local midnight on
 * 1 January is still 31 December in UTC east of Greenwich).
 */
function addYears(isoDate: string, years: number, timezone: string): string {
  const instant = Date.parse(isoDate);
  if (Number.isNaN(instant)) return isoDate;
  return fromAbsolute(instant, timezone).add({ years }).toDate().toISOString();
}

/** Account IDs as a stable key, so the same accounts in another order match. */
function accountScope(limit: ContributionLimit): string {
  return (limit.accountIds ?? "")
    .split(",")
    .map((accountId) => accountId.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

/**
 * Combines real limits with virtual, non-persisted projections for recurring
 * limits that don't yet have an explicit row for a given year. Each missing
 * year from `referenceYear` to `yearsAhead` past the reference year uses the
 * group's (matched by groupName and accounts) closest earlier limit as its template, when
 * that limit has `isRecurring: true`. Dates move by the years between them in
 * `timezone`, the timezone the saved dates are read in.
 */
export function withProjectedRecurringLimits(
  limits: ContributionLimit[],
  referenceYear: number = new Date().getFullYear(),
  yearsAhead: number = FUTURE_PROJECTION_YEARS,
  timezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ProjectedContributionLimit[] {
  const real: ProjectedContributionLimit[] = limits.map((limit) => ({
    ...limit,
    isProjected: false,
  }));

  // Limits with the same name but different accounts (e.g. one per spouse)
  // recur independently, so each name and account set is its own group.
  const byGroup = new Map<string, ContributionLimit[]>();
  for (const limit of limits) {
    const key = JSON.stringify([limit.groupName, accountScope(limit)]);
    const group = byGroup.get(key) ?? [];
    group.push(limit);
    byGroup.set(key, group);
  }

  const projected: ProjectedContributionLimit[] = [];

  for (const groupLimits of byGroup.values()) {
    const existingYears = [...new Set(groupLimits.map((limit) => limit.contributionYear))].sort(
      (a, b) => a - b,
    );
    // Saved rows outside the planning window remain visible, but cannot expand
    // synchronous projection work (including rows written by older clients).
    const lastProjectedYear = Math.min(
      referenceYear + Math.max(0, Math.min(yearsAhead, FUTURE_PROJECTION_YEARS)),
      MAX_CONTRIBUTION_YEAR,
    );

    // Only project forward from today — an old, unrenewed recurring limit
    // shouldn't backfill placeholders for years the user simply never visited.
    for (let year = referenceYear; year <= lastProjectedYear; year++) {
      if (existingYears.includes(year)) continue;
      // A limit saved for a later year doesn't end the projections before it.
      const earlierYears = existingYears.filter((existingYear) => existingYear < year);
      if (earlierYears.length === 0) continue;
      const templateYear = earlierYears[earlierYears.length - 1];
      const templateYearLimits = groupLimits.filter(
        (limit) => limit.contributionYear === templateYear,
      );
      // Prefer a recurring row when several limits share the same group and year
      // so recurrence isn't lost to arbitrary ordering.
      const template =
        templateYearLimits.find((limit) => limit.isRecurring) ?? templateYearLimits[0];
      if (!template?.isRecurring) continue;

      const yearsLater = year - template.contributionYear;
      projected.push({
        ...template,
        id: `projected:${template.id}:${year}`,
        contributionYear: year,
        startDate: template.startDate
          ? addYears(template.startDate, yearsLater, timezone)
          : template.startDate,
        endDate: template.endDate
          ? addYears(template.endDate, yearsLater, timezone)
          : template.endDate,
        createdAt: undefined,
        updatedAt: undefined,
        isProjected: true,
        sourceLimitId: template.id,
        sourceYear: template.contributionYear,
      });
    }
  }

  return [...real, ...projected];
}
