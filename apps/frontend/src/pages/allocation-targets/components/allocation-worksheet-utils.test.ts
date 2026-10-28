import { describe, expect, it } from "vitest";

import type {
  Account,
  AllocationTargetConstraint,
  CalculatedAdjustments,
  DriftReport,
} from "@/lib/types";

import { buildAllocationTargetColorMap } from "./allocation-target-colors";
import {
  estimatedFunding,
  accountLabels,
  adjustmentsFromCalculated,
  amountAccountCanTake,
  allocationProgress,
  amountAtRest,
  eligibleAccountIdsForChange,
  externalContributionFor,
  floorToDigits,
  formatDecimalInput,
  generationInputsKey,
  impactClasses,
  isShortOfFunding,
  parseDecimalInput,
  placementAccountIds,
  placementSlack,
  planningTotal,
  standingRules,
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

  it("keeps an increase out of an account that cannot take it, unless it already holds it", () => {
    const notCrypto = (accountId: string) => accountId !== "kraken";
    expect(
      eligibleAccountIdsForChange(500, ["acc-1"], ["acc-1", "kraken", "acc-2"], notCrypto),
    ).toEqual(["acc-1", "acc-2"]);
    expect(eligibleAccountIdsForChange(500, ["kraken"], ["acc-1", "kraken"], notCrypto)).toEqual([
      "acc-1",
      "kraken",
    ]);
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

describe("estimatedFunding", () => {
  const ledger = (entries: [string, number][], isValid = true) => ({
    byAccount: new Map(entries),
    isValid,
  });

  it("leaves the change itself out and reserves what other changes place", () => {
    const estimates = estimatedFunding(
      { brokerage: 1000, roth: 500 },
      new Map([
        ["aapl", ledger([["brokerage", 400]])],
        // An incomplete placement still reserves what it already places.
        ["vti", ledger([["brokerage", 100]], false)],
        ["msft", ledger([["roth", 9999]])],
      ]),
      "msft",
      ["brokerage", "roth"],
    );
    expect(estimates.get("brokerage")).toEqual({ capacity: 500, deficit: 0 });
    expect(estimates.get("roth")).toEqual({ capacity: 500, deficit: 0 });
  });

  it("adds what valid reductions raise, and nothing from an invalid one", () => {
    const estimates = estimatedFunding(
      { brokerage: 0 },
      new Map([
        ["bnd", ledger([["brokerage", -300]])],
        ["vnq", ledger([["brokerage", -1000]], false)],
      ]),
      "aapl",
      ["brokerage"],
    );
    expect(estimates.get("brokerage")).toEqual({ capacity: 300, deficit: 0 });
  });

  it("states an account's shortfall on its own, never offset by another account", () => {
    const estimates = estimatedFunding(
      { brokerage: 0, roth: 1500 },
      new Map([["aapl", ledger([["brokerage", 1000]])]]),
      "vti",
      ["brokerage", "roth"],
    );
    expect(estimates.get("brokerage")).toEqual({ capacity: 0, deficit: 1000 });
    expect(estimates.get("roth")).toEqual({ capacity: 1500, deficit: 0 });
  });
});

describe("account labels", () => {
  const account = (id: string, name: string, extra: Partial<Account> = {}) =>
    ({ id, name, currency: "USD", ...extra }) as Account;

  it("leaves a name alone when no other account shares it", () => {
    const labels = accountLabels([account("a", "Brokerage"), account("b", "Retirement")]);
    expect(labels.get("a")).toBe("Brokerage");
    expect(labels.get("b")).toBe("Retirement");
  });

  it("tells apart accounts that share a name by the end of their number", () => {
    const labels = accountLabels([
      account("a", "Individual", { accountNumber: "U1234001" }),
      account("b", "INDIVIDUAL", { accountNumber: "U5678002" }),
    ]);
    expect(labels.get("a")).toBe("Individual ··4001");
    expect(labels.get("b")).toBe("INDIVIDUAL ··8002");
  });

  it("ends a number typed with spaces in its last four characters", () => {
    const labels = accountLabels([
      account("a", "Checking", { accountNumber: "DE89 3704 0044 0532 0130 00" }),
      account("b", "Checking", { accountNumber: "NL91 ABNA 0417 1643 00" }),
    ]);
    expect(labels.get("a")).toBe("Checking ··3000");
    expect(labels.get("b")).toBe("Checking ··4300");
  });

  it("falls back on the currency when there is no number to tell them apart", () => {
    const labels = accountLabels([
      account("a", "Individual"),
      account("b", "Individual", { currency: "CAD" }),
    ]);
    expect(labels.get("a")).toBe("Individual (USD)");
    expect(labels.get("b")).toBe("Individual (CAD)");
  });
});

describe("what an account can take of a change", () => {
  it("takes what is left when the account can fund all of it", () => {
    expect(amountAccountCanTake(1200, 2000, undefined, false, 2)).toBe(1200);
  });

  it("never offers more than the account can fund, down to the cent", () => {
    // What a division leaves past the cent would put the account over by it.
    expect(amountAccountCanTake(83523.37, 18413.135072, undefined, false, 2)).toBe(18413.13);
  });

  it("takes whole units under a whole-unit policy", () => {
    expect(amountAccountCanTake(1000, 450, 100, true, 2)).toBe(400);
  });

  it("offers whole units rounded up to the cent, so the preview keeps every unit", () => {
    // Three units at a price stored as 39.849998: cut down to the cent, 119.54
    // floors to two units in the preview.
    const offered = amountAccountCanTake(119.55, 1000, 39.849998, true, 2);
    expect(offered).toBe(119.55);
    expect(Math.floor(offered / 39.849998)).toBe(3);
    // Rounding up stays within what the account can fund.
    expect(amountAccountCanTake(119.55, 119.55, 39.849998, true, 2)).toBe(119.55);
  });

  it("offers nothing while the account's funding is not known", () => {
    expect(amountAccountCanTake(1200, undefined, undefined, false, 2)).toBe(0);
  });

  it("leaves a fraction of a cent behind rather than going past what is left", () => {
    expect(amountAccountCanTake(1200.004, 2000, undefined, false, 2)).toBe(1200);
  });

  it("offers what is left as the row shows it, so placing it completes the row", () => {
    // The calculation leaves fractions of a cent; the row reads $4,351.02.
    expect(amountAccountCanTake(4351.0199, 12250.95, undefined, false, 2)).toBe(4351.02);
  });
});

describe("an amount cut to the currency's smallest unit", () => {
  it("never rounds up past what it was", () => {
    // Shown as "about $27,915.07" before, beside "Use $27,915.06".
    expect(floorToDigits(27915.065, 2)).toBe(27915.06);
    expect(floorToDigits(18413.14, 2)).toBe(18413.14);
    expect(floorToDigits(5000.9, 0)).toBe(5000);
  });
});

describe("a funding shortfall", () => {
  it("counts from a cent, as the amounts are shown", () => {
    expect(isShortOfFunding(-3e-12)).toBe(false);
    expect(isShortOfFunding(-0.004)).toBe(false);
    expect(isShortOfFunding(-0.006)).toBe(true);
    expect(isShortOfFunding(-300)).toBe(true);
    expect(isShortOfFunding(200)).toBe(false);
  });
});

describe("standingRules", () => {
  const rule = (
    subjectType: AllocationTargetConstraint["subjectType"],
    subjectId: string,
    action: AllocationTargetConstraint["action"],
    effect: AllocationTargetConstraint["effect"] = "block",
  ): AllocationTargetConstraint => ({
    id: `${subjectType}-${subjectId}-${action}`,
    targetId: "target-1",
    subjectType,
    subjectId,
    action,
    effect,
    createdAt: "",
    updatedAt: "",
  });

  it("reads the target's never-reduced assets and accounts as the calculation does", () => {
    const rules = standingRules([rule("asset", "vti", "sell"), rule("account", "acc-2", "sell")]);

    expect(rules.blocksReduce("vti", "acc-1", [])).toBe(true);
    expect(rules.blocksReduce("bnd", "acc-1", [])).toBe(false);
    expect(rules.blocksReduce("bnd", "acc-2", [])).toBe(true);
    expect(rules.protectedAccountIds).toEqual(new Set(["acc-2"]));
    // Selling rules leave increases alone.
    expect(rules.blocksIncrease("vti", [])).toBe(false);
  });

  it("lets trade rules bind both ways, and category rules only through classified categories", () => {
    const rules = standingRules([
      rule("category", "bonds", "trade"),
      rule("category", "__UNKNOWN__", "sell"),
    ]);

    expect(rules.blocksReduce("bnd", "acc-1", ["bonds"])).toBe(true);
    expect(rules.blocksIncrease("bnd", ["bonds"])).toBe(true);
    expect(rules.blocksReduce("btc", "acc-1", ["__UNKNOWN__"])).toBe(false);
  });

  it("leaves avoid rules to the preview", () => {
    const rules = standingRules([rule("asset", "vti", "sell", "avoid")]);

    expect(rules.blocksReduce("vti", "acc-1", [])).toBe(false);
  });
});

describe("impactClasses", () => {
  it("colours each class as the allocation page does, even past an empty one", () => {
    const row = (categoryId: string, categoryName: string, currentBps: number, targetBps: number) =>
      ({
        categoryId,
        categoryName,
        color: "",
        currentBps,
        targetBps,
        driftBps: currentBps - targetBps,
        currentValue: currentBps,
        targetValue: targetBps,
        valueDelta: 0,
        effectiveBandBps: 500,
        status: "in_band",
        isRequired: false,
        isZeroCurrent: currentBps === 0,
        isCash: false,
      }) as DriftReport["rows"][number];
    // An empty class first: the rail leaves it out, the allocation page keeps it.
    const report = {
      rows: [
        row("R00", "Antarctica", 0, 0),
        row("R10", "Europe", 4000, 5000),
        row("R20", "Asia", 6000, 5000),
      ],
    } as DriftReport;
    const pageColors = buildAllocationTargetColorMap(report.rows);

    const classes = impactClasses(report, null, 500);

    expect(classes.map((item) => item.categoryId)).toEqual(["R10", "R20"]);
    expect(classes.map((item) => item.color)).toEqual([
      pageColors.get("R10"),
      pageColors.get("R20"),
    ]);
  });
});

describe("placementSlack", () => {
  it("accepts 1% of the change, never less than two cents", () => {
    expect(placementSlack(58964.43, 58500, undefined)).toEqual({
      short: 589.6443,
      over: 589.6443,
    });
    expect(placementSlack(1, 1, undefined)).toEqual({ short: 0.02, over: 0.02 });
  });

  it("leaves less than a unit unplaced under whole units, once part of the change is placed", () => {
    // Three units at $280 of a $1,000 change: the $160 left buys nothing.
    expect(placementSlack(1000, 840, 280)).toEqual({ short: 280, over: 10 });
  });

  it("never accepts a change with nothing placed", () => {
    expect(placementSlack(50, 0, 100)).toEqual({ short: 0, over: 0.5 });
    expect(placementSlack(600, 0, undefined).short).toBe(0);
  });
});
