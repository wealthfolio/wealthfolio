import { describe, expect, it } from "vitest";

import type { CalculatedAdjustments } from "@/lib/types";
import {
  adjustmentsFromCalculated,
  allocationProgress,
  amountAtRest,
  eligibleAccountIdsForChange,
  externalContributionFor,
  formatDecimalInput,
  generationInputsKey,
  parseDecimalInput,
  placementAccountIds,
  planningTotal,
  unitPriceMoved,
  type WorksheetGenerationInputs,
} from "./allocation-worksheet-utils";

function calculated(adjustments: CalculatedAdjustments["adjustments"]): CalculatedAdjustments {
  return {
    mode: "rebalance",
    rule: "current_holding_proportions",
    adjustments,
    unresolved: [],
    scaling: {},
    remainingCash: 0,
    fundingShortfalls: [],
  };
}

const inputs: WorksheetGenerationInputs = {
  targetId: "target-1",
  targetVersion: "2026-01-01T00:00:00Z",
  accountIds: ["acc-2", "acc-1"],
  mode: "invest_cash",
  rule: "current_holding_proportions",
  trackedCashToUse: 500,
  externalContribution: { "acc-2": 100, "acc-1": 50 },
};

describe("allocation worksheet input utilities", () => {
  it("accepts period and comma decimal separators without changing scale", () => {
    expect(parseDecimalInput("32.5")).toBe(32.5);
    expect(parseDecimalInput("32,5")).toBe(32.5);
    expect(parseDecimalInput("-0,125")).toBe(-0.125);
    expect(formatDecimalInput(32.5, 4)).toBe("32.5");
  });

  it("rejects grouped and partially malformed values", () => {
    expect(parseDecimalInput("1,000.00")).toBeNaN();
    expect(parseDecimalInput("12abc")).toBeNaN();
    expect(parseDecimalInput("1.2.3")).toBeNaN();
  });

  it("distinguishes exact, incomplete, and excessive account allocation", () => {
    expect(allocationProgress(100, 100, 0.01)).toEqual({
      remaining: 0,
      overallocated: 0,
      isFullyAllocated: true,
    });
    expect(allocationProgress(100, 80, 0.01).remaining).toBe(20);
    expect(allocationProgress(100, 120, 0.01)).toEqual({
      remaining: 0,
      overallocated: 20,
      isFullyAllocated: false,
    });
  });
});

describe("planning total", () => {
  it("matches the basis the core sizes the target against", () => {
    // Same figures as the core test, so the two cannot drift apart unnoticed.
    expect(planningTotal(1000, 200, 100, true)).toBe(1100);
    expect(planningTotal(1000, 200, 100, false)).toBe(1300);
  });
});

describe("eligible accounts for a change", () => {
  it("lets an increase go to any account in scope, not only the one holding it", () => {
    expect(eligibleAccountIdsForChange(500, ["acc-1"], ["acc-1", "acc-2"])).toEqual([
      "acc-1",
      "acc-2",
    ]);
  });

  it("draws a reduction only from the accounts that hold the security", () => {
    expect(eligibleAccountIdsForChange(-500, ["acc-2"], ["acc-1", "acc-2"])).toEqual(["acc-2"]);
  });
});

describe("an amount field at rest", () => {
  it("reads at the currency's precision in the user's decimal mark", () => {
    expect(amountAtRest("239.240005", 2, ".")).toBe("239.24");
    expect(amountAtRest("417.9", 2, ",")).toBe("417,90");
    expect(amountAtRest("-900", 2, ".")).toBe("-900.00");
    expect(amountAtRest("-0.001", 2, ".")).toBe("0.00");
  });

  it("leaves an empty or unreadable entry as typed", () => {
    expect(amountAtRest("", 2, ".")).toBe("");
    expect(amountAtRest("12a", 2, ".")).toBe("12a");
  });
});

describe("a price moved since the calculation", () => {
  it("counts a move over 1% and ignores the drift prices make within a day", () => {
    expect(unitPriceMoved(149.4861, 147.820084)).toBe(true);
    expect(unitPriceMoved(101.01, 100)).toBe(true);
    expect(unitPriceMoved(98.99, 100)).toBe(true);
    // Synced again since the calculation: 0.07%.
    expect(unitPriceMoved(59.85, 59.81)).toBe(false);
    expect(unitPriceMoved(100.99, 100)).toBe(false);
    expect(unitPriceMoved(59.3100006, 59.31)).toBe(false);
  });
});

describe("accounts an allocation lists first", () => {
  it("lists the holders and keeps the other accounts behind a link", () => {
    expect(placementAccountIds(["acc-1", "acc-2", "acc-3"], ["acc-2"], [])).toEqual({
      shown: ["acc-2"],
      hidden: ["acc-1", "acc-3"],
    });
  });

  it("keeps an account with an amount in view, holder or not", () => {
    expect(placementAccountIds(["acc-1", "acc-2", "acc-3"], ["acc-2"], ["acc-3"])).toEqual({
      shown: ["acc-2", "acc-3"],
      hidden: ["acc-1"],
    });
  });

  it("lists every account for a security no eligible account holds", () => {
    expect(placementAccountIds(["acc-1", "acc-2"], ["acc-9"], [])).toEqual({
      shown: ["acc-1", "acc-2"],
      hidden: [],
    });
  });
});

describe("prefilling the worksheet from calculated adjustments", () => {
  it("leaves an increase the calculation did not place without account amounts", () => {
    const adjustments = adjustmentsFromCalculated(
      calculated([
        {
          lineId: "calc:vti:unassigned",
          direction: "increase",
          assetId: "vti",
          symbol: "VTI",
          accountId: null,
          amount: 1200,
          quantity: 12,
          unitPrice: 100,
          isBelowMinimum: false,
        },
      ]),
    );

    expect(adjustments.vti).toEqual({
      inputMode: "amount",
      inputValue: "1200",
      accountAmounts: {},
    });
  });

  it("keeps every account a reduction is drawn from", () => {
    const adjustments = adjustmentsFromCalculated(
      calculated([
        {
          lineId: "calc:bnd:acc-1",
          direction: "reduce",
          assetId: "bnd",
          symbol: "BND",
          accountId: "acc-1",
          amount: -300,
          quantity: -3,
          unitPrice: 100,
          isBelowMinimum: false,
        },
        {
          lineId: "calc:bnd:acc-2",
          direction: "reduce",
          assetId: "bnd",
          symbol: "BND",
          accountId: "acc-2",
          amount: -200,
          quantity: -2,
          unitPrice: 100,
          isBelowMinimum: false,
        },
      ]),
    );

    expect(adjustments.bnd).toEqual({
      inputMode: "amount",
      inputValue: "-500",
      accountAmounts: { "acc-1": "300", "acc-2": "200" },
    });
  });
});

describe("cash not yet recorded", () => {
  it("keeps only positive amounts for accounts in scope", () => {
    expect(
      externalContributionFor(["acc-1", "acc-2"], {
        "acc-1": "1000",
        "acc-2": "0",
        "acc-3": "500",
      }),
    ).toEqual({ "acc-1": 1000 });
  });

  it("ignores an amount that is not a number", () => {
    expect(externalContributionFor(["acc-1"], { "acc-1": "12abc" })).toEqual({});
  });
});

describe("generation inputs fingerprint", () => {
  it("does not depend on the order accounts or contributions arrive in", () => {
    expect(generationInputsKey(inputs)).toBe(
      generationInputsKey({
        ...inputs,
        accountIds: ["acc-1", "acc-2"],
        externalContribution: { "acc-1": 50, "acc-2": 100 },
      }),
    );
  });

  it.each([
    ["mode", { mode: "rebalance" as const }],
    ["cash to deploy", { trackedCashToUse: 600 }],
    ["cash not yet recorded", { externalContribution: { "acc-1": 50 } }],
    ["account scope", { accountIds: ["acc-1"] }],
    ["the target itself", { targetVersion: "2026-02-01T00:00:00Z" }],
  ])("changes when the %s changes", (_, change) => {
    expect(generationInputsKey({ ...inputs, ...change })).not.toBe(generationInputsKey(inputs));
  });

  it("tells an empty eligible selection apart from every recorded security", () => {
    expect(generationInputsKey({ ...inputs, eligibleAssetIds: [] })).not.toBe(
      generationInputsKey({ ...inputs, eligibleAssetIds: undefined }),
    );
  });
});
