import { describe, expect, it } from "vitest";
import { computeAccountShares } from "./goal-funding-shares";

const retirementGoalIds = new Set(["fire"]);

describe("computeAccountShares", () => {
  it("lets a savings goal take a share that retirement counts", () => {
    const shares = computeAccountShares({
      thisShare: 20,
      isRetirement: false,
      otherRules: [{ goalId: "fire", sharePercent: 100 }],
      retirementGoalIds,
    });

    expect(shares).toMatchObject({
      otherReserved: 0,
      maxForThisGoal: 100,
      left: 80,
      overBy: 0,
      retirementCounted: 80,
      free: 0,
      total: 100,
    });
  });

  it("still caps savings goals together at 100%", () => {
    const shares = computeAccountShares({
      thisShare: 70,
      isRetirement: false,
      otherRules: [
        { goalId: "house", sharePercent: 40 },
        { goalId: "fire", sharePercent: 100 },
      ],
      retirementGoalIds,
    });

    expect(shares).toMatchObject({ maxForThisGoal: 60, overBy: 10, retirementCounted: 0 });
  });

  it("counts retirement's share of what savings goals leave free", () => {
    const shares = computeAccountShares({
      thisShare: 100,
      isRetirement: true,
      otherRules: [{ goalId: "house", sharePercent: 20 }],
      retirementGoalIds,
    });

    expect(shares).toMatchObject({
      otherReserved: 20,
      retirementCounted: 80,
      maxForThisGoal: 100,
      free: 0,
      overBy: 0,
    });
  });

  it("keeps a lower retirement share and shows what nothing counts", () => {
    const shares = computeAccountShares({
      thisShare: 60,
      isRetirement: true,
      otherRules: [{ goalId: "house", sharePercent: 20 }],
      retirementGoalIds,
    });

    expect(shares).toMatchObject({ retirementCounted: 60, free: 20, total: 80 });
  });

  it("never marks retirement as over when savings goals hold everything", () => {
    const shares = computeAccountShares({
      thisShare: 100,
      isRetirement: true,
      otherRules: [{ goalId: "house", sharePercent: 100 }],
      retirementGoalIds,
    });

    expect(shares).toMatchObject({ retirementCounted: 0, overBy: 0, free: 0 });
  });
});
