import { describe, expect, it } from "vitest";
import { fallbackPalette, getTreemapColor } from "./treemap-palette";

describe("treemap palette", () => {
  it("draws Classic's ramp: Flexoki green and red at 50, 300 and 600", () => {
    // +50% total return is the gain ramp's middle (k = 0.5), Flexoki green-300 #a0af54;
    // -25% is the loss ramp's middle, red-300 #e8705f. A flat day is the low stop.
    expect(getTreemapColor(0.5, "pnl")).toEqual({ fill: "rgb(160,175,84)", isLightTile: true });
    expect(getTreemapColor(-0.25, "pnl")).toEqual({ fill: "rgb(232,112,95)", isLightTile: true });
    expect(getTreemapColor(0, "daily").fill).toBe("rgb(237,238,207)");
    // -5% on the day is 60% of the way from red-300 to red-600.
    expect(getTreemapColor(-0.05, "daily")).toEqual({ fill: "rgb(198,74,63)", isLightTile: false });
  });

  it("draws the theme's ramp through its middle stop", () => {
    const palette = {
      ...fallbackPalette,
      positiveLow: [0, 0, 0],
      positiveMid: [100, 50, 0],
      positiveHigh: [200, 200, 200],
    };
    expect(getTreemapColor(0.5 / 3, "pnl", palette).fill).toBe("rgb(50,25,0)");
    expect(getTreemapColor(0.5, "pnl", palette).fill).toBe("rgb(100,50,0)");
    expect(getTreemapColor(1.5, "pnl", palette).fill).toBe("rgb(150,125,100)");
  });

  it("keeps a straight ramp when the middle stop is halfway", () => {
    // The other themes set their middle stop halfway between low and high,
    // so their tiles stay where a straight blend from low to high put them.
    const low = [58, 31, 29];
    const high = [255, 69, 58];
    const palette = {
      ...fallbackPalette,
      negativeLow: low,
      negativeMid: low.map((v, i) => Math.round((v + high[i]) / 2)),
      negativeHigh: high,
    };
    for (const move of [0.001, 0.0025, 0.005, 0.01, 0.0125, 0.02, 0.05, 0.2]) {
      const t = move / (move + 0.0125);
      const straight = low.map((v, i) => v + (high[i] - v) * t);
      const fill = getTreemapColor(-move, "daily", palette).fill.match(/\d+/g)!.map(Number);
      fill.forEach((v, i) => expect(Math.abs(v - straight[i])).toBeLessThanOrEqual(1));
    }
  });

  it("labels each tile with the label that contrasts more", () => {
    // Classic's -1.5% daily tile, #e36a5a: ink reads at 5.9:1, paper at 3.2:1,
    // though the tile is darker than a luminance cut-off would call light.
    const tile = [227, 106, 90];
    const palette = {
      ...fallbackPalette,
      negativeLow: tile,
      negativeMid: tile,
      negativeHigh: tile,
    };
    expect(getTreemapColor(-0.015, "daily", palette).isLightTile).toBe(true);
    expect(getTreemapColor(-0.015, "daily").fill).toBe("rgb(227,106,90)");
  });
});
