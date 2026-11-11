import { describe, expect, it } from "vitest";
import {
  chargeLineDefaults,
  chargeLinesMetadata,
  getActivityChargeLines,
  sumChargeLines,
} from "./activity-charges";

const lines = [
  { category: "fee", label: "Commission", amount: "8.00" },
  { category: "fee", label: "Exchange fee", amount: "1.99" },
  { category: "tax", label: "Stamp duty", amount: "1.50" },
];

describe("getActivityChargeLines", () => {
  it("splits lines that add up to the totals by category", () => {
    expect(
      getActivityChargeLines({
        fee: 9.99,
        tax: 1.5,
        metadata: { charges: lines },
      }),
    ).toEqual({
      fee: [lines[0], lines[1]],
      tax: [lines[2]],
    });
  });

  it("hides lines once a total no longer matches them", () => {
    expect(
      getActivityChargeLines({
        fee: 12,
        tax: 1.5,
        metadata: { charges: lines },
      }),
    ).toBeNull();
    expect(
      getActivityChargeLines({
        fee: 9.99,
        tax: null,
        metadata: { charges: lines },
      }),
    ).toBeNull();
  });

  it("compares decimals exactly without a tolerance or binary rounding", () => {
    const feeLines = (...amounts: (string | number)[]) => ({
      charges: amounts.map((amount) => ({ category: "fee", label: "Commission", amount })),
    });
    expect(getActivityChargeLines({ fee: 0.3, metadata: feeLines(0.1, 0.2) })).not.toBeNull();
    expect(
      getActivityChargeLines({ fee: "0.03", metadata: feeLines("1e-2", "2e-2") }),
    ).not.toBeNull();
    expect(
      getActivityChargeLines({ fee: "100000000.01", metadata: feeLines("100000000") }),
    ).toBeNull();
    expect(getActivityChargeLines({ fee: 0, metadata: feeLines("0.0000000001") })).toBeNull();
    expect(
      getActivityChargeLines({
        fee: "9007199254740993.01",
        metadata: feeLines("9007199254740993", "0.01"),
      }),
    ).not.toBeNull();
    expect(getActivityChargeLines({ fee: 0, metadata: feeLines(1, -1) })).not.toBeNull();
  });

  it("ignores missing or malformed lines", () => {
    expect(getActivityChargeLines({ fee: 1, tax: 0, metadata: null })).toBeNull();
    expect(getActivityChargeLines({ fee: 1, tax: 0, metadata: { charges: [] } })).toBeNull();
    expect(
      getActivityChargeLines({
        fee: 1,
        tax: 0,
        metadata: { charges: [{ category: "levy", label: "x", amount: 1 }] },
      }),
    ).toBeNull();
    for (const amount of ["", " ", "0x10", "NaN", "Infinity", "1e999999999", "1e-999999999"]) {
      expect(
        getActivityChargeLines({
          fee: 0,
          metadata: { charges: [{ category: "fee", label: "Commission", amount }] },
        }),
      ).toBeNull();
    }
    expect(
      getActivityChargeLines({
        fee: 0,
        metadata: { charges: [{ category: "fee", label: "  ", amount: "0" }] },
      }),
    ).toBeNull();
  });
});

describe("sumChargeLines", () => {
  it("adds amounts exactly, so the total matches core's decimal check", () => {
    expect(
      sumChargeLines([
        { label: "a", amount: 0.1 },
        { label: "b", amount: 0.2 },
      ]),
    ).toBe(0.3);
    expect(
      sumChargeLines([
        { label: "a", amount: 1.005 },
        { label: "b", amount: 2.335 },
        { label: "c", amount: 0.00000001 },
      ]),
    ).toBe(3.34000001);
  });

  it("counts a line still waiting for its amount as nothing", () => {
    expect(sumChargeLines([{ label: "a", amount: 4 }, { label: "b" }])).toBe(4);
  });
});

describe("chargeLineDefaults", () => {
  const activity = { fee: "9.99", tax: "1.5", metadata: { charges: lines } };

  it("opens the stored lines by total, flagged so removing them all clears them", () => {
    expect(chargeLineDefaults(activity, ["fee", "tax"])).toEqual({
      feeLines: [
        { label: "Commission", amount: 8 },
        { label: "Exchange fee", amount: 1.99 },
      ],
      taxLines: [{ label: "Stamp duty", amount: 1.5 }],
      hadChargeLines: true,
    });
  });

  it("locks lines a form has no field for", () => {
    expect(chargeLineDefaults(activity, ["tax"])).toEqual({ chargeLinesLocked: true });
  });

  it("locks a hidden nonzero total even without stored lines", () => {
    expect(chargeLineDefaults({ fee: "1", tax: "2" }, ["tax"])).toEqual({
      chargeLinesLocked: true,
    });
  });

  it("locks stored decimals that cannot round-trip through a number", () => {
    expect(
      chargeLineDefaults(
        {
          fee: "0.3",
          metadata: {
            charges: [
              { category: "fee", label: "a", amount: "0.10000000000000001" },
              { category: "fee", label: "b", amount: "0.19999999999999999" },
            ],
          },
        },
        ["fee", "tax"],
      ),
    ).toEqual({ chargeLinesLocked: true });
  });

  it("locks a rebate, which a money input can't show", () => {
    expect(
      chargeLineDefaults(
        {
          fee: "4",
          metadata: {
            charges: [
              { category: "fee", label: "Commission", amount: "5" },
              { category: "fee", label: "Rebate", amount: "-1" },
            ],
          },
        },
        ["fee", "tax"],
      ),
    ).toEqual({ chargeLinesLocked: true });
  });

  it("opens no lines when there are none or they no longer add up", () => {
    expect(chargeLineDefaults({ fee: "1" }, ["fee", "tax"])).toEqual({});
    expect(chargeLineDefaults({ ...activity, fee: "12" }, ["fee", "tax"])).toEqual({});
  });
});

describe("chargeLinesMetadata", () => {
  it("saves the lines by category with trimmed labels", () => {
    expect(
      chargeLinesMetadata({
        feeLines: [{ label: " Commission ", amount: 8 }],
        taxLines: [{ label: "Stamp duty", amount: 0.1 }],
      }),
    ).toEqual({
      charges: [
        { category: "fee", label: "Commission", amount: "8" },
        { category: "tax", label: "Stamp duty", amount: "0.1" },
      ],
    });
  });

  it("clears the lines an activity was opened with once all are removed", () => {
    expect(chargeLinesMetadata({ feeLines: [], taxLines: [], hadChargeLines: true })).toEqual({
      charges: null,
    });
  });

  it("leaves stored lines alone when the form had none or couldn't edit them", () => {
    expect(chargeLinesMetadata({ feeLines: [], taxLines: [] })).toBeUndefined();
    expect(
      chargeLinesMetadata({
        feeLines: [{ label: "Commission", amount: 1 }],
        chargeLinesLocked: true,
      }),
    ).toBeUndefined();
  });
});
