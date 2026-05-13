import { describe, expect, it, vi } from "vitest";
import { formatAmount } from "./utils";

describe("formatAmount", () => {
  it("formats JPY with no decimals", () => {
    const result = formatAmount(1234, "JPY");
    expect(result).toMatch(/1[,.]234/);
    expect(result).not.toMatch(/00/);
  });

  it("formats BHD with 3 decimals", () => {
    const result = formatAmount(1234.5678, "BHD");
    expect(result).toMatch(/1[,.]234[,.]568/);
  });

  it("applies threshold for USD", () => {
    const result = formatAmount(0.004, "USD");
    expect(result).toMatch(/0[,.]00/);
  });

  it("applies dynamic threshold for JPY without returning -0", () => {
    const result = formatAmount(0.4, "JPY");
    expect(result).not.toMatch(/-0/);
  });

  it("handles pence path (GBp) correctly", () => {
    expect(formatAmount(1.5, "GBp", true)).toMatch(/^1[,.]50p$/);
    expect(formatAmount(1.5, "GBp", false)).toMatch(/^1[,.]50$/);
  });

  it("returns '-' for null or NaN", () => {
    expect(formatAmount(null, "USD")).toBe("-");
    expect(formatAmount(NaN, "USD")).toBe("-");
  });

  it("formats unknown currencies using default precision (2 decimals)", () => {
    // "XYZ"와 같이 ISO 표준에 없는 통화의 경우 기본값인 2자리 소수점으로 폴백됩니다.
    const result = formatAmount(1234.5678, "XYZ", false);
    expect(result).toMatch(/1[,.]234[,.]57/);
  });

  it("caches fraction digits and formatters for consecutive calls", () => {
    const numberFormatSpy = vi.spyOn(Intl, "NumberFormat");

    formatAmount(100, "TESTCOIN");
    const callsAfterFirst = numberFormatSpy.mock.calls.length;

    formatAmount(200, "TESTCOIN");
    expect(numberFormatSpy.mock.calls.length).toBe(callsAfterFirst); // 캐시를 사용하므로 추가 호출이 없어야 합니다.

    numberFormatSpy.mockRestore();
  });
});
