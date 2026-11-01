import { describe, expect, it, vi } from "vitest";
import {
  fallbackPalette,
  getTreemapColor,
  readableLabel,
  readableLabelColors,
  subscribeToTreemapTheme,
} from "./treemap-palette";

describe("treemap palette", () => {
  it("draws Classic's ramp: soft sage and rose through their midpoints", () => {
    // +50% total return is the gain ramp's middle (k = 0.5), #b8c496; -25% is the loss
    // ramp's middle, #dca89d. A flat day is the low stop.
    expect(getTreemapColor(0.5, "pnl")).toEqual({ fill: "rgb(184,196,150)", isLightTile: true });
    expect(getTreemapColor(-0.25, "pnl")).toEqual({ fill: "rgb(220,168,157)", isLightTile: true });
    expect(getTreemapColor(0, "daily").fill).toBe("rgb(230,236,213)");
    // -5% on the day is 60% of the way from the middle to #bd6f60; ink reads best on it.
    expect(getTreemapColor(-0.05, "daily")).toEqual({
      fill: "rgb(201,134,120)",
      isLightTile: true,
    });
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
    // A mid red tile, #e36a5a: ink reads at 5.9:1, paper at 3.2:1, though the tile
    // is darker than a luminance cut-off would call light.
    const tile = [227, 106, 90];
    const palette = {
      ...fallbackPalette,
      negativeLow: tile,
      negativeMid: tile,
      negativeHigh: tile,
    };
    expect(getTreemapColor(-0.015, "daily", palette).isLightTile).toBe(true);
  });

  it("labels any fill with the label that contrasts more", () => {
    // Poster dark: its first chart colour is its light label, #f2f2f2 (1:1), so the
    // dark label goes on it; its card, #1b1b1b, takes the light one.
    const poster = { ...fallbackPalette, labelDark: [17, 17, 17], labelLight: [242, 242, 242] };
    expect(readableLabel([242, 242, 242], poster)).toBe(poster.labelDark);
    expect(readableLabel([27, 27, 27], poster)).toBe(poster.labelLight);
  });

  it("resolves CSS colours on the page before picking their labels", () => {
    // jsdom has no canvas: stand in one that reads back the rgb() it was given.
    let fill = "";
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      set fillStyle(value: string) {
        fill = value;
      },
      getImageData: () => ({ data: [...fill.match(/\d+/g)!.map(Number), 255] }),
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    expect(readableLabelColors(["rgb(242, 242, 242)", "rgb(27, 27, 27)"], fallbackPalette)).toEqual(
      ["rgb(16,15,15)", "rgb(255,252,240)"],
    );
    expect(document.body.childElementCount).toBe(0);
    getContext.mockRestore();
  });

  it("re-reads the palette when the mode, theme or gain and loss colours change", async () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToTreemapTheme(onChange);
    const root = document.documentElement;
    for (const change of [
      () => root.setAttribute("data-gain-colors", "red-up"),
      () => root.setAttribute("data-theme", "ember"),
      () => root.classList.add("dark"),
    ]) {
      onChange.mockClear();
      change();
      await Promise.resolve();
      expect(onChange).toHaveBeenCalled();
    }
    unsubscribe();
    root.removeAttribute("data-gain-colors");
    root.removeAttribute("data-theme");
    root.classList.remove("dark");
  });
});
