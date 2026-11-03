import { describe, expect, it } from "vitest";

import { normalizeReportsPeriod } from "./period-preferences";

describe("spending period preferences", () => {
  it("normalizes legacy dashboard month periods for insights", () => {
    expect(normalizeReportsPeriod("3M")).toBe("3M");
    expect(normalizeReportsPeriod("LAST_MONTH")).toBe("LAST_MONTH");
    expect(normalizeReportsPeriod("1M")).toBeNull();
  });
});
