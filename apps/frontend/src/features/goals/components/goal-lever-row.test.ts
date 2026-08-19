import { describe, expect, it } from "vitest";
import { sliderMaxFor } from "./goal-lever-row";

describe("sliderMaxFor", () => {
  it("returns the base max for a value within range", () => {
    expect(sliderMaxFor(0, 20000, 5000)).toBe(20000);
  });

  it("grows to include a value far beyond the base max, uncapped", () => {
    expect(sliderMaxFor(15_000_000, 20000, 5000)).toBeGreaterThanOrEqual(15_000_000);
  });

  it("never returns a max below the current value", () => {
    expect(sliderMaxFor(200_001, 20000, 5000)).toBeGreaterThanOrEqual(200_001);
  });
});
