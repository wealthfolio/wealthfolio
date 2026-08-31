import { describe, expect, it } from "vitest";
import {
  applyContractMultiplier,
  explicitContractMultiplier,
  hasCompleteOptionContract,
  resolveContractMultiplier,
} from "./asset-contract-multiplier";

const completeOption = {
  underlyingAssetId: "AAPL",
  expiration: "2026-12-18",
  right: "CALL",
  strike: 200,
  multiplier: 10,
};

describe("hasCompleteOptionContract", () => {
  it("accepts a spec carrying every required contract field", () => {
    expect(hasCompleteOptionContract({ option: completeOption })).toBe(true);
  });

  it.each(["underlyingAssetId", "expiration", "right", "strike"])(
    "rejects a spec missing %s",
    (field) => {
      const option = { ...completeOption } as Record<string, unknown>;
      delete option[field];
      expect(hasCompleteOptionContract({ option })).toBe(false);
    },
  );

  it("treats a spec with only a multiplier as incomplete", () => {
    expect(hasCompleteOptionContract({ option: { multiplier: 10 } })).toBe(false);
  });
});

describe("explicitContractMultiplier", () => {
  it("prefers the nested value for options with a complete spec", () => {
    expect(
      explicitContractMultiplier({ option: completeOption, contractMultiplier: 50 }, "OPTION"),
    ).toBe(10);
  });

  it("falls through to top-level when the option spec is partial", () => {
    expect(
      explicitContractMultiplier({ option: { multiplier: 10 }, contractMultiplier: 50 }, "OPTION"),
    ).toBe(50);
  });

  it("ignores the nested value entirely for non-options", () => {
    expect(explicitContractMultiplier({ option: completeOption }, "EQUITY")).toBeNull();
  });

  it("accepts numeric strings, as the Rust reader does", () => {
    expect(explicitContractMultiplier({ contractMultiplier: "50" }, "EQUITY")).toBe(50);
  });

  it("rejects a non-positive top-level value", () => {
    expect(explicitContractMultiplier({ contractMultiplier: 0 }, "EQUITY")).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(explicitContractMultiplier({}, "OPTION")).toBeNull();
  });
});

describe("resolveContractMultiplier", () => {
  it("defaults options to 100", () => {
    expect(resolveContractMultiplier({}, "OPTION")).toBe(100);
  });

  it("defaults everything else to 1", () => {
    expect(resolveContractMultiplier({}, "EQUITY")).toBe(1);
    expect(resolveContractMultiplier({}, undefined)).toBe(1);
  });
});

describe("applyContractMultiplier", () => {
  it("keeps multiplier on a complete option spec even at the default", () => {
    const result = applyContractMultiplier({ option: completeOption }, "OPTION", 100);
    // Removing it would make the whole OptionSpec fail to deserialize in Rust.
    expect(result.option).toMatchObject({ ...completeOption, multiplier: 100 });
    expect(resolveContractMultiplier(result, "OPTION")).toBe(100);
  });

  it("writes the nested value and clears the top-level key for complete specs", () => {
    const result = applyContractMultiplier(
      { option: completeOption, contractMultiplier: 50 },
      "OPTION",
      25,
    );
    expect((result.option as Record<string, unknown>).multiplier).toBe(25);
    expect(result).not.toHaveProperty("contractMultiplier");
  });

  it("writes top-level for an option whose spec is partial", () => {
    const result = applyContractMultiplier({ option: { multiplier: 1 } }, "OPTION", 10);
    expect(result.contractMultiplier).toBe(10);
    expect(resolveContractMultiplier(result, "OPTION")).toBe(10);
  });

  it("removes the top-level key at the non-option default", () => {
    const result = applyContractMultiplier({ contractMultiplier: 50 }, "EQUITY", 1);
    expect(result).not.toHaveProperty("contractMultiplier");
  });

  it("writes top-level for a CFD arriving as EQUITY", () => {
    expect(applyContractMultiplier({}, "EQUITY", 100).contractMultiplier).toBe(100);
  });

  it("treats null and non-positive input as a reset to the default", () => {
    expect(applyContractMultiplier({ contractMultiplier: 5 }, "EQUITY", null)).not.toHaveProperty(
      "contractMultiplier",
    );
    expect(applyContractMultiplier({ contractMultiplier: 5 }, "EQUITY", 0)).not.toHaveProperty(
      "contractMultiplier",
    );
  });

  it("preserves sibling namespaces", () => {
    const result = applyContractMultiplier(
      { identifiers: { isin: "US123" }, bond: { couponRate: 0.04 } },
      "EQUITY",
      50,
    );
    expect(result.identifiers).toEqual({ isin: "US123" });
    expect(result.bond).toEqual({ couponRate: 0.04 });
  });

  it("does not mutate the input", () => {
    const metadata = { option: { ...completeOption } };
    applyContractMultiplier(metadata, "OPTION", 25);
    expect(metadata.option.multiplier).toBe(10);
  });
});
