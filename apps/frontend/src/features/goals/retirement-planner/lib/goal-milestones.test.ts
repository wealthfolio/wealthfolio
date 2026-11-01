import type { Goal } from "@/lib/types";
import { describe, expect, it } from "vitest";
import { ageAtDate, buildGoalMilestones } from "./goal-milestones";

function goal(overrides: Partial<Goal>): Goal {
  return {
    id: "goal",
    goalType: "home",
    title: "Goal",
    targetAmount: 60_000,
    statusLifecycle: "active",
    statusHealth: "on_track",
    priority: 0,
    targetDate: "2029-01-23",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const range = { birthYearMonth: "1992-03", startAge: 34, endAge: 90 };

describe("ageAtDate", () => {
  it("counts a birthday only once its month arrives", () => {
    expect(ageAtDate("1992-03", "2029-02-28")).toBe(36);
    expect(ageAtDate("1992-03", "2029-03-01")).toBe(37);
  });

  it("reads the calendar date without a timezone shift", () => {
    expect(ageAtDate("1992-01", "2030-01-01")).toBe(38);
  });

  it("rejects malformed input", () => {
    expect(ageAtDate("1992", "2029-01-23")).toBeUndefined();
    expect(ageAtDate("1992-13", "2029-01-23")).toBeUndefined();
    expect(ageAtDate("1992-03", "")).toBeUndefined();
  });
});

describe("buildGoalMilestones", () => {
  it("keeps active savings goals with a date in the chart's range, in date order", () => {
    const milestones = buildGoalMilestones(
      [
        goal({ id: "car", goalType: "car", targetDate: "2030-01-01" }),
        goal({ id: "home", targetDate: "2029-01-23", statusHealth: "off_track" }),
        goal({ id: "fire", goalType: "retirement", targetDate: "2051-10-29" }),
        goal({ id: "achieved", statusLifecycle: "achieved" }),
        goal({ id: "archived", statusLifecycle: "archived" }),
        goal({ id: "no-date", targetDate: undefined }),
        goal({ id: "past", targetDate: "2020-06-01" }),
        goal({ id: "beyond", targetDate: "2090-06-01" }),
      ],
      range,
    );

    expect(milestones.map((m) => [m.id, m.age, m.statusHealth])).toEqual([
      ["home", 36, "off_track"],
      ["car", 37, "on_track"],
    ]);
  });

  it("prefers the summary target core computed", () => {
    const [milestone] = buildGoalMilestones(
      [goal({ targetAmount: 50_000, summaryTargetAmount: 52_000 })],
      range,
    );
    expect(milestone.targetAmount).toBe(52_000);
  });
});
