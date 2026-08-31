import { describe, expect, it } from "vitest";
import { applyBondSpec, extractBondSpec } from "./asset-bond-spec";

describe("extractBondSpec", () => {
  it("converts the stored fraction to a display percent", () => {
    expect(extractBondSpec({ bond: { couponRate: 0.04375 } }).couponRate).toBeCloseTo(4.375, 10);
  });

  it("keeps a zero coupon distinct from an absent one", () => {
    expect(extractBondSpec({ bond: { couponRate: 0 } }).couponRate).toBe(0);
    expect(extractBondSpec({ bond: {} }).couponRate).toBeNull();
  });

  it("parses maturity as a local date, not UTC", () => {
    const { maturityDate } = extractBondSpec({ bond: { maturityDate: "2032-02-15" } });
    // `new Date("2032-02-15")` would be UTC midnight, i.e. Feb 14 in Toronto.
    expect(maturityDate?.getFullYear()).toBe(2032);
    expect(maturityDate?.getMonth()).toBe(1);
    expect(maturityDate?.getDate()).toBe(15);
  });

  it("returns empty values for metadata without a bond spec", () => {
    expect(extractBondSpec({})).toEqual({
      maturityDate: null,
      couponRate: null,
      couponFrequency: "",
    });
  });
});

describe("applyBondSpec", () => {
  const empty = { maturityDate: null, couponRate: null, couponFrequency: "" };

  it("stores the percent back as a fraction", () => {
    const result = applyBondSpec({}, { ...empty, couponRate: 4.375 });
    expect((result.bond as Record<string, unknown>).couponRate).toBeCloseTo(0.04375, 10);
  });

  it("stores a zero coupon rather than dropping it", () => {
    const result = applyBondSpec({}, { ...empty, couponRate: 0 });
    expect((result.bond as Record<string, unknown>).couponRate).toBe(0);
  });

  it("round-trips a maturity date without shifting the day", () => {
    const stored = applyBondSpec({}, { ...empty, maturityDate: new Date(2032, 1, 15) });
    expect((stored.bond as Record<string, unknown>).maturityDate).toBe("2032-02-15");
    expect(extractBondSpec(stored).maturityDate?.getDate()).toBe(15);
  });

  it("preserves spec fields it does not manage", () => {
    const result = applyBondSpec(
      { bond: { faceValue: 100, isin: "US912828XY12" } },
      { ...empty, couponRate: 2 },
    );
    expect(result.bond).toMatchObject({ faceValue: 100, isin: "US912828XY12" });
  });

  it("preserves sibling namespaces", () => {
    const result = applyBondSpec(
      { identifiers: { isin: "US912828XY12" }, contractMultiplier: 50 },
      { ...empty, couponRate: 2 },
    );
    expect(result.identifiers).toEqual({ isin: "US912828XY12" });
    expect(result.contractMultiplier).toBe(50);
  });

  it("drops the bond key entirely when every managed field is cleared", () => {
    expect(applyBondSpec({ bond: { couponRate: 0.02 } }, empty)).not.toHaveProperty("bond");
  });

  it("does not mutate the input", () => {
    const metadata = { bond: { couponRate: 0.02 } };
    applyBondSpec(metadata, { ...empty, couponRate: 5 });
    expect(metadata.bond.couponRate).toBe(0.02);
  });
});
