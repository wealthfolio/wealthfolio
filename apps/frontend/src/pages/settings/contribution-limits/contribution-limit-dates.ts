import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import type { ContributionLimit } from "@/lib/types";

/**
 * The form's former default dates: noon UTC on 1 January and 31 December. Like
 * the deposit count, these stand for the limit's year rather than for two days.
 */
export function hasFormerDefaultDates({
  contributionYear,
  startDate,
  endDate,
}: Pick<ContributionLimit, "contributionYear" | "startDate" | "endDate">) {
  return (
    Date.parse(startDate ?? "") === Date.UTC(contributionYear, 0, 1, 12) &&
    Date.parse(endDate ?? "") === Date.UTC(contributionYear, 11, 31, 12)
  );
}

/**
 * Whether a limit is running on `todayKey` (YYYY-MM-DD in `timezone`). A limit
 * with dates runs from its start day to its end day in `timezone`, as its
 * deposits are counted; one without runs over its year. An unset timezone uses
 * UTC, matching the deposit service.
 */
export function isContributionLimitCurrent(
  limit: ContributionLimit,
  todayKey: string,
  timezone = "UTC",
) {
  if (limit.startDate && limit.endDate && !hasFormerDefaultDates(limit)) {
    const start = new Date(limit.startDate);
    const end = new Date(limit.endDate);
    // The deposit count rejects dates it can't read, so such a limit isn't shown.
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    return (
      formatZonedDateKey(start, timezone) <= todayKey &&
      todayKey <= formatZonedDateKey(end, timezone)
    );
  }
  return todayKey.startsWith(`${limit.contributionYear}-`);
}
