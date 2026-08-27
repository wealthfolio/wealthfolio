import { describe, expect, it } from "vitest";

import { expandTemplatePlaceholders } from "./template-placeholders";

describe("template placeholders", () => {
  const now = new Date("2024-06-15T12:34:56Z");

  it("expands formatted date placeholders using UTC values", () => {
    expect(
      expandTemplatePlaceholders(
        "{FROM:%Y%m%d}/{TO:%d/%m/%Y}/{TODAY:%Y}/{DATE:%Y-%m-%d}",
        { FROM: "2024-01-02", TO: "2024-03-04", TODAY: "2024-06-15" },
        now,
      ),
    ).toBe("20240102/04/03/2024/2024/2024-06-15");
  });

  it("keeps unknown placeholders unchanged", () => {
    expect(expandTemplatePlaceholders("{SYMBOL}/{UNKNOWN:%Q}", { SYMBOL: "AAPL" }, now)).toBe(
      "AAPL/{UNKNOWN:%Q}",
    );
  });

  it("leaves unsupported date directives unchanged", () => {
    expect(expandTemplatePlaceholders("{FROM:%H}", { FROM: "2024-01-02" }, now)).toBe("{FROM:%H}");
  });
});
