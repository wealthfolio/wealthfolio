import { describe, expect, it } from "vitest";
import { ActivityType } from "@/lib/constants";
import { IMPORTABLE_ACTIVITY_TYPES } from "./activity-import-profile";
import { createDefaultActivityTemplate } from "./default-activity-template";
import { findMappedActivityType } from "./activity-type-mapping";

describe("activity-type-mapping", () => {
  it.each(IMPORTABLE_ACTIVITY_TYPES)(
    "treats exact canonical %s labels as explicit identity mappings",
    (type) => {
      expect(findMappedActivityType(type, createDefaultActivityTemplate().activityMappings)).toBe(
        type,
      );
    },
  );

  it("does not map two-sided exchanges from the default template", () => {
    expect(
      findMappedActivityType(
        ActivityType.FX_EXCHANGE,
        createDefaultActivityTemplate().activityMappings,
      ),
    ).toBeNull();
  });

  it("does not infer non-canonical labels without explicit mappings", () => {
    expect(findMappedActivityType("TRANSFER OUT", {})).toBeNull();
    expect(findMappedActivityType("PURCHASE", {})).toBeNull();
    expect(findMappedActivityType("DIV", {})).toBeNull();
  });

  it("requires exact explicit label matches", () => {
    expect(
      findMappedActivityType("DIVIDEND QUALIFIED", {
        [ActivityType.DIVIDEND]: ["DIVIDEND"],
      }),
    ).toBeNull();
  });

  it("lets explicit mappings override matching labels", () => {
    const mapped = findMappedActivityType("TRANSFER OUT", {
      [ActivityType.DEPOSIT]: ["TRANSFER OUT"],
    });
    expect(mapped).toBe(ActivityType.DEPOSIT);
  });

  it("preserves legacy truncated mappings when the old prefix cuts mid-label", () => {
    expect(
      findMappedActivityType("DIVIDEND QUALIFIED", {
        [ActivityType.DIVIDEND]: ["DIVIDEND_QUA"],
      }),
    ).toBe(ActivityType.DIVIDEND);
  });

  it("does not treat exact 12-character labels as legacy prefixes", () => {
    expect(
      findMappedActivityType("TRANSFER OUT FEE", {
        [ActivityType.TRANSFER_OUT]: ["TRANSFER_OUT"],
      }),
    ).toBeNull();
  });

  it("treats the selected template as the source of truth", () => {
    expect(
      findMappedActivityType("BUY", {
        [ActivityType.DIVIDEND]: ["DIV"],
      }),
    ).toBeNull();
  });
});
