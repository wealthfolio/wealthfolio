import { formatDateISO } from "@/lib/utils";

import {
  SPENDING_RANGE_FROM_PARAM,
  SPENDING_RANGE_TO_PARAM,
  spendingRangeFromParams,
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
