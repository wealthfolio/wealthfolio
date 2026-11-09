import { formatDateISO } from "@/lib/utils";

import {
  SPENDING_RANGE_FROM_PARAM,
  SPENDING_RANGE_TO_PARAM,
  spendingRangeFromParams,
  spendingRangeToReportsRange,
} from "./date-range-params";

describe("spendingRangeFromParams", () => {
  it("reads a complete inclusive range", () => {
    const params = new URLSearchParams({
      [SPENDING_RANGE_FROM_PARAM]: "2025-01-01",
      [SPENDING_RANGE_TO_PARAM]: "2025-12-31",
    });

    const range = spendingRangeFromParams(params);

    expect(formatDateISO(range?.from ?? new Date())).toBe("2025-01-01");
    expect(formatDateISO(range?.to ?? new Date())).toBe("2025-12-31");
  });

  it("rejects incomplete, invalid, and reversed ranges", () => {
    expect(
      spendingRangeFromParams(new URLSearchParams({ [SPENDING_RANGE_FROM_PARAM]: "2025-01-01" })),
    ).toBeUndefined();
    expect(
      spendingRangeFromParams(
        new URLSearchParams({
          [SPENDING_RANGE_FROM_PARAM]: "2025-02-30",
          [SPENDING_RANGE_TO_PARAM]: "2025-03-01",
        }),
      ),
    ).toBeUndefined();
    expect(
      spendingRangeFromParams(
        new URLSearchParams({
          [SPENDING_RANGE_FROM_PARAM]: "2025-12-31",
          [SPENDING_RANGE_TO_PARAM]: "2025-01-01",
        }),
      ),
    ).toBeUndefined();
  });
});

it("keeps calendar endpoints across DST in the app timezone", () => {
  const range = spendingRangeFromParams(
    new URLSearchParams({ spendingFrom: "2025-03-08", spendingTo: "2025-03-10" }),
  )!;
  const reportRange = spendingRangeToReportsRange(range, "America/Toronto");
  expect(reportRange.start.toISOString()).toBe("2025-03-08T05:00:00.000Z");
  expect(reportRange.end.toISOString()).toBe("2025-03-11T03:59:59.999Z");
  expect(reportRange.days).toBe(3);
});

it("excludes the preceding day when the selected day skips midnight", () => {
  const range = spendingRangeFromParams(
    new URLSearchParams({ spendingFrom: "2026-03-29", spendingTo: "2026-03-31" }),
  )!;
  const reportRange = spendingRangeToReportsRange(range, "Asia/Beirut");
  const precedingExpense = new Date("2026-03-28T21:30:00.000Z");
  expect(reportRange.start.toISOString()).toBe("2026-03-28T22:00:00.000Z");
  expect(precedingExpense.getTime()).toBeLessThan(reportRange.start.getTime());
});
