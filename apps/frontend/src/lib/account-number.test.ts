import { describe, expect, it } from "vitest";

import { maskAccountNumber } from "./account-number";

describe("maskAccountNumber", () => {
  it("shows the last four characters", () => {
    expect(maskAccountNumber("NL91ABNA0417164300")).toBe("··4300");
  });

  it("ignores spaces, so a grouped IBAN ends in its digits", () => {
    expect(maskAccountNumber("DE89 3704 0044 0532 0130 00")).toBe("··3000");
    expect(maskAccountNumber("  4100 ")).toBe("··4100");
  });

  it("keeps a number shorter than four characters whole", () => {
    expect(maskAccountNumber("12")).toBe("··12");
  });

  it("shows nothing without a number", () => {
    expect(maskAccountNumber(undefined)).toBeNull();
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber("")).toBeNull();
    expect(maskAccountNumber("   ")).toBeNull();
  });
});
