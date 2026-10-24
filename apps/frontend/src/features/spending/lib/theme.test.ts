import { SPENDING_THEME, tint } from "./theme";

describe("tint", () => {
  it("tints theme variables and stored colours alike", () => {
    // A hex alpha suffix ("var(--spending-deep)1f") is invalid CSS; color-mix takes both.
    expect(tint(SPENDING_THEME.deep, 0.12)).toBe(
      "color-mix(in oklab, var(--spending-deep) 12%, transparent)",
    );
    expect(tint("#16a34a", 0.12)).toBe("color-mix(in oklab, #16a34a 12%, transparent)");
  });
});
