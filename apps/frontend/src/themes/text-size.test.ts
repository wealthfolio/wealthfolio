import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTextSize,
  SYSTEM_TEXT_SCALE_GLOBAL,
  textSizeForScale,
  textSizeScales,
  textSizes,
} from "./text-size";

const setSystemScale = (scale: unknown) => {
  (window as unknown as Record<string, unknown>)[SYSTEM_TEXT_SCALE_GLOBAL] = scale;
};

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[SYSTEM_TEXT_SCALE_GLOBAL];
});

describe("text size", () => {
  it("keeps the scales equal to the root font sizes in globals.css", () => {
    // A string path: under jsdom, `new URL` builds a URL that readFileSync rejects.
    const css = readFileSync(join(import.meta.dirname, "../globals.css"), "utf8");
    for (const size of textSizes) {
      const rule = new RegExp(
        `:root\\[data-text-size="${size}"\\]\\s*\\{\\s*font-size:\\s*([\\d.]+)%`,
      ).exec(css);
      // The default size needs no rule: the root keeps the browser's size.
      const percent = rule ? Number(rule[1]) : 100;
      expect(percent / 100, size).toBe(textSizeScales[size]);
    }
  });

  it("maps a system font scale to the nearest size", () => {
    // Android's steps (Android 14 adds 1.5, 1.8 and 2.0) and a few vendor ones.
    expect(textSizeForScale(0.8)).toBe("small");
    expect(textSizeForScale(0.85)).toBe("small");
    expect(textSizeForScale(0.9)).toBe("small");
    expect(textSizeForScale(1)).toBe("default");
    expect(textSizeForScale(1.05)).toBe("default");
    expect(textSizeForScale(1.1)).toBe("large");
    expect(textSizeForScale(1.15)).toBe("large");
    expect(textSizeForScale(1.3)).toBe("extra-large");
    expect(textSizeForScale(2)).toBe("extra-large");
  });

  it("starts from the system's font scale until a size is picked", () => {
    expect(resolveTextSize(undefined)).toBe("default");
    setSystemScale(1.3);
    expect(resolveTextSize(undefined)).toBe("extra-large");
    expect(resolveTextSize(null)).toBe("extra-large");
    // A picked size wins, and a name from a newer version shows the default.
    expect(resolveTextSize("default")).toBe("default");
    expect(resolveTextSize("small")).toBe("small");
    expect(resolveTextSize("from-a-newer-version")).toBe("default");
  });

  it("ignores a system scale that isn't a positive number", () => {
    for (const scale of ["1.3", 0, -1, Number.NaN, null]) {
      setSystemScale(scale);
      expect(resolveTextSize(undefined), String(scale)).toBe("default");
    }
  });
});
