import { describe, expect, it } from "vitest";

import { appendJsonPathKey, walkJson } from "./json-path-suggestions";

describe("JSONPath generation", () => {
  it("keeps parser-safe keys in dot notation", () => {
    expect(appendJsonPathKey("$.data", "unit_price")).toBe("$.data.unit_price");
  });

  it("quotes Unicode and special-character keys", () => {
    expect(appendJsonPathKey("$[*]", "单位净值")).toBe('$[*]["单位净值"]');
    expect(appendJsonPathKey("$", "price.usd")).toBe('$["price.usd"]');
    expect(appendJsonPathKey("$", 'price"usd')).toBe('$["price\\"usd"]');
  });

  it("generates valid paths for numeric values under Chinese keys", () => {
    const entries = walkJson([{ 净值日期: "2026-07-11", 单位净值: 1.4018 }]);

    expect(entries).toEqual(
      expect.arrayContaining([
        { path: '$[*]["单位净值"]', value: 1.4018 },
        { path: '$[0]["单位净值"]', value: 1.4018 },
      ]),
    );
  });
});
