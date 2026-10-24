import { describe, expect, it } from "vitest";
import { fallbackPalette, getTreemapColor } from "./treemap-palette";

describe("treemap palette", () => {
  it("draws Classic's ramp: Flexoki green and red from 50 to 600", () => {
    // +50% total return is the gain ramp's mid-tone (k = 0.5): halfway from
    // #edeecf to #66800b. -25% is the loss mid-tone: halfway from #ffe1d5 to #af3029.
    expect(getTreemapColor(0.5, "pnl")).toEqual({ fill: "rgb(170,183,109)", isLightTile: true });
    expect(getTreemapColor(-0.25, "pnl")).toEqual({ fill: "rgb(215,137,127)", isLightTile: true });
    expect(getTreemapColor(0, "daily").fill).toBe("rgb(237,238,207)");
  });

  it("draws the theme's ramp", () => {
    const palette = {
      ...fallbackPalette,
      positiveLow: [0, 0, 0],
      positiveHigh: [200, 100, 0],
    };
    expect(getTreemapColor(0.5, "pnl", palette).fill).toBe("rgb(100,50,0)");
  });
});
